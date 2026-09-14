package app.nexus.android.playback

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class NexusOriginClientTest {
    @Test
    fun `preview artwork uses the fixed owned proxy and retains capacity retry guidance`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(503).addHeader("Retry-After", "2"))
        server.start()
        val cookies = FakeCookieStore("session=owned")
        try {
            val client = NexusOriginClient(server.url("/").toString(), cookies)
            val source = "https://images.example/cover.jpg?edition=2&size=large"
            val response = client.getArtwork(source, NEXUS_ORIGIN_CALL_DEADLINE_MS)
            val request = server.takeRequest()
            assertEquals("/api/media/image", request.requestUrl!!.encodedPath)
            assertEquals(source, request.requestUrl!!.queryParameter("url"))
            assertEquals("session=owned", request.getHeader("Cookie"))
            assertEquals(server.url("/").toString().removeSuffix("/"), request.getHeader("Origin"))
            assertEquals("identity", request.getHeader("Accept-Encoding"))
            assertEquals(NexusArtworkResponse.Rejected(503, 2000), response)
        } finally { server.shutdown() }
    }

    @Test
    fun `artwork advertised over the encoded limit is rejected before its absent body is read`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200)
            .addHeader("Content-Type", "image/png")
            .addHeader("X-Nexus-Image-Width", "1")
            .addHeader("X-Nexus-Image-Height", "1")
            .setHeader("Content-Length", MAX_ARTWORK_ENCODED_BYTES + 1))
        server.start()
        try {
            val client = NexusOriginClient(server.url("/").toString(), FakeCookieStore(null))
            val failure = runCatching { client.getArtwork("https://images.example/cover.png", NEXUS_ORIGIN_CALL_DEADLINE_MS) }.exceptionOrNull()
            assertTrue("advertised artwork limit did not fail at its header boundary", failure is IllegalArgumentException)
            assertEquals("artwork advertised more than the encoded byte limit", failure?.message)
        } finally { server.shutdown() }
    }

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

    @Test
    fun `response does not complete or flush until every WebView cookie acknowledgement arrives`() =
        runBlocking {
            val server = MockWebServer()
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .addHeader("Set-Cookie", "session=first; Path=/; HttpOnly")
                    .addHeader("Set-Cookie", "refresh=second; Path=/; HttpOnly")
                    .setBody("{}")
            )
            server.start()
            val cookies = AwaitingCookieStore()
            try {
                val request = async(Dispatchers.IO) {
                    NexusOriginClient(server.url("/").toString(), cookies)
                        .getListeningState(MEDIA_ID)
                }
                server.takeRequest()
                cookies.awaitFirstInstall()

                assertTrue("native request completed before CookieManager acknowledged writes", !request.isCompleted)
                assertEquals(0, cookies.flushes)

                cookies.acknowledgeNext()
                cookies.awaitSecondInstall()
                assertTrue("native request completed before every cookie acknowledgement", !request.isCompleted)
                assertEquals(0, cookies.flushes)

                cookies.acknowledgeNext()
                assertEquals(200, request.await().status)
                assertEquals(1, cookies.flushes)
            } finally {
                server.shutdown()
            }
        }

    private class FakeCookieStore(
        val cookies: String?,
    ) : NexusCookieStore {
        val installed = mutableListOf<String>()
        var flushes = 0

        override fun cookiesFor(url: String): String? = cookies

        override suspend fun install(url: String, setCookie: String) {
            installed += setCookie
        }

        override fun flush() {
            flushes += 1
        }
    }

    private class AwaitingCookieStore : NexusCookieStore {
        private val installs = mutableListOf<kotlinx.coroutines.CompletableDeferred<Unit>>()
        private val installCount = kotlinx.coroutines.CompletableDeferred<Unit>()
        var flushes = 0

        override fun cookiesFor(url: String): String? = null

        override suspend fun install(url: String, setCookie: String) {
            val acknowledgement = kotlinx.coroutines.CompletableDeferred<Unit>()
            installs += acknowledgement
            installCount.complete(Unit)
            acknowledgement.await()
        }

        suspend fun awaitFirstInstall() {
            installCount.await()
        }

        suspend fun awaitSecondInstall() {
            while (installs.size < 2) {
                delay(1)
            }
        }

        fun acknowledgeNext() {
            installs.firstOrNull { !it.isCompleted }?.complete(Unit)
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
