package app.nexus.android.offline

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.nexus.android.BuildConfig
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.UUID

private const val OFFLINE_MEDIA_WEB_OBJECT = "nexusOfflineMedia"
private const val OFFLINE_MEDIA_ROUTE_PREFIX = "/_native/offline-media/"

internal fun canonicalOriginRule(baseUrl: String): String {
    val uri = URI(baseUrl)
    return URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString()
}

internal class OfflineMediaWebCapability(
    private val webView: WebView,
    private val requestNotificationPermission: () -> Unit,
) : OfflineMediaStore.Listener {
    private val store = OfflineMediaStore.get(webView.context)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ownedOrigin = Uri.parse(BuildConfig.NEXUS_BASE_URL)

    @Volatile
    private var replyProxy: JavaScriptReplyProxy? = null
    @Volatile
    private var documentGeneration = 0L
    @Volatile
    private var connectionGeneration = 0L
    private var installed = false

    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return
        }
        WebViewCompat.addWebMessageListener(
            webView,
            OFFLINE_MEDIA_WEB_OBJECT,
            setOf(canonicalOriginRule(BuildConfig.NEXUS_BASE_URL)),
        ) { _, message, sourceOrigin, isMainFrame, commandReplyProxy ->
            if (
                !isMainFrame ||
                !isExactOwnedOrigin(sourceOrigin) ||
                message.type != WebMessageCompat.TYPE_STRING
            ) {
                return@addWebMessageListener
            }
            val raw = message.data ?: return@addWebMessageListener
            when (val parsed = OfflineMediaWire.parseCommand(raw)) {
                is CommandParseResult.Accepted ->
                    dispatch(parsed.command, commandReplyProxy)
                is CommandParseResult.Rejected ->
                    commandReplyProxy.postMessage(
                        OfflineMediaWire.rejected(
                            parsed.requestId,
                            RejectionCode.InvalidRequest,
                        )
                    )
                CommandParseResult.Unreplyable -> Unit
            }
        }
        store.addListener(this)
        installed = true
    }

    fun onPageStarted() {
        documentGeneration += 1
        connectionGeneration += 1
        replyProxy = null
        store.disconnect()
    }

    fun close() {
        documentGeneration += 1
        connectionGeneration += 1
        replyProxy = null
        store.disconnect()
        store.removeListener(this)
        if (
            installed &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) {
            WebViewCompat.removeWebMessageListener(webView, OFFLINE_MEDIA_WEB_OBJECT)
        }
        installed = false
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!isExactOwnedOrigin(uri) || !uri.encodedPath.orEmpty().startsWith(OFFLINE_MEDIA_ROUTE_PREFIX)) {
            return null
        }
        if (
            request.method != "GET" ||
            uri.query != null ||
            uri.fragment != null
        ) {
            return response(405, "Method Not Allowed")
        }
        val rawMediaId = uri.encodedPath.orEmpty().removePrefix(OFFLINE_MEDIA_ROUTE_PREFIX)
        if (rawMediaId.contains('/')) {
            return response(404, "Not Found")
        }
        val mediaId = runCatching { UUID.fromString(rawMediaId) }
            .getOrNull()
            ?.takeIf { it.toString() == rawMediaId }
            ?: return response(404, "Not Found")
        val range = request.requestHeaders.entries
            .firstOrNull { it.key.equals("Range", ignoreCase = true) }
            ?.value
        val opened = store.open(mediaId, range)
        return opened.fold(
            onSuccess = { read ->
                val headers = linkedMapOf(
                    "Accept-Ranges" to "bytes",
                    "Content-Length" to read.contentLength.toString(),
                    "Cache-Control" to "private, no-store",
                )
                read.contentRange?.let { headers["Content-Range"] = it }
                WebResourceResponse(
                    read.contentType,
                    null,
                    read.statusCode,
                    read.reasonPhrase,
                    headers,
                    read.body,
                )
            },
            onFailure = { error ->
                when (error) {
                    is UnsatisfiableRangeException ->
                        response(
                            416,
                            "Range Not Satisfiable",
                            mapOf(
                                "Accept-Ranges" to "bytes",
                                "Content-Range" to "bytes */${error.size}",
                                "Cache-Control" to "private, no-store",
                            ),
                        )
                    is AccountMismatchException, is LocalMediaMissingException ->
                        response(404, "Not Found")
                    is OfflineMediaPersistenceException ->
                        response(503, "Service Unavailable")
                    else -> throw error
                }
            },
        )
    }

    override fun onStateChanged(
        mediaId: UUID,
        state: Presence<NativeLocalAvailability>,
    ) {
        postEvent(OfflineMediaWire.stateChanged(mediaId, state))
    }

    override fun onNetworkPolicyChanged(policy: NetworkPolicy) {
        postEvent(OfflineMediaWire.networkPolicyChanged(policy))
    }

    private fun dispatch(
        command: OfflineMediaCommand,
        commandReplyProxy: JavaScriptReplyProxy,
    ) {
        when (command) {
            is OfflineMediaCommand.Connect -> {
                val generation = documentGeneration
                val connection = connectionGeneration + 1
                connectionGeneration = connection
                replyProxy = null
                store.connect(command.accountId) { result ->
                    mainHandler.post {
                        if (
                            generation != documentGeneration ||
                            connection != connectionGeneration
                        ) {
                            return@post
                        }
                        result.fold(
                            onSuccess = { (items, policy) ->
                                replyProxy = commandReplyProxy
                                commandReplyProxy.postMessage(
                                    OfflineMediaWire.connected(
                                        command.requestId,
                                        items,
                                        policy,
                                    )
                                )
                            },
                            onFailure = { error ->
                                commandReplyProxy.postMessage(
                                    OfflineMediaWire.rejected(
                                        command.requestId,
                                        rejectionCode(error),
                                    )
                                )
                            },
                        )
                    }
                }
            }
            is OfflineMediaCommand.GetSnapshot ->
                store.snapshot { result ->
                    mainHandler.post {
                        result.fold(
                            onSuccess = { (items, policy) ->
                                commandReplyProxy.postMessage(
                                    OfflineMediaWire.snapshot(command.requestId, items, policy)
                                )
                            },
                            onFailure = { error ->
                                commandReplyProxy.postMessage(
                                    OfflineMediaWire.rejected(
                                        command.requestId,
                                        rejectionCode(error),
                                    )
                                )
                            },
                        )
                    }
                }
            is OfflineMediaCommand.Enqueue -> {
                requestNotificationPermission()
                store.enqueue(command.spec) {
                    replyForResult(command.requestId, commandReplyProxy, it)
                }
            }
            is OfflineMediaCommand.Cancel ->
                store.cancel(command.mediaId) {
                    replyForResult(command.requestId, commandReplyProxy, it)
                }
            is OfflineMediaCommand.Retry -> {
                requestNotificationPermission()
                store.retry(command.mediaId) {
                    replyForResult(command.requestId, commandReplyProxy, it)
                }
            }
            is OfflineMediaCommand.Remove ->
                store.remove(command.mediaId) {
                    replyForResult(command.requestId, commandReplyProxy, it)
                }
            is OfflineMediaCommand.SetNetworkPolicy ->
                store.setNetworkPolicy(command.policy) {
                    replyForResult(command.requestId, commandReplyProxy, it)
                }
        }
    }

    private fun replyForResult(
        requestId: UUID,
        commandReplyProxy: JavaScriptReplyProxy,
        result: Result<Unit>,
    ) {
        mainHandler.post {
            result.fold(
                onSuccess = {
                    commandReplyProxy.postMessage(OfflineMediaWire.accepted(requestId))
                },
                onFailure = { error ->
                    commandReplyProxy.postMessage(
                        OfflineMediaWire.rejected(requestId, rejectionCode(error))
                    )
                },
            )
        }
    }

    private fun rejectionCode(error: Throwable): RejectionCode {
        return when (error) {
            is AccountMismatchException -> RejectionCode.AccountMismatch
            is OfflineMediaSourceException -> error.rejectionCode
            is OfflineMediaPersistenceException -> RejectionCode.StorageUnavailable
            else -> throw error
        }
    }

    private fun postEvent(message: String) {
        val generation = documentGeneration
        val connection = connectionGeneration
        val proxy = replyProxy
        mainHandler.post {
            if (
                generation == documentGeneration &&
                connection == connectionGeneration
            ) {
                val current = replyProxy
                if (proxy == null || current === proxy) {
                    current?.postMessage(message)
                }
            }
        }
    }

    private fun isExactOwnedOrigin(uri: Uri): Boolean {
        val scheme = uri.scheme ?: return false
        val host = uri.host ?: return false
        return scheme == ownedOrigin.scheme &&
            host.equals(ownedOrigin.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(ownedOrigin)
    }

    private fun effectivePort(uri: Uri): Int {
        return when {
            uri.port != -1 -> uri.port
            uri.scheme == "https" -> 443
            else -> 80
        }
    }

    private fun response(
        statusCode: Int,
        reasonPhrase: String,
        extraHeaders: Map<String, String> = emptyMap(),
    ): WebResourceResponse {
        return WebResourceResponse(
            "text/plain",
            "UTF-8",
            statusCode,
            reasonPhrase,
            mapOf(
                "Content-Length" to "0",
                "Cache-Control" to "private, no-store",
            ) + extraHeaders,
            ByteArrayInputStream(ByteArray(0)),
        )
    }
}
