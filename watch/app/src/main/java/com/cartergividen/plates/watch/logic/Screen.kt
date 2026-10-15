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
)

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
fun workoutScreen(state: State, email: String): WorkoutScreen? {
    val session = Workout.activeSession(state, email) ?: return null
    val sets = Workout.setsFor(state, session.id)
    val current = Workout.currentSet(state, sets)

    val screen = current?.let { set ->
        val same = sets.filter { it.exerciseKey == set.exerciseKey }
        val position = Workout.positionInExercise(sets, set)
        val placeholder = Workout.placeholder(Workout.previous(state, email, set), position)
        SetScreen(
            set = set,
            number = position + 1,
            ofExercise = same.size,
            weightLb = set.weightLb ?: placeholder?.weightLb,
            reps = set.reps ?: placeholder?.reps,
            lastTime = placeholder?.let { "${Workout.weightLabel(it.weightLb)} × ${it.reps ?: "—"}" },
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
