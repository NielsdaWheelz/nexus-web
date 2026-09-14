package app.nexus.android.offline.reading

import android.net.Network
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import app.nexus.android.BuildConfig
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import java.io.IOException
import java.net.Proxy
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal data class OfflineReadingHttpSession(
    val client: OkHttpClient,
    val hostedOrigin: HttpUrl,
    val cookieStore: OfflineReadingOwnedOriginCookieStore,
)

internal interface OfflineReadingOwnedOriginCookieStore {
    fun cookiesFor(origin: String): String?
    fun install(origin: String, setCookie: String)
    fun flush()
}

internal fun OfflineReadingOwnedOriginCookieStore.requireCookies(origin: HttpUrl): String =
    cookiesFor(origin.toString())
        ?.takeIf { it.isNotBlank() }
        ?: throw OfflineReadingCookieUnavailableException()

internal class WebViewOfflineReadingOwnedOriginCookieStore(
    private val manager: CookieManager = CookieManager.getInstance(),
) : OfflineReadingOwnedOriginCookieStore {
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun cookiesFor(origin: String): String? = manager.getCookie(origin)

    override fun install(origin: String, setCookie: String) {
        check(Looper.myLooper() != Looper.getMainLooper())
        val acknowledged = CountDownLatch(1)
        var accepted = false
        check(mainHandler.post {
            manager.setCookie(origin, setCookie) { result ->
                accepted = result
                acknowledged.countDown()
            }
        })
        check(acknowledged.await(OFFLINE_READING_COOKIE_ACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            "WebView cookie acknowledgement timed out"
        }
        if (!accepted) throw IOException("WebView rejected owned-origin cookie")
    }

    override fun flush() = manager.flush()
}

internal fun installOfflineReadingOwnedOriginCookies(
    response: Response,
    origin: HttpUrl,
    cookieStore: OfflineReadingOwnedOriginCookieStore =
        WebViewOfflineReadingOwnedOriginCookieStore(),
) {
    val setCookies = response.headers("Set-Cookie")
    setCookies.forEach { cookieStore.install(origin.toString(), it) }
    if (setCookies.isNotEmpty()) cookieStore.flush()
}

internal object OfflineReadingHttpSessionFactory {
    fun create(
        network: Network,
        cookieStore: OfflineReadingOwnedOriginCookieStore =
            WebViewOfflineReadingOwnedOriginCookieStore(),
    ): OfflineReadingHttpSession {
        val hostedOrigin = BuildConfig.NEXUS_BASE_URL.toHttpUrl().requireOfflineReadingOrigin()
        cookieStore.requireCookies(hostedOrigin)
        val client = OkHttpClient.Builder()
            .socketFactory(network.socketFactory)
            .dns(object : Dns {
                override fun lookup(hostname: String) = network.getAllByName(hostname).toList()
            })
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(OFFLINE_READING_CONNECT_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
            .readTimeout(OFFLINE_READING_READ_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
            .callTimeout(OFFLINE_READING_READ_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
            .build()
        return OfflineReadingHttpSession(client, hostedOrigin, cookieStore)
    }
}

internal fun HttpUrl.requireOfflineReadingOrigin(): HttpUrl {
    require(username.isEmpty() && password.isEmpty())
    require(encodedPath == "/" && encodedQuery == null && fragment == null)
    require(scheme == "https" || (BuildConfig.DEBUG && scheme == "http"))
    return this
}

/** Apply the exact browser-origin assertion required by the owned BFF CSRF boundary. */
internal fun Request.Builder.offlineReadingOwnedOrigin(origin: HttpUrl): Request.Builder =
    header("Origin", origin.requireOfflineReadingOrigin().toString().removeSuffix("/"))

internal val OFFLINE_READING_CONNECT_TIMEOUT: Duration = Duration.ofSeconds(20)
internal val OFFLINE_READING_READ_TIMEOUT: Duration = Duration.ofSeconds(60)
internal val OFFLINE_READING_PACKAGE_READ_TIMEOUT: Duration = Duration.ofSeconds(3_600)
// Candidate observation bound; qualification must include the slowest supported archive preparation.
internal val OFFLINE_READING_PREPARATION_MAX_AGE: Duration = Duration.ofHours(1)

internal fun offlineReadingPackageClient(base: OkHttpClient): OkHttpClient = base.newBuilder()
    .readTimeout(OFFLINE_READING_PACKAGE_READ_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
    .callTimeout(OFFLINE_READING_PACKAGE_READ_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
    .build()
internal const val OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES = 1024 * 1024

internal fun ResponseBody.readBoundedJson(
    maximumBytes: Long = OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES.toLong(),
): ByteArray {
    require(contentLength() <= maximumBytes)
    val source = source()
    require(!source.request(maximumBytes + 1)) {
        "offline reader JSON exceeds its byte limit"
    }
    return source.readByteArray()
}

internal class OfflineReadingCookieUnavailableException : RuntimeException()
private const val OFFLINE_READING_COOKIE_ACK_TIMEOUT_SECONDS = 20L
