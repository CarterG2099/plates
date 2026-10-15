package com.cartergividen.plates.watch.logic

import com.cartergividen.plates.watch.data.SessionRow
import com.cartergividen.plates.watch.data.SetRow
import com.cartergividen.plates.watch.data.State

/** The one set on screen, with the numbers it will be ticked with. */
data class SetScreen(
    val set: SetRow,
    val number: Int,
    val ofExercise: Int,
    /** Typed on the phone, else last time's — what ticking untouched records. */
    val weightLb: Double?,
    val reps: Int?,
    /** "135 × 8" — that set last time, or null the first time. */
    val lastTime: String?,
    /** Already ticked: opened from the overview to fix its numbers. */
    val done: Boolean = false,
)

/** One row of the overview. */
data class OverviewSet(
    val set: SetRow,
    /** "140 × 8": what you did, or for an open set what ticking it would record. */
    val label: String,
    val done: Boolean,
    val canOpen: Boolean,
    val current: Boolean,
)

data class OverviewGroup(val name: String, val sets: List<OverviewSet>)

/**
 * The numbers a set would be ticked with, and last time's line: its own if the
 * phone typed them, else that set last time, else the one just done this session.
 */
private fun numbersFor(state: State, email: String, sets: List<SetRow>, set: SetRow): Triple<Double?, Int?, String?> {
    val position = Workout.positionInExercise(sets, set)
    val placeholder = Workout.placeholder(Workout.previous(state, email, set), position)
    val fallback = placeholder ?: Workout.earlierThisSession(sets, set)
    return Triple(
        set.weightLb ?: fallback?.weightLb,
        set.reps ?: fallback?.reps,
        placeholder?.let { "${Workout.weightLabel(it.weightLb)} × ${it.reps ?: "—"}" },
    )
}

/** Every set of the open workout, by exercise in the order they come. */
fun overview(state: State, email: String, focus: String? = null): List<OverviewGroup>? {
    val session = Workout.activeSession(state, email) ?: return null
    val sets = Workout.setsFor(state, session.id)
    val current = Workout.currentSet(state, sets, focus)

    return sets.groupBy { it.exerciseKey }.values.map { group ->
        OverviewGroup(
            name = group.first().exerciseName,
            sets = group.map { set ->
                val (weight, reps, _) = numbersFor(state, email, sets, set)
                OverviewSet(
                    set = set,
                    label = "${Workout.weightLabel(weight)} × ${reps ?: "—"}",
                    done = set.completedAt != null,
                    canOpen = Workout.canOpen(state, set),
                    current = set.id == current?.id,
                )
            },
        )
    }
}

data class WorkoutScreen(
    val session: SessionRow,
    val current: SetScreen?,
    val done: Int,
    val total: Int,
    val cardioLeft: Int,
    val lastActivity: String?,
    val lastTicked: SetRow?,
    /** The set "one more" copies when the plan runs out. */
    val lastSet: SetRow?,
)

/** Everything the workout screen shows, worked out from state alone. */
fun workoutScreen(state: State, email: String, focus: String? = null): WorkoutScreen? {
    val session = Workout.activeSession(state, email) ?: return null
    val sets = Workout.setsFor(state, session.id)
    val current = Workout.currentSet(state, sets, focus)

    val screen = current?.let { set ->
        val (weight, reps, lastTime) = numbersFor(state, email, sets, set)
        SetScreen(
            set = set,
            number = Workout.positionInExercise(sets, set) + 1,
            ofExercise = sets.count { it.exerciseKey == set.exerciseKey },
            weightLb = weight,
            reps = reps,
            lastTime = lastTime,
            done = set.completedAt != null,
        )
    }

    return WorkoutScreen(
        session = session,
        current = screen,
        done = sets.count { it.completedAt != null },
        total = sets.size,
        cardioLeft = Workout.cardioLeft(state, sets),
        lastActivity = Workout.lastActivity(sets),
        lastTicked = Workout.lastTicked(sets),
        lastSet = sets.lastOrNull { !Workout.isCardio(state.exercises[it.exerciseId], it.exerciseName) },
    )
}

/** Eight digits typed on a keypad, nothing else accepted. */
data class CodeEntry(val digits: String = "") {
    val complete: Boolean get() = digits.length == LENGTH

    fun press(digit: Int): CodeEntry =
        if (complete || digit !in 0..9) this else CodeEntry(digits + digit)

    fun back(): CodeEntry = CodeEntry(digits.dropLast(1))

    /** "4815 16__" — the same two halves the phone shows. */
    val shown: String
        get() = digits.padEnd(LENGTH, '_').let { "${it.take(4)} ${it.drop(4)}" }

    companion object {
        const val LENGTH = 8
    }
}
