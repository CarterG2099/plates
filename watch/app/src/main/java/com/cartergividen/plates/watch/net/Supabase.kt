package com.cartergividen.plates.watch.net

import com.cartergividen.plates.watch.data.PlatesJson
import com.cartergividen.plates.watch.data.Table
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The real server: PostgREST and Supabase Auth over plain HTTP.
 *
 * The URL and publishable key are the same public pair docs/js/supabase.js
 * ships. They grant only what RLS allows; the watch's own session is what makes
 * it you.
 */
class Supabase(
    private val baseUrl: String = "https://hyxttezhchkihuubyprb.supabase.co",
    private val apiKey: String = "sb_publishable_NEfan_kNLH9aZ87Dh5JCWw_WHC0zqkN",
) : Remote {

    class HttpError(val status: Int, message: String) : Exception(message)

    override suspend fun redeem(code: String): Session {
        val body = buildJsonObject {
            put("action", "redeem")
            put("code", code)
        }
        val reply = request("POST", "/functions/v1/watch-pair", body = body).jsonObject
        // The function answers 200 with an `error` that says what to do next.
        reply["error"]?.jsonPrimitive?.content?.let { throw Exception(it) }
        return Session(
            email = reply.getValue("email").jsonPrimitive.content,
            accessToken = reply.getValue("access_token").jsonPrimitive.content,
            refreshToken = reply.getValue("refresh_token").jsonPrimitive.content,
            expiresAt = reply.getValue("expires_at").jsonPrimitive.long,
        )
    }

    override suspend fun refresh(refreshToken: String): Session {
        val body = buildJsonObject { put("refresh_token", refreshToken) }
        val reply = request("POST", "/auth/v1/token?grant_type=refresh_token", body = body).jsonObject
        return Session(
            email = reply.getValue("user").jsonObject.getValue("email").jsonPrimitive.content,
            accessToken = reply.getValue("access_token").jsonPrimitive.content,
            refreshToken = reply.getValue("refresh_token").jsonPrimitive.content,
            expiresAt = reply.getValue("expires_at").jsonPrimitive.long,
        )
    }

    override suspend fun upsert(token: String, table: Table, rows: List<JsonElement>) {
        if (rows.isEmpty()) return
        request(
            "POST", "/rest/v1/${table.path}?on_conflict=id",
            token = token,
            body = JsonArray(rows),
            headers = mapOf(
                "Content-Profile" to "plates",
                "Prefer" to "resolution=merge-duplicates,return=minimal",
            ),
        )
    }

    override suspend fun changedSince(
        token: String, email: String, table: Table, since: String?, offset: Int, limit: Int,
    ): List<JsonElement> {
        val query = buildList {
            add("select=${enc(table.columns)}")
            // RLS also shows the other half of the household's rows; the watch
            // only works with yours. The exercise library is shared plus your own.
            add(
                if (table == Table.EXERCISES) "or=${enc("(owner_email.is.null,owner_email.eq.$email)")}"
                else "owner_email=eq.${enc(email)}",
            )
            if (since != null) add("updated_at=gte.${enc(since)}")
            add("order=updated_at.asc")
            add("offset=$offset")
            add("limit=$limit")
        }.joinToString("&")

        return request(
            "GET", "/rest/v1/${table.path}?$query",
            token = token,
            headers = mapOf("Accept-Profile" to "plates"),
        ).jsonArray
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private suspend fun request(
        method: String,
        path: String,
        token: String? = null,
        body: JsonElement? = null,
        headers: Map<String, String> = emptyMap(),
    ): JsonElement = withContext(Dispatchers.IO) {
        val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("apikey", apiKey)
            // A publishable key is not a JWT, so it never rides as a Bearer:
            // signed-out calls send the apikey alone.
            if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(PlatesJson.encodeToString(JsonElement.serializer(), body).toByteArray()) }
            }

            val status = conn.responseCode
            val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw HttpError(status, "Server said $status: ${text.take(200)}")
            if (text.isBlank()) JsonObject(emptyMap()) else PlatesJson.parseToJsonElement(text)
        } finally {
            conn.disconnect()
        }
    }
}
