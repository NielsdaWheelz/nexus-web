package app.nexus.android.playback

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import app.nexus.android.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal const val NEXUS_ORIGIN_CALL_DEADLINE_MS = 20_000L
private const val MAX_ORIGIN_RESPONSE_BYTES = 128 * 1024L

internal data class NexusOriginResponse(
    val status: Int,
    val body: String,
)

internal sealed interface NexusArtworkResponse {
    data class Image(val bytes: ByteArray, val width: Int, val height: Int) : NexusArtworkResponse
    data class Rejected(val status: Int, val retryAfterMs: Long?) : NexusArtworkResponse
}

internal const val MAX_ARTWORK_ENCODED_BYTES = 10 * 1024 * 1024L

internal interface NexusOriginTransport {
    suspend fun getListeningState(mediaId: UUID): NexusOriginResponse

    suspend fun putListeningState(
        mediaId: UUID,
        jsonBody: String,
    ): NexusOriginResponse

    suspend fun postListeningActivity(jsonBody: String): NexusOriginResponse
}

internal interface NexusCookieStore {
    fun cookiesFor(url: String): String?
    suspend fun install(url: String, setCookie: String)
    fun flush()
}

private class WebViewCookieStore : NexusCookieStore {
    // The service may construct its transport in onCreate, where cookie/auth
    // access is forbidden. Resolve the WebView cookie owner only for a request.
    private val manager: CookieManager by lazy(LazyThreadSafetyMode.NONE) {
        CookieManager.getInstance()
    }
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun cookiesFor(url: String): String? = manager.getCookie(url)

    override suspend fun install(url: String, setCookie: String) =
        suspendCancellableCoroutine { continuation ->
            val posted = mainHandler.post {
                manager.setCookie(url, setCookie) { accepted ->
                    if (!continuation.isActive) {
                        return@setCookie
                    }
                    if (accepted) {
                        continuation.resume(Unit)
                    } else {
                        continuation.resumeWithException(
                            IOException("WebView rejected owned-origin cookie"),
                        )
                    }
                }
            }
            if (!posted && continuation.isActive) {
                continuation.resumeWithException(
                    IOException("WebView cookie acknowledgement could not be scheduled"),
                )
            }
        }

    override fun flush() {
        manager.flush()
    }
}

/**
 * The authenticated playback HTTP boundary. Callers choose fixed BFF
 * operations; they cannot supply a product host, path, or headers.
 */
internal class NexusOriginClient(
    baseUrl: String = BuildConfig.NEXUS_BASE_URL,
    private val cookies: NexusCookieStore = WebViewCookieStore(),
    client: OkHttpClient? = null,
) : NexusOriginTransport {
    private val base: HttpUrl = baseUrl.toHttpUrl()
    private val origin = base.newBuilder()
        .encodedPath("/")
        .build()
        .toString()
        .removeSuffix("/")
    private val client = client ?: OkHttpClient.Builder()
        .callTimeout(NEXUS_ORIGIN_CALL_DEADLINE_MS, TimeUnit.MILLISECONDS)
        .connectTimeout(NEXUS_ORIGIN_CALL_DEADLINE_MS, TimeUnit.MILLISECONDS)
        .readTimeout(NEXUS_ORIGIN_CALL_DEADLINE_MS, TimeUnit.MILLISECONDS)
        .writeTimeout(NEXUS_ORIGIN_CALL_DEADLINE_MS, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    init {
        require(base.username.isEmpty() && base.password.isEmpty())
        require(base.encodedPath == "/" && base.query == null && base.fragment == null)
        require(base.scheme == "http" || base.scheme == "https")
    }

    override suspend fun getListeningState(mediaId: UUID): NexusOriginResponse =
        execute(
            Request.Builder()
                .url(listeningStateUrl(mediaId))
                .get(),
        )

    override suspend fun putListeningState(
        mediaId: UUID,
        jsonBody: String,
    ): NexusOriginResponse =
        execute(
            Request.Builder()
                .url(listeningStateUrl(mediaId))
                .put(jsonBody.toRequestBody(JSON)),
        )

    override suspend fun postListeningActivity(jsonBody: String): NexusOriginResponse =
        execute(
            Request.Builder()
                .url(
                    base.newBuilder()
                        .addPathSegment("api")
                        .addPathSegment("consumption")
                        .addPathSegment("activity")
                        .build()
                )
                .post(jsonBody.toRequestBody(JSON)),
        )

    suspend fun getArtwork(remoteUrl: String, remainingMs: Long): NexusArtworkResponse {
        require(remainingMs > 0)
        val remote = remoteUrl.toHttpUrl()
        require(remote.scheme == "https" || remote.scheme == "http")
        val request = authenticatedRequest(
            Request.Builder().url(base.newBuilder().addPathSegments("api/media/image")
                .addQueryParameter("url", remoteUrl).build()).get()
                .header("Accept-Encoding", "identity"),
            accept = "image/*",
        )
        // Structured IO keeps the artwork producer alive through the actual
        // bounded body read; cancellation cannot release a detached callback.
        return withContext(Dispatchers.IO) {
            val call = client.newCall(request)
            call.timeout().timeout(minOf(remainingMs, NEXUS_ORIGIN_CALL_DEADLINE_MS), TimeUnit.MILLISECONDS)
            call.execute().use { response ->
                synchronizeCookies(response)
                if (response.code != 200) {
                    NexusArtworkResponse.Rejected(response.code, artworkRetryAfterMs(response.header("Retry-After")))
                } else {
                    require(response.header("Content-Encoding").let { it == null || it == "identity" }) {
                        "artwork response changed its byte representation"
                    }
                    val type = response.header("Content-Type")?.substringBefore(';')
                    require(type?.startsWith("image/") == true && type != "image/svg+xml") {
                        "artwork response omitted its image representation"
                    }
                    fun dimension(name: String): Int? = response.header(name)
                        ?.takeIf { it.matches(Regex("[1-9][0-9]*")) }?.toIntOrNull()
                    val width = dimension("X-Nexus-Image-Width")
                    val height = dimension("X-Nexus-Image-Height")
                    require(width != null && height != null && width in 1..4096 && height in 1..4096) {
                        "artwork response omitted validated display dimensions"
                    }
                    val declared = requireNotNull(response.body).contentLength()
                    require(declared >= 1) { "artwork response omitted its encoded length" }
                    require(declared <= MAX_ARTWORK_ENCODED_BYTES) {
                        "artwork advertised more than the encoded byte limit"
                    }
                    NexusArtworkResponse.Image(readArtworkBytes(response), width, height)
                }
            }
        }
    }

    private fun listeningStateUrl(mediaId: UUID): HttpUrl =
        base.newBuilder()
            .addPathSegment("api")
            .addPathSegment("media")
            .addPathSegment(mediaId.toString())
            .addPathSegment("listening-state")
            .build()

    private fun authenticatedRequest(requestBuilder: Request.Builder, accept: String): Request {
        val cookie = cookies.cookiesFor(origin)
        return requestBuilder.header("Origin", origin).header("Accept", accept)
            .header("Cache-Control", "no-store")
            .apply { if (!cookie.isNullOrBlank()) header("Cookie", cookie) }.build()
    }

    private suspend fun synchronizeCookies(response: Response) {
        val setCookies = response.headers("Set-Cookie")
        for (setCookie in setCookies) cookies.install(origin, setCookie)
        if (setCookies.isNotEmpty()) cookies.flush()
    }

    private suspend fun execute(
        requestBuilder: Request.Builder,
    ): NexusOriginResponse = suspendCancellableCoroutine { continuation ->
        val request = authenticatedRequest(requestBuilder, "application/json")
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(
            object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(error)
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    CoroutineScope(continuation.context + Dispatchers.IO).launch {
                        try {
                            val result = response.use {
                                synchronizeCookies(it)
                                decodeResponse(it)
                            }
                            if (continuation.isActive) {
                                continuation.resume(result)
                            }
                        } catch (error: Throwable) {
                            if (continuation.isActive) {
                                continuation.resumeWithException(error)
                            }
                        }
                    }
                }
            }
        )
    }

    private fun decodeResponse(response: Response): NexusOriginResponse {
        val body = response.body?.let {
            val declared = it.contentLength()
            if (declared > MAX_ORIGIN_RESPONSE_BYTES) {
                throw IOException("owned-origin response exceeds size limit")
            }
            val source = it.source()
            val buffer = Buffer()
            while (true) {
                val read = source.read(
                    buffer,
                    MAX_ORIGIN_RESPONSE_BYTES + 1 - buffer.size,
                )
                if (read == -1L) {
                    break
                }
                if (buffer.size > MAX_ORIGIN_RESPONSE_BYTES) {
                    throw IOException("owned-origin response exceeds size limit")
                }
            }
            buffer.readUtf8()
        }.orEmpty()
        return NexusOriginResponse(response.code, body)
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

/** The same bounded byte read serves authenticated preview and remote OS artwork. */
internal fun readArtworkBytes(response: Response): ByteArray {
    val body = requireNotNull(response.body) { "artwork response has no body" }
    val declared = body.contentLength()
    require(declared <= MAX_ARTWORK_ENCODED_BYTES) { "artwork exceeds encoded byte limit" }
    val buffer = Buffer()
    val source = body.source()
    while (source.read(buffer, MAX_ARTWORK_ENCODED_BYTES + 1 - buffer.size) != -1L) {
        require(buffer.size <= MAX_ARTWORK_ENCODED_BYTES) { "artwork exceeds encoded byte limit" }
    }
    require(buffer.size > 0 && (declared < 0 || buffer.size == declared)) { "artwork encoded length disagrees with its body" }
    return buffer.readByteArray()
}

internal fun artworkRetryAfterMs(header: String?): Long? {
    if (header == null) return null
    if (header.matches(Regex("[0-9]+"))) {
        val seconds = header.toLongOrNull() ?: return Long.MAX_VALUE
        return if (seconds > Long.MAX_VALUE / 1000) Long.MAX_VALUE else seconds * 1000
    }
    return try {
        (ZonedDateTime.parse(header, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - System.currentTimeMillis()).coerceAtLeast(0)
    } catch (_: DateTimeParseException) { null }
}
