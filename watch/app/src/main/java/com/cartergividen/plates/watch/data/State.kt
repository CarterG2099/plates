package com.cartergividen.plates.watch.data

import kotlinx.serialization.Serializable
import java.time.Instant

/** The five tables the watch mirrors, with exactly the columns [Rows] carries. */
enum class Table(val path: String, val columns: String) {
    SESSIONS("sessions", "id,owner_email,routine_id,name,started_at,ended_at,updated_at,deleted_at"),
    SETS(
        "session_sets",
        "id,owner_email,session_id,exercise_id,exercise_name,set_index,weight_lb,reps," +
            "is_warmup,completed_at,distance_m,duration_s,updated_at,deleted_at",
    ),
    ROUTINES("routines", "id,owner_email,name,position,updated_at,deleted_at"),
    ROUTINE_EXERCISES(
        "routine_exercises",
        "id,owner_email,routine_id,exercise_id,position,target_sets,notes,updated_at,deleted_at",
    ),
    EXERCISES("exercises", "id,owner_email,name,category,updated_at,deleted_at"),
}

/**
 * A write waiting to reach the server: which row, and the version of it that
 * was queued. The version is what makes dequeuing safe — see [State.dequeue].
 */
@Serializable
data class Queued(val table: Table, val id: String, val updatedAt: String)

/**
 * Everything the watch knows, in one value.
 *
 * Writes land here first and reach the server later, the same local-first rule
 * as the phone: a gym is the worst signal either of you will be in, so ticking
 * a set never waits on the network.
 */
@Serializable
data class State(
    val sessions: Map<String, SessionRow> = emptyMap(),
    val sets: Map<String, SetRow> = emptyMap(),
    val routines: Map<String, RoutineRow> = emptyMap(),
    val routineExercises: Map<String, RoutineExerciseRow> = emptyMap(),
    val exercises: Map<String, ExerciseRow> = emptyMap(),
    val outbox: List<Queued> = emptyList(),
    val cursors: Map<Table, String> = emptyMap(),
) {
    /** Write a row locally and queue it. One queue entry per row: the newest wins. */
    fun save(row: SessionRow) = copy(sessions = sessions + (row.id to row)).queue(Table.SESSIONS, row)
    fun save(row: SetRow) = copy(sets = sets + (row.id to row)).queue(Table.SETS, row)

    private fun queue(table: Table, row: Row) = copy(
        outbox = outbox.filterNot { it.table == table && it.id == row.id } +
            Queued(table, row.id, row.updatedAt),
    )

    fun rowFor(entry: Queued): Row? = when (entry.table) {
        Table.SESSIONS -> sessions[entry.id]
        Table.SETS -> sets[entry.id]
        Table.ROUTINES -> routines[entry.id]
        Table.ROUTINE_EXERCISES -> routineExercises[entry.id]
        Table.EXERCISES -> exercises[entry.id]
    }

    /**
     * Drop what the server now has — but only the versions that were sent.
     *
     * A set ticked while its earlier edit was in flight is queued again under the
     * same id. Dropping by id alone would throw that newer tick away as "sent",
     * and it would never leave the watch.
     */
    fun dequeue(sent: Collection<Queued>): State {
        val delivered = sent.toSet()
        return copy(outbox = outbox.filterNot { it in delivered })
    }

    /**
     * Fold pulled rows in, last write wins.
     *
     * A pulled row loses to a newer local one — that is an edit made here that
     * has not reached the server yet. Returns how many rows were actually news,
     * so a pull that only echoed back our own writes doesn't redraw the screen.
     */
    fun merge(table: Table, rows: List<Row>): Pair<State, Int> {
        var applied = 0
        fun <T : Row> fold(current: Map<String, T>, incoming: List<T>): Map<String, T> {
            val next = current.toMutableMap()
            for (remote in incoming) {
                val local = next[remote.id]
                if (local != null && Stamp.after(local.updatedAt, remote.updatedAt)) continue
                if (local == null || Stamp.after(remote.updatedAt, local.updatedAt)) applied++
                next[remote.id] = remote
            }
            return next
        }

        @Suppress("UNCHECKED_CAST")
        val merged = when (table) {
            Table.SESSIONS -> copy(sessions = fold(sessions, rows as List<SessionRow>))
            Table.SETS -> copy(sets = fold(sets, rows as List<SetRow>))
            Table.ROUTINES -> copy(routines = fold(routines, rows as List<RoutineRow>))
            Table.ROUTINE_EXERCISES -> copy(routineExercises = fold(routineExercises, rows as List<RoutineExerciseRow>))
            Table.EXERCISES -> copy(exercises = fold(exercises, rows as List<ExerciseRow>))
        }
        val newest = Stamp.latest(rows.map { it.updatedAt })
        val cursor = cursors[table]
        val nextCursors = if (newest != null && (cursor == null || Stamp.after(newest, cursor))) {
            cursors + (table to newest)
        } else {
            cursors
        }
        return merged.copy(cursors = nextCursors) to applied
    }

    /**
     * Forget history the watch will never show.
     *
     * Two years of sets is about seven thousand rows, and the watch only ever
     * needs each exercise's last outing for the "last time" numbers. Kept: every
     * set of an unfinished session, every set still waiting to sync, and for each
     * exercise the sets of the two most recent sessions that did it — two, so
     * that while one of them is the workout in progress the one before survives.
     *
     * Sessions themselves are small and all kept, which is what lets a pruned set
     * that the server later changes simply arrive again as a new row.
     */
    fun compact(): State {
        val queuedSets = outbox.filter { it.table == Table.SETS }.map { it.id }.toSet()
        val live = sets.values.filter { it.deletedAt == null }

        val keep = mutableSetOf<String>()
        for (set in live) {
            val session = sessions[set.sessionId]
            if (set.id in queuedSets || session == null || session.endedAt == null) keep += set.id
        }

        // Grouped once and each start parsed once: this runs after every sync,
        // and scanning every set again for each exercise was most of its cost.
        val started = HashMap<String, Instant>()
        fun startOf(session: SessionRow) = started.getOrPut(session.id) { Stamp.parse(session.startedAt) }

        live.groupBy { it.exerciseKey }.values.forEach { all ->
            val recent = all.filter { it.completedAt != null && !it.isWarmup }
                .map { it.sessionId }.distinct()
                .mapNotNull { sessions[it] }
                .sortedByDescending { startOf(it) }
                .take(2)
                .map { it.id }
                .toSet()
            all.filter { it.sessionId in recent }.forEach { keep += it.id }
        }

        return copy(sets = sets.filterKeys { it in keep || it in queuedSets })
    }
}
