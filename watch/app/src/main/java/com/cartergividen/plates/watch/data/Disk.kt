package com.cartergividen.plates.watch.data

import com.cartergividen.plates.watch.net.Session
import kotlinx.serialization.KSerializer
import java.io.File

/**
 * Two files in the app's private storage: the state, and the session.
 *
 * Written to a temp file and renamed into place, so a watch that dies mid-write
 * keeps the previous good copy rather than half a JSON document — the outbox
 * lives in that file, and losing it is losing sets.
 */
class Disk(private val dir: File) {
    fun loadState(): State = read("state.json", State.serializer()) ?: State()
    fun saveState(state: State) = write("state.json", State.serializer(), state)

    fun loadSession(): Session? = read("session.json", Session.serializer())
    fun saveSession(session: Session?) {
        if (session == null) File(dir, "session.json").delete()
        else write("session.json", Session.serializer(), session)
    }

    private fun <T> read(name: String, serializer: KSerializer<T>): T? {
        val file = File(dir, name)
        if (!file.exists()) return null
        return try {
            PlatesJson.decodeFromString(serializer, file.readText())
        } catch (e: Exception) {
            // Unreadable (an older app version's shape, say). Set aside rather
            // than deleted, so a lost outbox can still be dug out by hand, and
            // start clean rather than crash on every launch.
            file.renameTo(File(dir, "$name.bad"))
            null
        }
    }

    private fun <T> write(name: String, serializer: KSerializer<T>, value: T) {
        val tmp = File(dir, "$name.tmp")
        tmp.writeText(PlatesJson.encodeToString(serializer, value))
        if (!tmp.renameTo(File(dir, name))) error("Couldn't save $name")
    }
}
