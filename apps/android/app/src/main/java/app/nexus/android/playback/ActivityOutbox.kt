package app.nexus.android.playback

import android.util.Log
import androidx.core.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.temporal.ChronoUnit
import java.util.UUID

/** Canonical millisecond instants: they sort as strings and the server accepts them as `occurredAt`. */
internal val SPAN_INSTANT: DateTimeFormatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

/**
 * Listening spans not yet uploaded, durable across process death: one json array
 * of `{accountId, mediaId, span}` in one file, rewritten whole on each change.
 * The service's main thread is its only caller.
 */
internal class ActivityOutbox(file: File) {
    class Batch(val mediaId: UUID, val spans: List<JSONObject>)

    private val file = AtomicFile(file)
    private val entries = mutableListOf<JSONObject>()

    init {
        try {
            val stored = JSONArray(String(this.file.readFully()))
            for (i in 0 until stored.length()) entries += stored.getJSONObject(i)
        } catch (_: FileNotFoundException) {
            // justify-ignore-error: no file yet means nothing is pending.
        }
    }

    fun add(accountId: UUID, mediaId: UUID, span: JSONObject) {
        entries += JSONObject()
            .put("accountId", accountId.toString())
            .put("mediaId", mediaId.toString())
            .put("span", span)
        persist()
    }

    /** The media with the oldest pending span: its spans in occurrence order, at most 120 and 40 kB. */
    fun next(accountId: UUID): Batch? {
        val mine = entries.filter { it.getString("accountId") == accountId.toString() }.sortedBy(::occurredAt)
        val mediaId = mine.firstOrNull()?.getString("mediaId") ?: return null
        var bytes = 0
        val spans = mine.asSequence()
            .filter { it.getString("mediaId") == mediaId }
            .map { it.getJSONObject("span") }
            .takeWhile { bytes += it.toString().length + 1; bytes <= 40_000 }
            .take(120)
            .toList()
        return Batch(UUID.fromString(mediaId), spans)
    }

    fun remove(batch: Batch) {
        if (entries.removeAll { entry -> batch.spans.any { it === entry.getJSONObject("span") } }) persist()
    }

    /** Drops other accounts' spans (these cookies cannot send them) and spans the server would refuse as too old. */
    fun retain(accountId: UUID) {
        val cutoff = SPAN_INSTANT.format(Instant.now().minus(30, ChronoUnit.DAYS))
        val mine = accountId.toString()
        if (entries.removeAll { it.getString("accountId") != mine || occurredAt(it) < cutoff }) persist()
    }

    private fun occurredAt(entry: JSONObject): String = entry.getJSONObject("span").getString("occurredAt")

    private fun persist() {
        var stream: FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(JSONArray(entries).toString().toByteArray())
            file.finishWrite(stream)
        } catch (error: IOException) {
            // justify-ignore-error: the spans stay in memory and still upload; only
            // their survival of a process death is lost while storage refuses writes.
            stream?.let(file::failWrite)
            Log.w("ActivityOutbox", "spans not persisted", error)
        }
    }
}
