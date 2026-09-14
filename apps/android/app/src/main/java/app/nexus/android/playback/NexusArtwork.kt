package app.nexus.android.playback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.SystemClock
import androidx.media3.common.C
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.exifinterface.media.ExifInterface
import app.nexus.android.RetryPolicies
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URLDecoder
import java.util.UUID
import kotlin.coroutines.coroutineContext

/**
 * The upstream image the owned `/api/media/image` proxy is asked to fetch. Native
 * never reaches an upstream host itself: the proxy is the authorized boundary and
 * the only place the image's type, dimensions and length are validated.
 */
internal data class NativeArtworkSource(val upstreamUrl: String)

/** Read the upstream image out of the renderer's own owned-proxy path. */
internal fun artworkSourceFromProxyPath(proxy: String): NativeArtworkSource {
    val prefix = "/api/media/image?url="
    require(proxy.startsWith(prefix)) { "preview artwork omitted its owned proxy path" }
    val encoded = proxy.removePrefix(prefix)
    require(encoded.matches(Regex("(?:[A-Za-z0-9._~!*'()-]|%[0-9A-Fa-f]{2})+"))) {
        "preview artwork has an invalid source encoding"
    }
    return NativeArtworkSource(URLDecoder.decode(encoded, "UTF-8"))
}

private sealed interface ArtworkAttempt {
    data class Encoded(val bytes: ByteArray, val display: Pair<Int, Int>) : ArtworkAttempt
    data class Rejected(val status: Int, val retryAfterMs: Long?) : ArtworkAttempt
    data object TransportFailed : ArtworkAttempt
}

/** One service-owned producer. Cancellation waits for the actual bounded IO/decode. */
internal class NexusArtworkReader(
    private val origin: NexusOriginClient,
    private val maxDimension: Int,
) {
    private val producer = Mutex()

    init { require(maxDimension in 1..4096) }

    suspend fun read(source: NativeArtworkSource): ByteArray = producer.withLock {
        val deadline = SystemClock.elapsedRealtime() + RetryPolicies.ARTWORK_READ_DEADLINE.inWholeMilliseconds
        var backoff = 0L
        for (attempt in 0..RetryPolicies.SAME_SYSTEM_CLIENT_RECOVERY.size) {
            coroutineContext.ensureActive()
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= backoff) throw IOException("artwork read deadline exhausted")
            if (backoff > 0) delay(backoff)
            val requestBudget = deadline - SystemClock.elapsedRealtime()
            if (requestBudget <= 0) throw IOException("artwork read deadline exhausted")
            val response = try {
                when (val result = origin.getArtwork(source.upstreamUrl, requestBudget)) {
                    is NexusArtworkResponse.Image -> ArtworkAttempt.Encoded(result.bytes, result.width to result.height)
                    is NexusArtworkResponse.Rejected -> ArtworkAttempt.Rejected(result.status, result.retryAfterMs)
                }
            } catch (_: IOException) { ArtworkAttempt.TransportFailed }
            coroutineContext.ensureActive()
            if (SystemClock.elapsedRealtime() >= deadline) throw IOException("artwork read deadline exhausted")
            when (response) {
                is ArtworkAttempt.Encoded -> {
                    val bytes = withContext(Dispatchers.IO) {
                        staticArtwork(response.bytes, response.display, maxDimension)
                    }
                    if (SystemClock.elapsedRealtime() >= deadline) throw IOException("artwork read deadline exhausted")
                    return@withLock bytes
                }
                is ArtworkAttempt.Rejected -> {
                    if (response.status !in listOf(408, 429) && response.status < 500) {
                        throw IllegalArgumentException("artwork source rejected with ${response.status}")
                    }
                    backoff = maxOf(response.retryAfterMs ?: 0, RetryPolicies.SAME_SYSTEM_CLIENT_RECOVERY.getOrNull(attempt)?.inWholeMilliseconds ?: 0)
                }
                ArtworkAttempt.TransportFailed -> {
                    backoff = RetryPolicies.SAME_SYSTEM_CLIENT_RECOVERY.getOrNull(attempt)?.inWholeMilliseconds ?: 0
                }
            }
        }
        throw IOException("artwork read retries exhausted")
    }
}

private fun staticArtwork(bytes: ByteArray, display: Pair<Int, Int>, maxDimension: Int): ByteArray {
    val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dimensions)
    require(dimensions.outWidth in 1..4096 && dimensions.outHeight in 1..4096) {
        "artwork exceeds supported decoded dimensions"
    }
    val orientation = ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
    )
    val rotated = orientation in ExifInterface.ORIENTATION_TRANSPOSE..ExifInterface.ORIENTATION_ROTATE_270
    val actualDisplay = if (rotated) dimensions.outHeight to dimensions.outWidth else dimensions.outWidth to dimensions.outHeight
    require(display == actualDisplay) { "artwork display dimensions disagree with its source" }
    var sample = 1
    while ((maxOf(dimensions.outWidth, dimensions.outHeight) + sample - 1) / sample > maxDimension) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val original = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)) { "artwork is not a supported image" }
    val transform = Matrix().apply {
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
        }
    }
    var oriented: Bitmap? = null
    try {
        val image = Bitmap.createBitmap(original, 0, 0, original.width, original.height, transform, true)
        oriented = image
        require(maxOf(image.width, image.height) <= maxDimension) { "artwork decoder ignored its display bound" }
        val output = ByteArrayOutputStream()
        require(image.compress(Bitmap.CompressFormat.PNG, 100, output)) { "artwork derivative could not be encoded" }
        require(output.size() <= MAX_ARTWORK_ENCODED_BYTES) { "artwork derivative exceeds its encoded bound" }
        return output.toByteArray()
    } finally {
        if (oriented !== original) oriented?.recycle()
        original.recycle()
    }
}

/** Main-thread current-track ownership; metadata updates never replace the audio source. */
@androidx.annotation.OptIn(UnstableApi::class)
internal class NexusCurrentArtwork(
    private val player: Player,
    private val scope: CoroutineScope,
    private val reader: NexusArtworkReader,
) {
    private class Entry(
        val accountId: UUID,
        val sessionKey: UUID,
        val mediaId: String,
        val source: NativeArtworkSource,
        var job: Job? = null,
        var failed: Boolean = false,
    )
    private var current: Entry? = null

    fun install(accountId: UUID, sessionKey: UUID, source: NativeArtworkSource?) {
        clear()
        val item = player.currentMediaItem ?: return
        if (source == null) return
        val entry = Entry(accountId, sessionKey, item.mediaId, source)
        current = entry
        load(entry)
    }

    fun retry(accountId: UUID, sessionKey: UUID?) {
        val entry = current ?: return
        if (entry.accountId == accountId && entry.sessionKey == sessionKey && entry.failed) load(entry)
    }

    fun clear() {
        val previous = current
        current = null
        previous?.job?.cancel()
        if (previous != null && player.currentMediaItem?.mediaId == previous.mediaId) publish(null)
    }

    private fun load(entry: Entry) {
        entry.failed = false
        entry.job = scope.launch {
            try {
                val bytes = reader.read(entry.source)
                if (current === entry && player.currentMediaItem?.mediaId == entry.mediaId) publish(bytes)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: IOException) {
                if (current === entry) entry.failed = true
            } catch (_: IllegalArgumentException) {
                // Optional malformed/unavailable artwork retains the missing-cover
                // fallback. A later Connect may observe a repaired upstream image.
                if (current === entry) entry.failed = true
            }
        }
    }

    private fun publish(bytes: ByteArray?) {
        val item = player.currentMediaItem ?: return
        val index = player.currentMediaItemIndex
        if (index == C.INDEX_UNSET) return
        val metadata = item.mediaMetadata.buildUpon().setArtworkUri(null)
            .setArtworkData(bytes, MediaMetadata.PICTURE_TYPE_FRONT_COVER).build()
        player.replaceMediaItem(index, item.buildUpon().setMediaMetadata(metadata).build())
    }
}
