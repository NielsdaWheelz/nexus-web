package app.nexus.android.playback

import android.webkit.CookieManager
import app.nexus.android.BuildConfig
import kotlinx.coroutines.suspendCancellableCoroutine
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
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal const val NEXUS_ORIGIN_CALL_DEADLINE_MS = 20_000L
private const val MAX_ORIGIN_RESPONSE_BYTES = 128 * 1024L

internal data class NexusOriginResponse(
    val status: Int,
    val body: String,
)

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
    fun install(url: String, setCookie: String)
    fun flush()
}

private class WebViewCookieStore : NexusCookieStore {
    // The service may construct its transport in onCreate, where cookie/auth
    // access is forbidden. Resolve the WebView cookie owner only for a request.
    private val manager: CookieManager by lazy(LazyThreadSafetyMode.NONE) {
        CookieManager.getInstance()
    }

    override fun cookiesFor(url: String): String? = manager.getCookie(url)

    override fun install(url: String, setCookie: String) {
        manager.setCookie(url, setCookie)
    }

    override fun flush() {
        manager.flush()
    }
}

/**
 * The only authenticated native HTTP boundary. Callers choose among three
 * fixed BFF operations; they cannot supply a host, path, or headers.
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

    private fun listeningStateUrl(mediaId: UUID): HttpUrl =
        base.newBuilder()
            .addPathSegment("api")
            .addPathSegment("media")
            .addPathSegment(mediaId.toString())
            .addPathSegment("listening-state")
            .build()

    private suspend fun execute(
        requestBuilder: Request.Builder,
    ): NexusOriginResponse = suspendCancellableCoroutine { continuation ->
        val cookie = cookies.cookiesFor(origin)
        val request = requestBuilder
            .header("Origin", origin)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .apply {
                if (!cookie.isNullOrBlank()) {
                    header("Cookie", cookie)
                }
            }
            .build()
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
                    val result = runCatching {
                        response.use { decodeResponse(it) }
                    }
                    if (!continuation.isActive) {
                        return
                    }
                    result.fold(
                        onSuccess = { continuation.resume(it) },
                        onFailure = { continuation.resumeWithException(it) },
                    )
                }
            }
        )
    }

    private fun decodeResponse(response: Response): NexusOriginResponse {
        val setCookies = response.headers("Set-Cookie")
        setCookies.forEach { cookies.install(origin, it) }
        if (setCookies.isNotEmpty()) {
            cookies.flush()
        }
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
