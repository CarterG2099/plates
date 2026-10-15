package com.cartergividen.plates.watch

import com.cartergividen.plates.watch.data.ExerciseRow
import com.cartergividen.plates.watch.data.RoutineExerciseRow
import com.cartergividen.plates.watch.data.RoutineRow
import com.cartergividen.plates.watch.data.State
import com.cartergividen.plates.watch.logic.CodeEntry
import com.cartergividen.plates.watch.logic.Workout
import com.cartergividen.plates.watch.logic.workoutScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkoutTest {
    private val t = "2026-10-14T18:00:00Z"
    private var ids = 0
    private fun id() = "id${ids++}"

    private fun routineState(): Pair<State, RoutineRow> {
        val routine = RoutineRow(id = "push", ownerEmail = ME, name = "Push A", updatedAt = t)
        val state = State(
            routines = mapOf("push" to routine),
            exercises = mapOf("bench" to ExerciseRow(id = "bench", name = "Bench Press", updatedAt = t)),
            routineExercises = mapOf(
                "re2" to RoutineExerciseRow(id = "re2", ownerEmail = ME, routineId = "push", exerciseId = null,
                    position = 1, targetSets = null, notes = "Dips", updatedAt = t),
                "re1" to RoutineExerciseRow(id = "re1", ownerEmail = ME, routineId = "push", exerciseId = "bench",
                    position = 0, targetSets = 4, updatedAt = t),
                "gone" to RoutineExerciseRow(id = "gone", ownerEmail = ME, routineId = "push", exerciseId = "bench",
                    position = 2, targetSets = 1, updatedAt = t, deletedAt = t),
            ),
        )
        return state to routine
    }

    // ---- starting -----------------------------------------------------------------

    @Test fun `a routine opens with its planned sets, in order, empty`() {
        val (state, routine) = routineState()
        val (session, sets) = Workout.startFromRoutine(state, routine, ME, t, ::id)

        assertEquals("Push A", session.name)
        assertEquals("push", session.routineId)
        assertNull(session.endedAt)
        assertEquals(List(4) { "Bench Press" } + List(3) { "Dips" }, sets.map { it.exerciseName })
        assertEquals((0 until 7).toList(), sets.map { it.setIndex })
        assertTrue("empty, so last time's numbers are placeholders", sets.all { it.weightLb == null && it.reps == null })
        assertTrue(sets.all { it.sessionId == session.id && it.completedAt == null })
    }

    @Test fun `a routine exercise without a planned count gets three`() {
        val (state, routine) = routineState()
        val (_, sets) = Workout.startFromRoutine(state, routine, ME, t, ::id)
        assertEquals(Workout.DEFAULT_SETS, sets.count { it.exerciseName == "Dips" })
    }

    // ---- last time ----------------------------------------------------------------------

    private fun history(): State {
        var s = State()
        s = s.merge(com.cartergividen.plates.watch.data.Table.SESSIONS, listOf(
            session("old", started = "2026-10-01T10:00:00Z"),
            session("last", started = "2026-10-08T10:00:00Z"),
            session("now", started = "2026-10-14T10:00:00Z", ended = null),
            session("hers", started = "2026-10-12T10:00:00Z", owner = THEM),
        )).first
        s = s.merge(com.cartergividen.plates.watch.data.Table.SETS, listOf(
            set("o1", "old", index = 0, weight = 125.0, reps = 8, done = "2026-10-01T10:05:00Z"),
            set("lw", "last", index = 0, weight = 95.0, reps = 10, done = "2026-10-08T10:01:00Z", warmup = true),
            set("l1", "last", index = 1, weight = 135.0, reps = 8, done = "2026-10-08T10:05:00Z"),
            set("l2", "last", index = 2, weight = 140.0, reps = 6, done = "2026-10-08T10:09:00Z"),
            set("lx", "last", index = 3, weight = 145.0, reps = null, done = null),
            set("n1", "now", index = 0, done = "2026-10-14T10:05:00Z", weight = 150.0, reps = 5),
            set("n2", "now", index = 1),
            set("n3", "now", index = 2),
            set("n4", "now", index = 3),
        )).first
        return s
    }

    @Test fun `last time is the newest other session, working sets that were ticked`() {
        val state = history()
        val previous = Workout.previous(state, ME, state.sets.getValue("n2"))
        assertEquals(listOf("l1", "l2"), previous.map { it.id })
    }

    @Test fun `a placeholder past what you did last time repeats the last set`() {
        val state = history()
        val previous = Workout.previous(state, ME, state.sets.getValue("n2"))
        assertEquals("l2", Workout.placeholder(previous, 1)!!.id)
        assertEquals("l2", Workout.placeholder(previous, 5)!!.id)
        assertNull(Workout.placeholder(emptyList(), 0))
    }

    @Test fun `an exercise with no id matches history by name`() {
        val state = history().let { s ->
            s.copy(sets = s.sets + ("free" to set("free", "now", exercise = null, name = "Dips", index = 4)) +
                ("dipsBefore" to set("dipsBefore", "last", exercise = null, name = "Dips", index = 4,
                    weight = 0.0, reps = 12, done = "2026-10-08T10:20:00Z")))
        }
        assertEquals(listOf("dipsBefore"), Workout.previous(state, ME, state.sets.getValue("free")).map { it.id })
    }

    // ---- the screen ---------------------------------------------------------------------

    @Test fun `the screen offers the next unticked set with last time's numbers`() {
        val screen = workoutScreen(history(), ME)!!
        val current = screen.current!!

        assertEquals("n2", current.set.id)
        assertEquals(2, current.number)
        assertEquals(4, current.ofExercise)
        assertEquals(140.0, current.weightLb)     // last time's set 2
        assertEquals(6, current.reps)
        assertEquals("140 × 6", current.lastTime)
        assertEquals(1, screen.done)
        assertEquals(4, screen.total)
    }

    @Test fun `numbers typed on the phone beat last time's`() {
        val state = history().let { s -> s.copy(sets = s.sets + ("n2" to s.sets.getValue("n2").copy(weightLb = 155.0))) }
        val current = workoutScreen(state, ME)!!.current!!
        assertEquals(155.0, current.weightLb)
        assertEquals("reps still fall back", 6, current.reps)
    }

    @Test fun `cardio is skipped and counted for the phone`() {
        val state = history().let { s ->
            s.copy(
                exercises = s.exercises + ("run" to ExerciseRow(id = "run", name = "Treadmill", category = "cardio", updatedAt = t)),
                sets = s.sets + ("r1" to set("r1", "now", exercise = "run", name = "Treadmill", index = 1)) +
                    ("n2" to s.sets.getValue("n2").copy(setIndex = 2)),
            )
        }
        val screen = workoutScreen(state, ME)!!
        assertEquals("n2", screen.current!!.set.id)
        assertEquals(1, screen.cardioLeft)
    }

    @Test fun `cardio by name matches whole names only`() {
        assertTrue(Workout.isCardio(null, "Running"))
        assertFalse("a lunge is not a walk", Workout.isCardio(null, "Walking Lunge"))
    }

    @Test fun `no screen without an open workout of yours`() {
        val state = history().let { s -> s.copy(sessions = s.sessions - "now") }
        assertNull(workoutScreen(state, ME))
    }

    // ---- ticking and finishing -------------------------------------------------------------

    @Test fun `ticking records the numbers on screen, unticking keeps them`() {
        val set = set("n2", "now")
        val done = Workout.complete(set, 140.0, 6, "2026-10-14T10:08:00Z")
        assertEquals(140.0, done.weightLb)
        assertEquals(6, done.reps)
        assertEquals("2026-10-14T10:08:00Z", done.completedAt)
        assertEquals("2026-10-14T10:08:00Z", done.updatedAt)

        val undone = Workout.undo(done, "2026-10-14T10:09:00Z")
        assertNull(undone.completedAt)
        assertEquals(140.0, undone.weightLb)
    }

    @Test fun `one more set goes on the end, empty`() {
        val state = history()
        val sets = Workout.setsFor(state, "now")
        val more = Workout.oneMore(sets.last(), sets, t, ::id)
        assertEquals(4, more.setIndex)
        assertNull(more.completedAt)
        assertNull(more.weightLb)
        assertEquals("Bench Press", more.exerciseName)
    }

    @Test fun `a workout never ends before it began`() {
        val s = session("w", started = "2026-10-14T10:00:00Z", ended = null)
        assertEquals("2026-10-14T10:00:00Z", Workout.finish(s, "2026-10-14T09:00:00Z").endedAt)
        assertEquals("2026-10-14T11:00:00Z", Workout.finish(s, "2026-10-14T11:00:00Z").endedAt)
    }

    @Test fun `steppers move by five pounds and one rep, never below zero`() {
        assertEquals(140.0, Workout.stepWeight(135.0, 1), 0.0)
        assertEquals(0.0, Workout.stepWeight(2.5, -1), 0.0)
        assertEquals(5.0, Workout.stepWeight(null, 1), 0.0)
        assertEquals(0, Workout.stepReps(0, -1))
        assertEquals("135", Workout.weightLabel(135.0))
        assertEquals("132.5", Workout.weightLabel(132.5))
    }

    // ---- the pairing keypad -----------------------------------------------------------

    @Test fun `the keypad takes eight digits and no more`() {
        var entry = CodeEntry()
        for (d in listOf(4, 8, 1, 5, 1, 6, 2, 3, 9)) entry = entry.press(d)
        assertEquals("48151623", entry.digits)
        assertTrue(entry.complete)
        assertEquals("4815 1623", entry.shown)
        assertEquals("4815 162_", entry.back().shown)
        assertEquals("", CodeEntry().back().digits)
    }
}
