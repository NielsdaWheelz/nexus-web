@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.nexus.android.offline

import android.net.Uri
import android.os.StatFs
import android.util.Log
import androidx.media3.common.C
import androidx.media3.datasource.DataSink
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSink
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.ContentMetadataMutations
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.Downloader
import androidx.media3.exoplayer.offline.DownloaderFactory
import androidx.media3.exoplayer.offline.ProgressiveDownloader
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File
import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Proxy
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

internal val OFFLINE_PREFLIGHT_DEADLINE: Duration = Duration.ofSeconds(30)
internal const val OFFLINE_STORAGE_RESERVE_BYTES: Long = 512L * 1024L * 1024L
private const val MAX_REDIRECTS = 5
private const val LOG_TAG = "NexusOfflineMedia"

internal data class VettedProgressiveSource(
    val sourceUri: Uri,
    val contentType: String,
    val contentLength: Presence<Long>,
)

internal class OfflineMediaSourceException(
    val rejectionCode: RejectionCode,
    cause: Throwable? = null,
) : IOException(rejectionCode.name, cause)

internal class StorageReserveException : IOException("offline media storage reserve reached")

internal fun removeCachedResource(cache: Cache, key: String) {
    if (key !in cache.keys) {
        return
    }
    cache.applyContentMetadataMutations(
        key,
        ContentMetadataMutations()
            .remove(ContentMetadata.KEY_CONTENT_LENGTH)
            .remove(ContentMetadata.KEY_REDIRECTED_URI),
    )
    cache.removeResource(key)
    if (key in cache.keys) {
        cache.startReadWriteNonBlocking(
            key,
            0,
            C.LENGTH_UNSET.toLong(),
        )?.let(cache::releaseHoleSpan)
    }
}

internal fun preservesStorageReserve(availableBytes: Long, nextBytes: Long): Boolean {
    return nextBytes >= 0 &&
        nextBytes <= Long.MAX_VALUE - OFFLINE_STORAGE_RESERVE_BYTES &&
        availableBytes >= nextBytes + OFFLINE_STORAGE_RESERVE_BYTES
}

internal class PreflightCancellation {
    private val canceled = AtomicBoolean(false)
    private val cancelCall = AtomicReference<(() -> Unit)?>(null)

    fun attach(cancel: () -> Unit) {
        if (!cancelCall.compareAndSet(null, cancel)) {
            error("offline preflight call was attached twice")
        }
        if (canceled.get()) {
            cancel()
        }
    }

    fun cancel() {
        canceled.set(true)
        cancelCall.get()?.invoke()
    }

    fun isCanceled(): Boolean = canceled.get()
}

internal class PublicHttpsPolicy(
    private val systemDns: Dns = Dns.SYSTEM,
) {
    fun validateUrl(url: HttpUrl) {
        if (
            !url.isHttps ||
            url.username.isNotEmpty() ||
            url.password.isNotEmpty() ||
            url.fragment != null ||
            isIpLiteral(url.host)
        ) {
            throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
        }
    }

    fun lookupPublic(hostname: String): List<InetAddress> {
        if (isIpLiteral(hostname)) {
            throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
        }
        val addresses = try {
            systemDns.lookup(hostname)
        } catch (error: UnknownHostException) {
            throw error
        }
        if (addresses.isEmpty() || addresses.any { !isGlobalAddress(it) }) {
            throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
        }
        return addresses
    }

    private fun isIpLiteral(host: String): Boolean {
        return host.contains(':') || IPV4_LITERAL.matches(host)
    }

    companion object {
        private val IPV4_LITERAL = Regex("""\d{1,3}(?:\.\d{1,3}){3}""")

        internal fun isGlobalAddress(address: InetAddress): Boolean {
            if (
                address.isAnyLocalAddress ||
                address.isLoopbackAddress ||
                address.isLinkLocalAddress ||
                address.isSiteLocalAddress ||
                address.isMulticastAddress
            ) {
                return false
            }
            return when (address) {
                is Inet4Address -> isGlobalIpv4(address.address)
                is Inet6Address -> isGlobalIpv6(address.address)
                else -> false
            }
        }

        private fun isGlobalIpv4(bytes: ByteArray): Boolean {
            val first = bytes[0].toInt() and 0xff
            val second = bytes[1].toInt() and 0xff
            val third = bytes[2].toInt() and 0xff
            return when {
                first == 0 || first == 10 || first == 127 || first >= 224 -> false
                first == 100 && second in 64..127 -> false
                first == 169 && second == 254 -> false
                first == 172 && second in 16..31 -> false
                first == 192 && second == 0 && third == 0 -> false
                first == 192 && second == 0 && third == 2 -> false
                first == 192 && second == 88 && third == 99 -> false
                first == 192 && second == 168 -> false
                first == 198 && second in 18..19 -> false
                first == 198 && second == 51 && third == 100 -> false
                first == 203 && second == 0 && third == 113 -> false
                else -> true
            }
        }

        private fun isGlobalIpv6(bytes: ByteArray): Boolean {
            if (
                bytes.copyOfRange(0, 10).all { it == 0.toByte() } &&
                bytes[10] == 0xff.toByte() &&
                bytes[11] == 0xff.toByte()
            ) {
                return isGlobalIpv4(bytes.copyOfRange(12, 16))
            }
            if (hasPrefix(bytes, byteArrayOf(0x00, 0x64, 0xff.toByte(), 0x9b.toByte()), 96)) {
                return isGlobalIpv4(bytes.copyOfRange(12, 16))
            }
            if (!hasPrefix(bytes, byteArrayOf(0x20), 3)) {
                return false
            }
            return !hasPrefix(bytes, byteArrayOf(0x20, 0x01), 23) &&
                !hasPrefix(
                    bytes,
                    byteArrayOf(0x20, 0x01, 0x0d, 0xb8.toByte()),
                    32,
                ) &&
                !hasPrefix(bytes, byteArrayOf(0x20, 0x02), 16) &&
                !hasPrefix(bytes, byteArrayOf(0x3f, 0xff.toByte(), 0x00), 20)
        }

        private fun hasPrefix(
            address: ByteArray,
            prefix: ByteArray,
            prefixLength: Int,
        ): Boolean {
            require(prefixLength <= address.size * 8)
            val normalizedPrefix = prefix.copyOf(address.size)
            val fullBytes = prefixLength / 8
            if (
                !address.copyOfRange(0, fullBytes)
                    .contentEquals(normalizedPrefix.copyOfRange(0, fullBytes))
            ) {
                return false
            }
            val remainingBits = prefixLength % 8
            if (remainingBits == 0) {
                return true
            }
            val mask = 0xff shl (8 - remainingBits) and 0xff
            return (address[fullBytes].toInt() and mask) ==
                (normalizedPrefix[fullBytes].toInt() and mask)
        }
    }
}

internal class SafeHttpClient(
    private val policy: PublicHttpsPolicy = PublicHttpsPolicy(),
) {
    private data class AttemptIdentity(
        val requestId: String,
        val mediaId: UUID,
    )

    private val attemptIdentity = ThreadLocal<AttemptIdentity>()
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(OFFLINE_PREFLIGHT_DEADLINE.toMillis(), TimeUnit.MILLISECONDS)
        .readTimeout(OFFLINE_PREFLIGHT_DEADLINE.toMillis(), TimeUnit.MILLISECONDS)
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false)
        .followSslRedirects(false)
        .dns(
            object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    return policy.lookupPublic(hostname)
                }
            }
        )
        .addInterceptor(
            PublicRedirectInterceptor(policy) { url, status, redirects ->
                attemptIdentity.get()?.let { identity ->
                    Log.i(
                        LOG_TAG,
                        "requestId=${identity.requestId} mediaId=${identity.mediaId} " +
                            "host=${url.host} status=$status redirects=$redirects",
                    )
                }
            }
        )
        .build()

    fun <T> withAttempt(
        requestId: String,
        mediaId: UUID,
        action: () -> T,
    ): T {
        check(attemptIdentity.get() == null)
        attemptIdentity.set(AttemptIdentity(requestId, mediaId))
        return try {
            action()
        } finally {
            attemptIdentity.remove()
        }
    }

    fun preflight(
        requestId: UUID,
        mediaId: UUID,
        sourceUrl: String,
        filesDir: File,
        cancellation: PreflightCancellation = PreflightCancellation(),
    ): VettedProgressiveSource {
        val url = sourceUrl.toHttpUrlOrNull()
            ?: throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
        policy.validateUrl(url)
        val call = client.newCall(
                Request.Builder()
                    .url(url)
                    .get()
                    .header("Range", "bytes=0-0")
                    .build()
            )
        call.timeout().timeout(
            OFFLINE_PREFLIGHT_DEADLINE.toMillis(),
            TimeUnit.MILLISECONDS,
        )
        cancellation.attach(call::cancel)
        if (cancellation.isCanceled()) {
            throw PreflightCanceledException()
        }
        val response = try {
            call.execute()
        } catch (error: OfflineMediaSourceException) {
            throw error
        } catch (error: IOException) {
            if (cancellation.isCanceled()) {
                throw PreflightCanceledException()
            }
            when (error) {
                is SocketTimeoutException, is UnknownHostException ->
                    throw OfflineMediaSourceException(RejectionCode.NetworkUnavailable, error)
                else ->
                    throw OfflineMediaSourceException(RejectionCode.NetworkUnavailable, error)
            }
        }
        response.use {
            val redirectCount = response.request.tag(RedirectCount::class.java)?.value ?: 0
            Log.i(
                LOG_TAG,
                "requestId=$requestId mediaId=$mediaId host=${response.request.url.host} " +
                    "status=${response.code} redirects=$redirectCount bytes=0",
            )
            when (response.code) {
                200, 206 -> Unit
                404, 410 -> throw OfflineMediaSourceException(RejectionCode.SourceMissing)
                else -> throw OfflineMediaSourceException(RejectionCode.SourceUnavailable)
            }
            val contentType = response.header("Content-Type")
                ?.substringBefore(';')
                ?.trim()
                ?.lowercase()
                ?: throw OfflineMediaSourceException(RejectionCode.UnsupportedAudio)
            if (contentType !in SUPPORTED_AUDIO_CONTENT_TYPES) {
                throw OfflineMediaSourceException(RejectionCode.UnsupportedAudio)
            }
            val contentLength = response.totalRepresentationLength()
            if (
                contentLength is Presence.Present &&
                !hasSpaceFor(filesDir, contentLength.value)
            ) {
                throw OfflineMediaSourceException(RejectionCode.StorageInsufficient)
            }
            return VettedProgressiveSource(
                Uri.parse(sourceUrl),
                contentType,
                contentLength,
            )
        }
    }

    private fun Response.totalRepresentationLength(): Presence<Long> {
        val length = if (code == 206) {
            header("Content-Range")
                ?.let { CONTENT_RANGE.matchEntire(it) }
                ?.groupValues
                ?.get(1)
                ?.toLongOrNull()
        } else {
            body?.contentLength()?.takeIf { it >= 0 }
        }
        return length?.let(Presence<Long>::Present) ?: Presence.Absent
    }

    companion object {
        private val CONTENT_RANGE = Regex("""bytes 0-0/([1-9]\d*)""")
        private val SUPPORTED_AUDIO_CONTENT_TYPES = setOf(
            "audio/mpeg",
            "audio/mp3",
            "audio/mp4",
            "audio/x-m4a",
        )

        internal fun hasSpaceFor(filesDir: File, representationBytes: Long): Boolean {
            return preservesStorageReserve(
                StatFs(filesDir.absolutePath).availableBytes,
                representationBytes,
            )
        }
    }
}

internal class PreflightCanceledException : IOException("offline preflight canceled")

private data class RedirectCount(val value: Int)

private class PublicRedirectInterceptor(
    private val policy: PublicHttpsPolicy,
    private val logResponse: (HttpUrl, Int, Int) -> Unit,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        var redirectCount = 0
        val visited = mutableSetOf<String>()
        while (true) {
            policy.validateUrl(request.url)
            if (!visited.add(request.url.toString())) {
                throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
            }
            val response = chain.proceed(
                request.newBuilder()
                    .tag(RedirectCount::class.java, RedirectCount(redirectCount))
                    .build()
            )
            if (response.code !in REDIRECT_CODES) {
                logResponse(response.request.url, response.code, redirectCount)
                return response
            }
            val location = response.header("Location")
                ?: return response
            val next = response.request.url.resolve(location)
                ?: run {
                    response.close()
                    throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
                }
            response.close()
            redirectCount += 1
            if (redirectCount > MAX_REDIRECTS) {
                throw OfflineMediaSourceException(RejectionCode.SourceForbidden)
            }
            policy.validateUrl(next)
            request = request.newBuilder().url(next).build()
        }
    }

    companion object {
        private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
    }
}

internal class SafeProgressiveDownloaderFactory(
    private val cache: Cache,
    private val cacheDataSourceFactory: CacheDataSource.Factory,
    private val executor: Executor,
    private val safeHttpClient: SafeHttpClient,
) : DownloaderFactory {
    override fun createDownloader(request: DownloadRequest): Downloader {
        val metadata = OfflineMediaMetadata.decode(request.data)
        val cacheKey = request.customCacheKey
            ?: error("offline media request must have a custom cache key")
        check(cacheKey == request.id)
        check(request.mimeType == metadata.contentType)
        val downloader = ProgressiveDownloader(
            request.toMediaItem(),
            cacheDataSourceFactory,
            executor,
            0,
            C.LENGTH_UNSET.toLong(),
        )
        return object : Downloader {
            override fun download(progressListener: Downloader.ProgressListener?) {
                removeCachedResource(cache, cacheKey)
                safeHttpClient.withAttempt(request.id, metadata.mediaId) {
                    downloader.download(progressListener)
                }
            }

            override fun cancel() {
                downloader.cancel()
            }

            override fun remove() {
                downloader.remove()
            }
        }
    }
}

internal class ReserveGuardDataSinkFactory(
    cache: Cache,
    private val filesDir: File,
) : DataSink.Factory {
    private val delegate = CacheDataSink.Factory().setCache(cache)

    override fun createDataSink(): DataSink {
        return ReserveGuardDataSink(delegate.createDataSink(), filesDir)
    }
}

private class ReserveGuardDataSink(
    private val delegate: DataSink,
    private val filesDir: File,
) : DataSink {
    override fun open(dataSpec: DataSpec) {
        requireReserve(0)
        delegate.open(dataSpec)
    }

    override fun write(buffer: ByteArray, offset: Int, length: Int) {
        requireReserve(length.toLong())
        delegate.write(buffer, offset, length)
    }

    override fun close() {
        delegate.close()
    }

    private fun requireReserve(nextWriteBytes: Long) {
        val availableBytes = StatFs(filesDir.absolutePath).availableBytes
        if (!preservesStorageReserve(availableBytes, nextWriteBytes)) {
            throw StorageReserveException()
        }
    }
}
