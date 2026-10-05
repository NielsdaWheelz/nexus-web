package app.nexus.android.offline

import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/** A failed transfer with its user-facing reason; retryable ones go back to the queue. */
internal class TransferFailure(val reason: String, val retryable: Boolean) : Exception(reason)

internal class CopyMeta(val generation: Long, val baseline: JSONObject)

private const val USER_AGENT = "NexusAndroid/1"

/**
 * Fetches an episode's enclosure into `into/audio`. A kept partial resumes only
 * as the representation it came from: `audio.identity` holds that response's
 * strong ETag and full length, sent back as `If-Range`, and only a 206 for
 * exactly `bytes <len>-<total-1>/<total>` appends. A 200 restarts; any other
 * 206 or a 416 restarts once from zero. Without an identity there is no resume.
 */
internal fun fetchAudio(url: String, into: File, http: OkHttpClient, onProgress: (Long, Long?) -> Unit) {
    val file = File(into, "audio")
    val identity = File(into, "audio.identity")
    val known = identity.takeIf { file.length() > 0 && it.isFile }?.readText()?.split('\n')
        ?.takeIf { it.size == 2 }?.let { (etag, total) -> total.toLongOrNull()?.let { etag to it } }
    val offset = if (known != null) file.length() else 0L
    val request = Request.Builder()
        .url(url)
        .header("User-Agent", USER_AGENT)
        .apply { if (known != null) header("Range", "bytes=$offset-").header("If-Range", known.first) }
        .build()
    val restart = http.newCall(request).execute().use { response ->
        val resumed = known != null && response.code == 206 &&
            response.header("Content-Range") == "bytes $offset-${known.second - 1}/${known.second}"
        when {
            resumed || response.code == 200 -> Unit
            known != null && (response.code == 206 || response.code == 416) -> return@use true
            response.code in 500..599 -> throw TransferFailure("Server", true)
            else -> throw TransferFailure("SourceUnavailable", false)
        }
        val body = response.body!!
        val length = body.contentLength()
        if (length >= 0 && into.usableSpace - length < RESERVE_BYTES) throw TransferFailure("Storage", false)
        val start = if (resumed) offset else 0L
        val total = if (resumed) known?.second else length.takeIf { it >= 0 }
        FileOutputStream(file, resumed).use { out ->
            // after the truncate, before any byte: the identity always describes the partial's head
            if (!resumed) {
                val etag = response.header("ETag")?.takeUnless { it.startsWith("W/") }
                if (etag != null && total != null) identity.writeText("$etag\n$total") else identity.delete()
            }
            Counting(body.byteStream()) { onProgress(start + it, total) }.copyTo(out)
        }
        false
    }
    if (restart) {
        file.delete()
        return fetchAudio(url, into, http, onProgress)
    }
    if (!isAudio(file)) throw TransferFailure("Invalid", false)
    identity.delete()
}

/**
 * Fetches one reading copy: account check, stream token, the zip unpacked into
 * `into` (confined, CRC-checked, body length enforced), then the cursor baseline.
 */
internal suspend fun fetchCopy(
    mediaId: UUID,
    account: UUID?,
    into: File,
    http: OkHttpClient,
    origin: NexusOriginClient,
    onProgress: (Long, Long?) -> Unit,
): CopyMeta {
    try {
        if (origin.me() != account) throw TransferFailure("AuthorizationRequired", false)
        val (token, streamBaseUrl) = origin.mintStreamToken()
        val request = Request.Builder()
            .url("${streamBaseUrl.trimEnd('/')}/stream/media/$mediaId/reading-copy")
            .header("Authorization", "Bearer $token")
            .build()
        // the server builds the whole zip before its first byte; Caddy allows 660 s
        val copyHttp = http.newBuilder().readTimeout(15, TimeUnit.MINUTES).build()
        val generation = copyHttp.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw httpFailure(response.code)
            val body = response.body!!
            val length = body.contentLength()
            if (length >= 0 && into.usableSpace - length < RESERVE_BYTES) throw TransferFailure("Storage", false)
            val raw = Counting(body.byteStream()) { onProgress(it, length.takeIf { length >= 0 }) }
            unzip(raw, into.canonicalFile)
            // reading past the central directory makes OkHttp enforce Content-Length
            val rest = ByteArray(8192)
            while (raw.read(rest) >= 0) continue
            response.header("Nexus-Reader-Generation")?.toLongOrNull() ?: throw TransferFailure("Server", false)
        }
        return CopyMeta(generation, origin.getReaderState(mediaId))
    } catch (error: NexusOriginError) {
        throw httpFailure(error.status)
    }
}

private fun httpFailure(status: Int): TransferFailure = when (status) {
    401, 403 -> TransferFailure("AuthorizationRequired", false)
    404, 410 -> TransferFailure("SourceUnavailable", false)
    409 -> TransferFailure("Changed", false)
    in 500..599 -> TransferFailure("Server", true)
    else -> TransferFailure("Server", false)
}

/** Leaves the underlying stream open so the caller can drain it. */
private fun unzip(input: InputStream, dir: File) {
    val zip = ZipInputStream(input)
    while (true) {
        val entry = zip.nextEntry ?: return
        val target = File(dir, entry.name).canonicalFile
        if (!target.path.startsWith(dir.path + File.separator)) throw TransferFailure("Invalid", false)
        if (entry.isDirectory) {
            target.mkdirs()
            continue
        }
        target.parentFile?.mkdirs()
        FileOutputStream(target).use { zip.copyTo(it) }
    }
}

/** mp3 (ID3 tag or MPEG frame sync) or MP4 (`ftyp` box): catches an html error page served as 200. */
private fun isAudio(file: File): Boolean {
    val head = ByteArray(12)
    val read = file.inputStream().use { it.read(head) }
    if (read >= 3 && head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte()) return true
    if (read >= 2 && head[0] == 0xFF.toByte() && (head[1].toInt() and 0xE0) == 0xE0) return true
    return read >= 8 && String(head, 4, 4, Charsets.US_ASCII) == "ftyp"
}

private class Counting(input: InputStream, private val onCount: (Long) -> Unit) : FilterInputStream(input) {
    private var count = 0L

    override fun read(): Int = super.read().also { if (it >= 0) onCount(++count) }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        super.read(buffer, offset, length).also {
            if (it > 0) {
                count += it
                onCount(count)
            }
        }
}
