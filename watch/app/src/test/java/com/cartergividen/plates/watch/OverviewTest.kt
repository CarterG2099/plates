package com.cartergividen.plates.watch

import com.cartergividen.plates.watch.data.ExerciseRow
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.data.Table
import com.cartergividen.plates.watch.logic.Workout
import com.cartergividen.plates.watch.logic.overview
import com.cartergividen.plates.watch.logic.workoutScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Jumping to any set, and where the auto-advance goes after you do. */
class OverviewTest {
    private val t = "2026-10-15T10:00:00Z"

    /** Bench ×3 (first ticked), lat ×2, a run, with last week's bench for the labels. */
    private fun workout(): State {
        var s = State(exercises = mapOf("run" to ExerciseRow(id = "run", name = "Treadmill", category = "cardio", updatedAt = t)))
        s = s.merge(Table.SESSIONS, listOf(
            session("last", started = "2026-10-08T10:00:00Z"),
            session("now", started = "2026-10-15T10:00:00Z", ended = null),
        )).first
        s = s.merge(Table.SETS, listOf(
            set("h1", "last", index = 0, weight = 135.0, reps = 8, done = "2026-10-08T10:05:00Z"),
            set("h2", "last", index = 1, weight = 140.0, reps = 6, done = "2026-10-08T10:09:00Z"),
            set("b1", "now", index = 0, weight = 140.0, reps = 8, done = "2026-10-15T10:05:00Z"),
            set("b2", "now", index = 1),
            set("b3", "now", index = 2),
            set("l1", "now", exercise = "lat", name = "Lat Pulldown", index = 3),
            set("l2", "now", exercise = "lat", name = "Lat Pulldown", index = 4),
            set("r1", "now", exercise = "run", name = "Treadmill", index = 5),
        )).first
        return s
    }

    @Test fun `the overview groups sets by exercise, in workout order`() {
        val groups = overview(workout(), ME)!!
        assertEquals(listOf("Bench Press", "Lat Pulldown", "Treadmill"), groups.map { it.name })
        assertEquals(listOf("b1", "b2", "b3"), groups[0].sets.map { it.set.id })
    }

    @Test fun `a ticked set shows what you did, an open one what it will be`() {
        val bench = overview(workout(), ME)!![0].sets
        assertEquals("140 × 8", bench[0].label)
        assertTrue(bench[0].done)
        assertEquals("last week's second set", "140 × 6", bench[1].label)
        assertFalse(bench[1].done)
        assertEquals("past last week's sets, the last one repeats", "140 × 6", bench[2].label)
    }

    @Test fun `with nothing to go on a set reads as blank`() {
        val lat = overview(workout(), ME)!![1].sets
        assertEquals("— × —", lat[0].label)
    }

    @Test fun `cardio is listed but can't be opened`() {
        val run = overview(workout(), ME)!![2].sets.single()
        assertFalse(run.canOpen)
        assertTrue(overview(workout(), ME)!![0].sets.all { it.canOpen })
    }

    @Test fun `the set on screen is marked in the overview`() {
        val marked = overview(workout(), ME, focus = "l2")!!.flatMap { it.sets }.filter { it.current }
        assertEquals(listOf("l2"), marked.map { it.set.id })
    }

    // ---- jumping --------------------------------------------------------------------

    @Test fun `with no jump, the screen is the first open set`() {
        assertEquals("b2", workoutScreen(workout(), ME)!!.current!!.set.id)
    }

    @Test fun `a jump puts that set on screen`() {
        assertEquals("l1", workoutScreen(workout(), ME, focus = "l1")!!.current!!.set.id)
    }

    @Test fun `jumping to a ticked set opens it for fixing, with what was saved`() {
        val current = workoutScreen(workout(), ME, focus = "b1")!!.current!!
        assertEquals("b1", current.set.id)
        assertTrue(current.done)
        assertEquals(140.0, current.weightLb)
        assertEquals(8, current.reps)
    }

    @Test fun `a jump to something that is gone or is cardio falls back to the next open set`() {
        assertEquals("b2", workoutScreen(workout(), ME, focus = "nope")!!.current!!.set.id)
        assertEquals("b2", workoutScreen(workout(), ME, focus = "r1")!!.current!!.set.id)
    }

    // ---- where the tick goes next -------------------------------------------------------

    @Test fun `after a tick, the next set of the same exercise`() {
        val state = workout()
        val sets = Workout.setsFor(state, "now").map { if (it.id == "l1") it.copy(completedAt = t) else it }
        assertEquals("stays on lat even though bench is unfinished", "l2",
            Workout.nextAfterTick(state, sets, sets.first { it.id == "l1" }))
    }

    @Test fun `when that exercise is done, back to the first open set anywhere`() {
        val state = workout()
        val sets = Workout.setsFor(state, "now").map { if (it.id.startsWith("l")) it.copy(completedAt = t) else it }
        assertNull("null means: the first open set", Workout.nextAfterTick(state, sets, sets.first { it.id == "l2" }))
        assertEquals("b2", Workout.currentSet(state, sets)!!.id)
    }

    @Test fun `an earlier skipped set of the same exercise is picked up after the later ones`() {
        val state = workout()
        // Jumped to b3 and ticked it, leaving b2 open.
        val sets = Workout.setsFor(state, "now").map { if (it.id == "b3") it.copy(completedAt = t) else it }
        assertEquals("b2", Workout.nextAfterTick(state, sets, sets.first { it.id == "b3" }))
    }
}
