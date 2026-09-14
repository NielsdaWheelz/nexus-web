package app.nexus.android.offline.readingweb

import android.net.Uri
import android.content.Context
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.offline.OfflineMediaStore
import app.nexus.android.offline.reading.NativeReaderProgressView
import app.nexus.android.offline.reading.OfflineReadingAccountTransitionView
import app.nexus.android.offline.reading.OfflineReadingAvailability
import app.nexus.android.offline.reading.OfflineReadingBindingView
import app.nexus.android.offline.reading.OfflineReadingItemSnapshot
import app.nexus.android.offline.reading.OfflineReadingLease
import app.nexus.android.offline.reading.OfflineReadingMediaKind
import app.nexus.android.offline.reading.OfflineReadingStore
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.reading.ReadingStoreSnapshot
import app.nexus.android.webkit.OwnedDocumentChannels
import app.nexus.android.webkit.OwnedOrigin
import app.nexus.android.webkit.OwnedWebMessage
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.lang.reflect.Proxy
import java.time.Instant
import java.util.UUID
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingRequestRouterTest {
    @Test
    fun `malformed enqueue fields are invalid requests before store dispatch`() {
        val valid = JSONObject()
            .put("protocolVersion", 1)
            .put("requestId", "018f2e74-5efc-7d8e-8a3a-142857142857")
            .put("kind", "Enqueue")
            .put("mediaId", "018f2e74-5efc-7d1e-8a3a-142857142857")
            .put("requestedTitle", "Plane Notes")
            .put("mediaKind", "Epub")
            .put("readerGeneration", 1)
        assertEquals(true, offlineReadingCommandIsValid(valid, "Enqueue"))
        listOf(
            JSONObject(valid.toString()).put("mediaKind", "Audio"),
            JSONObject(valid.toString()).put("requestedTitle", "   "),
            JSONObject(valid.toString()).put("extra", true),
            JSONObject(valid.toString()).put("mediaId", "not-a-uuid"),
        ).forEach { mutation ->
            assertEquals(false, offlineReadingCommandIsValid(mutation, "Enqueue"))
        }
        assertNull(offlineReadingCommandKind(JSONObject(valid.toString()).apply { remove("kind") }))
        assertNull(offlineReadingCommandKind(JSONObject(valid.toString()).put("kind", 42)))
    }

    @Test
    fun `process recovery preserves pending switch while durable logout wins over a stale cookie`() {
        val attested = UUID.fromString("22222222-2222-4222-8222-222222222222")
        val foreign = UUID.fromString("33333333-3333-4333-8333-333333333333")

        assertEquals(
            OfflineReadingRecoveryStep.FinishLogout,
            hostedRecoveryStep(OfflineReadingAccountTransitionView.Logout, attested),
        )
        assertEquals(
            OfflineReadingRecoveryStep.ConnectTarget(attested),
            hostedRecoveryStep(OfflineReadingAccountTransitionView.AccountSwitch(attested), attested),
        )
        assertEquals(
            OfflineReadingRecoveryStep.RejectForeignTransition,
            hostedRecoveryStep(OfflineReadingAccountTransitionView.AccountSwitch(foreign), attested),
        )
        assertEquals(
            OfflineReadingRecoveryStep.ConnectTarget(foreign),
            offlineRecoveryStep(OfflineReadingAccountTransitionView.AccountSwitch(foreign)),
        )
    }

    @Test
    fun `session gate serializes connect commands and permits only a safe logout retry`() {
        listOf("Enqueue", "GetSnapshot", "LogoutAndPurge").forEach { kind ->
            assertEquals(
                "NotConnected",
                offlineReadingSessionRejection(
                    OfflineReadingSessionState.Disconnected,
                    kind,
                    connectedReplyAvailable = false,
                ),
            )
        }
        assertNull(
            offlineReadingSessionRejection(
                OfflineReadingSessionState.Disconnected,
                "ConnectHosted",
                connectedReplyAvailable = false,
            ),
        )
        listOf("ConnectHosted", "ConnectOffline").forEach { kind ->
            assertEquals(
                "Busy",
                offlineReadingSessionRejection(
                    OfflineReadingSessionState.Connecting,
                    kind,
                    connectedReplyAvailable = false,
                ),
            )
        }
        listOf("Enqueue", "GetSnapshot", "LogoutAndPurge").forEach { kind ->
            assertNull(
                offlineReadingSessionRejection(
                    OfflineReadingSessionState.Connected,
                    kind,
                    connectedReplyAvailable = true,
                ),
            )
        }
        assertEquals(
            "NotConnected",
            offlineReadingSessionRejection(
                OfflineReadingSessionState.Connected,
                "GetSnapshot",
                connectedReplyAvailable = false,
            ),
        )
        listOf("ConnectHosted", "GetSnapshot", "Enqueue", "LogoutAndPurge").forEach { kind ->
            assertEquals(
                "Busy",
                offlineReadingSessionRejection(
                    OfflineReadingSessionState.LoggingOut,
                    kind,
                    connectedReplyAvailable = true,
                ),
            )
        }
        assertNull(
            offlineReadingSessionRejection(
                OfflineReadingSessionState.LogoutRetry,
                "LogoutAndPurge",
                connectedReplyAvailable = true,
            ),
        )
        listOf("ConnectOffline", "GetSnapshot", "Enqueue").forEach { kind ->
            assertEquals(
                "Busy",
                offlineReadingSessionRejection(
                    OfflineReadingSessionState.LogoutRetry,
                    kind,
                    connectedReplyAvailable = true,
                ),
            )
        }
    }

    @Test
    fun `cold local open defers until reconciliation and publishes only a ready target`() {
        val mediaId = UUID.fromString("018f2e74-5efc-7d1e-8a3a-142857142857")
        val empty = ReadingStoreSnapshot(
            binding = OfflineReadingBindingView.Absent,
            networkPolicy = NetworkPolicy.UnmeteredOnly,
            items = emptyList(),
        )
        val ready = empty.copy(
            items = listOf(
                OfflineReadingItemSnapshot.PackageItem(
                    mediaId = mediaId,
                    title = "Plane Notes",
                    mediaKind = OfflineReadingMediaKind.Epub,
                    readerGeneration = 1,
                    readerRevisionKey = "a".repeat(64),
                    availability = OfflineReadingAvailability.Ready(
                        sizeBytes = 1,
                        installedAt = Instant.EPOCH,
                        progress = NativeReaderProgressView.Canonical("{}"),
                    ),
                ),
            ),
        )

        assertEquals(
            OfflineLocalOpenDisposition.Defer,
            offlineLocalOpenDisposition(mediaId, empty, reconciliationPending = true),
        )
        assertEquals(mediaId, validatedPendingLocalOpen(mediaId, ready))
        assertNull(validatedPendingLocalOpen(mediaId, empty))
        // A deferred open reconciliation cannot satisfy goes back to Android so
        // the launch link is offered instead of dropped.
        assertEquals(
            true,
            deferredLocalOpenUnavailable(mediaId, validatedPendingLocalOpen(mediaId, empty)),
        )
        assertEquals(
            false,
            deferredLocalOpenUnavailable(mediaId, validatedPendingLocalOpen(mediaId, ready)),
        )
        assertEquals(false, deferredLocalOpenUnavailable(null, null))
        assertEquals(
            OfflineLocalOpenDisposition.Ready,
            offlineLocalOpenDisposition(mediaId, ready, reconciliationPending = false),
        )
    }

    @Test
    fun `aggregate policy applies reading before audio and same-value retry converges after audio failure`() {
        val calls = mutableListOf<String>()
        val results = mutableListOf<Result<Unit>>()
        var failAudio = true
        val apply = {
            applyOfflineNetworkPolicy(
                NetworkPolicy.AnyConnected,
                applyReading = {
                    calls += "reading:${it.name}"
                },
                applyAudio = { policy, callback ->
                    calls += "audio:${policy.name}"
                    callback(
                        if (failAudio) Result.failure(IllegalStateException("injected"))
                        else Result.success(Unit)
                    )
                },
                completed = results::add,
            )
        }

        apply()
        failAudio = false
        apply()

        assertEquals(
            listOf(
                "reading:AnyConnected", "audio:AnyConnected",
                "reading:AnyConnected", "audio:AnyConnected",
            ),
            calls,
        )
        assertEquals(true, results[0].isFailure)
        assertEquals(true, results[1].isSuccess)
    }

    @Test
    fun `hosted connect accepts only reconciled matching authorized binding`() {
        val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
        fun snapshot(binding: OfflineReadingBindingView) = ReadingStoreSnapshot(
            binding = binding,
            networkPolicy = NetworkPolicy.UnmeteredOnly,
            items = emptyList(),
        )

        assertEquals(
            true,
            hostedReconciledSnapshotAccepted(
                snapshot(OfflineReadingBindingView.Present(accountId, authorizationRequired = false)),
                accountId,
            ),
        )
        assertEquals(
            false,
            hostedReconciledSnapshotAccepted(
                snapshot(OfflineReadingBindingView.Present(accountId, authorizationRequired = true)),
                accountId,
            ),
        )
        assertEquals(false, hostedReconciledSnapshotAccepted(snapshot(OfflineReadingBindingView.Absent), accountId))
    }

    @Test
    fun `hosted open-downloaded-copy command is rejected by offline document`() {
        assertEquals(true, offlineReadingCommandAllowed("OpenDownloadedCopy", false))
        assertEquals(false, offlineReadingCommandAllowed("OpenDownloadedCopy", true))
        assertEquals(false, offlineReadingCommandAllowed("OpenHosted", false))
        assertEquals(true, offlineReadingCommandAllowed("OpenHosted", true))
    }

    @Test
    fun `exact main URL opens the packaged shell asset`() {
        val context: Context = RuntimeEnvironment.getApplication()
        val router = OfflineReadingRequestRouter(
            context,
            OfflineReadingLeaseRegistry { },
        )
        val request = Proxy.newProxyInstance(
            WebResourceRequest::class.java.classLoader,
            arrayOf(WebResourceRequest::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "getUrl" -> Uri.parse(OFFLINE_READING_MAIN_URL)
                "getRequestHeaders" -> emptyMap<String, String>()
                "isForMainFrame" -> true
                "hasGesture" -> false
                "getMethod" -> "GET"
                "isRedirect" -> false
                else -> null
            }
        } as WebResourceRequest

        val response = router.intercept(request)
        assertEquals(200, response?.statusCode)
        val html = response?.data?.bufferedReader()?.use { it.readText() }.orEmpty()
        assertEquals(true, html.contains("Content-Security-Policy"))
    }

    @Test
    fun `reserved origin rejects every origin and URL decoration mutation`() {
        assertEquals(
            true,
            isOfflineReadingReservedOrigin(
                Uri.parse("https://appassets.androidplatform.net/nexus-offline/index.html"),
            ),
        )
        listOf(
            "http://appassets.androidplatform.net/nexus-offline/index.html",
            "https://appassets.androidplatform.net:444/nexus-offline/index.html",
            "https://attacker.example/nexus-offline/index.html",
            "https://appassets.androidplatform.net/nexus-offline/index.html?remote=1",
            "https://appassets.androidplatform.net/nexus-offline/index.html#remote",
        ).forEach { mutation ->
            assertEquals(false, isOfflineReadingReservedOrigin(Uri.parse(mutation)))
        }
        assertEquals(true, isOfflineReadingMainFrameUrl(Uri.parse(OFFLINE_READING_MAIN_URL)))
        assertEquals(
            false,
            isOfflineReadingMainFrameUrl(Uri.parse("https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/descriptor.json")),
        )
    }

    @Test
    fun `reserved host routes only exact static and unguessable lease paths`() {
        assertEquals(
            OfflineReadingLocalPath.Static("index.html"),
            parseOfflineReadingLocalPath("/nexus-offline/index.html"),
        )
        assertEquals(
            OfflineReadingLocalPath.Lease(
                "018f2e745efc7d8e8a3a142857142857",
                "descriptor.json",
            ),
            parseOfflineReadingLocalPath(
                "/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/descriptor.json",
            ),
        )
        assertNull(parseOfflineReadingLocalPath("/nexus-offline/lease/018F2E745EFC7D8E8A3A142857142857/descriptor.json"))
        assertNull(parseOfflineReadingLocalPath("/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/../descriptor.json"))
        assertNull(parseOfflineReadingLocalPath("/nexus-offline/index.html/extra"))
    }

    @Test
    fun `one bounded byte range is accepted and every ambiguous range is closed`() {
        assertEquals(OfflineByteRange(0, 9), parseOfflineByteRange("bytes=0-9", 100))
        assertEquals(OfflineByteRange(90, 99), parseOfflineByteRange("bytes=90-", 100))
        assertNull(parseOfflineByteRange("bytes=-10", 100))
        assertNull(parseOfflineByteRange("bytes=0-9,20-29", 100))
        assertNull(parseOfflineByteRange("bytes=100-", 100))
        assertNull(parseOfflineByteRange("items=0-9", 100))
    }

    @Test
    fun `every unroutable reserved-host request answers a closed local 404 instead of a network load`() {
        val router = OfflineReadingRequestRouter(
            RuntimeEnvironment.getApplication(),
            OfflineReadingLeaseRegistry { },
        )

        listOf(
            // Decorated forms of the reserved origin: a null here would hand the
            // reserved name back to the WebView network stack.
            "https://appassets.androidplatform.net/nexus-offline/index.html?remote=1",
            "https://appassets.androidplatform.net/nexus-offline/index.html#remote",
            "https://appassets.androidplatform.net:444/nexus-offline/index.html",
            "https://user@appassets.androidplatform.net/nexus-offline/index.html",
            "http://appassets.androidplatform.net/nexus-offline/index.html",
            // Owned host, but nothing the package serves.
            "https://appassets.androidplatform.net/nexus-offline/assets/missing-asset.js",
            "https://appassets.androidplatform.net/elsewhere",
            "https://appassets.androidplatform.net/nexus-offline/lease/018f2e745efc7d8e8a3a142857142857/descriptor.json",
        ).forEach { url ->
            val response = router.intercept(localRequest(url))
            assertEquals("$url must be answered locally", 404, response?.statusCode)
            assertEquals("$url must not carry package bytes", "text/plain", response?.mimeType)
        }

        assertNull(
            "requests off the reserved host stay with the WebView",
            router.intercept(localRequest("https://nexus.example.test/media/1")),
        )
    }

    @Test
    fun `declared extensionless PDF MIME enables seeking and undeclared files remain private`() {
        val directory = createTempDirectory("offline-reading-lease").toFile()
        val bytes = ByteArray(64) { index -> (index + 1).toByte() }
        File(directory, "assets").mkdir()
        File(directory, "assets/document").writeBytes(bytes)
        File(directory, "assets/undeclared").writeText("private")
        File(directory, "descriptor.json").writeText("{}")
        val registry = OfflineReadingLeaseRegistry { }
        val capability = registry.publish(lease(directory))
        val router = OfflineReadingRequestRouter(
            RuntimeEnvironment.getApplication(),
            registry,
        )
        val pdfUrl = "https://appassets.androidplatform.net/nexus-offline/lease/$capability/assets/document"

        val full = router.intercept(localRequest(pdfUrl))
        assertEquals(200, full?.statusCode)
        assertEquals(
            "the packaged reader only issues ranges when the first response says bytes",
            "bytes",
            full?.responseHeaders?.get("Accept-Ranges"),
        )

        assertEquals("application/pdf", full?.mimeType)
        assertEquals(bytes.toList(), full?.data?.use { it.readBytes() }?.toList())
        assertEquals(404, router.intercept(localRequest(pdfUrl.replace("assets/document", "assets/undeclared")))?.statusCode)
        val ranged = router.intercept(localRequest(pdfUrl, range = "bytes=8-11"))
        assertEquals(206, ranged?.statusCode)
        assertEquals("bytes 8-11/64", ranged?.responseHeaders?.get("Content-Range"))
        assertEquals(
            listOf<Byte>(9, 10, 11, 12),
            ranged?.data?.use { it.readBytes() }?.toList(),
        )

        // A resource the lease serves whole must not claim range support it refuses.
        val descriptor = router.intercept(
            localRequest("https://appassets.androidplatform.net/nexus-offline/lease/$capability/descriptor.json"),
        )
        assertEquals("none", descriptor?.responseHeaders?.get("Accept-Ranges"))
        assertEquals(
            416,
            router.intercept(
                localRequest(
                    "https://appassets.androidplatform.net/nexus-offline/lease/$capability/descriptor.json",
                    range = "bytes=0-1",
                ),
            )?.statusCode,
        )
        directory.deleteRecursively()
    }

    @Test
    fun `an unavailable account binding rejects hosted connect and raises the Android downloaded-copies affordance`() {
        val affordances = mutableListOf<Unit>()
        val proxy = RecordingReplyProxy()
        val capability = capability(
            attestHostedAccount = { completed ->
                completed(Result.failure(java.io.IOException("account-binding endpoint unavailable")))
            },
            onHostedConnectUnavailable = { affordances += Unit },
        )
        capability.onPageStarted(BuildConfig.NEXUS_BASE_URL)
        val requestId = UUID.fromString("018f2e74-5efc-7d8e-8a3a-142857142857")

        capability.receive(
            hostedMessage(proxy, command("ConnectHosted", requestId), generation = 1),
        )
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(
            "the hosted renderer must learn the binding is unavailable",
            "AuthorizationRequired",
            proxy.outcomes(requestId).single().optString("code"),
        )
        assertEquals(
            "only Android may offer the shelf to an unattested hosted renderer",
            1,
            affordances.size,
        )
        capability.close()
    }

    @Test
    fun `a superseded document's late message cannot claim the active document's identity`() {
        val shellOrigin = OwnedOrigin("https://$OFFLINE_READING_ASSET_HOST")
        val hostedOrigin = OwnedOrigin(BuildConfig.NEXUS_BASE_URL)

        assertEquals(
            OfflineReadingDocument.Shell,
            offlineReadingMessageDocument(Uri.parse("https://$OFFLINE_READING_ASSET_HOST"), shellOrigin, hostedOrigin),
        )
        assertEquals(
            OfflineReadingDocument.Hosted,
            offlineReadingMessageDocument(Uri.parse(BuildConfig.NEXUS_BASE_URL), shellOrigin, hostedOrigin),
        )
        assertNull(
            offlineReadingMessageDocument(Uri.parse("https://attacker.example"), shellOrigin, hostedOrigin),
        )

        // The hosted document spoke first, so its channel keeps generation 1 even
        // when its message is delivered after the shell document started.
        val channels = OwnedDocumentChannels()
        val hostedChannel = Any()
        val shellChannel = Any()
        assertEquals(1L, channels.generationOf(hostedChannel, 1))
        assertEquals(1L, channels.generationOf(hostedChannel, 2))
        assertEquals(2L, channels.generationOf(shellChannel, 2))
        repeat(32) { index ->
            channels.generationOf(Any(), 3L + index)
        }
        assertEquals(
            "a known superseded channel must remain fenced for the capability lifetime",
            1L,
            channels.generationOf(hostedChannel, 35),
        )

        assertEquals(
            "a hosted message delivered while the shell is active is not the shell",
            false,
            offlineReadingMessageAdmitted(
                messageDocument = OfflineReadingDocument.Hosted,
                messageGeneration = 2,
                activeDocument = OfflineReadingDocument.Shell,
                currentGeneration = 2,
            ),
        )
        assertEquals(
            "a superseded shell document cannot speak for the current one",
            false,
            offlineReadingMessageAdmitted(
                messageDocument = OfflineReadingDocument.Shell,
                messageGeneration = 1,
                activeDocument = OfflineReadingDocument.Shell,
                currentGeneration = 2,
            ),
        )
        assertEquals(
            true,
            offlineReadingMessageAdmitted(
                messageDocument = OfflineReadingDocument.Shell,
                messageGeneration = 2,
                activeDocument = OfflineReadingDocument.Shell,
                currentGeneration = 2,
            ),
        )
    }

    @Test
    fun `a hosted document's late ConnectOffline neither answers nor takes the shell session`() {
        val hostedProxy = RecordingReplyProxy()
        val shellProxy = RecordingReplyProxy()
        val capability = capability(
            attestHostedAccount = { completed ->
                completed(Result.failure(java.io.IOException("hosted attestation must not run here")))
            },
            onHostedConnectUnavailable = { },
        )
        val hostedRequestId = UUID.fromString("018f2e74-5efc-7d8e-8a3a-142857142857")
        val shellRequestId = UUID.fromString("018f2e74-5efc-7d8e-8a3a-142857142858")

        capability.onPageStarted(BuildConfig.NEXUS_BASE_URL)
        capability.onPageStarted(OFFLINE_READING_MAIN_URL)
        // Delivered after the shell document started, but sent by the hosted one.
        // The generation equals the current one — a delivery-time stamp cannot
        // tell the documents apart, so admission must classify by source origin.
        capability.receive(
            hostedMessage(hostedProxy, command("ConnectOffline", hostedRequestId), generation = 2),
        )
        shadowOf(Looper.getMainLooper()).idle()
        capability.receive(
            shellMessage(shellProxy, command("ConnectOffline", shellRequestId), generation = 2),
        )
        shadowOf(Looper.getMainLooper()).idle()

        assertTrue(
            "the hosted document must not receive shelf inventory or any reply",
            hostedProxy.messages.isEmpty(),
        )
        assertTrue(
            "the shell session must still be free to connect, got ${shellProxy.messages}",
            shellProxy.outcomes(shellRequestId).none { it.optString("code") == "Busy" },
        )
        capability.close()
    }

    private fun capability(
        attestHostedAccount: ((Result<UUID>) -> Unit) -> Unit,
        onHostedConnectUnavailable: () -> Unit,
    ): OfflineReadingWebCapability {
        val context: Context = RuntimeEnvironment.getApplication()
        val store = OfflineReadingStore.get(context)
        return OfflineReadingWebCapability(
            webView = WebView(context),
            store = store,
            leases = OfflineReadingLeaseRegistry(store::closeLease),
            attestHostedAccount = attestHostedAccount,
            audioStore = OfflineMediaStore.get(context),
            openHosted = { },
            openOffline = { },
            onLogout = { },
            onHostedConnectUnavailable = onHostedConnectUnavailable,
        )
    }

    private fun command(kind: String, requestId: UUID): String = JSONObject()
        .put("protocolVersion", 1)
        .put("requestId", requestId.toString())
        .put("kind", kind)
        .toString()

    private fun hostedMessage(proxy: JavaScriptReplyProxy, data: String, generation: Long) =
        OwnedWebMessage(
            data = data,
            replyProxy = proxy,
            sourceOrigin = Uri.parse(BuildConfig.NEXUS_BASE_URL),
            documentGeneration = generation,
        )

    private fun shellMessage(proxy: JavaScriptReplyProxy, data: String, generation: Long) =
        OwnedWebMessage(
            data = data,
            replyProxy = proxy,
            sourceOrigin = Uri.parse("https://$OFFLINE_READING_ASSET_HOST"),
            documentGeneration = generation,
        )

    private fun lease(directory: File) = OfflineReadingLease(
        id = UUID.fromString("018f2e74-5efc-7d2e-8a3a-142857142857"),
        mediaId = UUID.fromString("018f2e74-5efc-7d1e-8a3a-142857142857"),
        readerGeneration = 1,
        readerRevisionKey = "a".repeat(64),
        installedAt = Instant.EPOCH,
        progress = NativeReaderProgressView.Canonical("{}"),
        packageDirectory = directory,
        memberMediaTypes = mapOf("descriptor.json" to "application/json", "assets/document" to "application/pdf"),
    )

    private fun localRequest(url: String, range: String? = null): WebResourceRequest =
        Proxy.newProxyInstance(
            WebResourceRequest::class.java.classLoader,
            arrayOf(WebResourceRequest::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "getUrl" -> Uri.parse(url)
                "getRequestHeaders" -> range?.let { mapOf("range" to it) } ?: emptyMap<String, String>()
                "isForMainFrame" -> false
                "hasGesture" -> false
                "getMethod" -> "GET"
                "isRedirect" -> false
                else -> null
            }
        } as WebResourceRequest
}

/** Records what the production capability posts back to one WebView document. */
private class RecordingReplyProxy : JavaScriptReplyProxy() {
    val messages = mutableListOf<String>()

    override fun postMessage(message: String) {
        messages += message
    }

    override fun postMessage(message: ByteArray) =
        throw UnsupportedOperationException("the offline-reading protocol is string-only")

    fun outcomes(requestId: UUID): List<JSONObject> = messages
        .map(::JSONObject)
        .filter { it.optString("requestId") == requestId.toString() }
        .map { it.getJSONObject("outcome") }
}
