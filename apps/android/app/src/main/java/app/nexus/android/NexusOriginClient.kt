package app.nexus.android

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal const val NEXUS_ORIGIN_CALL_DEADLINE_MS = 20_000L
// a settle answer carries the whole lectern (at most 2,000 rows)
private const val MAX_ORIGIN_RESPONSE_BYTES = 4 * 1024 * 1024L

private class NexusOriginResponse(
    val status: Int,
    val body: String,
)

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

/** A non-2xx answer from the origin, with its envelope error code and details when it has them. */
internal class NexusOriginError(
    val status: Int,
    val code: String?,
    val details: JSONObject? = null,
) : Exception("origin $status $code")

/**
 * The only authenticated native HTTP boundary. Callers choose among fixed BFF
 * operations; they cannot supply a host, path, or headers. `http` lets a job
 * bind the calls to its granted network; the origin policy is applied on top.
 */
internal class NexusOriginClient(
    baseUrl: String = BuildConfig.NEXUS_BASE_URL,
    private val cookies: NexusCookieStore = WebViewCookieStore(),
    http: OkHttpClient = OkHttpClient(),
) {
    private val base: HttpUrl = baseUrl.toHttpUrl()
    private val origin = base.newBuilder()
        .encodedPath("/")
        .build()
        .toString()
        .removeSuffix("/")
    private val client = http.newBuilder()
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

    /** The account the WebView session cookie belongs to. */
    suspend fun me(): UUID = UUID.fromString(data(Request.Builder().url(api("me")).get()).getString("user_id"))

    /** `token` and `stream_base_url` for one direct call to the stream lane. */
    suspend fun mintStreamToken(): Pair<String, String> =
        data(Request.Builder().url(api("stream-token")).post("{}".toRequestBody(JSON)))
            .let { it.getString("token") to it.getString("stream_base_url") }

    /** The reader cursor snapshot `{state, revision, locator?}`. */
    suspend fun getReaderState(mediaId: UUID): JSONObject =
        data(Request.Builder().url(api("media", mediaId.toString(), "reader-state")).get())

    suspend fun putReaderState(mediaId: UUID, body: JSONObject): JSONObject =
        data(
            Request.Builder()
                .url(api("media", mediaId.toString(), "reader-state"))
                .put(body.toString().toRequestBody(JSON)),
        )

    /** The episode's player descriptor now: where a play starts, its reset epoch and override revision. */
    suspend fun player(mediaId: UUID): JSONObject =
        data(Request.Builder().url(api("media", mediaId.toString(), "player")).get())

    /** Accepted position and fences; a stale epoch returns the same tuple in `details.current`. */
    suspend fun putListening(mediaId: UUID, body: JSONObject): JSONObject =
        data(Request.Builder().url(api("media", mediaId.toString(), "listening-state"))
            .put(body.toString().toRequestBody(JSON)))

    /** One batch of activity spans; 204. The BFF adds the device id. */
    suspend fun postActivity(body: JSONObject) {
        call(Request.Builder().url(api("consumption", "activity")).post(body.toString().toRequestBody(JSON)))
    }

    /** A consumption command (the player sends only `SettleNaturalEnd`); the result. */
    suspend fun consumptionCommand(body: JSONObject): JSONObject =
        data(Request.Builder().url(api("consumption", "commands")).post(body.toString().toRequestBody(JSON)))

    private fun api(vararg segments: String): HttpUrl =
        base.newBuilder().addPathSegment("api").apply { segments.forEach { addPathSegment(it) } }.build()

    private suspend fun data(request: Request.Builder): JSONObject =
        call(request) ?: throw IOException("origin answered without data")

    /** The envelope's `data`, or null for an empty 2xx; any other status throws [NexusOriginError]. */
    private suspend fun call(request: Request.Builder): JSONObject? {
        val response = execute(request)
        try {
            if (response.status !in 200..299) {
                val error = try {
                    JSONObject(response.body).getJSONObject("error")
                } catch (_: JSONException) {
                    // justify-ignore-error: a body that is not the error envelope
                    // (a proxy page) still carries its status.
                    null
                }
                val code = error?.optString("code")?.ifEmpty { null }
                throw NexusOriginError(response.status, code, error?.optJSONObject("details"))
            }
            return if (response.body.isEmpty()) null else JSONObject(response.body).getJSONObject("data")
        } catch (error: JSONException) {
            throw IOException("origin answered a malformed body", error)
        }
    }

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
                    CoroutineScope(continuation.context + Dispatchers.IO).launch {
                        try {
                            val result = response.use { decodeResponse(it) }
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

    private suspend fun decodeResponse(response: Response): NexusOriginResponse {
        val setCookies = response.headers("Set-Cookie")
        for (setCookie in setCookies) {
            cookies.install(origin, setCookie)
        }
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
