package com.cartergividen.plates.watch.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The rows the watch reads and writes, named exactly as the `plates` tables name
 * their columns.
 *
 * Only the columns the watch uses. That is safe for writes as well as reads: an
 * upsert updates the columns it is sent and leaves the rest alone, so a set the
 * phone gave an RPE keeps it when the watch ticks it. The `select` lists in
 * [Tables] ask for exactly these, which keeps a first sync small.
 *
 * Timestamps stay as the ISO strings Postgres sends. They are compared through
 * [Stamp], never as strings: the server writes "+00:00" and the phone writes
 * "Z", and those do not sort together.
 */

interface Row {
    val id: String
    val updatedAt: String
    val deletedAt: String?
}

@Serializable
data class SessionRow(
    override val id: String,
    @SerialName("owner_email") val ownerEmail: String,
    @SerialName("routine_id") val routineId: String? = null,
    val name: String? = null,
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("updated_at") override val updatedAt: String,
    @SerialName("deleted_at") override val deletedAt: String? = null,
) : Row

@Serializable
data class SetRow(
    override val id: String,
    @SerialName("owner_email") val ownerEmail: String,
    @SerialName("session_id") val sessionId: String,
    @SerialName("exercise_id") val exerciseId: String? = null,
    @SerialName("exercise_name") val exerciseName: String,
    @SerialName("set_index") val setIndex: Int = 0,
    @SerialName("weight_lb") val weightLb: Double? = null,
    val reps: Int? = null,
    @SerialName("is_warmup") val isWarmup: Boolean = false,
    @SerialName("completed_at") val completedAt: String? = null,
    @SerialName("distance_m") val distanceM: Double? = null,
    @SerialName("duration_s") val durationS: Int? = null,
    @SerialName("updated_at") override val updatedAt: String,
    @SerialName("deleted_at") override val deletedAt: String? = null,
) : Row {
    /** What groups sets into one exercise, the same key the phone uses. */
    val exerciseKey: String get() = exerciseId ?: exerciseName
}

@Serializable
data class RoutineRow(
    override val id: String,
    @SerialName("owner_email") val ownerEmail: String,
    val name: String,
    val position: Int = 0,
    @SerialName("updated_at") override val updatedAt: String,
    @SerialName("deleted_at") override val deletedAt: String? = null,
) : Row

@Serializable
data class RoutineExerciseRow(
    override val id: String,
    @SerialName("owner_email") val ownerEmail: String,
    @SerialName("routine_id") val routineId: String,
    @SerialName("exercise_id") val exerciseId: String? = null,
    val position: Int = 0,
    @SerialName("target_sets") val targetSets: Int? = null,
    val notes: String? = null,
    @SerialName("updated_at") override val updatedAt: String,
    @SerialName("deleted_at") override val deletedAt: String? = null,
) : Row

@Serializable
data class ExerciseRow(
    override val id: String,
    @SerialName("owner_email") val ownerEmail: String? = null,
    val name: String,
    val category: String? = null,
    @SerialName("updated_at") override val updatedAt: String,
    @SerialName("deleted_at") override val deletedAt: String? = null,
) : Row

/** One JSON configuration for the store file and the network alike. */
val PlatesJson = Json {
    ignoreUnknownKeys = true
    // Nulls are sent, not skipped: un-ticking a set is completed_at going back
    // to null, and an omitted key would leave the server's tick in place.
    explicitNulls = true
    encodeDefaults = true
}
