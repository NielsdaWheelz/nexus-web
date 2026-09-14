package app.nexus.android.offline.reading

import android.net.Network
import app.nexus.android.BuildConfig
import app.nexus.android.offline.readingweb.OfflineReadingAccountAttestor
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowStatFs
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.SocketFactory

/**
 * Drives the REAL [HttpOfflineReadingOriginClient] against a loopback HTTP boundary. The
 * production origins from BuildConfig stay in every URL; only the socket transport is
 * redirected to the local server — exactly the seam Android's `Network.socketFactory`
 * owns in production.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingOriginClientTest {
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val mediaId = UUID.fromString("00000000-0000-4000-8000-000000000007")
    private val fixtureDirectory = File(
        File(System.getProperty("nexus.testdata.offlineReadingContract") ?: error("testdata root is missing")).parentFile,
        "offline-reading",
    )
    private val archiveBytes = File(fixtureDirectory, "retained-unicode-schema-2.zip").readBytes()
    private val fixtureMetadata = JSONObject(File(fixtureDirectory, "retained-unicode-schema-2.json").readText())
    private val packageSha256 = fixtureMetadata.getString("package_sha256")
    private val server = MockWebServer()
    private lateinit var workDirectory: File

    private val transfer = OfflineReadingTransfer(
        id = UUID.fromString("11111111-1111-4111-8111-111111111111"),
        bindingId = UUID.fromString("44444444-4444-4444-8444-444444444444"),
        mediaId = mediaId,
        requestedTitle = "Verified copy",
        requestedMediaKind = OfflineReadingMediaKind.WebArticle,
        state = ReadingTransferState.Authorizing,
        automaticRestartCount = 0,
        stagingName = "staging-1",
        requestedAt = Instant.parse("2026-08-13T18:00:00Z"),
        readerGeneration = 7,
        preparationStartedAt = null,
    )

    @Before
    fun setUp() {
        server.start()
        workDirectory = kotlin.io.path.createTempDirectory("offline-origin-client").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        workDirectory.deleteRecursively()
    }

    private val hostedOrigin = BuildConfig.NEXUS_BASE_URL.toHttpUrl().requireOfflineReadingOrigin()
    private val cookieStore = object : OfflineReadingOwnedOriginCookieStore {
        private val cookies = mutableMapOf(hostedOrigin.toString() to "nexus_session=host-test")
        override fun cookiesFor(origin: String): String? = cookies[origin]
        override fun install(origin: String, setCookie: String) {
            cookies[origin] = setCookie.substringBefore(';')
        }
        override fun flush() = Unit
    }

    private fun loopbackOkClient(): OkHttpClient {
        val loopbackRedirect = object : SocketFactory() {
            private fun socket(): Socket = object : Socket() {
                override fun connect(endpoint: SocketAddress?, timeout: Int) {
                    super.connect(InetSocketAddress("127.0.0.1", server.port), timeout)
                }
            }
            override fun createSocket(): Socket = socket()
            override fun createSocket(host: String?, port: Int): Socket =
                error("offline reading client must create unconnected sockets")
            override fun createSocket(host: String?, port: Int, local: InetAddress?, localPort: Int): Socket =
                error("offline reading client must create unconnected sockets")
            override fun createSocket(address: InetAddress?, port: Int): Socket =
                error("offline reading client must create unconnected sockets")
            override fun createSocket(address: InetAddress?, port: Int, local: InetAddress?, localPort: Int): Socket =
                error("offline reading client must create unconnected sockets")
        }
        return OkHttpClient.Builder()
            .socketFactory(loopbackRedirect)
            .dns(object : okhttp3.Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    listOf(InetAddress.getByName("127.0.0.1"))
            })
            .proxy(java.net.Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }

    private fun realClient(clock: Clock = Clock.systemUTC()): HttpOfflineReadingOriginClient {
        val okClient = loopbackOkClient()
        return HttpOfflineReadingOriginClient(clock) { _ ->
            OfflineReadingHttpSession(okClient, hostedOrigin, cookieStore)
        }
    }

    private fun serve(baselineGeneration: Long) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/media/$mediaId/offline-reading-token" -> MockResponse()
                        .setResponseCode(200)
                        .setBody(
                            """{"data":{"token":"tok-1","package_base_url":""" +
                                """"${BuildConfig.NEXUS_API_ORIGIN}","account_id":"$accountId",""" +
                                """"reader_generation":7,""" +
                                """"package_schema_version":2,""" +
                                """"expires_at":"2026-08-17T19:00:00Z"}}"""
                        )
                    path == "/offline-reading/packages/$mediaId" -> MockResponse()
                        .setResponseCode(200)
                        .setHeader("Content-Type", "application/vnd.nexus.offline-reading+zip")
                        .setHeader("Nexus-Expanded-Length", fixtureMetadata.getLong("expanded_bytes").toString())
                        .setHeader("Nexus-Account-Id", accountId.toString())
                        .setHeader("Nexus-Reader-Generation", "7")
                        .setHeader(
                            "Content-Digest",
                            "sha-256=:" + Base64.getEncoder().encodeToString(
                                java.security.MessageDigest.getInstance("SHA-256")
                                    .digest(archiveBytes)
                            ) + ":",
                        )
                        .setBody(Buffer().write(archiveBytes))
                    path == "/api/media/$mediaId/offline-reader-state" -> MockResponse()
                        .setResponseCode(200)
                        .setHeader("Nexus-Account-Id", accountId.toString())
                        .setHeader("Nexus-Reader-Generation", baselineGeneration.toString())
                        .setBody(
                            """{"data":{"accountId":"$accountId",""" +
                                """"readerGeneration":$baselineGeneration,""" +
                                """"cursor":{"state":"Empty","revision":0}}}"""
                        )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @Test
    fun `successful progress responses preserve protocol defects instead of availability failures`() {
        val valid = """{"data":{"accountId":"$accountId","readerGeneration":7,"cursor":{"state":"Empty","revision":0}}}"""
        fun response() = MockResponse().setHeader("Nexus-Account-Id", accountId.toString())
            .setHeader("Nexus-Reader-Generation", "7").setBody(valid)
        val cases = listOf(
            Triple("malformed-json", response().setBody("{"), java.io.IOException::class.java),
            Triple("malformed-utf8", response().setBody(Buffer().write(byteArrayOf(0xc3.toByte(), 0x28))), java.nio.charset.CharacterCodingException::class.java),
            Triple("foreign-account", response().setHeader("Nexus-Account-Id", "33333333-3333-4333-8333-333333333333"), IllegalArgumentException::class.java),
            Triple("missing-account", response().removeHeader("Nexus-Account-Id"), IllegalStateException::class.java),
            Triple("generation-mismatch", response().setHeader("Nexus-Reader-Generation", "8"), IllegalArgumentException::class.java),
            Triple("wrong-shape", response().setBody("""{"data":{}}"""), IllegalArgumentException::class.java),
        )
        val session = OfflineReadingHttpSession(loopbackOkClient(), hostedOrigin, cookieStore)
        val client = HttpOfflineReaderProgressOriginClient(network()) { session }
        for ((name, reply, expected) in cases) {
            server.enqueue(reply)
            val failure = try { client.fetch(mediaId, accountId); null }
                catch (error: Exception) { error }
            assertTrue("successful progress protocol failure was modeled as availability ($name): $failure",
                expected.isInstance(failure))
        }
    }

    @Test
    fun `owned cookie persistence failure remains a defect after an HTTP response`() {
        val cookies = object : OfflineReadingOwnedOriginCookieStore {
            override fun cookiesFor(origin: String) = "nexus_session=host-test"
            override fun install(origin: String, setCookie: String) {
                throw java.io.IOException("cookie storage failed")
            }
            override fun flush() = Unit
        }
        val client = HttpOfflineReaderProgressOriginClient(network()) {
            OfflineReadingHttpSession(loopbackOkClient(), hostedOrigin, cookies)
        }
        server.enqueue(MockResponse().setHeader("Set-Cookie", "nexus_session=refreshed")
            .setHeader("Nexus-Account-Id", accountId.toString()).setHeader("Nexus-Reader-Generation", "7")
            .setBody("""{"data":{"accountId":"$accountId","readerGeneration":7,"cursor":{"state":"Empty","revision":0}}}"""))
        val failure = assertThrows("cookie persistence was modeled as transport loss", java.io.IOException::class.java) {
            client.fetch(mediaId, accountId)
        }
        assertEquals("cookie storage failed", failure.message)
    }

    @Test
    fun `progress transport and owned HTTP outcomes retain their modeled states`() {
        val session = OfflineReadingHttpSession(loopbackOkClient(), hostedOrigin, cookieStore)
        val client = HttpOfflineReaderProgressOriginClient(network()) { session }
        for ((status, code, reason) in listOf(
            Triple(401, "E_UNAUTHENTICATED", ReaderProgressOriginFailure.AuthorizationRequired),
            Triple(403, "E_FORBIDDEN", ReaderProgressOriginFailure.AuthorizationRequired),
            Triple(404, "E_MEDIA_NOT_FOUND", ReaderProgressOriginFailure.SourceUnavailable),
            Triple(503, "E_SERVER", ReaderProgressOriginFailure.Server),
        )) {
            server.enqueue(MockResponse().setResponseCode(status)
                .setBody("""{"error":{"code":"$code","message":"owned failure"}}"""))
            val failure = assertThrows(code, OfflineReaderProgressOriginException::class.java) { client.fetch(mediaId, accountId) }
            assertEquals(code, reason, failure.reason)
        }
        for (body in listOf("<html>gateway</html>", "{", "{\"error\":{}}")) {
            server.enqueue(MockResponse().setResponseCode(401).setBody(body))
            val failure = assertThrows(OfflineReaderProgressOriginException::class.java) { client.fetch(mediaId, accountId) }
            assertEquals("an unsuccessful gateway response lost its status fallback",
                ReaderProgressOriginFailure.AuthorizationRequired, failure.reason)
        }
        val candidate = ReaderProgressSyncCandidate(transfer.bindingId, accountId, mediaId, 7, 0,
            """{"kind":"web","target":{"fragment_id":"source"},"locations":{"text_offset":0,"progression":null,"total_progression":null,"position":null},"text":{"quote":"source","quote_prefix":null,"quote_suffix":null}}""")
        for ((code, expected) in listOf(
            "E_READER_STATE_CONFLICT" to RemoteReaderWriteResult.Conflict,
            "E_READER_CONTENT_CHANGED" to RemoteReaderWriteResult.ContentChanged,
            "E_MEDIA_NOT_FOUND" to RemoteReaderWriteResult.SourceUnavailable,
        )) {
            server.enqueue(MockResponse().setResponseCode(409)
                .setBody("""{"error":{"code":"$code","message":"owned outcome"}}"""))
            assertEquals(code, expected, client.compareAndSwap(candidate))
        }
        server.enqueue(MockResponse().setHeader("Nexus-Account-Id", accountId.toString())
            .setHeader("Nexus-Reader-Generation", "7")
            .setBody("""{"data":{"accountId":"$accountId","readerGeneration":7,"cursor":{"state":"Empty","revision":0}}}""")
            .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val disconnected = assertThrows(OfflineReaderProgressOriginException::class.java) { client.fetch(mediaId, accountId) }
        assertEquals(ReaderProgressOriginFailure.Network, disconnected.reason)
        assertTrue(disconnected.cause is java.io.IOException)
    }

    @Test
    fun `real client downloads a conforming package that the real verifier then accepts`() {
        serve(baselineGeneration = 7)
        val destination = File(workDirectory, ".staging").apply { check(mkdirs()) }
            .resolve("staging-1.zip")
        ShadowStatFs.registerStats(destination.parentFile, 4_000_000, 4_000_000, 4_000_000)
        val client = realClient()
        var lastProgress = -1L to -1L

        val downloaded = OfflineReadingTransferOperations.register(transfer.id).use { operation ->
            client.downloadPackage(
                transfer,
                accountId,
                network(),
                destination,
                operation,
            ) { received, total -> lastProgress = received to total }
        }

        val artifact = (downloaded as OfflineReadingDownloadResult.Downloaded).artifact
        assertEquals(packageSha256, artifact.packageSha256)
        assertEquals(7L, artifact.readerGeneration)
        assertArrayEquals(archiveBytes, destination.readBytes())
        assertEquals(archiveBytes.size.toLong() to archiveBytes.size.toLong(), lastProgress)
        // Install step 5 evidence: downloading never touches the reader-state endpoint,
        // so verification can fully precede the baseline fetch.
        assertEquals(2, server.requestCount)
        val mint = server.takeRequest()
        assertEquals("/api/media/$mediaId/offline-reading-token", mint.requestUrl!!.encodedPath)
        assertTrue("download selection changed before mint", mint.body.readUtf8() == "{\"expected_reader_generation\":7}")
        assertEquals(
            "/offline-reading/packages/$mediaId",
            server.takeRequest().requestUrl!!.encodedPath,
        )

        // The real verifier accepts the downloaded artifact end to end.
        val verification = runCatching { OfflineReadingPackageVerifier().verifyAndExtract(
            artifact, accountId, mediaId, File(workDirectory, "verified"),
        ) }
        assertTrue("the retained schema-2 publication must verify: ${verification.exceptionOrNull()}", verification.isSuccess)
        val verified = verification.getOrThrow()
        assertEquals(2, verified.manifest.packageSchemaVersion)
        assertFalse(verified.extractedDirectory.resolve("reader.json").exists())
        val text = listOf("0-7-0.json", "7-10-0.json").joinToString("") { key ->
            JSONObject(verified.extractedDirectory.resolve(
                "units/00000000-0000-4000-8000-000000000008/$key",
            ).readText()).getString("canonical_text")
        }
        assertEquals("café 🧠\ncat", text)

        // Install step 6 is a separate later call.
        val baseline = OfflineReadingTransferOperations.register(transfer.id).use { operation ->
            client.fetchBaseline(
                transfer,
                accountId,
                network(),
                operation,
            )
        }
        assertEquals(accountId, baseline.accountId)
        assertEquals(7L, baseline.readerGeneration)
        assertEquals(3, server.requestCount)
        assertEquals(
            "/api/media/$mediaId/offline-reader-state",
            server.takeRequest().requestUrl!!.encodedPath,
        )
    }

    @Test
    fun `retained download keeps the separately attested current cursor generation`() {
        serve(baselineGeneration = 8)
        val client = realClient()

        val baseline = OfflineReadingTransferOperations.register(transfer.id).use { operation ->
                client.fetchBaseline(
                    transfer,
                    accountId,
                    network(),
                    operation,
                )
        }

        assertEquals(accountId, baseline.accountId)
        assertEquals(8L, baseline.readerGeneration)
    }

    @Test
    fun `worker preparation observes status before minting the same selected generation`() {
        serve(baselineGeneration = 9)
        val origin = server.dispatcher
        var ready = false
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                if (path.endsWith("/offline-package")) {
                    assertEquals("/api/media/$mediaId/reader-publications/7/offline-package", path)
                    assertEquals("2", request.requestUrl!!.queryParameter("schema"))
                    return MockResponse().setBody("""{"data":{"reader_generation":7,"state":{"kind":"${if (ready) "Ready" else "Preparing"}"}}}""")
                }
                if (path.endsWith("/offline-reading-token") && !ready) {
                    return MockResponse().setResponseCode(202).setBody(
                        """{"data":{"reader_generation":7,"status_path":"/media/$mediaId/reader-publications/7/offline-package?schema=2"}}""",
                    )
                }
                return origin.dispatch(request)
            }
        }
        val destination = File(workDirectory, "staging/selected.zip")
        destination.parentFile!!.mkdirs()
        ShadowStatFs.registerStats(destination.parentFile, 4_000_000, 4_000_000, 4_000_000)
        // One second inside the observation bound, read from the same clock the store stamps
        // preparationStartedAt with: a bound narrowed or removed stops observing here.
        val client = realClient(
            Clock.fixed(
                PREPARATION_STARTED_AT.plus(OFFLINE_READING_PREPARATION_MAX_AGE).minusSeconds(1),
                ZoneOffset.UTC,
            )
        )
        OfflineReadingTransferOperations.register(transfer.id).use { operation ->
            val first = client.downloadPackage(transfer, accountId, network(), destination, operation) { _, _ -> error("preparation cannot download") }
            assertEquals(OfflineReadingDownloadResult.Preparing, first)
            assertEquals(1, server.requestCount)
            assertFalse(destination.exists())
            val waiting = transfer.copy(preparationStartedAt = PREPARATION_STARTED_AT)
            val second = client.downloadPackage(waiting, accountId, network(), destination, operation) { _, _ -> error("preparation cannot download") }
            assertEquals(OfflineReadingDownloadResult.Preparing, second)
            assertEquals(2, server.requestCount)
            ready = true
            val third = client.downloadPackage(waiting, accountId, network(), destination, operation) { _, _ -> }
            assertEquals(7L, (third as OfflineReadingDownloadResult.Downloaded).artifact.readerGeneration)
            assertEquals(5, server.requestCount)
        }
    }

    @Test
    fun `expired preparation stops observation without minting or downloading`() {
        // Serve the other paths so a widened bound answers instead of hanging: it would then
        // poll and fail as SourceUnavailable, never as the bound's own Server outcome.
        serve(baselineGeneration = 7)
        // One second past the observation bound, on the same clock as the inside-the-bound case.
        val expired = realClient(
            Clock.fixed(
                PREPARATION_STARTED_AT.plus(OFFLINE_READING_PREPARATION_MAX_AGE).plusSeconds(1),
                ZoneOffset.UTC,
            )
        )
        val error = assertThrows(OfflineReadingOriginException::class.java) {
            OfflineReadingTransferOperations.register(transfer.id).use { operation ->
                expired.downloadPackage(transfer.copy(preparationStartedAt = PREPARATION_STARTED_AT), accountId,
                    network(), File(workDirectory, "expired.zip"), operation) { _, _ -> }
            }
        }
        assertEquals(ReadingFailureReason.Server, error.reason)
        assertEquals(0, server.requestCount)
    }

    /**
     * The account-binding handshake gates every other call on this boundary, so it is proved
     * against the exact envelope `python/nexus/api/routes/offline_reading.py` answers. The
     * numbers the attestor compares are the native constants, which is what keeps a package
     * schema bump from shipping half-applied.
     */
    @Test
    fun `account attestation accepts the advertised handshake and refuses an unusable one`() {
        fun envelope(packageSchema: Int, minimumBundle: Int): String =
            """{"data":{"account_id":"$accountId","protocol_version":1,""" +
                """"package_schema_version":$packageSchema,"reader_contract_version":1,""" +
                """"minimum_reader_bundle_version":$minimumBundle}}"""
        val bodies = ArrayDeque(
            listOf(
                envelope(OFFLINE_READING_PACKAGE_SCHEMA_VERSION, OFFLINE_READING_READER_BUNDLE_VERSION),
                envelope(OFFLINE_READING_PACKAGE_SCHEMA_VERSION, OFFLINE_READING_READER_BUNDLE_VERSION - 1),
                envelope(OFFLINE_READING_PACKAGE_SCHEMA_VERSION, 0),
                envelope(OFFLINE_READING_PACKAGE_SCHEMA_VERSION - 1, OFFLINE_READING_READER_BUNDLE_VERSION),
                envelope(OFFLINE_READING_PACKAGE_SCHEMA_VERSION, OFFLINE_READING_READER_BUNDLE_VERSION + 1),
            )
        )
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                assertEquals("/api/offline-reading/account-binding", request.requestUrl!!.encodedPath)
                return MockResponse().setBody(bodies.removeFirst())
            }
        }
        val attestor = OfflineReadingAccountAttestor(cookieStore, loopbackOkClient())
        fun attest(): Result<UUID> {
            val answered = CountDownLatch(1)
            val outcome = AtomicReference<Result<UUID>>()
            attestor.attest { result ->
                outcome.set(result)
                answered.countDown()
            }
            assertTrue("attestation never answered", answered.await(20, TimeUnit.SECONDS))
            return outcome.get()
        }

        assertEquals(accountId, attest().getOrThrow())
        val earlier = attest()
        if (OFFLINE_READING_READER_BUNDLE_VERSION > 1) {
            assertTrue("an earlier positive bundle minimum must remain usable", earlier.isSuccess)
            assertEquals(accountId, earlier.getOrThrow())
        } else assertTrue(earlier.isFailure)
        assertTrue("a nonpositive bundle minimum must not bind", attest().isFailure)
        assertTrue("a package schema this build cannot install must not bind", attest().isFailure)
        assertTrue("a reader bundle newer than this build must not bind", attest().isFailure)
        assertEquals(5, server.requestCount)
    }

    private fun network(): Network = ShadowNetwork.newInstance(789)

    private companion object {
        val PREPARATION_STARTED_AT: Instant = Instant.parse("2026-08-13T18:05:00Z")
    }
}
