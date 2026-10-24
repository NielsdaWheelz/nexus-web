package app.nexus.android

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
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
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal const val NEXUS_ORIGIN_CALL_DEADLINE_MS = 20_000L
// the server builds a reading copy before it answers
private const val READING_COPY_DEADLINE_MINUTES = 5L
// a lectern answer carries at most 2,000 rows
private const val MAX_ORIGIN_RESPONSE_BYTES = 4 * 1024 * 1024L

internal class NexusOriginResponse(
    val status: Int,
    val body: String,
)

internal interface NexusCookieStore {
    fun cookiesFor(url: String): String?
    suspend fun install(url: String, setCookie: String, current: () -> Boolean)
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

    override suspend fun install(url: String, setCookie: String, current: () -> Boolean) = withContext(NonCancellable) {
        suspendCancellableCoroutine { continuation ->
            val posted = mainHandler.post {
                if (!current()) {
                    if (continuation.isActive) continuation.resumeWithException(IOException("retired credential operation"))
                    return@post
                }
                manager.setCookie(url, setCookie) { accepted ->
                    if (!continuation.isActive) {
                        return@setCookie
                    }
                    if (accepted && current()) {
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
    private val copyClient = client.newBuilder()
        .callTimeout(READING_COPY_DEADLINE_MINUTES, TimeUnit.MINUTES)
        .readTimeout(READING_COPY_DEADLINE_MINUTES, TimeUnit.MINUTES)
        .build()
    private val catalogClient = client.newBuilder()
        .callTimeout(120, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    init {
        require(base.username.isEmpty() && base.password.isEmpty())
        require(base.encodedPath == "/" && base.query == null && base.fragment == null)
        require(base.scheme == "http" || base.scheme == "https")
    }

    /** Credential effects are used only by DeviceSession's serialized lane. Ordinary calls never install cookies. */
    suspend fun bootstrap(current: () -> Boolean): JSONObject =
        credential(Request.Builder().url(api("native", "bootstrap")).get(), current).getJSONObject("data")

    suspend fun handoff(code: String, verifier: String, expectedAccount: String?, current: () -> Boolean) {
        credential(Request.Builder().url(api("native", "session", "handoff"))
            .post(JSONObject().put("code", code).put("verifier", verifier)
                .put("expected_account_id", expectedAccount ?: JSONObject.NULL).toString().toRequestBody(JSON)), current)
    }

    suspend fun emailChange(email: String, current: () -> Boolean): JSONObject =
        credential(Request.Builder().url(api("me", "email-change"))
            .post(JSONObject().put("email", email).toString().toRequestBody(JSON)), current)

    suspend fun identities(current: () -> Boolean): JSONObject =
        credential(Request.Builder().url(api("me", "identities")).get(), current)

    suspend fun deleteIdentity(id: String, current: () -> Boolean): JSONObject =
        credential(Request.Builder().url(api("me", "identities", id)).delete(), current)

    /** Token minting never sends or installs app cookies. The current attempt owns redemption. */
    suspend fun google(idToken: String, nonce: String, challenge: String): String {
        val response = execute(Request.Builder().url(base.resolve("/auth/native/google")!!)
            .post(JSONObject().put("id_token", idToken).put("nonce", nonce).put("hc", challenge)
                .toString().toRequestBody(JSON)), client, sendCookies = false)
        checkStatus(response)
        return JSONObject(response.body).getJSONObject("data").getString("code")
    }

    /** One bounded best effort with captured credentials; sign-out never installs a response cookie. */
    suspend fun signOut(cookie: String?) {
        val response = execute(Request.Builder().url(base.resolve("/auth/signout")!!)
            .post(ByteArray(0).toRequestBody(null)), client, sendCookies = false, capturedCookie = cookie)
        checkStatus(response)
    }

    fun capturedCookies(): String? = cookies.cookiesFor(origin)

    private suspend fun credential(request: Request.Builder, current: () -> Boolean): JSONObject {
        val response = execute(request, client, current = current, unlimited = true)
        checkStatus(response)
        return if (response.body.isEmpty()) JSONObject() else JSONObject(response.body)
    }

    private fun checkStatus(response: NexusOriginResponse) {
        if (response.status in 200..299) return
        val error = try { JSONObject(response.body).optJSONObject("error") } catch (_: JSONException) { null }
        throw NexusOriginError(response.status, error?.optString("code"), error?.optJSONObject("details"))
    }

    /** The account the WebView session cookie belongs to. */
    suspend fun me(): UUID = UUID.fromString(data(Request.Builder().url(api("me")).get()).getString("user_id"))

    /** Complete metadata only; the caller owns staging and atomic publication. */
    suspend fun catalog(destination: OutputStream) {
        checkStatus(execute(Request.Builder().url(api("offline-catalog")).get(), catalogClient,
            destination = destination))
    }

    /** A fresh offline reading copy `{url, expires_at, generation}`; the url needs no credentials. */
    suspend fun readingCopy(mediaId: UUID): JSONObject =
        data(
            Request.Builder().url(api("media", mediaId.toString(), "reading-copy"))
                .post("{}".toRequestBody(JSON)),
            copyClient,
        )

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

    /** The terminal listening sample and override fence; 204, with no next-row result. */
    suspend fun settleNaturalEnd(mediaId: UUID, body: JSONObject) {
        call(Request.Builder().url(api("media", mediaId.toString(), "natural-end"))
            .post(body.toString().toRequestBody(JSON)))
    }

    private fun api(vararg segments: String): HttpUrl =
        base.newBuilder().addPathSegment("api").apply { segments.forEach { addPathSegment(it) } }.build()

    private suspend fun data(request: Request.Builder, http: OkHttpClient = client): JSONObject =
        call(request, http) ?: throw IOException("origin answered without data")

    /** The envelope's `data`, or null for an empty 2xx; any other status throws [NexusOriginError]. */
    private suspend fun call(request: Request.Builder, http: OkHttpClient = client): JSONObject? {
        val response = execute(request, http)
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
        http: OkHttpClient,
        current: (() -> Boolean)? = null,
        unlimited: Boolean = false,
        sendCookies: Boolean = true,
        capturedCookie: String? = null,
        destination: OutputStream? = null,
    ): NexusOriginResponse = suspendCancellableCoroutine { continuation ->
        if (current == null && sendCookies && DeviceSession.current()?.remotelyAdmitted() != true) {
            continuation.resumeWithException(NexusOriginError(503, "E_REMOTE_UNAVAILABLE"))
            return@suspendCancellableCoroutine
        }
        val cookie = capturedCookie ?: if (sendCookies) cookies.cookiesFor(origin) else null
        val request = requestBuilder
            .header("Origin", origin)
            .header("User-Agent", NexusWebView.USER_AGENT_TOKEN)
            .header("Accept", "application/json")
            .header("X-Nexus-Wire", BuildConfig.NEXUS_WIRE.toString())
            .header("Cache-Control", "no-store")
            .apply {
                if (!cookie.isNullOrBlank()) {
                    header("Cookie", cookie)
                }
            }
            .build()
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(
            object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(error)
                    }
                }

                override fun onResponse(call: Call, response: Response) {
                    CoroutineScope(Dispatchers.IO).launch {
                        try {
                            val result = response.use { decodeResponse(it, current, unlimited, destination) }
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

    private suspend fun decodeResponse(response: Response, current: (() -> Boolean)?, unlimited: Boolean, destination: OutputStream?): NexusOriginResponse {
        val setCookies = if (current != null) response.headers("Set-Cookie") else emptyList()
        for (setCookie in setCookies) {
            if (current?.invoke() != true) throw IOException("retired credential operation")
            cookies.install(origin, setCookie, current)
        }
        if (setCookies.isNotEmpty()) {
            cookies.flush()
        }
        if (destination != null && response.isSuccessful) {
            val body = response.body ?: throw IOException("origin answered without catalog")
            if (body.contentLength() > MAX_CATALOG_BYTES) throw LocalStateError("E_CATALOG_TOO_LARGE", "catalog exceeds this device’s size limit")
            body.byteStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                var bytes = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    bytes += count
                    if (bytes > MAX_CATALOG_BYTES) throw LocalStateError("E_CATALOG_TOO_LARGE", "catalog exceeds this device’s size limit")
                    destination.write(buffer, 0, count)
                }
            }
            return NexusOriginResponse(response.code, "")
        }
        val body = response.body?.let {
            val declared = it.contentLength()
            if (!unlimited && declared > MAX_ORIGIN_RESPONSE_BYTES) {
                throw IOException("owned-origin response exceeds size limit")
            }
            if (unlimited) return@let it.string()
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
        if (current == null && (response.code == 401 || response.code == 426)) DeviceSession.current()?.requestCheck()
        return NexusOriginResponse(response.code, body)
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
