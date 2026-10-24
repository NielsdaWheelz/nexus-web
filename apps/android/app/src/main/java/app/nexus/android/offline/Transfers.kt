package app.nexus.android.offline

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.os.Handler
import android.os.HandlerThread
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.DefaultRendererCapabilitiesList
import androidx.media3.exoplayer.source.TrackGroupArray
import com.google.common.util.concurrent.ListenableFuture
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.inspector.MetadataRetriever
import app.nexus.android.LocalStateError
import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.android.asCoroutineDispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.zip.ZipInputStream

internal class TransferFailure(val reason: String, val retryable: Boolean, cause: Throwable? = null) : Exception(reason, cause)
internal class CopyMeta(val generation: Long, val baseline: JSONObject)
internal class AudioMeta(val byteCount: Long, val mime: String, val durationMs: Long?)
internal class ExtraMeta(val mime: String, val sha256: String)
private const val USER_AGENT = "NexusAndroid/1"
private const val EXTRA_LIMIT = 8L * 1024 * 1024

/**
 * Strong-etag range resumption preserves a representation, never merely an URL.
 * A resumed body must finish at its pinned full length. Reserve checks also run
 * for unknown-length bodies. Inspection uses playback's default source/extractors.
 */
internal suspend fun fetchAudio(
    context: Context,
    url: String,
    into: File,
    http: OkHttpClient,
    onProgress: (Long, Long?) -> Unit,
): AudioMeta {
    val file = File(into, "audio")
    val identity = File(into, "audio.identity")
    var restarted = false
    while (true) {
        val known = if (identity.isFile && file.length() > 0) {
            val parts = storage { identity.readText() }.split('\n')
            if (parts.size == 2 && parts[0].startsWith('"') && parts[0].endsWith('"')) {
                parts[1].toLongOrNull()?.takeIf { it > file.length() }?.let { parts[0] to it }
            } else null
        } else null
        val offset = if (known != null) file.length() else 0L
        val request = Request.Builder().url(url).header("User-Agent", USER_AGENT).apply {
            if (known != null) header("Range", "bytes=$offset-").header("If-Range", known.first)
        }.build()
        var restart = false
        http.newCall(request).execute().use { response ->
            val resumed = known != null && response.code == 206 &&
                response.header("Content-Range") == "bytes $offset-${known.second - 1}/${known.second}"
            if (!resumed && response.code != 200) {
                if (known != null && response.code in setOf(206, 416) && !restarted) {
                    restart = true
                    return@use
                }
                throw when (response.code) {
                    206, 416 -> TransferFailure("Invalid", false)
                    in 500..599 -> TransferFailure("Server", true)
                    else -> TransferFailure("SourceUnavailable", false)
                }
            }
            val body = response.body ?: throw TransferFailure("Invalid", false)
            val length = body.contentLength()
            val start = if (resumed) offset else 0L
            val total = if (resumed) known!!.second else length.takeIf { it >= 0 }
            if (resumed && length >= 0 && length != known!!.second - start) throw TransferFailure("Invalid", false)
            if (length >= 0 && into.usableSpace - length < RESERVE_BYTES) throw TransferFailure("Storage", false)
            withOutput(file, resumed) { out ->
                if (!resumed) {
                    val etag = response.header("ETag")?.takeIf { it.startsWith('"') && it.endsWith('"') }
                    if (etag != null && total != null) storage { writeSynced(identity, "$etag\n$total".toByteArray()) }
                    else identity.delete()
                }
                copyBytes(body.byteStream(), out, into, null) { onProgress(start + it, total) }
                storage { out.fd.sync() }
            }
            if (total != null && file.length() != total) throw TransferFailure("Invalid", false)
        }
        if (restart) {
            file.delete(); identity.delete(); restarted = true
            continue
        }
        if (file.length() == 0L) throw TransferFailure("Invalid", false)
        val result = inspectAudio(context, file)
        identity.delete()
        return result
    }
}

/**
 * Capability renderers need one real looper, including lazy spatializer/receiver
 * registration and release. Future waits and codec capability probes stay off
 * the app/player looper; this private looper never owns playback or focus.
 */
private suspend fun inspectAudio(context: Context, file: File): AudioMeta {
    val thread = HandlerThread("nexus-audio-inspection").apply { start() }
    val dispatcher = Handler(thread.looper).asCoroutineDispatcher()
    try {
        return runInterruptible(dispatcher) {
            val retriever = MetadataRetriever.Builder(context, MediaItem.fromUri(Uri.fromFile(file)))
                .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context))).build()
            var capabilities: DefaultRendererCapabilitiesList? = null
            var tracksFuture: ListenableFuture<TrackGroupArray>? = null
            var durationFuture: ListenableFuture<Long>? = null
            var primary: Throwable? = null
            val deadline = SystemClock.elapsedRealtime() + 30_000
            try {
                val renderers = DefaultRendererCapabilitiesList.Factory(context).createRendererCapabilitiesList()
                capabilities = renderers
                val tracks = retriever.retrieveTrackGroups().also { tracksFuture = it }
                val duration = retriever.retrieveDurationUs().also { durationFuture = it }
                val groups = tracks.get((deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
                var mime: String? = null
                for (index in 0 until groups.length) {
                    val group = groups.get(index)
                    for (track in 0 until group.length) {
                        val format = group.getFormat(track)
                        if (!MimeTypes.isAudio(format.sampleMimeType) || format.drmInitData != null || format.cryptoType != C.CRYPTO_TYPE_NONE) continue
                        if (renderers.rendererCapabilities.any { renderer ->
                            renderer.trackType == C.TRACK_TYPE_AUDIO && RendererCapabilities.getFormatSupport(renderer.supportsFormat(format)) == C.FORMAT_HANDLED
                        }) mime = format.sampleMimeType
                    }
                }
                if (mime == null) throw TransferFailure("Invalid", false)
                val durationUs = duration.get((deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1), TimeUnit.MILLISECONDS)
                AudioMeta(file.length(), mime, durationUs.takeIf { it != C.TIME_UNSET && it >= 0 }?.div(1000))
            } catch (error: Throwable) {
                val failure = when (error) {
                    is ExoPlaybackException, is ExecutionException, is TimeoutException -> TransferFailure("Invalid", false, error)
                    else -> error
                }
                primary = failure
                throw failure
            } finally {
                var cleanup: Throwable? = null
                fun close(action: () -> Unit) {
                    try { action() } catch (error: Throwable) {
                        val previous = cleanup
                        if (previous == null) cleanup = error else previous.addSuppressed(error)
                    }
                }
                close { tracksFuture?.cancel(true) }
                close { durationFuture?.cancel(true) }
                close { retriever.close() }
                close { capabilities?.release() }
                val inspectionFailure = primary
                cleanup?.let { error -> if (inspectionFailure == null) throw error else inspectionFailure.addSuppressed(error) }
            }
        }
    } finally { thread.quitSafely() }
}

/** The exact captured transcript bytes are pinned by both source identity and complete-body digest. */
internal suspend fun fetchTranscript(transfer: Transfer, capture: JSONObject, into: File, origin: NexusOriginClient): ExtraMeta {
    val expected = capture.getJSONObject("transcript")
    try {
        origin.episodeDownloadTranscript(transfer.mediaId, capture.getString("source_key"), expected.getString("sha256"), into)
    } catch (error: NexusOriginError) { throw httpFailure(error.status) }
    catch (error: LocalStateError) {
        throw when (error.code) {
            "E_LOCAL_CONTENT_IO" -> TransferFailure("Storage", false)
            "E_EPISODE_TRANSCRIPT_TOO_LARGE", "E_LOCAL_CONTENT_LIMIT" -> TransferFailure("TooLarge", false)
            else -> error
        }
    }
    if (into.length() != expected.getLong("byte_count") || storage { digest(into) } != expected.getString("sha256")) {
        throw TransferFailure("Changed", false)
    }
    return ExtraMeta("application/json", expected.getString("sha256"))
}

/** Artwork retries use the captured publisher URL, never a refreshed rendition. */
internal fun fetchArtwork(url: String, into: File, http: OkHttpClient): ExtraMeta {
    val capturedUrl = url.toHttpUrlOrNull() ?: throw TransferFailure("Invalid", false)
    http.newCall(Request.Builder().url(capturedUrl).header("User-Agent", USER_AGENT).build()).execute().use { response ->
        if (!response.isSuccessful) throw if (response.code in 500..599) TransferFailure("Server", true) else TransferFailure("SourceUnavailable", false)
        val body = response.body ?: throw TransferFailure("Invalid", false)
        if (body.contentLength() > EXTRA_LIMIT) throw TransferFailure("TooLarge", false)
        withOutput(into) { out ->
            copyBytes(body.byteStream(), out, into.parentFile!!, EXTRA_LIMIT) { }
            storage { out.fd.sync() }
        }
    }
    val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeFile(into.absolutePath, options)
    val mime = options.outMimeType?.takeIf { it.startsWith("image/") } ?: throw TransferFailure("Invalid", false)
    if (options.outWidth <= 0 || options.outHeight <= 0) throw TransferFailure("Invalid", false)
    return ExtraMeta(mime, storage { digest(into) })
}

/** Reading-copy retries retain their existing snapshot/position semantics. */
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
        val copy = origin.readingCopy(mediaId)
        http.newCall(Request.Builder().url(copy.getString("url")).build()).execute().use { response ->
            if (!response.isSuccessful) throw httpFailure(response.code)
            val body = response.body ?: throw TransferFailure("Invalid", false)
            val length = body.contentLength()
            if (length >= 0 && into.usableSpace - length < RESERVE_BYTES) throw TransferFailure("Storage", false)
            val raw = Counting(body.byteStream()) { onProgress(it, length.takeIf { length >= 0 }) }
            unzip(raw, into.canonicalFile)
            val rest = ByteArray(8192)
            while (raw.read(rest) >= 0) continue
        }
        return CopyMeta(copy.getLong("generation"), origin.getReaderState(mediaId))
    } catch (error: NexusOriginError) { throw httpFailure(error.status) }
}

private fun httpFailure(status: Int): TransferFailure = when (status) {
    401 -> TransferFailure("AuthorizationRequired", false)
    403, 404, 410 -> TransferFailure("SourceUnavailable", false)
    409 -> TransferFailure("Changed", false)
    426, in 500..599 -> TransferFailure("Server", true)
    else -> TransferFailure("Server", false)
}

private fun unzip(input: InputStream, dir: File) {
    val zip = ZipInputStream(input)
    while (true) {
        val entry = zip.nextEntry ?: return
        val target = File(dir, entry.name).canonicalFile
        if (!target.path.startsWith(dir.path + File.separator)) throw TransferFailure("Invalid", false)
        if (entry.isDirectory) { target.mkdirs(); continue }
        target.parentFile?.mkdirs()
        withOutput(target) { copyBytes(zip, it, dir, null) { } }
    }
}

private fun copyBytes(input: InputStream, output: OutputStream, reserve: File, limit: Long?, onProgress: (Long) -> Unit) {
    val buffer = ByteArray(64 * 1024)
    var bytes = 0L
    while (true) {
        val count = input.read(buffer)
        if (count == -1) break
        bytes += count
        if (limit != null && bytes > limit) throw TransferFailure("TooLarge", false)
        if (reserve.usableSpace - count < RESERVE_BYTES) throw TransferFailure("Storage", false)
        storage { output.write(buffer, 0, count) }
        onProgress(bytes)
    }
}

private inline fun <T> withOutput(file: File, append: Boolean = false, block: (FileOutputStream) -> T): T {
    val output = storage { FileOutputStream(file, append) }
    return try { block(output) } finally { storage { output.close() } }
}

private inline fun <T> storage(block: () -> T): T = try { block() } catch (_: IOException) {
    // justify-ignore-error: local output failure is storage; network reads remain outside this boundary.
    throw TransferFailure("Storage", false)
}

internal fun digest(file: File): String {
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) { val count = input.read(buffer); if (count == -1) break; hash.update(buffer, 0, count) }
    }
    return hash.digest().joinToString("") { "%02x".format(it) }
}

private class Counting(input: InputStream, private val onCount: (Long) -> Unit) : FilterInputStream(input) {
    private var count = 0L
    override fun read(): Int = `in`.read().also { if (it >= 0) onCount(++count) }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = `in`.read(buffer, offset, length).also {
        if (it > 0) { count += it; onCount(count) }
    }
}
