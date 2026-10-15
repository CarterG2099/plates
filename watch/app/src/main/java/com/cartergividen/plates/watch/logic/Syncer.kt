package com.cartergividen.plates.watch.logic

import com.cartergividen.plates.watch.data.ExerciseRow
import com.cartergividen.plates.watch.data.PlatesJson
import com.cartergividen.plates.watch.data.Queued
import com.cartergividen.plates.watch.data.Row
import com.cartergividen.plates.watch.data.RoutineExerciseRow
import com.cartergividen.plates.watch.data.RoutineRow
import com.cartergividen.plates.watch.data.SessionRow
import com.cartergividen.plates.watch.data.SetRow
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.data.Table
import com.cartergividen.plates.watch.net.Remote
import com.cartergividen.plates.watch.net.Session
import kotlinx.serialization.json.JsonElement

/**
 * Where the state lives. Sync reads a snapshot and writes back only through
 * [update], so a set ticked while a request is in flight is never overwritten
 * by a state computed before the tick.
 */
interface StateHolder {
    val state: State
    fun update(change: (State) -> State)
}

/** docs/js/sync.js for the watch: push the outbox, then pull what changed. */
class Syncer(private val remote: Remote, private val pageSize: Int = 1000) {

    /** Returns how many pulled rows were news — zero means nothing to redraw. */
    suspend fun sync(holder: StateHolder, session: Session): Int {
        push(holder, session.accessToken)
        var applied = 0
        for (table in PULL_ORDER) applied += pull(holder, session, table)
        holder.update { it.compact() }
        return applied
    }

    private suspend fun push(holder: StateHolder, token: String) {
        val snapshot = holder.state
        val byTable = snapshot.outbox.groupBy { it.table }
        for ((table, entries) in byTable) {
            val sent = mutableListOf<Queued>()
            val rows = entries.mapNotNull { entry ->
                snapshot.rowFor(entry)?.let { row -> sent += entry; encode(table, row) }
            }
            // Throws on failure, leaving everything queued for the next pass —
            // which is almost always just absent signal.
            remote.upsert(token, table, rows)
            holder.update { it.dequeue(sent) }
        }
    }

    private suspend fun pull(holder: StateHolder, session: Session, table: Table): Int {
        val since = holder.state.cursors[table]
        var offset = 0
        var applied = 0
        while (true) {
            val page = remote.changedSince(session.accessToken, session.email, table, since, offset, pageSize)
            if (page.isEmpty()) break
            val rows = page.map { decode(table, it) }
            var news = 0
            holder.update { state -> state.merge(table, rows).also { news = it.second }.first }
            applied += news
            if (page.size < pageSize) break
            offset += pageSize
        }
        return applied
    }

    companion object {
        /** Routines and the library first, so the start screen fills before history. */
        val PULL_ORDER = listOf(Table.EXERCISES, Table.ROUTINES, Table.ROUTINE_EXERCISES, Table.SESSIONS, Table.SETS)

        fun encode(table: Table, row: Row): JsonElement = when (table) {
            Table.SESSIONS -> PlatesJson.encodeToJsonElement(SessionRow.serializer(), row as SessionRow)
            Table.SETS -> PlatesJson.encodeToJsonElement(SetRow.serializer(), row as SetRow)
            Table.ROUTINES -> PlatesJson.encodeToJsonElement(RoutineRow.serializer(), row as RoutineRow)
            Table.ROUTINE_EXERCISES -> PlatesJson.encodeToJsonElement(RoutineExerciseRow.serializer(), row as RoutineExerciseRow)
            Table.EXERCISES -> PlatesJson.encodeToJsonElement(ExerciseRow.serializer(), row as ExerciseRow)
        }

        fun decode(table: Table, json: JsonElement): Row = when (table) {
            Table.SESSIONS -> PlatesJson.decodeFromJsonElement(SessionRow.serializer(), json)
            Table.SETS -> PlatesJson.decodeFromJsonElement(SetRow.serializer(), json)
            Table.ROUTINES -> PlatesJson.decodeFromJsonElement(RoutineRow.serializer(), json)
            Table.ROUTINE_EXERCISES -> PlatesJson.decodeFromJsonElement(RoutineExerciseRow.serializer(), json)
            Table.EXERCISES -> PlatesJson.decodeFromJsonElement(ExerciseRow.serializer(), json)
        }

        /** Refresh a minute before expiry, so a request never goes out on a dying token. */
        suspend fun fresh(session: Session, remote: Remote, nowSeconds: Long): Session =
            if (session.expiresAt - nowSeconds > 60) session else remote.refresh(session.refreshToken)
    }
}
