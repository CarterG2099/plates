package com.cartergividen.plates.watch.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.cartergividen.plates.watch.data.Disk
import com.cartergividen.plates.watch.data.RoutineRow
import com.cartergividen.plates.watch.data.Stamp
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.logic.CodeEntry
import com.cartergividen.plates.watch.logic.StateHolder
import com.cartergividen.plates.watch.logic.Syncer
import com.cartergividen.plates.watch.logic.Workout
import com.cartergividen.plates.watch.logic.workoutScreen
import com.cartergividen.plates.watch.net.Session
import com.cartergividen.plates.watch.net.Supabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID

/** Sync status, said plainly on the home screen. */
data class SyncStatus(val busy: Boolean = false, val error: String? = null, val pending: Int = 0)

/** The numbers dialled in on the current set before it is ticked. */
data class Draft(val setId: String, val weightLb: Double?, val reps: Int?)

class WatchViewModel(app: Application) : AndroidViewModel(app), StateHolder {
    private val disk = Disk(app.filesDir)
    private val remote = Supabase()
    private val syncer = Syncer(remote)

    // Filled from disk off the main thread: the file is ~470KB of JSON, and
    // parsing it before the first frame was most of a cold start on the watch.
    private val _state = MutableStateFlow(State())
    val stateFlow: StateFlow<State> = _state.asStateFlow()
    override val state: State get() = _state.value

    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    private val _session = MutableStateFlow(disk.loadSession())
    val session: StateFlow<Session?> = _session.asStateFlow()

    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    private val _draft = MutableStateFlow<Draft?>(null)
    val draft: StateFlow<Draft?> = _draft.asStateFlow()

    // The set jumped to from the overview; null means the first open one.
    private val _focus = MutableStateFlow<String?>(null)
    val focus: StateFlow<String?> = _focus.asStateFlow()

    private val _overviewOpen = MutableStateFlow(false)
    val overviewOpen: StateFlow<Boolean> = _overviewOpen.asStateFlow()

    private val _code = MutableStateFlow(CodeEntry())
    val code: StateFlow<CodeEntry> = _code.asStateFlow()
    private val _pairing = MutableStateFlow<String?>(null)   // error, or "Pairing…"
    val pairing: StateFlow<String?> = _pairing.asStateFlow()

    // Saves are conflated: a burst of ticks writes the file once, with the last state.
    private val saves = Channel<State>(Channel.CONFLATED)
    private val syncLock = Mutex()
    private var poller: Job? = null

    init {
        viewModelScope.launch(Dispatchers.IO) {
            val stored = disk.loadState()
            _state.value = stored
            _status.update { it.copy(pending = stored.outbox.size) }
            _loaded.value = true
            for (s in saves) disk.saveState(s)
        }
    }

    @Synchronized
    override fun update(change: (State) -> State) {
        val before = _state.value
        _state.update(change)
        val after = _state.value
        // An equal state leaves the flow holding the old object. Most syncs pull
        // back only what is already here, and re-saving the whole file for each
        // one kept the watch busy every 15 seconds. Nothing is saved before the
        // load either: it would write an empty state over the real one.
        if (after === before || !_loaded.value) return
        saves.trySend(after)
        _status.update { it.copy(pending = after.outbox.size) }
    }

    // ---- sync ---------------------------------------------------------------

    /** While the app is on screen, sync every 15s so the phone's edits show up. */
    fun foreground(on: Boolean) {
        poller?.cancel()
        if (!on) return
        poller = viewModelScope.launch {
            while (isActive) {
                syncNow()
                delay(15_000)
            }
        }
    }

    fun syncNow() {
        val current = _session.value ?: return
        viewModelScope.launch {
            _loaded.first { it }
            if (!syncLock.tryLock()) return@launch   // one pass at a time; the next poll catches up
            try {
                _status.update { it.copy(busy = true) }
                val fresh = Syncer.fresh(current, remote, System.currentTimeMillis() / 1000)
                if (fresh != current) {
                    _session.value = fresh
                    withContext(Dispatchers.IO) { disk.saveSession(fresh) }
                }
                // Decoding, merging and pruning are the heavy part, and on the
                // main thread they stalled whatever was on screen.
                withContext(Dispatchers.Default) { syncer.sync(this@WatchViewModel, fresh) }
                _status.update { it.copy(busy = false, error = null) }
            } catch (e: Exception) {
                // Usually just no signal. Everything stays queued for the next pass.
                _status.update { it.copy(busy = false, error = e.message ?: "Sync failed") }
            } finally {
                syncLock.unlock()
            }
        }
    }

    // ---- pairing --------------------------------------------------------------

    fun press(digit: Int) { _code.update { it.press(digit) }; _pairing.value = null }
    fun backspace() { _code.update { it.back() } }

    fun submitCode() {
        val entry = _code.value
        if (!entry.complete) return
        viewModelScope.launch {
            _pairing.value = "Pairing…"
            try {
                val paired = remote.redeem(entry.digits)
                withContext(Dispatchers.IO) { disk.saveSession(paired) }
                _session.value = paired
                _pairing.value = null
                _code.value = CodeEntry()
                syncNow()
            } catch (e: Exception) {
                _pairing.value = e.message ?: "Pairing failed"
                _code.value = CodeEntry()
            }
        }
    }

    fun signOut() {
        foreground(false)
        _session.value = null
        update { State() }
        viewModelScope.launch(Dispatchers.IO) { disk.saveSession(null) }
    }

    // ---- the workout --------------------------------------------------------------

    private val email get() = _session.value?.email
    private fun now() = Stamp.now()
    private fun newId() = UUID.randomUUID().toString()

    fun start(routine: RoutineRow) {
        val me = email ?: return
        val (session, sets) = Workout.startFromRoutine(state, routine, me, now(), ::newId)
        update { s -> sets.fold(s.save(session)) { acc, set -> acc.save(set) } }
        syncNow()
    }

    fun showOverview(open: Boolean) { _overviewOpen.value = open }

    /** Jump to a set from the overview. */
    fun open(setId: String) {
        _focus.value = setId
        _draft.value = null
        _overviewOpen.value = false
    }

    /** The numbers on screen: what you dialled, else what the set already holds. */
    private fun dialled(): Draft? {
        val me = email ?: return null
        val current = workoutScreen(state, me, _focus.value)?.current ?: return null
        val draft = _draft.value
        return if (draft?.setId == current.set.id) draft
        else Draft(current.set.id, current.weightLb, current.reps)
    }

    fun stepWeight(direction: Int) {
        val d = dialled() ?: return
        _draft.value = d.copy(weightLb = Workout.stepWeight(d.weightLb, direction))
    }

    fun stepReps(direction: Int) {
        val d = dialled() ?: return
        _draft.value = d.copy(reps = Workout.stepReps(d.reps, direction))
    }

    fun setWeight(weightLb: Double) {
        val d = dialled() ?: return
        _draft.value = d.copy(weightLb = weightLb)
    }

    fun setReps(reps: Int) {
        val d = dialled() ?: return
        _draft.value = d.copy(reps = reps)
    }

    /**
     * Tick the set on screen, then move on: the next set of the same exercise,
     * else the first open one. A set reopened from the overview is saved with its
     * new numbers and keeps its tick — fixing a number is not redoing the set.
     */
    fun tick() {
        val me = email ?: return
        val screen = workoutScreen(state, me, _focus.value) ?: return
        val current = screen.current ?: return
        val d = dialled() ?: return
        if (!Workout.canTick(d.reps)) return

        val stamp = now()
        if (current.done) {
            update { it.save(current.set.copy(weightLb = d.weightLb, reps = d.reps, updatedAt = stamp)) }
            _focus.value = null
        } else {
            val ticked = Workout.complete(current.set, d.weightLb, d.reps, stamp)
            update { it.save(ticked) }
            _focus.value = Workout.nextAfterTick(state, Workout.setsFor(state, screen.session.id), ticked)
        }
        _draft.value = null
        syncNow()
    }

    /** ‹ or ›: the previous or next set in workout order, ticked or not. */
    fun step(direction: Int) {
        val me = email ?: return
        val current = workoutScreen(state, me, _focus.value)?.current ?: return
        val target = if (direction < 0) current.previousId else current.nextId
        if (target != null) open(target)
    }

    /** Take the tick off the set on screen, and stay on it to redo it. */
    fun untick() {
        val me = email ?: return
        val current = workoutScreen(state, me, _focus.value)?.current ?: return
        if (!current.done) return
        update { it.save(Workout.undo(current.set, now())) }
        _focus.value = current.set.id
        _draft.value = null
        syncNow()
    }

    fun oneMore() {
        val me = email ?: return
        val screen = workoutScreen(state, me, _focus.value) ?: return
        val like = screen.lastSet ?: return
        val added = Workout.oneMore(like, Workout.setsFor(state, screen.session.id), now(), ::newId)
        update { it.save(added) }
        _focus.value = added.id
        syncNow()
    }

    fun finish() {
        val me = email ?: return
        val session = Workout.activeSession(state, me) ?: return
        update { it.save(Workout.finish(session, now())) }
        _draft.value = null
        _focus.value = null
        _overviewOpen.value = false
        syncNow()
    }
}
