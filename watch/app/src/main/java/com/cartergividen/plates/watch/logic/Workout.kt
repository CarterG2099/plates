package com.cartergividen.plates.watch.logic

import com.cartergividen.plates.watch.data.ExerciseRow
import com.cartergividen.plates.watch.data.RoutineRow
import com.cartergividen.plates.watch.data.SessionRow
import com.cartergividen.plates.watch.data.SetRow
import com.cartergividen.plates.watch.data.Stamp
import com.cartergividen.plates.watch.data.State

/**
 * The phone's workout rules, for a wrist.
 *
 * Each function here mirrors one in docs/js/workout.js or the Train screen in
 * app.js, and says which. They have to agree: the phone and the watch edit the
 * same session, and a set the watch writes must look to the phone exactly like
 * one the phone wrote itself.
 */
object Workout {
    /** workout.js DEFAULT_SETS: a routine exercise with no planned count opens with three. */
    const val DEFAULT_SETS = 3
    const val WEIGHT_STEP = 5.0
    const val REPS_STEP = 1

    /** workout.js CARDIO_NAMES. Whole names, never a pattern — "Walking Lunge" is not cardio. */
    private val CARDIO_NAMES = setOf(
        "running", "treadmill running", "cycling", "indoor cycling", "outdoor cycling",
        "walking", "swimming", "hiking", "elliptical", "rowing (machine)",
        "stair machine (steps)", "stair machine",
    )

    /** workout.js isCardio. Cardio stays on the phone: the watch logs weight and reps. */
    fun isCardio(exercise: ExerciseRow?, name: String): Boolean {
        if (exercise?.category == "cardio") return true
        return listOfNotNull(exercise?.name, name).any { it.trim().lowercase() in CARDIO_NAMES }
    }

    /** workout.js activeSession: the newest unfinished workout, if any. */
    fun activeSession(state: State, email: String): SessionRow? =
        state.sessions.values
            .filter { it.ownerEmail == email && it.deletedAt == null && it.endedAt == null }
            .maxByOrNull { Stamp.parse(it.startedAt) }

    /** workout.js setsForSession. */
    fun setsFor(state: State, sessionId: String): List<SetRow> =
        state.sets.values.filter { it.sessionId == sessionId && it.deletedAt == null }.sortedBy { it.setIndex }

    /** workout.js routinesFor: yours, in the order you train them. */
    fun routines(state: State, email: String): List<RoutineRow> =
        state.routines.values
            .filter { it.ownerEmail == email && it.deletedAt == null }
            .sortedWith(compareBy({ it.position }, { it.name }))

    /**
     * workout.js lastPerformance: the working sets of the newest other session
     * that did this exercise. The numbers a set falls back to when you tick it
     * without changing anything.
     */
    fun previous(state: State, email: String, set: SetRow): List<SetRow> {
        val sessions = state.sessions.values
            .filter { it.ownerEmail == email && it.deletedAt == null && it.id != set.sessionId }
            .associateBy { it.id }

        val matching = state.sets.values.filter {
            it.deletedAt == null && it.sessionId in sessions && !it.isWarmup && it.completedAt != null &&
                (if (set.exerciseId != null) it.exerciseId == set.exerciseId else it.exerciseName == set.exerciseName)
        }
        val newest = matching.maxByOrNull { Stamp.parse(sessions.getValue(it.sessionId).startedAt) } ?: return emptyList()
        return matching.filter { it.sessionId == newest.sessionId }.sortedBy { it.setIndex }
    }

    /** app.js placeholderFor: that set last time, else the last one there was. */
    fun placeholder(previous: List<SetRow>, position: Int): SetRow? =
        previous.getOrNull(position) ?: previous.lastOrNull()

    /** Where a set sits among its own exercise's sets — what the placeholder is indexed by. */
    fun positionInExercise(sets: List<SetRow>, set: SetRow): Int =
        sets.filter { it.exerciseKey == set.exerciseKey }.indexOfFirst { it.id == set.id }

    /** The next set to do: the first unticked one the watch can log. */
    fun currentSet(state: State, sets: List<SetRow>): SetRow? =
        sets.firstOrNull { it.completedAt == null && !isCardio(state.exercises[it.exerciseId], it.exerciseName) }

    /** Unticked cardio, left for the phone. */
    fun cardioLeft(state: State, sets: List<SetRow>): Int =
        sets.count { it.completedAt == null && isCardio(state.exercises[it.exerciseId], it.exerciseName) }

    /** workout.js lastActivityAt: when the newest tick happened, for the rest clock. */
    fun lastActivity(sets: List<SetRow>): String? = Stamp.latest(sets.mapNotNull { it.completedAt })

    /**
     * app.js startFromRoutine: a session seeded with the routine's exercises, as
     * many empty sets each as the routine plans.
     *
     * Empty on purpose, the same as the phone: last time's numbers are a
     * placeholder, adopted when you tick the set without changing them.
     */
    fun startFromRoutine(
        state: State,
        routine: RoutineRow,
        email: String,
        now: String,
        newId: () -> String,
    ): Pair<SessionRow, List<SetRow>> {
        val session = SessionRow(
            id = newId(), ownerEmail = email, routineId = routine.id, name = routine.name,
            startedAt = now, endedAt = null, updatedAt = now,
        )
        val planned = state.routineExercises.values
            .filter { it.routineId == routine.id && it.deletedAt == null }
            .sortedBy { it.position }

        val sets = mutableListOf<SetRow>()
        for (item in planned) {
            val exercise = item.exerciseId?.let { state.exercises[it] }
            val name = exercise?.name ?: item.notes ?: "Exercise"
            repeat(item.targetSets?.takeIf { it > 0 } ?: DEFAULT_SETS) {
                sets += SetRow(
                    id = newId(), ownerEmail = email, sessionId = session.id,
                    exerciseId = item.exerciseId, exerciseName = name, setIndex = sets.size,
                    updatedAt = now,
                )
            }
        }
        return session to sets
    }

    /**
     * app.js toggleDone, ticking: stamped done with the numbers on screen. The
     * screen starts from the placeholder, so ticking untouched adopts last time.
     */
    fun complete(set: SetRow, weightLb: Double?, reps: Int?, now: String): SetRow =
        set.copy(weightLb = weightLb, reps = reps, completedAt = now, updatedAt = now)

    /** app.js toggleDone, unticking. The numbers stay; only the tick goes. */
    fun undo(set: SetRow, now: String): SetRow = set.copy(completedAt = null, updatedAt = now)

    /** The most recently ticked set, for undoing a mis-tap. */
    fun lastTicked(sets: List<SetRow>): SetRow? =
        sets.filter { it.completedAt != null }.maxByOrNull { Stamp.parse(it.completedAt!!) }

    /** workout.js addSet: one more of the same exercise, at the end of the session. */
    fun oneMore(like: SetRow, sets: List<SetRow>, now: String, newId: () -> String): SetRow =
        SetRow(
            id = newId(), ownerEmail = like.ownerEmail, sessionId = like.sessionId,
            exerciseId = like.exerciseId, exerciseName = like.exerciseName,
            setIndex = (sets.maxOfOrNull { it.setIndex } ?: -1) + 1, updatedAt = now,
        )

    /** workout.js finishSession: never ends before it began. */
    fun finish(session: SessionRow, now: String): SessionRow {
        val end = if (Stamp.after(session.startedAt, now)) session.startedAt else now
        return session.copy(endedAt = end, updatedAt = now)
    }

    /**
     * No history for this exercise: the set of it you just ticked, this
     * session. So only the very first set of something new starts blank —
     * after that, set 2 opens where set 1 left off.
     */
    fun earlierThisSession(sets: List<SetRow>, set: SetRow): SetRow? =
        sets.filter { it.exerciseKey == set.exerciseKey && it.completedAt != null && it.setIndex < set.setIndex }
            .maxByOrNull { it.setIndex }

    /** A set needs reps to be a set. Weight may stay empty: bodyweight work has none. */
    fun canTick(reps: Int?): Boolean = reps != null && reps > 0

    // The wheels behind a tap on the number. Five-pound notches, not 2.5: on the
    // emulator a bezel click moved one notch, and halving the notches halves the
    // spinning to a heavy set. A blank value opens on the empty bar and a typical
    // set, which is where most first sets of something new begin.
    val WEIGHT_OPTIONS: List<Double> = (0..120).map { it * 5.0 }
    val REPS_OPTIONS: List<Int> = (1..50).toList()
    private const val BLANK_WEIGHT = 45.0
    private const val BLANK_REPS = 8

    fun weightIndex(weight: Double?): Int =
        Math.round((weight ?: BLANK_WEIGHT) / 5.0).toInt().coerceIn(0, WEIGHT_OPTIONS.lastIndex)

    fun repsIndex(reps: Int?): Int = ((reps ?: BLANK_REPS) - 1).coerceIn(0, REPS_OPTIONS.lastIndex)

    fun stepWeight(weight: Double?, direction: Int): Double =
        ((weight ?: 0.0) + direction * WEIGHT_STEP).coerceAtLeast(0.0)

    fun stepReps(reps: Int?, direction: Int): Int =
        ((reps ?: 0) + direction * REPS_STEP).coerceAtLeast(0)

    /** "135" not "135.0", but "132.5" kept. */
    fun weightLabel(weight: Double?): String = when {
        weight == null -> "—"
        weight % 1.0 == 0.0 -> weight.toLong().toString()
        else -> weight.toString()
    }
}
