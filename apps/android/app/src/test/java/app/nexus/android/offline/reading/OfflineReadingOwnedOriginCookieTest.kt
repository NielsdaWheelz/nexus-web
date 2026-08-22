package app.nexus.android.offline.reading

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineReadingOwnedOriginCookieTest {
    @Test
    fun `native state changes carry the exact hosted browser origin required by the BFF`() {
        val hostedOrigin = "http://10.0.2.2:3000/".toHttpUrl()
        val request = Request.Builder()
            .url("http://10.0.2.2:3000/api/media/one/offline-reading-token")
            .offlineReadingOwnedOrigin(hostedOrigin)
            .build()

        assertEquals("http://10.0.2.2:3000", request.header("Origin"))
    }

    @Test
    fun `all rotated owned-origin cookies are durable before the next request`() {
        val origin = "https://nexus.example/".toHttpUrl()
        val store = MemoryOwnedOriginCookieStore("access=old; refresh=old")
        val response = Response.Builder()
            .request(Request.Builder().url(origin).build())
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .addHeader("Set-Cookie", "access=new; Path=/; HttpOnly; Secure")
            .addHeader("Set-Cookie", "refresh=next; Path=/; HttpOnly; Secure")
            .build()

        installOfflineReadingOwnedOriginCookies(response, origin, store)
        val nextHostedRequest = Request.Builder()
            .url(origin.newBuilder().addPathSegment("offline-reader-state").build())
            .header("Cookie", store.requireCookies(origin))
            .build()

        assertEquals("access=new; refresh=next", store.cookiesFor(origin.toString()))
        assertEquals("access=new; refresh=next", nextHostedRequest.header("Cookie"))
        assertEquals(1, store.flushCount)
        assertTrue(store.flushedAfterEveryInstall)
    }
}

private class MemoryOwnedOriginCookieStore(initial: String) : OfflineReadingOwnedOriginCookieStore {
    private val values = linkedMapOf<String, String>()
    private var installs = 0
    var flushCount = 0
        private set
    var flushedAfterEveryInstall = false
        private set

    init {
        initial.split("; ").forEach { token ->
            val (name, value) = token.split('=', limit = 2)
            values[name] = value
        }
    }

    override fun cookiesFor(origin: String): String =
        values.entries.joinToString("; ") { (name, value) -> "$name=$value" }

    override fun install(origin: String, setCookie: String) {
        val (name, value) = setCookie.substringBefore(';').split('=', limit = 2)
        values[name] = value
        installs += 1
    }

    override fun flush() {
        flushCount += 1
        flushedAfterEveryInstall = installs == 2
    }
}
