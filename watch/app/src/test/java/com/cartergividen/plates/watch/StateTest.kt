package com.cartergividen.plates.watch

import com.cartergividen.plates.watch.data.Queued
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.data.Table
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StateTest {

    @Test fun `saving a row twice queues it once, at its newest version`() {
        val first = set("s1", "w", updated = "2026-10-01T10:00:00Z")
        val second = first.copy(reps = 8, updatedAt = "2026-10-01T10:01:00Z")
        val state = State().save(first).save(second)

        assertEquals(listOf(Queued(Table.SETS, "s1", "2026-10-01T10:01:00Z")), state.outbox)
        assertEquals(8, state.sets.getValue("s1").reps)
    }

    @Test fun `a set ticked while its earlier edit was in flight stays queued`() {
        val edit = set("s1", "w", reps = 8, updated = "2026-10-01T10:00:00Z")
        val sent = State().save(edit).outbox            // what the push took
        val ticked = State().save(edit)
            .save(edit.copy(completedAt = "2026-10-01T10:00:30Z", updatedAt = "2026-10-01T10:00:30Z"))

        val after = ticked.dequeue(sent)

        assertEquals("the tick has not reached the server", 1, after.outbox.size)
        assertEquals("2026-10-01T10:00:30Z", after.outbox.single().updatedAt)
    }

    @Test fun `a delivered row leaves the outbox`() {
        val state = State().save(set("s1", "w"))
        assertTrue(state.dequeue(state.outbox).outbox.isEmpty())
    }

    @Test fun `a pulled row loses to a newer local edit`() {
        val local = set("s1", "w", reps = 10, updated = "2026-10-01T10:05:00Z")
        val remote = local.copy(reps = 6, updatedAt = "2026-10-01T10:00:00Z")
        val (merged, applied) = State().save(local).merge(Table.SETS, listOf(remote))

        assertEquals(10, merged.sets.getValue("s1").reps)
        assertEquals(0, applied)
    }

    @Test fun `a newer pulled row replaces the local one`() {
        val local = set("s1", "w", reps = 6, updated = "2026-10-01T10:00:00Z")
        val remote = local.copy(reps = 10, updatedAt = "2026-10-01T10:05:00Z")
        val (merged, applied) = State().save(local).merge(Table.SETS, listOf(remote))

        assertEquals(10, merged.sets.getValue("s1").reps)
        assertEquals(1, applied)
    }

    @Test fun `the server's +00 00 and the phone's Z are compared as moments, not text`() {
        // As text "…10:00:00Z" sorts after "…10:00:00.500+00:00" ('Z' beats '.'),
        // yet the server's row is half a second newer. Text order would keep
        // the older row.
        val local = set("s1", "w", reps = 6, updated = "2026-10-01T10:00:00Z")
        val remote = local.copy(reps = 10, updatedAt = "2026-10-01T10:00:00.500+00:00")
        assertTrue("the trap is real", local.updatedAt > remote.updatedAt)
        val (merged, _) = State().save(local).merge(Table.SETS, listOf(remote))

        assertEquals(10, merged.sets.getValue("s1").reps)
    }

    @Test fun `an echo of our own write is not news`() {
        val row = set("s1", "w", reps = 6)
        val (_, applied) = State().save(row).merge(Table.SETS, listOf(row))
        assertEquals(0, applied)
    }

    @Test fun `the cursor moves to the newest pulled row and never back`() {
        val rows = listOf(
            set("a", "w", updated = "2026-10-01T10:00:00Z"),
            set("b", "w", updated = "2026-10-02T10:00:00+00:00"),
        )
        val (once, _) = State().merge(Table.SETS, rows)
        assertEquals("2026-10-02T10:00:00+00:00", once.cursors[Table.SETS])

        val (twice, _) = once.merge(Table.SETS, listOf(set("c", "w", updated = "2026-09-01T10:00:00Z")))
        assertEquals("2026-10-02T10:00:00+00:00", twice.cursors[Table.SETS])
    }

    @Test fun `compacting keeps each exercise's last two outings and drops the rest`() {
        var state = State()
        for ((i, day) in listOf("01", "02", "03").withIndex()) {
            state = state.merge(Table.SESSIONS, listOf(session("w$i", started = "2026-10-${day}T10:00:00Z"))).first
            state = state.merge(Table.SETS, listOf(set("s$i", "w$i", done = "2026-10-${day}T10:10:00Z"))).first
        }

        val kept = state.compact().sets.keys
        assertEquals(setOf("s1", "s2"), kept)
    }

    @Test fun `compacting never drops the open workout or anything unsynced`() {
        var state = State()
        for ((i, day) in listOf("01", "02", "03").withIndex()) {
            state = state.merge(Table.SESSIONS, listOf(session("w$i", started = "2026-10-${day}T10:00:00Z"))).first
            state = state.merge(Table.SETS, listOf(set("s$i", "w$i", done = "2026-10-${day}T10:10:00Z"))).first
        }
        state = state.save(state.sets.getValue("s0").copy(updatedAt = "2026-10-04T00:00:00Z"))   // unsynced
        state = state.merge(Table.SESSIONS, listOf(session("open", started = "2026-10-05T10:00:00Z", ended = null))).first
        state = state.merge(Table.SETS, listOf(set("planned", "open"))).first

        // s0 is the oldest outing and would go — but it is waiting to sync.
        assertEquals(setOf("s0", "s1", "s2", "planned"), state.compact().sets.keys)
    }

    @Test fun `a warm-up or an unticked set is not an outing`() {
        var state = State()
        state = state.merge(Table.SESSIONS, listOf(
            session("old", started = "2026-10-01T10:00:00Z"),
            session("mid", started = "2026-10-02T10:00:00Z"),
            session("new", started = "2026-10-03T10:00:00Z"),
        )).first
        state = state.merge(Table.SETS, listOf(
            set("real-old", "old", done = "2026-10-01T10:10:00Z"),
            set("real-mid", "mid", done = "2026-10-02T10:10:00Z"),
            set("warm-new", "new", done = "2026-10-03T10:10:00Z", warmup = true),
        )).first

        val kept = state.compact().sets.keys
        assertTrue("the two real outings survive", "real-old" in kept && "real-mid" in kept)
        assertFalse(state.compact().sets.containsKey("warm-new"))
    }

    @Test fun `each exercise keeps its own last two outings, warm-ups included`() {
        var state = State()
        state = state.merge(Table.SESSIONS, listOf(
            session("d1", started = "2026-10-01T10:00:00Z"),
            session("d2", started = "2026-10-02T10:00:00Z"),
            session("d3", started = "2026-10-03T10:00:00Z"),
        )).first
        state = state.merge(Table.SETS, listOf(
            set("bench-1", "d1", done = "2026-10-01T10:10:00Z"),
            set("bench-2", "d2", done = "2026-10-02T10:10:00Z"),
            set("bench-2w", "d2", done = "2026-10-02T10:05:00Z", warmup = true),
            set("bench-3", "d3", done = "2026-10-03T10:10:00Z"),
            // Rows only on the first day: still its two most recent.
            set("row-1", "d1", exercise = "row", name = "Row", done = "2026-10-01T10:20:00Z"),
        )).first

        assertEquals(setOf("bench-2", "bench-2w", "bench-3", "row-1"), state.compact().sets.keys)
    }

    // The watch saves its whole state file only when the state changes, and most
    // syncs pull back exactly what it already has. Those must come out equal.
    @Test fun `pulling back what is already here, and compacting again, change nothing`() {
        var state = State()
        val sessions = listOf(session("d1", started = "2026-10-01T10:00:00Z"))
        val sets = listOf(set("s1", "d1", done = "2026-10-01T10:10:00Z"))
        state = state.merge(Table.SESSIONS, sessions).first
        state = state.merge(Table.SETS, sets).first.compact()

        val again = state.merge(Table.SESSIONS, sessions).first.merge(Table.SETS, sets).first.compact()
        assertEquals(state, again)
    }
}
