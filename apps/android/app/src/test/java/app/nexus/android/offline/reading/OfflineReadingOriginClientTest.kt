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
import org.junit.Assert.assertTrue
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
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
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
    private val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")
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

    private fun realSession(): OfflineReadingHttpSession {
        val hostedOrigin = BuildConfig.NEXUS_BASE_URL.toHttpUrl().requireOfflineReadingOrigin()
        val cookieStore = object : OfflineReadingOwnedOriginCookieStore {
            private val cookies = mutableMapOf(hostedOrigin.toString() to "nexus_session=host-test")
            override fun cookiesFor(origin: String): String? = cookies[origin]
            override fun install(origin: String, setCookie: String) {
                cookies[origin] = setCookie.substringBefore(';')
            }
            override fun flush() = Unit
        }
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
        val okClient = OkHttpClient.Builder()
            .socketFactory(loopbackRedirect)
            .dns(object : okhttp3.Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    listOf(InetAddress.getByName("127.0.0.1"))
            })
            .proxy(java.net.Proxy.NO_PROXY)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
        return OfflineReadingHttpSession(okClient, hostedOrigin, cookieStore)
    }

    private fun realClient(): HttpOfflineReadingOriginClient {
        val session = realSession()
        return HttpOfflineReadingOriginClient { _ -> session }
    }

    private fun serve(built: BuiltOfflineReadingPackage, baselineGeneration: Long) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/media/$mediaId/offline-reading-token" -> MockResponse()
                        .setResponseCode(200)
                        .setBody(
                            """{"data":{"token":"tok-1","package_base_url":""" +
                                """"${BuildConfig.NEXUS_API_ORIGIN}","account_id":"$accountId",""" +
                                """"reader_generation":${built.readerGeneration},""" +
                                """"package_schema_version":1,""" +
                                """"expires_at":"2026-08-17T19:00:00Z"}}"""
                        )
                    path == "/offline-reading/packages/$mediaId" -> MockResponse()
                        .setResponseCode(200)
                        .setHeader("Content-Type", "application/vnd.nexus.offline-reading+zip")
                        .setHeader("Nexus-Expanded-Length", built.expandedBytes.toString())
                        .setHeader("Nexus-Account-Id", accountId.toString())
                        .setHeader("Nexus-Reader-Generation", built.readerGeneration.toString())
                        .setHeader(
                            "Content-Digest",
                            "sha-256=:" + Base64.getEncoder().encodeToString(
                                java.security.MessageDigest.getInstance("SHA-256")
                                    .digest(built.archiveBytes)
                            ) + ":",
                        )
                        .setBody(Buffer().write(built.archiveBytes))
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
    fun `account attestation accepts reader2 and rejects old reader or bundle handshakes`() {
        val session = realSession()
        val attestor = OfflineReadingAccountAttestor(session.cookieStore, session.client)
        for ((reader, bundle) in listOf(2 to 2, 1 to 2, 2 to 1)) {
            server.enqueue(
                MockResponse().setBody(
                    """{"data":{"account_id":"$accountId","protocol_version":1,""" +
                        """"package_schema_version":1,"reader_contract_version":$reader,""" +
                        """"minimum_reader_bundle_version":$bundle}}"""
                )
            )
            val result = CompletableFuture<Result<UUID>>()
            attestor.attest { result.complete(it) }
            val account = result.get(5, TimeUnit.SECONDS)
            if (reader == 2 && bundle == 2) {
                assertEquals(accountId, account.getOrThrow())
            } else {
                assertTrue("reader $reader / bundle $bundle must require an update", account.isFailure)
            }
        }
    }

    @Test
    fun `real client downloads a conforming package that the real verifier then accepts`() {
        val built = buildWebArticleReadingPackage(mediaId, "Verified copy")
        serve(built, baselineGeneration = built.readerGeneration)
        val destination = File(workDirectory, ".staging").apply { check(mkdirs()) }
            .resolve("staging-1.zip")
        ShadowStatFs.registerStats(destination.parentFile, 4_000_000, 4_000_000, 4_000_000)
        val client = realClient()
        var lastProgress = -1L to -1L

        val artifact = OfflineReadingTransferOperations.register(transfer.id).use { operation ->
            client.downloadPackage(
                transfer,
                accountId,
                network(),
                destination,
                operation,
            ) { received, total -> lastProgress = received to total }
        }

        assertEquals(built.packageSha256, artifact.packageSha256)
        assertEquals(built.readerGeneration, artifact.readerGeneration)
        assertArrayEquals(built.archiveBytes, destination.readBytes())
        assertEquals(built.archiveBytes.size.toLong() to built.archiveBytes.size.toLong(), lastProgress)
        // Install step 5 evidence: downloading never touches the reader-state endpoint,
        // so verification can fully precede the baseline fetch.
        assertEquals(2, server.requestCount)
        assertEquals(
            "/api/media/$mediaId/offline-reading-token",
            server.takeRequest().requestUrl!!.encodedPath,
        )
        assertEquals(
            "/offline-reading/packages/$mediaId",
            server.takeRequest().requestUrl!!.encodedPath,
        )

        // The real verifier accepts the downloaded artifact end to end.
        val verified = OfflineReadingPackageVerifier().verifyAndExtract(
            artifact,
            accountId,
            mediaId,
            File(workDirectory, "verified"),
        )
        assertArrayEquals(
            built.readerJson,
            verified.extractedDirectory.resolve("reader.json").readBytes(),
        )

        // Install step 6 is a separate later call.
        val baseline = OfflineReadingTransferOperations.register(transfer.id).use { operation ->
            client.fetchBaseline(
                transfer,
                accountId,
                network(),
                built.readerGeneration,
                operation,
            )
        }
        assertEquals(accountId, baseline.accountId)
        assertEquals(built.readerGeneration, baseline.readerGeneration)
        assertEquals(3, server.requestCount)
        assertEquals(
            "/api/media/$mediaId/offline-reader-state",
            server.takeRequest().requestUrl!!.encodedPath,
        )
    }

    @Test
    fun `baseline generation drift during install maps to ContentChanged not Integrity`() {
        val built = buildWebArticleReadingPackage(mediaId, "Verified copy")
        serve(built, baselineGeneration = built.readerGeneration + 1)
        val client = realClient()

        val error = assertThrows(OfflineReadingOriginException::class.java) {
            OfflineReadingTransferOperations.register(transfer.id).use { operation ->
                client.fetchBaseline(
                    transfer,
                    accountId,
                    network(),
                    built.readerGeneration,
                    operation,
                )
            }
        }

        assertEquals(ReadingFailureReason.ContentChanged, error.reason)
    }

    private fun network(): Network = ShadowNetwork.newInstance(789)
}
