package com.cartergividen.plates.watch.net

import com.cartergividen.plates.watch.data.Table
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** What a successful pairing or refresh hands back: the watch's own session. */
@Serializable
data class Session(
    val email: String,
    val accessToken: String,
    val refreshToken: String,
    /** Unix seconds, as Supabase reports it. */
    val expiresAt: Long,
)

/**
 * Everything the watch asks of the server. An interface so [com.cartergividen
 * .plates.watch.logic.Syncer] can be tested against a fake — the merge and
 * dequeue rules are where a lost set would come from, not the HTTP.
 */
interface Remote {
    /** Trade a pairing code from the phone for a session. Throws with the server's explanation. */
    suspend fun redeem(code: String): Session

    suspend fun refresh(refreshToken: String): Session

    /** Upsert rows on id. Partial rows are fine: unsent columns are left as they are. */
    suspend fun upsert(token: String, table: Table, rows: List<JsonElement>)

    /**
     * One page of the account's rows in a table changed at or after [since],
     * oldest first. Inclusive, like the phone's cursor, so a row stamped in the
     * same instant as the boundary is never skipped.
     */
    suspend fun changedSince(token: String, email: String, table: Table, since: String?, offset: Int, limit: Int): List<JsonElement>
}
