package app.nexus.android.offline

import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nexus.android.BuildConfig
import app.nexus.android.NexusWebView
import org.json.JSONTokener
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class OfflineMediaTest {
    @Test
    fun systemLimitFallbackIsAnExactDurableStoppedState() {
        val active = Download(
            DownloadRequest.Builder(
                "download-id",
                Uri.parse("https://media.example/episode.mp3"),
            ).build(),
            Download.STATE_DOWNLOADING,
            10,
            20,
            100,
            Download.STOP_REASON_NONE,
            Download.FAILURE_REASON_NONE,
        )

        val stopped = systemLimited(active)

        assertEquals(Download.STATE_STOPPED, stopped.state)
        assertEquals(OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON, stopped.stopReason)
        assertEquals(active.request, stopped.request)
        assertEquals(active.startTimeMs, stopped.startTimeMs)
        assertEquals(active.contentLength, stopped.contentLength)
    }

    @Test
    fun connectQueuedDuringManagerInitializationEventuallyReplies() {
        val store = OfflineMediaStore.get(ApplicationProvider.getApplicationContext())
        val connected = CountDownLatch(1)
        store.disconnect()

        store.connect(UUID.fromString("22222222-2222-4222-8222-222222222222")) { result ->
            val (_, policy) = result.getOrThrow()
            assertEquals(
                "expected the persisted default policy in the first Connected snapshot",
                NetworkPolicy.UnmeteredOnly,
                policy,
            )
            connected.countDown()
        }

        assertTrue(
            "expected Connect to resume after Media3 index initialization",
            connected.await(10, TimeUnit.SECONDS),
        )
        store.disconnect()
    }

    @Test
    fun webCapabilityIsInjectedOnlyAtTheExactOwnedOrigin() {
        withCapabilityPage(BuildConfig.NEXUS_BASE_URL) { webView ->
            assertEquals(
                "\"object\"",
                evaluate(webView, "typeof window.nexusOfflineMedia"),
            )
        }
        withCapabilityPage("https://off-origin.example") { webView ->
            assertEquals(
                "\"undefined\"",
                evaluate(webView, "typeof window.nexusOfflineMedia"),
            )
        }
    }

    @Test
    fun wrongProtocolVersionIsStrictlyRejectedInTheMainFrame() {
        withCapabilityPage(BuildConfig.NEXUS_BASE_URL) { webView ->
            evaluate(
                webView,
                """
                window._offlineReplies = [];
                window.nexusOfflineMedia.onmessage = event => window._offlineReplies.push(event.data);
                window.nexusOfflineMedia.postMessage(JSON.stringify({
                  kind: "GetSnapshot",
                  requestId: "11111111-1111-4111-8111-111111111111",
                  protocolVersion: 2
                }));
                true;
                """.trimIndent(),
            )
            waitUntil("expected an InvalidRequest reply for protocol version 2") {
                evaluate(webView, "window._offlineReplies.length") == "1"
            }
            val reply = JSONObject(
                JSONTokener(evaluate(webView, "window._offlineReplies[0]")).nextValue() as String
            )
            assertEquals("Rejected", reply.getJSONObject("outcome").getString("kind"))
            assertEquals("InvalidRequest", reply.getJSONObject("outcome").getString("code"))
        }
    }

    @Test
    fun platformDecoderRejectsLenientAndDuplicateJsonMembers() {
        val requestId = "11111111-1111-4111-8111-111111111111"
        listOf(
            """{'kind':'GetSnapshot','requestId':'$requestId','protocolVersion':1}""",
            """{"kind":"GetSnapshot","requestId":"$requestId","protocolVersion":1,}""",
            """{"kind":"GetSnapshot","requestId":"$requestId","request\u0049d":"$requestId","protocolVersion":1}""",
        ).forEach { raw ->
            assertEquals(
                "expected platform strict syntax rejection for $raw",
                CommandParseResult.Unreplyable,
                OfflineMediaWire.parseCommand(raw),
            )
        }
    }

    @Test
    fun sameOriginSubframeCannotIssueCommands() {
        withCapabilityPage(BuildConfig.NEXUS_BASE_URL) { webView ->
            evaluate(
                webView,
                """
                window._subframeReplied = false;
                const frame = document.createElement("iframe");
                frame.srcdoc = `<script>
                  nexusOfflineMedia.onmessage = () => parent._subframeReplied = true;
                  nexusOfflineMedia.postMessage(JSON.stringify({
                    kind: "GetSnapshot",
                    requestId: "11111111-1111-4111-8111-111111111111",
                    protocolVersion: 1
                  }));
                <\/script>`;
                document.body.appendChild(frame);
                true;
                """.trimIndent(),
            )
            Thread.sleep(500)
            assertFalse(
                "expected the native capability to ignore a same-origin subframe command",
                evaluate(webView, "window._subframeReplied") == "true",
            )
        }
    }

    private fun withCapabilityPage(
        origin: String,
        assertion: (WebView) -> Unit,
    ) {
        lateinit var webView: WebView
        lateinit var capability: OfflineMediaWebCapability
        val loaded = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView = WebView(ApplicationProvider.getApplicationContext())
            NexusWebView.configure(webView)
            capability = OfflineMediaWebCapability(webView) {}
            capability.install()
            webView.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    loaded.countDown()
                }
            }
            webView.loadDataWithBaseURL(
                "$origin/",
                "<!doctype html><html><body></body></html>",
                "text/html",
                "UTF-8",
                null,
            )
        }
        assertTrue("expected the WebView fixture to load", loaded.await(10, TimeUnit.SECONDS))
        try {
            assertion(webView)
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                capability.close()
                webView.destroy()
            }
        }
    }

    private fun evaluate(webView: WebView, script: String): String {
        val completed = CountDownLatch(1)
        var result = "null"
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView.evaluateJavascript(script) {
                result = it
                completed.countDown()
            }
        }
        assertTrue("expected JavaScript evaluation to finish", completed.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun waitUntil(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            if (condition()) {
                return
            }
            Thread.sleep(50)
        }
        throw AssertionError(message)
    }
}
