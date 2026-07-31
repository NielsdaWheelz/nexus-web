package app.nexus.android.playback

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import app.nexus.android.webkit.requireBoundedString
import app.nexus.android.webkit.requireCanonicalUuid
import app.nexus.android.webkit.requireExactKeys
import app.nexus.android.webkit.requireLong
import app.nexus.android.webkit.requireObject
import app.nexus.android.webkit.strictJsonObject
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONObject
import java.util.UUID

internal const val NATIVE_PLAYER_COMMAND_DEADLINE_MS = 5_000L
private const val PLAYER_WEB_OBJECT = "nexusPlayer"

internal class PlayerBridgeSessionFence {
    var currentSessionKey: UUID? = null
        private set
    var pendingNaturalEndMutationId: UUID? = null
        private set
    var pendingNaturalEndSessionKey: UUID? = null
        private set
    private var lastAcknowledgedNaturalEndMutationId: UUID? = null

    fun reset() {
        currentSessionKey = null
        pendingNaturalEndMutationId = null
        pendingNaturalEndSessionKey = null
        lastAcknowledgedNaturalEndMutationId = null
    }

    fun installSnapshot(sessionKey: UUID?) {
        currentSessionKey = sessionKey
    }

    fun observeSnapshotEvent(sessionKey: UUID?) {
        // Validation is intentional, mutation is not. A queued event from the
        // previous native session must not roll back bridge command fencing.
        @Suppress("UNUSED_VARIABLE")
        val validatedOnly = sessionKey
    }

    fun installPendingNaturalEnd(receipt: PendingNaturalEnd?) {
        pendingNaturalEndMutationId = receipt?.clientMutationId
        pendingNaturalEndSessionKey = receipt?.sessionKey
    }

    fun acceptNaturalEndEvent(receipt: PendingNaturalEnd): Boolean {
        if (
            receipt.sessionKey != currentSessionKey ||
            receipt.clientMutationId == lastAcknowledgedNaturalEndMutationId
        ) {
            return false
        }
        pendingNaturalEndMutationId = receipt.clientMutationId
        pendingNaturalEndSessionKey = receipt.sessionKey
        return true
    }

    fun acceptedLoad(sessionKey: UUID) {
        currentSessionKey = sessionKey
        lastAcknowledgedNaturalEndMutationId = null
    }

    fun acceptedDismiss() {
        currentSessionKey = null
    }

    fun acceptedAcknowledge(clientMutationId: UUID) {
        pendingNaturalEndMutationId = null
        pendingNaturalEndSessionKey = null
        lastAcknowledgedNaturalEndMutationId = clientMutationId
    }

    fun installControllerReconnect(
        sessionKey: UUID?,
        receipt: PendingNaturalEnd?,
    ) {
        currentSessionKey = sessionKey
        installPendingNaturalEnd(receipt)
    }

    fun acceptsSessionCommand(command: PlayerCommand.SessionCommand): Boolean {
        return if (command is PlayerCommand.AcknowledgeNaturalEnd) {
            command.sessionKey == pendingNaturalEndSessionKey &&
                command.clientMutationId == pendingNaturalEndMutationId
        } else {
            command.sessionKey == currentSessionKey
        }
    }
}

internal class NexusPlayerBridge(
    webView: WebView,
    private val controller: () -> MediaController?,
) {
    private data class PendingRequest(
        val documentGeneration: Long,
        val connectionGeneration: Long,
        val replyProxy: JavaScriptReplyProxy,
        val command: PlayerCommand,
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val framing = OwnedOriginWebMessage(
        webView,
        PLAYER_WEB_OBJECT,
        BuildConfig.NEXUS_BASE_URL,
        ::onMessage,
    )
    private val pending = mutableMapOf<UUID, PendingRequest>()
    private var connectionGeneration = 0L
    private var eventReplyProxy: JavaScriptReplyProxy? = null
    private var connectedAccountId: UUID? = null
    private var controllerReconciliationPending = false
    private val sessionFence = PlayerBridgeSessionFence()

    fun install(): Boolean = framing.install()

    fun onPageStarted() {
        framing.onDocumentStarted()
        connectionGeneration += 1
        eventReplyProxy = null
        connectedAccountId = null
        controllerReconciliationPending = false
        sessionFence.reset()
        pending.clear()
    }

    fun onControllerEvent(raw: String) {
        mainHandler.post {
            val event = runCatching { strictJsonObject(raw) }.getOrNull() ?: return@post
            if (
                event.optLong("protocolVersion", -1) !=
                PLAYER_PROTOCOL_VERSION.toLong()
            ) {
                return@post
            }
            when (event.optString("kind")) {
                "SnapshotChanged" -> {
                    runCatching {
                        event.requireExactKeys("protocolVersion", "kind", "snapshot")
                        sessionFence.observeSnapshotEvent(
                            snapshotSessionKey(event.requireObject("snapshot"))
                        )
                    }.getOrElse { return@post }
                }
                "NaturalEndPending" -> {
                    val receipt = runCatching {
                        event.requireExactKeys("protocolVersion", "kind", "receipt")
                        PlayerWire.decodePendingNaturalEnd(
                            event.requireObject("receipt").toString()
                        )
                    }.getOrElse { return@post }
                    if (!sessionFence.acceptNaturalEndEvent(receipt)) {
                        return@post
                    }
                }
                else -> return@post
            }
            val replyProxy = eventReplyProxy ?: return@post
            runCatching { postToOwnedPage(replyProxy, raw) }
                .onFailure {
                    if (eventReplyProxy === replyProxy) {
                        eventReplyProxy = null
                    }
                }
        }
    }

    fun onResume() {
        sendVisibility(true)
    }

    fun onPause() {
        sendVisibility(false)
    }

    fun onControllerDisconnected() {
        connectionGeneration += 1
        pending.clear()
        controllerReconciliationPending =
            connectedAccountId != null && eventReplyProxy != null
    }

    fun onControllerConnected(mediaController: MediaController) {
        val accountId = connectedAccountId ?: return
        val replyProxy = eventReplyProxy ?: return
        val documentGeneration = framing.currentDocumentGeneration()
        val expectedConnectionGeneration = connectionGeneration
        val requestId = UUID.randomUUID()
        controllerReconciliationPending = true
        val raw = JSONObject()
            .put("kind", "Connect")
            .put("requestId", requestId.toString())
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("accountId", accountId.toString())
            .toString()
        val future = runCatching {
            mediaController.sendCustomCommand(
                SessionCommand(
                    NexusPlaybackService.actionFor(
                        PlayerCommand.Connect(requestId, accountId)
                    ),
                    Bundle.EMPTY,
                ),
                Bundle().apply {
                    putString(NexusPlaybackService.ARG_COMMAND_JSON, raw)
                },
            )
        }.getOrNull() ?: return
        mainHandler.postDelayed(
            {
                if (
                    framing.currentDocumentGeneration() == documentGeneration &&
                    connectionGeneration == expectedConnectionGeneration &&
                    connectedAccountId == accountId &&
                    eventReplyProxy === replyProxy &&
                    controllerReconciliationPending &&
                    !future.isDone
                ) {
                    future.cancel(true)
                }
            },
            NATIVE_PLAYER_COMMAND_DEADLINE_MS,
        )
        future.addListener(
            {
                val result = runCatching { future.get() }.getOrNull()
                mainHandler.post {
                    if (
                        framing.currentDocumentGeneration() != documentGeneration ||
                        connectionGeneration != expectedConnectionGeneration ||
                        connectedAccountId != accountId ||
                        eventReplyProxy !== replyProxy
                    ) {
                        return@post
                    }
                    val reply = result?.extras
                        ?.getString(NexusPlaybackService.ARG_REPLY_JSON)
                        ?: return@post
                    val reconciliation = decodeControllerReconciliation(
                        reply,
                        requestId,
                        accountId,
                    ) ?: return@post
                    sessionFence.installControllerReconnect(
                        reconciliation.sessionKey,
                        reconciliation.pendingNaturalEnd,
                    )
                    controllerReconciliationPending = false
                    runCatching {
                        postToOwnedPage(
                            replyProxy,
                            PlayerWire.controllerReconnected(
                                reconciliation.snapshot,
                                reconciliation.pendingNaturalEnd,
                            )
                        )
                    }.onFailure {
                        if (eventReplyProxy === replyProxy) {
                            eventReplyProxy = null
                        }
                    }
                }
            },
            MoreExecutors.directExecutor(),
        )
    }

    fun close() {
        sendVisibility(false)
        framing.close()
        connectionGeneration += 1
        pending.clear()
        eventReplyProxy = null
        controllerReconciliationPending = false
    }

    private fun onMessage(message: OwnedWebMessage) {
        when (val parsed = PlayerWire.parseCommand(message.data)) {
            PlayerCommandParseResult.Unreplyable -> Unit
            is PlayerCommandParseResult.Rejected ->
                postReply(
                    message.replyProxy,
                    PlayerWire.rejected(
                        parsed.requestId,
                        PlayerRejectionCode.InvalidRequest,
                    )
                )
            is PlayerCommandParseResult.Accepted ->
                dispatch(parsed.command, message)
        }
    }

    private fun dispatch(command: PlayerCommand, message: OwnedWebMessage) {
        val mediaController = controller()
        if (mediaController == null) {
            postReply(
                message.replyProxy,
                PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.PlayerUnavailable,
                )
            )
            return
        }
        if (command is PlayerCommand.Connect) {
            controllerReconciliationPending = false
            connectionGeneration += 1
            eventReplyProxy = null
            connectedAccountId = null
            sessionFence.reset()
            sendCustom(mediaController, command, message)
            return
        }
        if (controllerReconciliationPending) {
            postReply(
                message.replyProxy,
                PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.PlayerUnavailable,
                )
            )
            return
        }
        if (connectedAccountId == null) {
            postReply(
                message.replyProxy,
                PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.AccountMismatch,
                )
            )
            return
        }
        if (command is PlayerCommand.SessionCommand) {
            if (!sessionFence.acceptsSessionCommand(command)) {
                postReply(
                    message.replyProxy,
                    PlayerWire.rejected(
                        command.requestId,
                        PlayerRejectionCode.StaleSession,
                    )
                )
                return
            }
            if (
                sessionFence.pendingNaturalEndMutationId != null &&
                command !is PlayerCommand.AcknowledgeNaturalEnd &&
                command !is PlayerCommand.Dismiss
            ) {
                postReply(
                    message.replyProxy,
                    PlayerWire.rejected(
                        command.requestId,
                        PlayerRejectionCode.NaturalEndPending,
                    )
                )
                return
            }
        }
        when (command) {
            is PlayerCommand.Play -> {
                mediaController.prepare()
                mediaController.play()
                postReply(message.replyProxy, PlayerWire.accepted(command.requestId))
            }
            is PlayerCommand.Pause -> {
                mediaController.pause()
                postReply(message.replyProxy, PlayerWire.accepted(command.requestId))
            }
            is PlayerCommand.SeekTo -> {
                mediaController.seekTo(command.positionMs)
                postReply(message.replyProxy, PlayerWire.accepted(command.requestId))
            }
            is PlayerCommand.SkipBy -> {
                mediaController.seekTo(
                    kotlin.math.max(0, mediaController.currentPosition + command.deltaMs)
                )
                postReply(message.replyProxy, PlayerWire.accepted(command.requestId))
            }
            is PlayerCommand.SetVolume -> {
                mediaController.volume = command.volume.toFloat()
                postReply(message.replyProxy, PlayerWire.accepted(command.requestId))
            }
            else -> sendCustom(mediaController, command, message)
        }
    }

    private fun sendCustom(
        mediaController: MediaController,
        command: PlayerCommand,
        message: OwnedWebMessage,
    ) {
        val request = PendingRequest(
            documentGeneration = message.documentGeneration,
            connectionGeneration = connectionGeneration,
            replyProxy = message.replyProxy,
            command = command,
        )
        pending[command.requestId] = request
        mainHandler.postDelayed(
            {
                if (pending[command.requestId] === request) {
                    // The web command owner observes its five-second timeout and
                    // reconciles with GetSnapshot. The ambiguous operation is
                    // deliberately not converted into a definitive rejection.
                    pending.remove(command.requestId)
                }
            },
            NATIVE_PLAYER_COMMAND_DEADLINE_MS,
        )
        val future = mediaController.sendCustomCommand(
            SessionCommand(NexusPlaybackService.actionFor(command), Bundle.EMPTY),
            Bundle().apply {
                putString(NexusPlaybackService.ARG_COMMAND_JSON, commandRaw(message))
            },
        )
        future.addListener(
            {
                val result = runCatching { future.get() }.getOrNull()
                mainHandler.post {
                    if (
                        pending.remove(command.requestId) !== request ||
                        framing.currentDocumentGeneration() != request.documentGeneration ||
                        connectionGeneration != request.connectionGeneration
                    ) {
                        return@post
                    }
                    val reply = result?.extras
                        ?.getString(NexusPlaybackService.ARG_REPLY_JSON)
                        ?: PlayerWire.rejected(
                            command.requestId,
                            PlayerRejectionCode.PlayerUnavailable,
                        )
                    if (!installReplyState(reply, request)) {
                        postReply(
                            request.replyProxy,
                            PlayerWire.rejected(
                                command.requestId,
                                PlayerRejectionCode.PlayerUnavailable,
                            )
                        )
                        return@post
                    }
                    postReply(request.replyProxy, reply)
                }
            },
            MoreExecutors.directExecutor(),
        )
    }

    private fun commandRaw(message: OwnedWebMessage): String = message.data

    private fun postReply(
        replyProxy: JavaScriptReplyProxy,
        raw: String,
    ) {
        runCatching { postToOwnedPage(replyProxy, raw) }
    }

    @SuppressLint("RequiresFeature")
    private fun postToOwnedPage(
        replyProxy: JavaScriptReplyProxy,
        raw: String,
    ) {
        // Reply proxies exist only after OwnedOriginWebMessage has installed
        // the WEB_MESSAGE_LISTENER-gated owned-origin channel.
        replyProxy.postMessage(raw)
    }

    private fun installReplyState(raw: String, request: PendingRequest): Boolean {
        return runCatching {
            val reply = strictJsonObject(raw)
            require(reply.requireCanonicalUuid("requestId") == request.command.requestId)
            require(
                reply.requireLong("protocolVersion", 1, 1) ==
                    PLAYER_PROTOCOL_VERSION.toLong()
            )
            when (reply.requireBoundedString("kind", 1, 32)) {
                "Connected" -> {
                    reply.requireExactKeys(
                        "kind",
                        "requestId",
                        "protocolVersion",
                        "snapshot",
                        "pendingNaturalEnd",
                    )
                    val connect = request.command as? PlayerCommand.Connect
                        ?: error("Connected reply for non-Connect")
                    connectedAccountId = connect.accountId
                    controllerReconciliationPending = false
                    eventReplyProxy = request.replyProxy
                    installSnapshotIdentity(reply.requireObject("snapshot"))
                    sessionFence.installPendingNaturalEnd(
                        pendingNaturalEnd(
                            reply.requireObject("pendingNaturalEnd")
                        )
                    )
                }
                "Snapshot" -> {
                    reply.requireExactKeys(
                        "kind",
                        "requestId",
                        "protocolVersion",
                        "snapshot",
                        "pendingNaturalEnd",
                    )
                    installSnapshotIdentity(reply.requireObject("snapshot"))
                    sessionFence.installPendingNaturalEnd(
                        pendingNaturalEnd(
                            reply.requireObject("pendingNaturalEnd")
                        )
                    )
                }
                "Accepted" -> {
                    reply.requireExactKeys("kind", "requestId", "protocolVersion")
                    when (val command = request.command) {
                        is PlayerCommand.LoadCanonical -> {
                            sessionFence.acceptedLoad(command.sessionKey)
                        }
                        is PlayerCommand.LoadPreview -> {
                            sessionFence.acceptedLoad(command.sessionKey)
                        }
                        is PlayerCommand.Dismiss ->
                            sessionFence.acceptedDismiss()
                        is PlayerCommand.AcknowledgeNaturalEnd -> {
                            sessionFence.acceptedAcknowledge(
                                command.clientMutationId
                            )
                        }
                        else -> Unit
                    }
                }
                "Rejected" -> {
                    reply.requireExactKeys(
                        "kind",
                        "requestId",
                        "protocolVersion",
                        "code",
                    )
                    PlayerRejectionCode.valueOf(
                        reply.requireBoundedString("code", 1, 32)
                    )
                }
                else -> error("unknown player reply")
            }
        }.isSuccess
    }

    private fun installSnapshotIdentity(snapshot: org.json.JSONObject) {
        sessionFence.installSnapshot(snapshotSessionKey(snapshot))
    }

    private data class ControllerReconciliation(
        val snapshot: JSONObject,
        val sessionKey: UUID?,
        val pendingNaturalEnd: PendingNaturalEnd?,
    )

    private fun decodeControllerReconciliation(
        raw: String,
        requestId: UUID,
        accountId: UUID,
    ): ControllerReconciliation? {
        return runCatching {
            val reply = strictJsonObject(raw)
            reply.requireExactKeys(
                "kind",
                "requestId",
                "protocolVersion",
                "snapshot",
                "pendingNaturalEnd",
            )
            require(reply.requireBoundedString("kind", 1, 32) == "Connected")
            require(reply.requireCanonicalUuid("requestId") == requestId)
            require(
                reply.requireLong("protocolVersion", 1, 1) ==
                    PLAYER_PROTOCOL_VERSION.toLong()
            )
            val snapshot = reply.requireObject("snapshot")
            val sessionKey = snapshotSessionKey(snapshot)
            val pending = pendingNaturalEnd(
                reply.requireObject("pendingNaturalEnd")
            )
            require(pending == null || pending.accountId == accountId)
            ControllerReconciliation(snapshot, sessionKey, pending)
        }.getOrNull()
    }

    private fun snapshotSessionKey(
        snapshot: org.json.JSONObject,
    ): UUID? {
        return when (snapshot.requireBoundedString("kind", 1, 16)) {
            "Absent" -> {
                snapshot.requireExactKeys(
                    "kind",
                    "deviceDefaultPauseShorteningMode",
                    "pauseShorteningSavedOnDeviceMs",
                )
                PauseShorteningMode.valueOf(
                    snapshot.requireBoundedString(
                        "deviceDefaultPauseShorteningMode",
                        1,
                        16,
                    )
                )
                snapshot.requireLong(
                    "pauseShorteningSavedOnDeviceMs",
                    0,
                    Long.MAX_VALUE,
                )
                null
            }
            "Canonical" -> {
                snapshot.requireExactKeys(
                    "kind",
                    "sessionKey",
                    "phase",
                    "positionMs",
                    "durationMs",
                    "bufferedMs",
                    "volume",
                    "observedBaseRate",
                    "rateState",
                    "persistence",
                    "playbackFailure",
                    "pauseShortening",
                    "session",
                )
                snapshot.requireCanonicalUuid("sessionKey")
            }
            "Preview" -> {
                snapshot.requireExactKeys(
                    "kind",
                    "sessionKey",
                    "phase",
                    "positionMs",
                    "durationMs",
                    "bufferedMs",
                    "volume",
                    "observedBaseRate",
                    "rateState",
                    "persistence",
                    "playbackFailure",
                    "pauseShortening",
                    "descriptor",
                )
                snapshot.requireCanonicalUuid("sessionKey")
            }
            else -> error("unknown player snapshot")
        }
    }

    private fun pendingNaturalEnd(
        value: org.json.JSONObject,
    ): PendingNaturalEnd? {
        return when (value.requireBoundedString("kind", 1, 16)) {
            "Absent" -> {
                value.requireExactKeys("kind")
                null
            }
            "Present" -> {
                value.requireExactKeys("kind", "value")
                PlayerWire.decodePendingNaturalEnd(
                    value.requireObject("value").toString()
                )
            }
            else -> error("unknown Presence kind")
        }
    }

    private fun sendVisibility(visible: Boolean) {
        val mediaController = controller() ?: return
        mediaController.sendCustomCommand(
            SessionCommand(NexusPlaybackService.ACTION_WEB_VISIBILITY, Bundle.EMPTY),
            Bundle().apply { putBoolean(NexusPlaybackService.ARG_VISIBLE, visible) },
        )
    }
}
