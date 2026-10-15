package com.cartergividen.plates.watch

import com.cartergividen.plates.watch.data.SessionRow
import com.cartergividen.plates.watch.data.SetRow

const val ME = "c@x.com"
const val THEM = "a@x.com"

fun session(
    id: String,
    started: String = "2026-10-01T10:00:00Z",
    ended: String? = "2026-10-01T11:00:00Z",
    owner: String = ME,
    updated: String = started,
) = SessionRow(id = id, ownerEmail = owner, name = id, startedAt = started, endedAt = ended, updatedAt = updated)

fun set(
    id: String,
    session: String,
    exercise: String? = "bench",
    name: String = "Bench Press",
    index: Int = 0,
    weight: Double? = null,
    reps: Int? = null,
    done: String? = null,
    warmup: Boolean = false,
    updated: String = "2026-10-01T10:00:00Z",
) = SetRow(
    id = id, ownerEmail = ME, sessionId = session, exerciseId = exercise, exerciseName = name,
    setIndex = index, weightLb = weight, reps = reps, isWarmup = warmup, completedAt = done, updatedAt = updated,
)
