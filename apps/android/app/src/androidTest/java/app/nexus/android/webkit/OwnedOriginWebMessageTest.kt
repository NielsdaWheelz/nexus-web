package app.nexus.android.webkit

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class OwnedOriginWebMessageTest {
    @Test
    fun ownedOriginMatchesOnlyTheExactSchemeHostAndEffectivePort() {
        val ownedOrigin = OwnedOrigin("https://nexus.example")

        assertTrue(ownedOrigin.matches(Uri.parse("https://NEXUS.example/path?query=1")))
        assertTrue(ownedOrigin.matches(Uri.parse("https://nexus.example:443")))

        assertFalse(ownedOrigin.matches(Uri.parse("http://nexus.example")))
        assertFalse(ownedOrigin.matches(Uri.parse("https://sub.nexus.example")))
        assertFalse(ownedOrigin.matches(Uri.parse("https://nexus.example:444")))
        assertFalse(ownedOrigin.matches(Uri.parse("https://user@nexus.example")))
    }

    @Test
    fun listenerAcceptsOnlyOwnedTopFrameAndClosesTheDocumentGeneration() {
        assumeTrue(
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        )

        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val delivered = CopyOnWriteArrayList<OwnedWebMessage>()
        val pageLoaded = CountDownLatch(1)
        val topFrameDelivered = CountDownLatch(1)
        lateinit var webView: WebView
        lateinit var bridge: OwnedOriginWebMessage
        var loadedGeneration = 0L

        instrumentation.runOnMainSync {
            webView = WebView(ApplicationProvider.getApplicationContext())
            webView.settings.javaScriptEnabled = true
            val document = """
                <!doctype html>
                <html>
                  <body>Owned document</body>
                </html>
            """.trimIndent().toByteArray()
            webView.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? {
                    if (request.url.toString() != OWNED_DOCUMENT_URL) {
                        return null
                    }
                    return WebResourceResponse(
                        "text/html",
                        "UTF-8",
                        ByteArrayInputStream(document),
                    )
                }

                override fun onPageFinished(view: WebView, url: String) {
                    if (url == OWNED_DOCUMENT_URL) {
                        pageLoaded.countDown()
                    }
                }
            }
            bridge = OwnedOriginWebMessage(
                webView = webView,
                objectName = "nexusTestBridge",
                baseUrl = OWNED_DOCUMENT_URL,
            ) { message ->
                delivered += message
                topFrameDelivered.countDown()
            }
            assertTrue(bridge.install())
            loadedGeneration = bridge.onDocumentStarted()
            webView.loadUrl(OWNED_DOCUMENT_URL)
        }

        try {
            assertTrue(
                "Expected the owned document to finish loading.",
                pageLoaded.await(WEBVIEW_EVENT_TIMEOUT_SECONDS, TimeUnit.SECONDS),
            )
            instrumentation.runOnMainSync {
                webView.evaluateJavascript(
                    """
                        nexusTestBridge.postMessage("top");
                        const frame = document.createElement("iframe");
                        frame.srcdoc =
                          '<script>nexusTestBridge.postMessage("frame")<' + '/script>';
                        document.body.appendChild(frame);
                    """.trimIndent(),
                    null,
                )
            }
            assertTrue(
                "Expected the owned top frame to reach the native listener.",
                topFrameDelivered.await(
                    WEBVIEW_EVENT_TIMEOUT_SECONDS,
                    TimeUnit.SECONDS,
                ),
            )
            instrumentation.waitForIdleSync()
            Thread.sleep(WEBVIEW_SETTLE_MS)

            assertEquals(listOf("top"), delivered.map(OwnedWebMessage::data))
            assertEquals(loadedGeneration, delivered.single().documentGeneration)

            instrumentation.runOnMainSync {
                bridge.close()
                assertEquals(
                    loadedGeneration + 1,
                    bridge.currentDocumentGeneration(),
                )
                webView.evaluateJavascript(
                    """
                        if (window.nexusTestBridge) {
                          window.nexusTestBridge.postMessage("after-close");
                        }
                    """.trimIndent(),
                    null,
                )
            }
            instrumentation.waitForIdleSync()
            Thread.sleep(WEBVIEW_SETTLE_MS)

            assertEquals(listOf("top"), delivered.map(OwnedWebMessage::data))
        } finally {
            instrumentation.runOnMainSync {
                bridge.close()
                webView.destroy()
            }
        }
    }

    private companion object {
        const val OWNED_DOCUMENT_URL = "https://bridge.example/"
        const val WEBVIEW_EVENT_TIMEOUT_SECONDS = 10L
        const val WEBVIEW_SETTLE_MS = 250L
    }
}
