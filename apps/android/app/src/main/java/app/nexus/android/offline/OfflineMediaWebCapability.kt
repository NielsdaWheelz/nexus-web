package app.nexus.android.offline

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.nexus.android.BuildConfig
import java.net.URI
import java.util.UUID

private const val OFFLINE_MEDIA_WEB_OBJECT = "nexusOfflineMedia"

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

}
