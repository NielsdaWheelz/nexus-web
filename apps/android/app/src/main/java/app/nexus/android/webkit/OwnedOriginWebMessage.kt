package app.nexus.android.webkit

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.IdentityHashMap
import java.util.concurrent.atomic.AtomicLong

internal const val OWNED_WEB_MESSAGE_LIMIT_BYTES = 64 * 1024

internal data class OwnedWebMessage(
    val data: String,
    val replyProxy: JavaScriptReplyProxy,
    /** Exact origin of the document that sent this message. */
    val sourceOrigin: Uri,
    /** Navigation generation of the document that sent it, not of the delivery. */
    val documentGeneration: Long,
)

/**
 * Binds every inbound reply channel to the navigation generation that was
 * current when its document first spoke. Delivery order is not ordered against
 * `onPageStarted`, so stamping a message with the generation observed at
 * delivery time would let a superseded document's late message claim the
 * current document's identity.
 *
 * Keys are compared by identity: one WebView document owns exactly one reply
 * proxy instance. A known channel is retained for this capability's lifetime;
 * evicting it would let a superseded document be re-stamped as current after
 * enough navigations. Only the UI thread touches this map.
 */
internal class OwnedDocumentChannels {
    private val generations = IdentityHashMap<Any, Long>()

    fun generationOf(channel: Any, currentGeneration: Long): Long =
        generations.getOrPut(channel) { currentGeneration }
}

internal class OwnedOrigin(baseUrl: String) {
    private val origin = Uri.parse(baseUrl)

    val rule: String = URI(
        origin.scheme,
        null,
        origin.host,
        origin.port,
        null,
        null,
        null,
    ).toString()

    init {
        require(origin.scheme == "http" || origin.scheme == "https")
        require(origin.host != null)
        require(origin.userInfo == null)
        require(origin.path.isNullOrEmpty() || origin.path == "/")
        require(origin.query == null)
        require(origin.fragment == null)
    }

    fun matches(candidate: Uri): Boolean {
        val scheme = candidate.scheme ?: return false
        val host = candidate.host ?: return false
        return scheme == origin.scheme &&
            host.equals(origin.host, ignoreCase = true) &&
            effectivePort(candidate) == effectivePort(origin) &&
            candidate.userInfo == null
    }

    private fun effectivePort(uri: Uri): Int {
        return when {
            uri.port != -1 -> uri.port
            uri.scheme == "https" -> 443
            else -> 80
        }
    }
}

/**
 * Exact AndroidX WebKit framing for one semantic protocol. Domain decoding,
 * account state, and command dispatch remain with the protocol owner.
 */
internal class OwnedOriginWebMessage(
    private val webView: WebView,
    private val objectName: String,
    baseUrls: Set<String>,
    private val onMessage: (OwnedWebMessage) -> Unit,
) {
    constructor(
        webView: WebView,
        objectName: String,
        baseUrl: String,
        onMessage: (OwnedWebMessage) -> Unit,
    ) : this(webView, objectName, setOf(baseUrl), onMessage)

    private val ownedOrigins = baseUrls.map(::OwnedOrigin)
    private val documentGeneration = AtomicLong(0)
    private val channels = OwnedDocumentChannels()
    private var installed = false

    fun install(): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return false
        }
        WebViewCompat.addWebMessageListener(
            webView,
            objectName,
            ownedOrigins.mapTo(mutableSetOf()) { it.rule },
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            if (
                !isMainFrame ||
                ownedOrigins.none { it.matches(sourceOrigin) } ||
                message.type != WebMessageCompat.TYPE_STRING
            ) {
                return@addWebMessageListener
            }
            val data = message.data ?: return@addWebMessageListener
            if (data.toByteArray(StandardCharsets.UTF_8).size > OWNED_WEB_MESSAGE_LIMIT_BYTES) {
                return@addWebMessageListener
            }
            onMessage(
                OwnedWebMessage(
                    data = data,
                    replyProxy = replyProxy,
                    sourceOrigin = sourceOrigin,
                    documentGeneration = channels.generationOf(replyProxy, documentGeneration.get()),
                )
            )
        }
        installed = true
        return true
    }

    fun onDocumentStarted(): Long = documentGeneration.incrementAndGet()

    fun currentDocumentGeneration(): Long = documentGeneration.get()

    fun close() {
        documentGeneration.incrementAndGet()
        if (
            installed &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) {
            WebViewCompat.removeWebMessageListener(webView, objectName)
        }
        installed = false
    }
}
