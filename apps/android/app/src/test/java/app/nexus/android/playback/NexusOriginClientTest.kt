package app.nexus.android.playback

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.UUID

class NexusOriginClientTest {
    @Test
    fun `listening request uses only fixed owned path origin and WebView cookies`() =
        runBlocking {
            val server = MockWebServer()
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .addHeader("Set-Cookie", "session=rotated; Path=/; HttpOnly")
                    .setBody("""{"data":{"ok":true}}""")
            )
            server.start()
            val origin = server.url("/").toString().removeSuffix("/")
            val cookies = FakeCookieStore("session=owned")
            try {
                val client = NexusOriginClient(origin, cookies)
                val response = client.getListeningState(MEDIA_ID)
                val request = server.takeRequest()

                assertEquals(200, response.status)
                assertEquals(
                    "/api/media/$MEDIA_ID/listening-state",
                    request.path,
                )
                assertEquals(origin, request.getHeader("Origin"))
                assertEquals("session=owned", request.getHeader("Cookie"))
                assertEquals(
                    listOf("session=rotated; Path=/; HttpOnly"),
                    cookies.installed,
                )
                assertEquals(1, cookies.flushes)
            } finally {
                server.shutdown()
            }
        }

    @Test
    fun `origin constructor rejects base paths and credentials`() {
        val cookies = FakeCookieStore(null)
        NexusOriginClient("https://example.com/", cookies)
        runCatching {
            NexusOriginClient("https://example.com/arbitrary", cookies)
        }.onSuccess { error("base path was accepted") }
        runCatching {
            NexusOriginClient("https://user@example.com", cookies)
        }.onSuccess { error("credentials were accepted") }
        assertNull(cookies.cookies)
    }

    private class FakeCookieStore(
        val cookies: String?,
    ) : NexusCookieStore {
        val installed = mutableListOf<String>()
        var flushes = 0

        override fun cookiesFor(url: String): String? = cookies

        override fun install(url: String, setCookie: String) {
            installed += setCookie
        }

        override fun flush() {
            flushes += 1
        }
    }

    private companion object {
        val MEDIA_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000001")
    }
}
