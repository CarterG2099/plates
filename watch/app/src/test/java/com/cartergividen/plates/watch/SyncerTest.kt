package com.cartergividen.plates.watch

import com.cartergividen.plates.watch.data.PlatesJson
import com.cartergividen.plates.watch.data.SetRow
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.data.Table
import com.cartergividen.plates.watch.logic.StateHolder
import com.cartergividen.plates.watch.logic.Syncer
import com.cartergividen.plates.watch.net.Remote
import com.cartergividen.plates.watch.net.Session
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncerTest {
    private val login = Session(ME, "access", "refresh", expiresAt = 2_000_000_000)

    private class Holder(override var state: State) : StateHolder {
        override fun update(change: (State) -> State) { state = change(state) }
    }

    private open class FakeRemote : Remote {
        val upserts = mutableListOf<Pair<Table, List<JsonElement>>>()
        val server = mutableMapOf<Table, List<JsonElement>>()
        val asked = mutableListOf<Triple<Table, String?, Int>>()
        var onUpsert: () -> Unit = {}
        var failUpsert = false

        override suspend fun redeem(code: String) = error("unused")
        override suspend fun refresh(refreshToken: String) = Session(ME, "new-access", "new-refresh", 9)
        override suspend fun upsert(token: String, table: Table, rows: List<JsonElement>) {
            if (failUpsert) throw Exception("no signal")
            onUpsert()
            upserts += table to rows
        }
        override suspend fun changedSince(
            token: String, email: String, table: Table, since: String?, offset: Int, limit: Int,
        ): List<JsonElement> {
            asked += Triple(table, since, offset)
            return server[table].orEmpty().drop(offset).take(limit)
        }
    }

    private fun json(row: SetRow) = PlatesJson.encodeToJsonElement(SetRow.serializer(), row)

    @Test fun `queued rows are pushed and leave the outbox`() = runBlocking {
        val remote = FakeRemote()
        val holder = Holder(State().save(set("s1", "w", reps = 8)))
        Syncer(remote).sync(holder, login)

        assertEquals(Table.SETS, remote.upserts.single().first)
        assertTrue(holder.state.outbox.isEmpty())
    }

    @Test fun `a tick that lands mid-push is kept for the next one`() = runBlocking {
        val remote = FakeRemote()
        val row = set("s1", "w", reps = 8, updated = "2026-10-14T10:00:00Z")
        val holder = Holder(State().save(row))
        remote.onUpsert = {
            holder.update { it.save(row.copy(completedAt = "2026-10-14T10:00:05Z", updatedAt = "2026-10-14T10:00:05Z")) }
        }

        Syncer(remote).sync(holder, login)

        assertEquals("2026-10-14T10:00:05Z", holder.state.outbox.single().updatedAt)
        assertEquals("2026-10-14T10:00:05Z", holder.state.sets.getValue("s1").completedAt)
    }

    @Test fun `no signal leaves everything queued`() = runBlocking {
        val remote = FakeRemote().apply { failUpsert = true }
        val holder = Holder(State().save(set("s1", "w")))
        runCatching { Syncer(remote).sync(holder, login) }
        assertEquals(1, holder.state.outbox.size)
    }

    @Test fun `pulls page through, from the cursor`() = runBlocking {
        val remote = FakeRemote()
        remote.server[Table.SETS] = (0 until 5).map { json(set("p$it", "w", updated = "2026-10-14T10:00:0${it}Z")) }
        val holder = Holder(State(cursors = mapOf(Table.SETS to "2026-10-14T09:00:00Z")))

        Syncer(remote, pageSize = 2).sync(holder, login)

        val setPulls = remote.asked.filter { it.first == Table.SETS }
        assertEquals(listOf(0, 2, 4), setPulls.map { it.third })
        assertTrue(setPulls.all { it.second == "2026-10-14T09:00:00Z" })
        assertEquals(5, holder.state.sets.size)
        assertEquals("2026-10-14T10:00:04Z", holder.state.cursors[Table.SETS])
    }

    @Test fun `a pull does not undo an edit that has not been pushed yet`() = runBlocking {
        val remote = FakeRemote().apply { failUpsert = false }
        val mine = set("s1", "w", reps = 10, updated = "2026-10-14T10:05:00Z")
        remote.server[Table.SETS] = listOf(json(mine.copy(reps = 6, updatedAt = "2026-10-14T10:00:00Z")))
        remote.onUpsert = { }
        val holder = Holder(State().save(mine))

        Syncer(remote).sync(holder, login)

        assertEquals(10, holder.state.sets.getValue("s1").reps)
    }

    @Test fun `rows go out in the database's own column names, nulls included`() {
        val obj = Syncer.encode(Table.SETS, set("s1", "w")).jsonObject
        assertTrue("session_id" in obj && "exercise_name" in obj && "set_index" in obj)
        assertEquals("un-ticking must send completed_at: null, not omit it", JsonNull, obj["completed_at"])
        assertNull(obj["sessionId"])
    }

    @Test fun `server rows with columns the watch does not know still decode`() {
        val withExtras = PlatesJson.parseToJsonElement(
            """{"id":"s1","owner_email":"$ME","session_id":"w","exercise_name":"Bench","set_index":0,
               "rpe":8,"replaced_at":null,"updated_at":"2026-10-14T10:00:00+00:00"}""",
        )
        val row = Syncer.decode(Table.SETS, withExtras) as SetRow
        assertEquals("Bench", row.exerciseName)
    }

    @Test fun `the token is refreshed a minute before it expires, not after`() = runBlocking {
        val remote = FakeRemote()
        val soon = login.copy(expiresAt = 1_000)
        assertEquals("access", Syncer.fresh(soon, remote, nowSeconds = 900).accessToken)
        assertEquals("new-access", Syncer.fresh(soon, remote, nowSeconds = 950).accessToken)
    }
}
