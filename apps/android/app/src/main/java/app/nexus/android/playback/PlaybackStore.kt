package app.nexus.android.playback

import android.content.Context
import androidx.core.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.UUID

/**
 * One account's atomic playback envelope. Queue/cursor, recorder writes, retained
 * descriptors and the occurrence checkpoint commit together. Activity and audio
 * files retain their existing owners. Nothing in this file grants autoplay.
 * All access belongs to the playback service's main thread.
 */
internal class PlaybackStore(context: Context, val accountId: UUID) {
    private val file = AtomicFile(File(context.filesDir, "player/accounts/$accountId.json"))
    var value: JSONObject = try {
        JSONObject(String(file.readFully(), Charsets.UTF_8)).also {
            require(it.getString("account_id") == accountId.toString())
            validateQueue(it.getJSONObject("queue"))
        }
    } catch (_: FileNotFoundException) {
        // justify-ignore-error: a first account binding starts with an empty queue.
        JSONObject().put("account_id", accountId.toString())
            .put("queue", JSONObject().put("queue_id", UUID.randomUUID().toString())
                .put("revision", 1L).put("entries", JSONArray())
                .put("current_entry_id", JSONObject.NULL).put("source", JSONObject.NULL))
            .put("lane", JSONArray()).put("descriptors", JSONObject())
            .put("checkpoint", JSONObject.NULL)
    }
        private set

    val queue: JSONObject get() = value.getJSONObject("queue")

    /** Publish only after a verified atomic replace; failure leaves the previous envelope authoritative. */
    fun update(change: (JSONObject) -> Unit) {
        val next = JSONObject(value.toString())
        change(next)
        val bytes = next.toString().toByteArray(Charsets.UTF_8)
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(bytes)
            stream.fd.sync()
            file.finishWrite(stream)
            if (!file.readFully().contentEquals(bytes)) throw IOException("playback envelope was not replaced")
        } catch (error: IOException) {
            stream?.let(file::failWrite)
            throw error
        }
        value = next
    }

    fun header(): JSONObject {
        val queue = queue
        val entries = queue.getJSONArray("entries")
        val current = queue.nullableString("current_entry_id")
        val index = (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == current }
        return JSONObject().put("queue_id", queue.getString("queue_id"))
            .put("revision", queue.getLong("revision").toString())
            .put("current_entry_id", current ?: JSONObject.NULL)
            .put("current_entry", index?.let(entries::getJSONObject) ?: JSONObject.NULL)
            .put("current_index", index ?: JSONObject.NULL).put("count", entries.length())
            .put("source", queue.get("source")).put("can_restore", false)
    }

    fun descriptor(mediaId: UUID): JSONObject? = value.getJSONObject("descriptors")
        .optJSONObject(mediaId.toString())?.let { JSONObject(it.toString()) }

    companion object {
        const val MAX_ENTRIES = 10_000
        const val MESSAGE_BYTES = 32 * 1024

        /** Current account filenames, including AtomicFile's recoverable backup, constrain first provisioning. */
        fun cachedAccounts(context: Context): Set<UUID> {
            val directory = File(context.filesDir, "player/accounts")
            if (!directory.exists()) return emptySet()
            val files = directory.listFiles() ?: throw IOException("saved playback accounts could not be read")
            return files.mapNotNull { file ->
                when {
                    file.name.endsWith(".json.bak") -> UUID.fromString(file.name.removeSuffix(".json.bak"))
                    file.name.endsWith(".json") -> UUID.fromString(file.name.removeSuffix(".json"))
                    else -> null
                }
            }.toSet()
        }

        fun validateEntry(entry: JSONObject) {
            require(entry.length() == 2)
            UUID.fromString(entry.getString("id"))
            UUID.fromString(entry.getString("media_id"))
        }

        fun validateSource(source: JSONObject?) {
            if (source == null) return
            require(source.toString().toByteArray(Charsets.UTF_8).size <= 8 * 1024)
            val kind = source.getString("kind")
            require(kind in setOf("Lectern", "Library", "Podcast"))
            source.getString("label")
            source.getString("query")
            when (kind) {
                "Lectern" -> require(source.nullableString("sort") in setOf(null, "added_asc", "added_desc", "title_asc", "title_desc"))
                "Library" -> {
                    UUID.fromString(source.getString("library_id"))
                    require(source.nullableString("sort") in setOf(null, "title_asc", "title_desc", "creator_asc", "creator_desc", "published_asc", "published_desc", "remaining_asc", "remaining_desc", "added_asc", "added_desc"))
                    require(source.nullableString("projection") in setOf(null, "unfiled", "in_progress"))
                    require(source.nullableString("completion") in setOf(null, "unfinished"))
                    require(source.nullableString("entry_type") in setOf(null, "web_article", "epub", "pdf", "video", "podcast_episode"))
                }
                "Podcast" -> {
                    UUID.fromString(source.getString("podcast_id"))
                    require(source.getString("state") in setOf("all", "unplayed", "in_progress", "played"))
                    require(source.getString("sort") in setOf("newest", "oldest", "duration_asc", "duration_desc"))
                }
            }
        }

        fun validateQueue(queue: JSONObject) {
            UUID.fromString(queue.getString("queue_id"))
            val entries = queue.getJSONArray("entries")
            require(entries.length() <= MAX_ENTRIES)
            val ids = HashSet<String>()
            for (index in 0 until entries.length()) {
                val entry = entries.getJSONObject(index)
                validateEntry(entry)
                require(ids.add(entry.getString("id")))
            }
            val current = queue.nullableString("current_entry_id")
            require(current == null || current in ids)
            validateSource(queue.optJSONObject("source"))
        }
    }
}

internal fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else getString(key)
