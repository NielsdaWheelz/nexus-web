package app.nexus.android.offline.readingweb

import android.database.SQLException
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineMediaStore
import app.nexus.android.offline.reading.*
import app.nexus.android.webkit.OwnedOrigin
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import app.nexus.android.webkit.requireBoundedString
import app.nexus.android.webkit.requireCanonicalUuid
import app.nexus.android.webkit.requireExactKeys
import app.nexus.android.webkit.requireLong
import app.nexus.android.webkit.strictJsonObject
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

private const val OBJECT_NAME = "nexusOfflineReading"

/** The two documents that may speak this protocol, told apart by exact origin. */
internal enum class OfflineReadingDocument {
    Shell,
    Hosted,
}

internal fun offlineReadingMessageDocument(
    sourceOrigin: Uri,
    shellOrigin: OwnedOrigin,
    hostedOrigin: OwnedOrigin,
): OfflineReadingDocument? = when {
    shellOrigin.matches(sourceOrigin) -> OfflineReadingDocument.Shell
    hostedOrigin.matches(sourceOrigin) -> OfflineReadingDocument.Hosted
    else -> null
}

/**
 * A command runs only when the document that sent it is still the document the
 * shell has loaded: its origin must match the active document and its
 * navigation generation must still be current. A late message from a superseded
 * document can therefore neither cross the shell/hosted command fence nor
 * capture the live session's reply channel.
 */
internal fun offlineReadingMessageAdmitted(
    messageDocument: OfflineReadingDocument?,
    messageGeneration: Long,
    activeDocument: OfflineReadingDocument,
    currentGeneration: Long,
): Boolean =
    messageDocument == activeDocument && messageGeneration == currentGeneration

/**
 * Failures the renderer protocol answers with a reply: malformed payloads,
 * refused commands, and durable-store refusals. Anything else is a defect and
 * keeps propagating.
 */
internal fun isOfflineReadingCommandFailure(error: Throwable): Boolean =
    error is IllegalArgumentException ||
        error is IllegalStateException ||
        error is JSONException ||
        error is SQLException ||
        error is IOException

/**
 * Runs one durable-store step, returning the command failure it refused with.
 * A defect is never converted into a protocol reply.
 */
private inline fun <T> commandStep(step: () -> T): Result<T> =
    try {
        Result.success(step())
    } catch (error: Exception) {
        if (!isOfflineReadingCommandFailure(error)) throw error
        Result.failure(error)
    }

/** Parses renderer-supplied JSON, whose malformedness is an expected input. */
private inline fun <T : Any> parsedOrNull(parse: () -> T): T? =
    try {
        parse()
    } catch (_: IllegalArgumentException) {
        // justify-ignore-error: a malformed renderer payload carries no reply
        // address and no further classification; the caller drops or rejects it.
        null
    } catch (_: IllegalStateException) {
        // justify-ignore-error: the strict JSON readers signal a wrong member
        // type the same way; it is still only renderer input malformedness.
        null
    } catch (_: JSONException) {
        // justify-ignore-error: as above for a payload missing a required member.
        null
    }

internal fun applyOfflineNetworkPolicy(
    policy: NetworkPolicy,
    applyReading: (NetworkPolicy) -> Unit,
    applyAudio: (NetworkPolicy, (Result<Unit>) -> Unit) -> Unit,
    completed: (Result<Unit>) -> Unit,
) {
    commandStep { applyReading(policy) }.onFailure {
        completed(Result.failure(it))
        return
    }
    commandStep {
        applyAudio(policy, completed)
    }.onFailure {
        completed(Result.failure(it))
    }
}

internal fun hostedReconciledSnapshotAccepted(
    snapshot: ReadingStoreSnapshot,
    accountId: UUID,
): Boolean = (snapshot.binding as? OfflineReadingBindingView.Present)?.let {
    it.accountId == accountId && !it.authorizationRequired
} == true

internal fun offlineReadingCommandAllowed(kind: String, offlineDocument: Boolean): Boolean =
    kind in if (offlineDocument) {
        setOf(
            "ConnectOffline", "GetSnapshot", "Cancel", "Retry", "Remove",
            "OpenReading", "CloseReading", "SaveReaderProgress",
            "ResolveReaderProgress", "SetNetworkPolicy", "OpenHosted",
            "LogoutAndPurge",
        )
    } else {
        setOf(
            "ConnectHosted", "GetSnapshot", "Enqueue", "Cancel", "Retry",
            "Remove", "OpenDownloadedCopy", "SetNetworkPolicy", "LogoutAndPurge",
        )
    }

internal fun offlineReadingCommandKind(root: JSONObject): String? =
    parsedOrNull { root.requireBoundedString("kind", 1, 64) }

internal enum class OfflineReadingSessionState {
    Disconnected,
    Connecting,
    Connected,
    LoggingOut,
    LogoutRetry,
}

internal fun offlineReadingSessionRejection(
    state: OfflineReadingSessionState,
    kind: String,
    connectedReplyAvailable: Boolean,
): String? {
    if (kind == "ConnectHosted" || kind == "ConnectOffline") {
        return if (state == OfflineReadingSessionState.Disconnected) null else "Busy"
    }
    if (state == OfflineReadingSessionState.LoggingOut) return "Busy"
    if (state == OfflineReadingSessionState.LogoutRetry) {
        return if (kind == "LogoutAndPurge" && connectedReplyAvailable) null else "Busy"
    }
    return if (state == OfflineReadingSessionState.Connected && connectedReplyAvailable) {
        null
    } else {
        "NotConnected"
    }
}

internal enum class OfflineLocalOpenDisposition {
    Reject,
    Defer,
    Ready,
}

internal fun offlineLocalOpenDisposition(
    mediaId: UUID,
    snapshot: ReadingStoreSnapshot,
    reconciliationPending: Boolean,
): OfflineLocalOpenDisposition {
    if (reconciliationPending) return OfflineLocalOpenDisposition.Defer
    return if (snapshot.hasReadyOfflineReading(mediaId)) {
        OfflineLocalOpenDisposition.Ready
    } else {
        OfflineLocalOpenDisposition.Reject
    }
}

internal fun validatedPendingLocalOpen(
    mediaId: UUID?,
    snapshot: ReadingStoreSnapshot,
): UUID? = mediaId?.takeIf(snapshot::hasReadyOfflineReading)

/**
 * A local open that was deferred until reconciliation, and that reconciliation
 * cannot satisfy, goes back to Android: the link is offered, never dropped.
 */
internal fun deferredLocalOpenUnavailable(pending: UUID?, validated: UUID?): Boolean =
    pending != null && validated == null

private fun ReadingStoreSnapshot.hasReadyOfflineReading(mediaId: UUID): Boolean = items.any {
    it.mediaId == mediaId && it.availability is OfflineReadingAvailability.Ready
}

internal sealed interface OfflineReadingRecoveryStep {
    data object Reconcile : OfflineReadingRecoveryStep
    data object FinishLogout : OfflineReadingRecoveryStep
    data class ConnectTarget(val accountId: UUID) : OfflineReadingRecoveryStep
    data object RejectForeignTransition : OfflineReadingRecoveryStep
}

internal fun hostedRecoveryStep(
    pending: OfflineReadingAccountTransitionView,
    attestedAccountId: UUID,
): OfflineReadingRecoveryStep = when (pending) {
    OfflineReadingAccountTransitionView.None ->
        OfflineReadingRecoveryStep.ConnectTarget(attestedAccountId)
    OfflineReadingAccountTransitionView.Logout -> OfflineReadingRecoveryStep.FinishLogout
    is OfflineReadingAccountTransitionView.AccountSwitch ->
        if (pending.targetAccountId == attestedAccountId) {
            OfflineReadingRecoveryStep.ConnectTarget(attestedAccountId)
        } else {
            OfflineReadingRecoveryStep.RejectForeignTransition
        }
}

internal fun offlineRecoveryStep(
    pending: OfflineReadingAccountTransitionView,
): OfflineReadingRecoveryStep = when (pending) {
    OfflineReadingAccountTransitionView.None -> OfflineReadingRecoveryStep.Reconcile
    OfflineReadingAccountTransitionView.Logout -> OfflineReadingRecoveryStep.FinishLogout
    is OfflineReadingAccountTransitionView.AccountSwitch ->
        OfflineReadingRecoveryStep.ConnectTarget(pending.targetAccountId)
}

internal fun offlineReadingCommandIsValid(root: JSONObject, kind: String): Boolean = parsedOrNull {
    when (kind) {
        "ConnectHosted", "ConnectOffline", "GetSnapshot", "OpenHosted", "LogoutAndPurge" ->
            root.requireExactKeys("protocolVersion", "requestId", "kind")
        "Enqueue" -> {
            root.requireExactKeys(
                "protocolVersion", "requestId", "kind", "mediaId", "requestedTitle", "mediaKind",
            )
            root.requireCanonicalUuid("mediaId")
            require(root.requireBoundedString("requestedTitle", 1, 512).isNotBlank())
            OfflineReadingMediaKind.valueOf(root.requireBoundedString("mediaKind", 3, 10))
        }
        "Cancel", "Retry", "Remove", "OpenReading", "OpenDownloadedCopy" -> {
            root.requireExactKeys("protocolVersion", "requestId", "kind", "mediaId")
            root.requireCanonicalUuid("mediaId")
        }
        "CloseReading" -> {
            root.requireExactKeys("protocolVersion", "requestId", "kind", "leaseId")
            root.requireCanonicalUuid("leaseId")
        }
        "SaveReaderProgress" -> {
            root.requireExactKeys(
                "protocolVersion", "requestId", "kind", "mediaId",
                "readerGeneration", "readerRevisionKey", "locator",
            )
            root.requireCanonicalUuid("mediaId")
            root.requireLong("readerGeneration", 1, Long.MAX_VALUE)
            require(root.requireBoundedString("readerRevisionKey", 64, 64).matches(Regex("[0-9a-f]{64}")))
            root.getJSONObject("locator")
        }
        "ResolveReaderProgress" -> {
            root.requireExactKeys("protocolVersion", "requestId", "kind", "mediaId", "choice")
            root.requireCanonicalUuid("mediaId")
            require(root.requireBoundedString("choice", 6, 9) in setOf("Canonical", "Device"))
        }
        "SetNetworkPolicy" -> {
            root.requireExactKeys("protocolVersion", "requestId", "kind", "policy")
            NetworkPolicy.valueOf(root.requireBoundedString("policy", 1, 32))
        }
        else -> error("unsupported command")
    }
} != null

internal class OfflineReadingWebCapability(
    private val webView: WebView,
    private val store: OfflineReadingStore,
    private val leases: OfflineReadingLeaseRegistry,
    private val attestHostedAccount: ((Result<UUID>) -> Unit) -> Unit,
    private val audioStore: OfflineMediaStore,
    private val openHosted: () -> Unit,
    private val openOffline: () -> Unit,
    private val onLogout: () -> Unit,
    /**
     * Hosted Nexus loaded but could not be bound to an account: only Android can
     * offer the shelf, because package inventory never reaches an unattested
     * hosted renderer.
     */
    private val onHostedConnectUnavailable: () -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val shellOrigin = OwnedOrigin("https://$OFFLINE_READING_ASSET_HOST")
    private val hostedOrigin = OwnedOrigin(BuildConfig.NEXUS_BASE_URL)
    private val bridge = OwnedOriginWebMessage(
        webView,
        OBJECT_NAME,
        setOf(BuildConfig.NEXUS_BASE_URL, "https://$OFFLINE_READING_ASSET_HOST"),
        ::receive,
    )
    private var listener: AutoCloseable? = null
    private var replyProxy: JavaScriptReplyProxy? = null
    @Volatile private var sessionState = OfflineReadingSessionState.Disconnected
    private var activeDocument = OfflineReadingDocument.Hosted
    private var pendingLocalOpen: UUID? = null
    private var pendingLocalOpenUnavailable: (() -> Unit)? = null

    fun install() {
        bridge.install()
        listener = store.addListener(::snapshotChanged)
    }

    fun onPageStarted(url: String?) {
        bridge.onDocumentStarted()
        replyProxy = null
        sessionState = OfflineReadingSessionState.Disconnected
        leases.clear()
        activeDocument = if (url == OFFLINE_READING_MAIN_URL) {
            OfflineReadingDocument.Shell
        } else {
            OfflineReadingDocument.Hosted
        }
        if (activeDocument != OfflineReadingDocument.Shell) {
            pendingLocalOpen = null
            pendingLocalOpenUnavailable = null
        }
    }

    fun close() {
        replyProxy = null
        sessionState = OfflineReadingSessionState.Disconnected
        activeDocument = OfflineReadingDocument.Hosted
        pendingLocalOpen = null
        pendingLocalOpenUnavailable = null
        listener?.close()
        listener = null
        leases.clear()
        bridge.close()
    }

    /**
     * Asks the shelf to open one installed media locally. A media that
     * reconciliation later cannot produce is handed back through
     * [onUnavailable]: the caller still owns the link and must offer it.
     */
    fun requestLocalOpen(mediaId: UUID, onUnavailable: () -> Unit = {}): Boolean {
        val reconciliationPending = store.reconciliationIsPending()
        val disposition = offlineLocalOpenDisposition(
            mediaId,
            store.snapshot(),
            reconciliationPending,
        )
        if (disposition == OfflineLocalOpenDisposition.Reject) return false
        pendingLocalOpen = mediaId
        pendingLocalOpenUnavailable = onUnavailable
        if (disposition == OfflineLocalOpenDisposition.Ready) {
            publishPendingLocalOpen()
        }
        return true
    }

    internal fun receive(message: OwnedWebMessage) {
        val document = offlineReadingMessageDocument(message.sourceOrigin, shellOrigin, hostedOrigin)
        if (
            !offlineReadingMessageAdmitted(
                messageDocument = document,
                messageGeneration = message.documentGeneration,
                activeDocument = activeDocument,
                currentGeneration = bridge.currentDocumentGeneration(),
            )
        ) {
            return
        }
        dispatch(message, offlineDocument = document == OfflineReadingDocument.Shell)
    }

    private fun dispatch(message: OwnedWebMessage, offlineDocument: Boolean) {
        val root = parsedOrNull { strictJsonObject(message.data) } ?: return
        val requestId = parsedOrNull { root.requireCanonicalUuid("requestId") } ?: return
        if (parsedOrNull { root.requireLong("protocolVersion", 1, 1) } == null) {
            reply(message.replyProxy, requestId, rejected("InvalidRequest"))
            return
        }
        val kind = offlineReadingCommandKind(root)
        if (kind == null) {
            reply(message.replyProxy, requestId, rejected("InvalidRequest"))
            return
        }
        if (!offlineReadingCommandAllowed(kind, offlineDocument)) {
            reply(message.replyProxy, requestId, rejected("InvalidRequest"))
            return
        }
        if (!offlineReadingCommandIsValid(root, kind)) {
            reply(message.replyProxy, requestId, rejected("InvalidRequest"))
            return
        }
        val sessionRejection = offlineReadingSessionRejection(
            sessionState,
            kind,
            replyProxy != null,
        )
        if (sessionRejection != null) {
            reply(message.replyProxy, requestId, rejected(sessionRejection))
            return
        }
        if (kind == "ConnectHosted" || kind == "ConnectOffline") {
            sessionState = OfflineReadingSessionState.Connecting
        } else if (kind == "LogoutAndPurge") {
            sessionState = OfflineReadingSessionState.LoggingOut
        }
        try {
            when (kind) {
                "ConnectHosted" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind")
                    if (offlineDocument) error("unsupported origin")
                    attestHostedAccount { attestation ->
                        if (message.documentGeneration != bridge.currentDocumentGeneration()) return@attestHostedAccount
                        attestation.fold(
                            onSuccess = { accountId ->
                                commandStep {
                                    connectHostedAfterRecovery(message, requestId, accountId)
                                }.onFailure {
                                    failHostedConnect(message, requestId, "Failed")
                                }
                            },
                            onFailure = {
                                failHostedConnect(message, requestId, "AuthorizationRequired")
                            },
                        )
                    }
                    return
                }
                "ConnectOffline" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind")
                    if (!offlineDocument) error("unsupported origin")
                    connectOfflineAfterRecovery(message, requestId)
                    return
                }
                "GetSnapshot" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind")
                    reply(message.replyProxy, requestId, outcome("Snapshot", "snapshot" to snapshotJson(store.snapshot())))
                }
                "Enqueue" -> {
                    root.requireExactKeys(
                        "protocolVersion", "requestId", "kind", "mediaId", "requestedTitle", "mediaKind",
                    )
                    store.enqueue(
                        root.requireCanonicalUuid("mediaId"),
                        root.requireBoundedString("requestedTitle", 1, 512),
                        OfflineReadingMediaKind.valueOf(root.requireBoundedString("mediaKind", 3, 10)),
                    )
                    reply(message.replyProxy, requestId, accepted())
                }
                "Cancel", "Retry", "Remove" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind", "mediaId")
                    val mediaId = root.requireCanonicalUuid("mediaId")
                    when (kind) {
                        "Cancel" -> store.cancel(mediaId)
                        "Retry" -> store.retry(mediaId)
                        else -> store.remove(mediaId)
                    }
                    reply(message.replyProxy, requestId, accepted())
                }
                "OpenReading" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind", "mediaId")
                    store.openAsync(root.requireCanonicalUuid("mediaId")) { result ->
                        if (
                            message.documentGeneration != bridge.currentDocumentGeneration() ||
                            sessionState != OfflineReadingSessionState.Connected
                        ) {
                            result.getOrNull()?.let { store.closeLease(it.id) }
                            return@openAsync
                        }
                        result.fold(
                            onSuccess = { lease ->
                                reply(
                                    message.replyProxy,
                                    requestId,
                                    opened(lease, leases.publish(lease)),
                                )
                            },
                            onFailure = {
                                reply(message.replyProxy, requestId, rejected("Failed"))
                            },
                        )
                    }
                    return
                }
                "OpenDownloadedCopy" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind", "mediaId")
                    if (!offlineReadingCommandAllowed(kind, offlineDocument)) error("unsupported origin")
                    val mediaId = root.requireCanonicalUuid("mediaId")
                    if (!requestLocalOpen(mediaId)) {
                        reply(message.replyProxy, requestId, rejected("NotFound"))
                        return
                    }
                    reply(message.replyProxy, requestId, accepted())
                    mainHandler.post(openOffline)
                }
                "CloseReading" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind", "leaseId")
                    leases.close(root.requireCanonicalUuid("leaseId"))
                    reply(message.replyProxy, requestId, accepted())
                }
                "SaveReaderProgress" -> {
                    root.requireExactKeys(
                        "protocolVersion", "requestId", "kind", "mediaId",
                        "readerGeneration", "readerRevisionKey", "locator",
                    )
                    val result = store.saveReaderProgress(
                        root.requireCanonicalUuid("mediaId"),
                        root.requireLong("readerGeneration", 1, Long.MAX_VALUE),
                        root.requireBoundedString("readerRevisionKey", 64, 64),
                        root.getJSONObject("locator").toString(),
                    )
                    reply(message.replyProxy, requestId, outcome("ReaderProgressSaved", "result" to progressJson(result, true)))
                }
                "ResolveReaderProgress" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind", "mediaId", "choice")
                    val result = store.resolveReaderProgress(
                        root.requireCanonicalUuid("mediaId"),
                        root.requireBoundedString("choice", 6, 9) == "Canonical",
                    )
                    reply(message.replyProxy, requestId, outcome("ReaderProgressSaved", "result" to progressJson(result, true)))
                }
                "SetNetworkPolicy" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind", "policy")
                    val policy = NetworkPolicy.valueOf(
                        root.requireBoundedString("policy", 1, 32),
                    )
                    applyOfflineNetworkPolicy(
                        policy,
                        applyReading = { store.setNetworkPolicy(it) },
                        applyAudio = audioStore::setNetworkPolicy,
                    ) { result ->
                        if (
                            message.documentGeneration != bridge.currentDocumentGeneration() ||
                            sessionState != OfflineReadingSessionState.Connected
                        ) return@applyOfflineNetworkPolicy
                        reply(
                            message.replyProxy,
                            requestId,
                            if (result.isSuccess) accepted() else rejected("Failed"),
                        )
                    }
                    return
                }
                "OpenHosted" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind")
                    if (!offlineDocument) error("unsupported origin")
                    reply(message.replyProxy, requestId, accepted())
                    openHosted()
                }
                "LogoutAndPurge" -> {
                    root.requireExactKeys("protocolVersion", "requestId", "kind")
                    store.beginAccountTransition(null)
                    leases.clear()
                    audioStore.purgeAndDisconnect { audioResult ->
                        if (message.documentGeneration != bridge.currentDocumentGeneration()) return@purgeAndDisconnect
                        if (audioResult.isFailure) {
                            sessionState = OfflineReadingSessionState.LogoutRetry
                            reply(message.replyProxy, requestId, rejected("Failed"))
                            return@purgeAndDisconnect
                        }
                        if (commandStep { store.completeAccountTransition(null) }.isFailure) {
                            sessionState = OfflineReadingSessionState.LogoutRetry
                            reply(message.replyProxy, requestId, rejected("Failed"))
                            return@purgeAndDisconnect
                        }
                        sessionState = OfflineReadingSessionState.Disconnected
                        replyProxy = null
                        reply(message.replyProxy, requestId, accepted())
                        mainHandler.post(onLogout)
                    }
                    return
                }
                else -> reply(message.replyProxy, requestId, rejected("InvalidRequest"))
            }
        } catch (error: Exception) {
            // A refused command answers the renderer; a broken invariant stays a
            // defect instead of becoming a product-facing protocol outcome.
            if (!isOfflineReadingCommandFailure(error)) throw error
            when (kind) {
                "ConnectHosted" -> {
                    sessionState = OfflineReadingSessionState.Disconnected
                    replyProxy = null
                    mainHandler.post(onHostedConnectUnavailable)
                }
                "ConnectOffline" -> {
                    sessionState = OfflineReadingSessionState.Disconnected
                    replyProxy = null
                }
                "LogoutAndPurge" -> sessionState = OfflineReadingSessionState.LogoutRetry
            }
            reply(message.replyProxy, requestId, rejected("Failed"))
        }
    }

    private fun connectHostedAfterRecovery(
        message: OwnedWebMessage,
        requestId: UUID,
        attestedAccountId: UUID,
    ) {
        leases.clear()
        when (val step = hostedRecoveryStep(store.pendingAccountTransition(), attestedAccountId)) {
            is OfflineReadingRecoveryStep.ConnectTarget -> connectHostedTarget(
                message, requestId, step.accountId,
            )
            OfflineReadingRecoveryStep.FinishLogout -> {
                audioStore.purgeAndDisconnect { logoutResult ->
                    if (message.documentGeneration != bridge.currentDocumentGeneration()) return@purgeAndDisconnect
                    if (logoutResult.isFailure) {
                        failHostedConnect(message, requestId, "Failed")
                        return@purgeAndDisconnect
                    }
                    if (commandStep { store.completeAccountTransition(null) }.isFailure) {
                        failHostedConnect(message, requestId, "Failed")
                        return@purgeAndDisconnect
                    }
                    sessionState = OfflineReadingSessionState.Disconnected
                    replyProxy = null
                    reply(message.replyProxy, requestId, rejected("AuthorizationRequired"))
                    mainHandler.post(onLogout)
                }
            }
            OfflineReadingRecoveryStep.RejectForeignTransition -> {
                failHostedConnect(message, requestId, "Failed")
            }
            OfflineReadingRecoveryStep.Reconcile -> error("hosted recovery cannot reconcile")
        }
    }

    private fun connectHostedTarget(
        message: OwnedWebMessage,
        requestId: UUID,
        accountId: UUID,
    ) {
        if (commandStep { store.beginAccountTransition(accountId) }.isFailure) {
            failHostedConnect(message, requestId, "Failed")
            return
        }
        audioStore.connect(accountId) { audioResult ->
            if (message.documentGeneration != bridge.currentDocumentGeneration()) return@connect
            if (audioResult.isFailure) {
                failHostedConnect(message, requestId, "Failed")
                return@connect
            }
            commandStep { store.completeAccountTransition(accountId) }.getOrElse {
                failHostedConnect(message, requestId, "Failed")
                return@connect
            }
            store.reconcileAsync { snapshot ->
                if (message.documentGeneration != bridge.currentDocumentGeneration()) return@reconcileAsync
                if (!hostedReconciledSnapshotAccepted(snapshot, accountId)) {
                    failHostedConnect(message, requestId, "Failed")
                    return@reconcileAsync
                }
                replyProxy = message.replyProxy
                sessionState = OfflineReadingSessionState.Connected
                reply(message.replyProxy, requestId, connected(snapshot))
            }
        }
    }

    private fun connectOfflineAfterRecovery(
        message: OwnedWebMessage,
        requestId: UUID,
    ) {
        leases.clear()
        when (val step = offlineRecoveryStep(store.pendingAccountTransition())) {
            OfflineReadingRecoveryStep.Reconcile -> {
                store.reconcileAsync { snapshot ->
                    if (message.documentGeneration != bridge.currentDocumentGeneration()) return@reconcileAsync
                    finishOfflineConnect(message, requestId, snapshot)
                }
            }
            OfflineReadingRecoveryStep.FinishLogout -> {
                audioStore.purgeAndDisconnect { audioResult ->
                    if (message.documentGeneration != bridge.currentDocumentGeneration()) return@purgeAndDisconnect
                    if (audioResult.isFailure) {
                        failConnect(message, requestId, "Failed")
                        return@purgeAndDisconnect
                    }
                    val snapshot = commandStep { store.completeAccountTransition(null) }.getOrElse {
                        failConnect(message, requestId, "Failed")
                        return@purgeAndDisconnect
                    }
                    sessionState = OfflineReadingSessionState.Disconnected
                    replyProxy = null
                    reply(message.replyProxy, requestId, connected(snapshot))
                    mainHandler.post(onLogout)
                }
            }
            is OfflineReadingRecoveryStep.ConnectTarget -> {
                audioStore.connect(step.accountId) { audioResult ->
                    if (message.documentGeneration != bridge.currentDocumentGeneration()) return@connect
                    if (audioResult.isFailure) {
                        failConnect(message, requestId, "Failed")
                        return@connect
                    }
                    val snapshot = commandStep {
                        store.completeAccountTransition(step.accountId)
                    }.getOrElse {
                        failConnect(message, requestId, "Failed")
                        return@connect
                    }
                    finishOfflineConnect(
                        message,
                        requestId,
                        snapshot,
                    )
                }
            }
            OfflineReadingRecoveryStep.RejectForeignTransition ->
                error("offline recovery has no attested foreign account")
        }
    }

    private fun finishOfflineConnect(
        message: OwnedWebMessage,
        requestId: UUID,
        snapshot: ReadingStoreSnapshot,
    ) {
        val validated = validatedPendingLocalOpen(pendingLocalOpen, snapshot)
        if (deferredLocalOpenUnavailable(pendingLocalOpen, validated)) {
            pendingLocalOpenUnavailable?.let { unavailable -> mainHandler.post(unavailable) }
        }
        pendingLocalOpen = validated
        if (validated == null) pendingLocalOpenUnavailable = null
        replyProxy = message.replyProxy
        sessionState = OfflineReadingSessionState.Connected
        reply(message.replyProxy, requestId, connected(snapshot))
        publishPendingLocalOpen()
    }

    private fun failConnect(
        message: OwnedWebMessage,
        requestId: UUID,
        code: String,
    ) {
        sessionState = OfflineReadingSessionState.Disconnected
        replyProxy = null
        reply(message.replyProxy, requestId, rejected(code))
    }

    /**
     * Hosted Nexus is loaded but has no attested account binding, so the hosted
     * renderer cannot be shown the shelf. Android owns the affordance instead.
     */
    private fun failHostedConnect(
        message: OwnedWebMessage,
        requestId: UUID,
        code: String,
    ) {
        failConnect(message, requestId, code)
        mainHandler.post(onHostedConnectUnavailable)
    }

    private fun snapshotChanged(snapshot: ReadingStoreSnapshot) {
        val proxy = replyProxy ?: return
        mainHandler.post {
            if (proxy !== replyProxy) return@post
            proxy.postMessage(
                JSONObject()
                    .put("protocolVersion", 1)
                    .put("event", JSONObject().put("kind", "SnapshotChanged").put("snapshot", snapshotJson(snapshot)))
                    .toString()
            )
        }
    }

    private fun publishPendingLocalOpen() {
        if (activeDocument != OfflineReadingDocument.Shell) return
        val mediaId = pendingLocalOpen ?: return
        val proxy = replyProxy ?: return
        pendingLocalOpen = null
        pendingLocalOpenUnavailable = null
        mainHandler.post {
            if (proxy !== replyProxy) return@post
            proxy.postMessage(
                JSONObject()
                    .put("protocolVersion", 1)
                    .put(
                        "event",
                        JSONObject()
                            .put("kind", "OpenReadingRequested")
                            .put("mediaId", mediaId.toString()),
                    )
                    .toString()
            )
        }
    }

    private fun reply(proxy: JavaScriptReplyProxy, requestId: UUID, outcome: JSONObject) {
        mainHandler.post {
            proxy.postMessage(
                JSONObject()
                    .put("protocolVersion", 1)
                    .put("requestId", requestId.toString())
                    .put("outcome", outcome)
                    .toString()
            )
        }
    }

    private fun connected(snapshot: ReadingStoreSnapshot) = outcome("Connected", "snapshot" to snapshotJson(snapshot))
    private fun accepted() = outcome("Accepted")
    private fun rejected(code: String) = outcome("Rejected", "code" to code)

    private fun outcome(kind: String, vararg fields: Pair<String, Any>) =
        JSONObject().put("kind", kind).also { json -> fields.forEach { json.put(it.first, it.second) } }

    private fun opened(lease: OfflineReadingLease, capability: String) = outcome(
        "OpenedReading",
        "leaseId" to lease.id.toString(),
        "readerGeneration" to lease.readerGeneration,
        "readerRevisionKey" to lease.readerRevisionKey,
        "readerUrl" to "https://$OFFLINE_READING_ASSET_HOST/nexus-offline/lease/$capability/reader.json",
        "progress" to progressJson(lease.progress, false),
        "installedAt" to lease.installedAt.toString(),
    )

    private fun snapshotJson(snapshot: ReadingStoreSnapshot): JSONObject = JSONObject()
        .put(
            "binding",
            when (val binding = snapshot.binding) {
                OfflineReadingBindingView.Absent -> JSONObject().put("kind", "Absent")
                is OfflineReadingBindingView.Present -> JSONObject()
                    .put("kind", "Present")
                    .put(
                        "value",
                        JSONObject()
                            .put("accountId", binding.accountId.toString())
                            .put("authorizationRequired", binding.authorizationRequired),
                    )
            },
        )
        .put("networkPolicy", snapshot.networkPolicy.name)
        .put("items", org.json.JSONArray().also { items -> snapshot.items.forEach { items.put(itemJson(it)) } })

    private fun itemJson(item: OfflineReadingItemSnapshot): JSONObject = JSONObject()
        .put("mediaId", item.mediaId.toString())
        .put("title", item.title)
        .put("mediaKind", item.mediaKind.name)
        .put(
            "availability",
            if (item is OfflineReadingItemSnapshot.PackageItem &&
                item.availability is OfflineReadingAvailability.Ready
            ) {
                availabilityJson(item.availability, item.readerGeneration, item.readerRevisionKey)
            } else {
                availabilityJson(item.availability)
            },
        )

    private fun availabilityJson(
        value: OfflineReadingAvailability,
        readerGeneration: Long? = null,
        readerRevisionKey: String? = null,
    ): JSONObject = when (value) {
        is OfflineReadingAvailability.Transfer -> transferJson(value.state)
        is OfflineReadingAvailability.Ready -> outcome(
            "Ready",
            "sizeBytes" to value.sizeBytes,
            "installedAt" to value.installedAt.toString(),
            "readerGeneration" to requireNotNull(readerGeneration),
            "readerRevisionKey" to requireNotNull(readerRevisionKey),
            "progress" to progressJson(value.progress, false),
        )
        OfflineReadingAvailability.Removing -> outcome("Removing")
    }

    private fun transferJson(state: ReadingTransferState): JSONObject = when (state) {
        ReadingTransferState.Preparing -> outcome("Preparing")
        is ReadingTransferState.Queued -> outcome("Queued", "reason" to state.reason.name)
        ReadingTransferState.Authorizing -> outcome("Authorizing")
        is ReadingTransferState.Downloading -> outcome(
            "Downloading", "receivedBytes" to state.receivedBytes, "totalBytes" to state.totalBytes,
        )
        ReadingTransferState.Verifying -> outcome("Verifying")
        is ReadingTransferState.Restarting -> outcome(
            "Restarting", "attempt" to state.attempt, "reason" to state.reason.name,
        )
        is ReadingTransferState.Failed -> outcome("Failed", "reason" to state.reason.name)
    }

    private fun progressJson(view: NativeReaderProgressView, saveResult: Boolean): JSONObject {
        val result = when (view) {
            is NativeReaderProgressView.Canonical -> outcome(
                "Canonical", "snapshot" to JSONObject(view.baselineJson),
            )
            is NativeReaderProgressView.Pending -> outcome(
                "Pending", "baseline" to JSONObject(view.baselineJson), "device" to JSONObject(view.deviceLocatorJson),
            )
            is NativeReaderProgressView.Conflict -> outcome(
                "Conflict", "canonical" to JSONObject(view.canonicalJson), "device" to JSONObject(view.deviceLocatorJson),
            )
            is NativeReaderProgressView.ContentChanged -> outcome(
                "ContentChanged", "baseline" to JSONObject(view.baselineJson), "device" to JSONObject(view.deviceLocatorJson),
            )
            is NativeReaderProgressView.SourceUnavailable -> outcome(
                "SourceUnavailable", "baseline" to JSONObject(view.baselineJson), "device" to JSONObject(view.deviceLocatorJson),
            )
        }
        return if (saveResult && view !is NativeReaderProgressView.Canonical && view !is NativeReaderProgressView.Conflict) {
            outcome(
                when (view) {
                    is NativeReaderProgressView.Pending -> "DurablyPending"
                    is NativeReaderProgressView.ContentChanged -> "ContentChanged"
                    is NativeReaderProgressView.SourceUnavailable -> "SourceUnavailable"
                    else -> error("unreachable")
                },
                "view" to result,
            )
        } else result
    }
}
