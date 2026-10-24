package app.nexus.android.playback

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
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
 * Mutations are serialized with the fixed-route reader; no lock crosses networking.
 */
internal class PlaybackStore private constructor(context: Context, val accountId: UUID) {
    private val file = AtomicFile(File(context.filesDir, "player/accounts/$accountId.json"))
    @Volatile var value: JSONObject = try {
        JSONObject(String(file.readFully(), Charsets.UTF_8)).also {
            require(it.getString("account_id") == accountId.toString())
            validateQueue(it.getJSONObject("queue"))
        }
    } catch (error: FileNotFoundException) {
        if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()) throw error
        // justify-ignore-error: a first account binding starts with an empty queue.
        JSONObject().put("account_id", accountId.toString())
            .put("queue", JSONObject().put("queue_id", UUID.randomUUID().toString())
                .put("revision", 1L).put("entries", JSONArray())
                .put("current_entry_id", JSONObject.NULL).put("source", JSONObject.NULL))
            .put("lane", JSONArray()).put("descriptors", JSONObject())
            .put("checkpoint", JSONObject.NULL)
    }
        private set
    var onListeningChanged: (() -> Unit)? = null

    init {
        ListeningPublication.nextRevision()
        // One explicit conversion preserves old authored samples, without inventing observations.
        if (!value.has("format_version")) update { envelope ->
            envelope.put("format_version", 1).put("fact_sequence", 0L).put("listening", JSONObject())
            val lane = envelope.getJSONArray("lane")
            for (index in 0 until lane.length()) {
                val fact = lane.getJSONObject(index)
                val sequence = envelope.getLong("fact_sequence") + 1
                envelope.put("fact_sequence", sequence)
                fact.put("sequence", sequence).put("barrier", fact.getBoolean("settle") || threshold(sample(fact)))
                projectFact(envelope, fact)
            }
            val descriptors = envelope.getJSONObject("descriptors")
            for (id in descriptors.keys()) {
                val descriptor = descriptors.getJSONObject(id)
                val listening = descriptor.optJSONObject("local_listening") ?: continue
                val record = record(envelope, id)
                if (record.optJSONObject("local") != null) continue
                val sequence = envelope.getLong("fact_sequence") + 1
                envelope.put("fact_sequence", sequence)
                projectFact(envelope, JSONObject().put("sequence", sequence).put("media_id", id)
                    .put("body", listening).put("settle", false))
                record.getJSONObject("local").put("completed", descriptor.optBoolean("locally_completed") || threshold(listening))
                record.put("ack_sequence", sequence)
            }
        }
        require(value.getInt("format_version") == 1)
        require(value.getLong("fact_sequence") >= 0)
        value.getJSONObject("listening")
    }

    val queue: JSONObject get() = value.getJSONObject("queue")

    /** The disk replace linearizes all writers; readers only see complete immutable envelopes. */
    @Synchronized fun update(change: (JSONObject) -> Unit) {
        val before = if (value.has("listening")) listeningBody(value).toString() else null
        val next = JSONObject(value.toString())
        change(next)
        val bytes = next.toString().toByteArray(Charsets.UTF_8)
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(bytes)
            stream.fd.sync()
            file.finishWrite(stream)
            try {
                val directory = Os.open(checkNotNull(file.baseFile.parent), OsConstants.O_RDONLY, 0)
                try { Os.fsync(directory) } finally { Os.close(directory) }
            } catch (error: ErrnoException) { throw IOException("playback directory was not synced", error) }
            if (!file.readFully().contentEquals(bytes)) throw IOException("playback envelope was not replaced")
        } catch (error: IOException) {
            stream?.let(file::failWrite)
            throw error
        }
        value = next
        if (next.has("listening") && before != listeningBody(next).toString()) {
            ListeningPublication.nextRevision()
            onListeningChanged?.invoke()
        }
    }

    @Synchronized fun listeningBytes(): ByteArray {
        val bytes = listeningBody(value).put("revision", ListeningPublication.revision().toString()).toString().toByteArray(Charsets.UTF_8)
        if (bytes.size > 16 * 1024 * 1024) throw ListeningPublication.Error("E_LISTENING_LIMIT")
        return bytes
    }

    fun record(mediaId: UUID): JSONObject? = value.getJSONObject("listening").optJSONObject(mediaId.toString())
        ?.let { JSONObject(it.toString()) }

    fun observe(observations: List<JSONObject>) {
        observations.forEach(::validateObservation)
        update { envelope -> observations.forEach { adoptObservation(envelope, it) } }
    }

    fun baseline(mediaId: UUID, baseline: JSONObject) {
        val observation = baseline.getJSONObject("observation")
        require(observation.getString("media_id") == mediaId.toString())
        validateObservation(observation)
        update { envelope ->
            adoptObservation(envelope, observation)
            val record = record(envelope, mediaId.toString())
            if (!record.has("playback_rate")) record.put("playback_rate", baseline.getDouble("playback_rate"))
            if (!record.has("pause_shortening_mode")) record.put("pause_shortening_mode", baseline.get("pause_shortening_mode"))
        }
    }

    fun collect(catalogRevision: String?) {
        if (catalogRevision == null) return
        val floor = catalogRevision.toBigInteger()
        update { envelope ->
            val records = envelope.getJSONObject("listening")
            for (id in records.keys()) {
                val record = records.getJSONObject(id)
                val local = record.optJSONObject("local") ?: continue
                val receipt = record.nullableString("ack_revision") ?: continue
                val sequence = local.getString("sequence").toLong()
                if (receipt.toBigInteger() <= floor && sequence <= record.optLong("ack_sequence") &&
                    !facts(envelope).any { it.getString("media_id") == id }) record.put("local", JSONObject.NULL)
            }
        }
    }

    private fun listeningBody(envelope: JSONObject): JSONObject {
        val episodes = JSONArray()
        val records = envelope.getJSONObject("listening")
        for (id in records.keys().asSequence().sorted()) {
            val record = records.getJSONObject(id)
            val local = record.optJSONObject("local")?.takeIf {
                it.getString("sequence").toLong() > record.getLong("ack_sequence")
            }
            episodes.put(JSONObject().put("media_id", id).put("observed", record.get("observed"))
                .put("local", local ?: JSONObject.NULL))
        }
        return JSONObject().put("account_id", accountId.toString()).put("episodes", episodes)
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
        private val stores = mutableMapOf<UUID, PlaybackStore>()
        @Synchronized fun open(context: Context, accountId: UUID): PlaybackStore =
            stores.getOrPut(accountId) { PlaybackStore(context, accountId) }
        @Synchronized fun retire(accountId: UUID) { stores.remove(accountId)?.onListeningChanged = null }

        fun facts(envelope: JSONObject): List<JSONObject> = envelope.getJSONArray("lane").let { lane ->
            (0 until lane.length()).map(lane::getJSONObject)
        }
        fun sample(fact: JSONObject): JSONObject = if (fact.getBoolean("settle"))
            fact.getJSONObject("body").getJSONObject("terminal_listening") else fact.getJSONObject("body")
        fun threshold(sample: JSONObject): Boolean = sample.nullableLong("duration_ms")?.takeIf { it > 0 }
            ?.let { sample.getLong("position_ms").toDouble() / it >= .95 } == true
        fun record(envelope: JSONObject, id: String): JSONObject {
            val records = envelope.getJSONObject("listening")
            return records.optJSONObject(id) ?: JSONObject().put("observed", JSONObject.NULL)
                .put("local", JSONObject.NULL).put("ack_sequence", 0L).put("ack_revision", JSONObject.NULL)
                .put("source_unavailable", false).also { records.put(id, it) }
        }
        fun projectFact(envelope: JSONObject, fact: JSONObject) {
            val record = record(envelope, fact.getString("media_id"))
            val listening = sample(fact)
            val state = record.optJSONObject("observed")?.getJSONObject("state")
            val previous = record.optJSONObject("local")
            val epoch = listening.getLong("expected_reset_epoch")
            val completed = (previous?.takeIf { it.getLong("reset_epoch") == epoch }?.getBoolean("completed") == true) ||
                state?.nullableString("consumption_override_status") == "finished" || threshold(listening) || fact.getBoolean("settle")
            record.put("local", JSONObject().put("sequence", fact.getLong("sequence").toString())
                .put("reset_epoch", epoch).put("position_ms", listening.getLong("position_ms"))
                .put("duration_ms", listening.get("duration_ms")).put("completed", completed)
                .put("terminal", facts(envelope).lastOrNull {
                    it.getString("media_id") == fact.getString("media_id") && it.getBoolean("settle") &&
                        sample(it).getLong("expected_reset_epoch") == epoch
                }?.let { JSONObject().put("expected_override_revision", it.getJSONObject("body").get("expected_override_revision")) } ?: JSONObject.NULL)
                .put("disposition", if (record.getBoolean("source_unavailable")) "SourceUnavailable" else "Pending"))
            if (!listening.isNull("episode_playback_rate")) record.put("playback_rate", listening.getDouble("episode_playback_rate"))
        }
        fun validateObservation(observation: JSONObject) {
            require(observation.keys().asSequence().toSet() == setOf("media_id", "consumption_revision", "state"))
            UUID.fromString(observation.getString("media_id"))
            val revision = observation.getString("consumption_revision")
            require(revision.matches(Regex("[1-9][0-9]*")))
            val state = observation.getJSONObject("state")
            require(state.keys().asSequence().toSet() == setOf("reset_epoch", "consumption_override_revision", "consumption_override_status", "position_ms", "duration_ms", "lectern_member"))
            require(state.getLong("reset_epoch") >= 0)
            require(state.nullableLong("consumption_override_revision")?.let { it > 0 } != false)
            require(state.nullableString("consumption_override_status") in setOf(null, "finished", "unread"))
            require(state.nullableLong("position_ms")?.let { it >= 0 } != false)
            require(state.nullableLong("duration_ms")?.let { it >= 0 } != false)
            state.getBoolean("lectern_member")
        }
        fun adoptObservation(envelope: JSONObject, observation: JSONObject) {
            val id = observation.getString("media_id")
            val record = record(envelope, id)
            val prior = record.optJSONObject("observed")
            if (prior != null && prior.getString("consumption_revision").toBigInteger() >= observation.getString("consumption_revision").toBigInteger()) return
            record.put("observed", JSONObject(observation.toString()))
            val state = observation.getJSONObject("state")
            val epoch = state.getLong("reset_epoch")
            val override = state.nullableLong("consumption_override_revision")
            val lane = facts(envelope).filter { fact ->
                fact.getString("media_id") != id || sample(fact).getLong("expected_reset_epoch") == epoch &&
                    (!fact.getBoolean("settle") || fact.getJSONObject("body").nullableLong("expected_override_revision") == override)
            }
            envelope.put("lane", JSONArray(lane))
            val local = record.optJSONObject("local")
            if (local != null) {
                if (local.getLong("reset_epoch") != epoch) record.put("local", JSONObject.NULL)
                else if (local.optJSONObject("terminal") != null &&
                    local.getJSONObject("terminal").nullableLong("expected_override_revision") != override) {
                    record.put("local", JSONObject.NULL)
                    lane.filter { it.getString("media_id") == id }.forEach { projectFact(envelope, it) }
                } else if (prior != null && prior.getJSONObject("state").nullableLong("consumption_override_revision") != override) {
                    local.put("completed", state.nullableString("consumption_override_status") == "finished" ||
                        lane.any { it.getString("media_id") == id && threshold(sample(it)) })
                }
            }
        }

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

/** Fixed-route snapshots share the actual envelope and account retirement with native playback. */
internal object ListeningPublication {
    class Error(val code: String, cause: Throwable? = null) : IOException(code, cause)
    private val clock = java.util.concurrent.atomic.AtomicLong()
    private val streams = mutableMapOf<UUID, MutableSet<java.io.InputStream>>()
    private val generations = mutableMapOf<UUID, Long>()
    fun nextRevision(): Long = clock.incrementAndGet()
    fun revision(): Long = clock.get()
    fun open(context: Context, accountId: UUID): java.io.InputStream {
        val (playback, generation) = try { synchronized(streams) {
            if (app.nexus.android.DeviceSession.current()?.accountId() != accountId) throw Error("E_LISTENING_ACCOUNT")
            PlaybackStore.open(context, accountId) to (generations[accountId] ?: 0L)
        } }
        catch (error: org.json.JSONException) { throw Error("E_LISTENING_INVALID", error) }
        catch (error: IllegalArgumentException) { throw Error("E_LISTENING_INVALID", error) }
        catch (error: Error) { throw error }
        catch (error: IOException) { throw Error("E_LISTENING_IO", error) }
        val bytes = playback.listeningBytes()
        return synchronized(streams) {
            if (app.nexus.android.DeviceSession.current()?.accountId() != accountId ||
                generation != (generations[accountId] ?: 0L)) throw Error("E_LISTENING_ACCOUNT")
            object : java.io.ByteArrayInputStream(bytes) {
                @Volatile private var retired = false
                override fun read(): Int { checkOpen(); return super.read() }
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int { checkOpen(); return super.read(buffer, offset, length) }
                private fun checkOpen() { if (retired) throw IOException("listening stream retired") }
                override fun close() { synchronized(streams) { retired = true; streams[accountId]?.remove(this) }; super.close() }
            }.also { streams.getOrPut(accountId) { mutableSetOf() }.add(it) }
        }
    }
    fun retire(accountId: UUID) {
        synchronized(streams) {
            generations[accountId] = (generations[accountId] ?: 0L) + 1
            streams.remove(accountId)?.toList()?.forEach { it.close() }
            PlaybackStore.retire(accountId)
        }
        nextRevision()
    }
}
