package app.nexus.android.playback

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import app.nexus.android.R
import app.nexus.android.RetryPolicies
import app.nexus.android.webkit.requireCanonicalUuid
import app.nexus.android.webkit.requireExactKeys
import app.nexus.android.webkit.requireLong
import app.nexus.android.webkit.requireObject
import app.nexus.android.webkit.strictJsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.time.Duration.Companion.milliseconds

internal const val NATIVE_LISTENING_SYNC_INTERVAL_MS = 15_000L
internal const val NATIVE_ACTIVITY_CHECKPOINT_MS = 10_000L
internal const val NATIVE_RECORDER_CADENCE_TICK_MS = 5_000L
internal const val NATIVE_ACTIVITY_SPAN_MAX_MS = 30_000L
private const val NATIVE_ACTIVITY_SUSPENSION_AFTER_MS = 35_000L
private const val NATIVE_ACTIVITY_BATCH_MAX_BYTES = 48_000
internal const val NATIVE_ACTIVITY_QUEUE_MAX_BATCHES = 120

internal data class RecorderPlaybackSample(
    val positionMs: Long,
    val durationMs: Presence<Long>,
)

internal data class NaturalEndCapture(
    val positionMs: Long,
    val durationMs: Presence<Long>,
    val episodePlaybackRate: Presence<Double>,
    val writeRevision: Long,
    val resetEpoch: Long,
)

/**
 * One service-lifetime owner for canonical listening state and Listening
 * activity. All public methods and callbacks run on the service's main scope;
 * NexusOriginClient moves blocking I/O off that scope.
 */
internal class NativeConsumptionRecorder(
    context: Context?,
    private val scope: CoroutineScope,
    private val client: NexusOriginTransport,
    private val readPlayback: () -> RecorderPlaybackSample,
    private val onListeningStateAccepted: (ListeningState) -> Unit,
    private val onListeningStateAdopted: (ListeningState) -> Unit,
    private val onPersistenceChanged: (PlayerPersistence) -> Unit,
    private val elapsedNow: () -> Long = SystemClock::elapsedRealtime,
    private val wallNow: () -> Long = System::currentTimeMillis,
    private val retryDelay: suspend (Long) -> Unit = {
        delay(it.milliseconds)
    },
    private val cadenceDelay: suspend (Long) -> Unit = {
        delay(it.milliseconds)
    },
) {
    private data class RecordingSession(
        val token: UUID,
        val sessionKey: UUID,
        val mediaId: UUID,
        var episodeRate: Presence<Double>,
        var writeRevision: Long,
        var resetEpoch: Long,
        var playing: Boolean = false,
        var dirtyVersion: Long = 0,
        var dirty: DirtyHeartbeat? = null,
        var generation: UUID = UUID.randomUUID(),
        var sequence: Long = 0,
        var drained: Boolean = false,
    )

    private data class DirtyHeartbeat(
        val version: Long,
        val sample: RecorderPlaybackSample,
    )

    private data class HeartbeatRequest(
        val token: UUID,
        val dirtyVersion: Long,
        val generation: UUID,
        val sequence: Long,
        val expectedWriteRevision: Long,
        val expectedResetEpoch: Long,
        val episodeRate: Presence<Double>,
        val sample: RecorderPlaybackSample,
    )

    private data class ActivityEpoch(
        val token: UUID,
        val mediaId: UUID,
        val startedElapsedMs: Long,
        val startedWallMs: Long,
        val startedPositionMs: Long,
        val startedDurationMs: Presence<Long>,
    )

    private data class FrozenActivity(
        val body: String,
        var retryAttempt: Int = 0,
    )

    private enum class RecoveryKind {
        Network,
        AuthExpired,
    }

    private val connectivity = context?.getSystemService(
        Context.CONNECTIVITY_SERVICE
    ) as? ConnectivityManager
    private val networkSuspensionMessage = context?.getString(
        R.string.player_progress_sync_network
    ) ?: "Listening progress will sync when the network recovers."
    private val authSuspensionMessage = context?.getString(
        R.string.player_progress_sync_auth
    ) ?: "Sign in again to sync listening progress."
    private var session: RecordingSession? = null
    private var cadenceJob: Job? = null
    private val heartbeatJobs = mutableMapOf<UUID, Job>()
    private var recoveryJob: Job? = null
    private var recoveryKind: RecoveryKind? = null
    private var activityEpoch: ActivityEpoch? = null
    private val activityQueue = ArrayDeque<FrozenActivity>()
    private var activityJob: Job? = null
    private var naturalEndCapture:
        Pair<UUID, (NaturalEndCapture) -> Unit>? = null
    private var naturalEndSample: RecorderPlaybackSample? = null
    private val heartbeatOutcomeAmbiguous = mutableSetOf<UUID>()
    private var drainCallback: (() -> Unit)? = null
    private var drainDeadlineJob: Job? = null
    private var closed = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(
            network: Network,
            capabilities: NetworkCapabilities,
        ) {
            if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                scope.launch {
                    if (recoveryKind == RecoveryKind.Network) {
                        retryPersistence()
                    }
                }
            }
        }
    }

    init {
        connectivity?.registerDefaultNetworkCallback(networkCallback)
    }

    fun install(
        sessionKey: UUID,
        descriptor: CanonicalDescriptor,
        episodeRate: Presence<Double>,
    ) {
        stopCurrent(flush = true)
        heartbeatOutcomeAmbiguous.clear()
        recoveryJob?.cancel()
        recoveryJob = null
        recoveryKind = null
        session = RecordingSession(
            token = UUID.randomUUID(),
            sessionKey = sessionKey,
            mediaId = descriptor.mediaId,
            episodeRate = episodeRate,
            writeRevision = descriptor.writeRevision,
            resetEpoch = descriptor.resetEpoch,
        )
        onPersistenceChanged(PlayerPersistence.Ready)
    }

    fun updateEpisodeRate(episodeRate: Presence<Double>) {
        session?.episodeRate = episodeRate
    }

    fun onPlayingChanged(playing: Boolean) {
        val current = session ?: return
        if (current.drained) {
            current.playing = false
            return
        }
        if (current.playing == playing) {
            return
        }
        current.playing = playing
        if (playing) {
            openActivity(current)
            startCadence()
        } else {
            closeActivity(reopen = false)
            markHeartbeatDirty(current)
            sendHeartbeatIfReady()
            stopCadence()
        }
    }

    fun beforeManualDiscontinuity() {
        val current = session ?: return
        if (current.drained) {
            return
        }
        closeActivity(reopen = false)
        markHeartbeatDirty(current)
        sendHeartbeatIfReady()
    }

    fun afterManualDiscontinuity() {
        val current = session ?: return
        if (current.playing) {
            openActivity(current)
        }
    }

    fun flush() {
        val current = session ?: return
        if (current.drained) {
            return
        }
        closeActivity(reopen = current.playing)
        markHeartbeatDirty(current)
        sendHeartbeatIfReady()
    }

    fun captureNaturalEnd(onCaptured: (NaturalEndCapture) -> Unit) {
        val current = session ?: return
        check(naturalEndCapture == null)
        closeActivity(reopen = false)
        current.playing = false
        current.drained = true
        stopCadence()
        current.dirty = null
        naturalEndSample = readPlayback().bounded()
        naturalEndCapture = current.token to onCaptured
        if (
            current.token in heartbeatOutcomeAmbiguous &&
            recoveryKind != null &&
            recoveryJob?.isActive != true
        ) {
            retryPersistence()
        }
        completeNaturalEndCaptureIfReady()
    }

    fun drain(
        deadlineMs: Long,
        onDrained: () -> Unit,
    ) {
        val current = session
        if (current == null) {
            onDrained()
            return
        }
        check(drainCallback == null)
        closeActivity(reopen = false)
        current.playing = false
        current.drained = true
        stopCadence()
        markHeartbeatDirty(current)
        drainCallback = onDrained
        sendHeartbeatIfReady()
        drainDeadlineJob = scope.launch {
            delay(deadlineMs.milliseconds)
            finishDrain()
        }
        completeDrainIfReady()
    }

    fun adoptListeningState(state: ListeningState) {
        val current = session ?: return
        closeActivity(reopen = false)
        current.playing = false
        current.episodeRate = state.episodePlaybackRate
        current.writeRevision = state.writeRevision
        current.resetEpoch = state.resetEpoch
        current.dirty = null
        current.generation = UUID.randomUUID()
        current.sequence = 0
        current.drained = false
        recoveryJob?.cancel()
        recoveryJob = null
        recoveryKind = null
        stopCadence()
        onPersistenceChanged(PlayerPersistence.Ready)
    }

    fun retryPersistence() {
        val current = session ?: return
        if (recoveryKind == null) {
            return
        }
        if (recoveryJob?.isActive == true) {
            return
        }
        recoveryJob = scope.launch {
            recover(current.token, fromSuspended = true)
        }
    }

    fun discardPending() {
        cadenceJob?.cancel()
        cadenceJob = null
        heartbeatJobs.values.forEach(Job::cancel)
        heartbeatJobs.clear()
        heartbeatOutcomeAmbiguous.clear()
        recoveryJob?.cancel()
        recoveryJob = null
        activityJob?.cancel()
        activityJob = null
        activityEpoch = null
        activityQueue.clear()
        naturalEndCapture = null
        naturalEndSample = null
        drainCallback = null
        drainDeadlineJob?.cancel()
        drainDeadlineJob = null
        session = null
        recoveryKind = null
    }

    fun dismiss() {
        stopCurrent(flush = true)
        session = null
        recoveryJob?.cancel()
        recoveryJob = null
        recoveryKind = null
        onPersistenceChanged(PlayerPersistence.Ready)
    }

    fun close() {
        if (closed) {
            return
        }
        closed = true
        dismiss()
        activityJob?.cancel()
        activityJob = null
        connectivity?.unregisterNetworkCallback(networkCallback)
    }

    private fun stopCurrent(flush: Boolean) {
        val current = session ?: return
        closeActivity(reopen = false)
        current.playing = false
        stopCadence()
        if (flush && !current.drained) {
            markHeartbeatDirty(current)
            sendHeartbeatIfReady()
        }
    }

    private fun startCadence() {
        if (cadenceJob?.isActive == true) {
            return
        }
        cadenceJob = scope.launch {
            var activityElapsedMs = 0L
            var heartbeatElapsedMs = 0L
            while (true) {
                cadenceDelay(NATIVE_RECORDER_CADENCE_TICK_MS)
                val current = session ?: break
                if (!current.playing) {
                    break
                }
                activityElapsedMs += NATIVE_RECORDER_CADENCE_TICK_MS
                heartbeatElapsedMs += NATIVE_RECORDER_CADENCE_TICK_MS
                if (activityElapsedMs >= NATIVE_ACTIVITY_CHECKPOINT_MS) {
                    activityElapsedMs = 0
                    closeActivity(reopen = true)
                }
                if (heartbeatElapsedMs >= NATIVE_LISTENING_SYNC_INTERVAL_MS) {
                    heartbeatElapsedMs = 0
                    markHeartbeatDirty(current)
                    sendHeartbeatIfReady()
                }
            }
        }
    }

    private fun stopCadence() {
        cadenceJob?.cancel()
        cadenceJob = null
    }

    private fun markHeartbeatDirty(current: RecordingSession) {
        current.dirtyVersion += 1
        current.dirty = DirtyHeartbeat(
            version = current.dirtyVersion,
            sample = readPlayback().bounded(),
        )
    }

    private fun sendHeartbeatIfReady() {
        val current = session ?: return
        val dirty = current.dirty ?: return
        if (
            heartbeatJobs[current.token]?.isActive == true ||
            recoveryJob?.isActive == true ||
            recoveryKind != null
        ) {
            return
        }
        val request = HeartbeatRequest(
            token = current.token,
            dirtyVersion = dirty.version,
            generation = current.generation,
            sequence = current.sequence,
            expectedWriteRevision = current.writeRevision,
            expectedResetEpoch = current.resetEpoch,
            episodeRate = current.episodeRate,
            sample = dirty.sample,
        )
        current.sequence += 1
        heartbeatOutcomeAmbiguous += request.token
        val job = scope.launch {
            val result = runCatching {
                client.putListeningState(
                    current.mediaId,
                    request.toJson().toString(),
                )
            }
            heartbeatJobs.remove(request.token)
            if (result.exceptionOrNull() is CancellationException) {
                return@launch
            }
            if (session?.token != request.token) {
                heartbeatOutcomeAmbiguous -= request.token
                sendHeartbeatIfReady()
                completeNaturalEndCaptureIfReady()
                completeDrainIfReady()
                return@launch
            }
            result.fold(
                onSuccess = { handleHeartbeatResponse(request, it) },
                onFailure = { beginRecovery(request.token) },
            )
            completeNaturalEndCaptureIfReady()
            completeDrainIfReady()
        }
        heartbeatJobs[request.token] = job
    }

    private fun handleHeartbeatResponse(
        request: HeartbeatRequest,
        response: NexusOriginResponse,
    ) {
        when {
            response.status == 200 -> {
                val result = decodeHeartbeatResult(response.body)
                check(
                    result.generation == request.generation &&
                        result.sequence == request.sequence
                ) {
                    "Heartbeat response generation/sequence echo mismatch"
                }
                val current = session ?: return
                heartbeatOutcomeAmbiguous -= request.token
                current.writeRevision = result.state.writeRevision
                current.resetEpoch = result.state.resetEpoch
                current.episodeRate = result.state.episodePlaybackRate
                if (current.dirty?.version == request.dirtyVersion) {
                    current.dirty = null
                }
                onListeningStateAccepted(result.state)
                onPersistenceChanged(PlayerPersistence.Ready)
                sendHeartbeatIfReady()
            }
            response.status == 401 -> {
                heartbeatOutcomeAmbiguous -= request.token
                suspendPersistence(RecoveryKind.AuthExpired)
            }
            response.status == 409 ||
                response.status == 408 ||
                response.status == 429 ||
                response.status >= 500 ->
                beginRecovery(request.token)
            else ->
                error("Unexpected listening heartbeat response ${response.status}")
        }
    }

    private fun beginRecovery(token: UUID) {
        if (session?.token != token || recoveryJob?.isActive == true) {
            return
        }
        heartbeatOutcomeAmbiguous += token
        recoveryJob = scope.launch {
            recover(token, fromSuspended = false)
        }
    }

    private suspend fun recover(
        token: UUID,
        fromSuspended: Boolean,
    ) {
        val current = session?.takeIf { it.token == token } ?: return
        for (delayDuration in RetryPolicies.SAME_SYSTEM_CLIENT_RECOVERY) {
            retryDelay(delayDuration.inWholeMilliseconds)
            if (session?.token != token) {
                return
            }
            val response = try {
                client.getListeningState(current.mediaId)
            } catch (_: IOException) {
                continue
            }
            when {
                response.status == 200 -> {
                    val server = decodeListeningStateEnvelope(response.body)
                    val active = session?.takeIf { it.token == token } ?: return
                    heartbeatOutcomeAmbiguous -= token
                    if (server.resetEpoch != active.resetEpoch) {
                        closeActivity(reopen = false)
                        active.playing = false
                        stopCadence()
                        active.dirty = null
                        active.episodeRate = server.episodePlaybackRate
                        active.writeRevision = server.writeRevision
                        active.resetEpoch = server.resetEpoch
                        onListeningStateAdopted(server)
                    } else {
                        active.writeRevision = server.writeRevision
                        active.resetEpoch = server.resetEpoch
                        val local = active.dirty?.sample ?: readPlayback().bounded()
                        onListeningStateAccepted(
                            server.copy(
                                positionMs = local.positionMs,
                                durationMs = local.durationMs,
                                episodePlaybackRate = active.episodeRate,
                            )
                        )
                    }
                    active.generation = UUID.randomUUID()
                    active.sequence = 0
                    recoveryKind = null
                    recoveryJob = null
                    onPersistenceChanged(PlayerPersistence.Ready)
                    restartActivityRetries()
                    sendHeartbeatIfReady()
                    completeNaturalEndCaptureIfReady()
                    completeDrainIfReady()
                    return
                }
                response.status == 401 -> {
                    heartbeatOutcomeAmbiguous -= token
                    suspendPersistence(RecoveryKind.AuthExpired)
                    return
                }
                response.status == 408 ||
                    response.status == 409 ||
                    response.status == 429 ||
                    response.status >= 500 ->
                    continue
                else ->
                    error("Unexpected listening recovery response ${response.status}")
            }
        }
        if (session?.token == token) {
            if (naturalEndCapture?.first == token) {
                // The prior PUT remains irreducibly ambiguous after the
                // self-bounding GET schedule. Capture the last accepted fence;
                // terminal settlement's Superseded result conservatively wins
                // if that PUT actually committed.
                heartbeatOutcomeAmbiguous -= token
            }
            suspendPersistence(RecoveryKind.Network)
        }
        if (fromSuspended) {
            // A manual or validated-network retry consumes one fresh bounded
            // schedule; exhaustion remains suspended with the dirty sample.
            recoveryJob = null
        }
    }

    private fun suspendPersistence(kind: RecoveryKind) {
        recoveryJob?.cancel()
        recoveryJob = null
        recoveryKind = kind
        onPersistenceChanged(
            when (kind) {
                RecoveryKind.Network -> PlayerPersistence.Suspended(
                    PersistenceSuspension.Network,
                    networkSuspensionMessage,
                )
                RecoveryKind.AuthExpired -> PlayerPersistence.Suspended(
                    PersistenceSuspension.AuthExpired,
                    authSuspensionMessage,
                )
            }
        )
        completeNaturalEndCaptureIfReady()
        if (kind == RecoveryKind.AuthExpired) {
            finishDrain()
        }
    }

    private fun completeNaturalEndCaptureIfReady() {
        val pending = naturalEndCapture ?: return
        val current = session?.takeIf { it.token == pending.first } ?: run {
            naturalEndCapture = null
            naturalEndSample = null
            return
        }
        if (
            heartbeatJobs[current.token]?.isActive == true ||
            recoveryJob?.isActive == true ||
            current.token in heartbeatOutcomeAmbiguous
        ) {
            return
        }
        val sample = naturalEndSample ?: return
        naturalEndCapture = null
        naturalEndSample = null
        pending.second(
            NaturalEndCapture(
                positionMs = sample.positionMs,
                durationMs = sample.durationMs,
                episodePlaybackRate = current.episodeRate,
                writeRevision = current.writeRevision,
                resetEpoch = current.resetEpoch,
            )
        )
    }

    private fun completeDrainIfReady() {
        if (drainCallback == null) {
            return
        }
        val current = session
        if (
            current?.let { heartbeatJobs[it.token]?.isActive == true } == true ||
            recoveryJob?.isActive == true ||
            current?.dirty != null
        ) {
            return
        }
        finishDrain()
    }

    private fun finishDrain() {
        val callback = drainCallback ?: return
        drainCallback = null
        drainDeadlineJob?.cancel()
        drainDeadlineJob = null
        session?.token?.let { heartbeatJobs.remove(it)?.cancel() }
        recoveryJob?.cancel()
        recoveryJob = null
        session?.let {
            it.dirty = null
            it.generation = UUID.randomUUID()
            it.sequence = 0
        }
        session?.token?.let(heartbeatOutcomeAmbiguous::remove)
        callback()
    }

    private fun openActivity(current: RecordingSession) {
        if (activityEpoch != null) {
            return
        }
        val sample = readPlayback().bounded()
        activityEpoch = ActivityEpoch(
            token = current.token,
            mediaId = current.mediaId,
            startedElapsedMs = elapsedNow(),
            startedWallMs = wallNow(),
            startedPositionMs = sample.positionMs,
            startedDurationMs = sample.durationMs,
        )
    }

    private fun closeActivity(reopen: Boolean) {
        val epoch = activityEpoch ?: return
        activityEpoch = null
        val current = session?.takeIf { it.token == epoch.token }
        val endedElapsedMs = elapsedNow()
        val elapsedMs = endedElapsedMs - epoch.startedElapsedMs
        val end = readPlayback().bounded()
        if (
            elapsedMs in 1..NATIVE_ACTIVITY_SPAN_MAX_MS &&
            current != null
        ) {
            enqueueActivity(
                epoch,
                elapsedMs,
                end,
            )
        } else if (elapsedMs > NATIVE_ACTIVITY_SUSPENSION_AFTER_MS) {
            // A delayed callback is an ambiguous suspension gap, not evidence.
        }
        if (reopen && current?.playing == true) {
            openActivity(current)
        }
    }

    private fun enqueueActivity(
        epoch: ActivityEpoch,
        durationMs: Long,
        end: RecorderPlaybackSample,
    ) {
        val progress = progressPair(
            epoch.startedPositionMs,
            epoch.startedDurationMs,
            end.positionMs,
            end.durationMs,
        )
        val span = JSONObject()
            .put(
                "occurredAt",
                CANONICAL_INSTANT.format(
                    Instant.ofEpochMilli(epoch.startedWallMs)
                ),
            )
            .put("durationMs", durationMs)
            .put("progressStart", progress.first)
            .put("progressEnd", progress.second)
            .put(
                "mediaPositionStartMs",
                presenceJson(Presence.Present(epoch.startedPositionMs)),
            )
            .put(
                "mediaPositionEndMs",
                presenceJson(Presence.Present(end.positionMs)),
            )
        val body = JSONObject()
            .put("clientMutationId", UUID.randomUUID().toString())
            .put("mediaRef", "media:${epoch.mediaId}")
            .put("deviceClass", "Mobile")
            .put(
                "batch",
                JSONObject()
                    .put("modality", "Listening")
                    .put("spans", JSONArray().put(span)),
            )
            .toString()
        check(body.toByteArray(Charsets.UTF_8).size <= NATIVE_ACTIVITY_BATCH_MAX_BYTES)
        if (activityQueue.size >= NATIVE_ACTIVITY_QUEUE_MAX_BATCHES) {
            suspendPersistence(RecoveryKind.Network)
            return
        }
        activityQueue.addLast(FrozenActivity(body))
        sendActivityIfReady()
    }

    private fun sendActivityIfReady() {
        if (
            activityJob?.isActive == true ||
            activityQueue.isEmpty() ||
            recoveryKind != null
        ) {
            return
        }
        val frozen = activityQueue.first()
        activityJob = scope.launch {
            val result = runCatching { client.postListeningActivity(frozen.body) }
            activityJob = null
            if (result.exceptionOrNull() is CancellationException) {
                return@launch
            }
            result.fold(
                onSuccess = { response ->
                    when {
                        response.status == 204 -> activityQueue.removeFirst()
                        response.status == 401 -> {
                            suspendPersistence(RecoveryKind.AuthExpired)
                        }
                        response.status == 403 || response.status == 404 ->
                            activityQueue.removeFirst()
                        response.status == 408 ||
                            response.status == 429 ||
                            response.status >= 500 ->
                            retryActivity(frozen)
                        else ->
                            error("Unexpected Listening activity response ${response.status}")
                    }
                },
                onFailure = { retryActivity(frozen) },
            )
            sendActivityIfReady()
        }
    }

    private fun retryActivity(frozen: FrozenActivity) {
        val delayDuration = RetryPolicies.SAME_SYSTEM_CLIENT_RECOVERY
            .getOrNull(frozen.retryAttempt)
        if (delayDuration == null) {
            frozen.retryAttempt = 0
            suspendPersistence(RecoveryKind.Network)
            return
        }
        frozen.retryAttempt += 1
        activityJob = scope.launch {
            retryDelay(delayDuration.inWholeMilliseconds)
            activityJob = null
            sendActivityIfReady()
        }
    }

    private fun restartActivityRetries() {
        activityQueue.forEach { it.retryAttempt = 0 }
        sendActivityIfReady()
    }

    private fun RecorderPlaybackSample.bounded(): RecorderPlaybackSample =
        copy(
            positionMs = positionMs.coerceIn(0, Int.MAX_VALUE.toLong()),
            durationMs = when (durationMs) {
                Presence.Absent -> Presence.Absent
                is Presence.Present ->
                    Presence.Present(
                        durationMs.value.coerceIn(0, Int.MAX_VALUE.toLong())
                    )
            },
        )

    private fun HeartbeatRequest.toJson(): JSONObject =
        JSONObject()
            .put("positionMs", sample.positionMs)
            .put("durationMs", presenceJson(sample.durationMs))
            .put("episodePlaybackRate", presenceJson(episodeRate))
            .put("expectedWriteRevision", expectedWriteRevision)
            .put("expectedResetEpoch", expectedResetEpoch)
            .put("heartbeatGeneration", generation.toString())
            .put("heartbeatSequence", sequence)

    private data class DecodedHeartbeatResult(
        val state: ListeningState,
        val generation: UUID,
        val sequence: Long,
    )

    private fun decodeHeartbeatResult(raw: String): DecodedHeartbeatResult {
        val envelope = strictJsonObject(raw)
        envelope.requireExactKeys("data")
        val data = envelope.requireObject("data")
        data.requireExactKeys(
            "listeningState",
            "heartbeatGeneration",
            "heartbeatSequence",
        )
        return DecodedHeartbeatResult(
            state = decodeListeningState(data.requireObject("listeningState")),
            generation = data.requireCanonicalUuid("heartbeatGeneration"),
            sequence = data.requireLong("heartbeatSequence", 0, Int.MAX_VALUE.toLong()),
        )
    }

    private fun decodeListeningStateEnvelope(raw: String): ListeningState {
        val envelope = strictJsonObject(raw)
        envelope.requireExactKeys("data")
        return decodeListeningState(envelope.requireObject("data"))
    }

    private fun decodeListeningState(json: JSONObject): ListeningState {
        json.requireExactKeys(
            "positionMs",
            "durationMs",
            "episodePlaybackRate",
            "writeRevision",
            "resetEpoch",
        )
        return ListeningState(
            positionMs = json.requireLong(
                "positionMs",
                0,
                Int.MAX_VALUE.toLong(),
            ),
            durationMs = decodeLongPresence(json.requireObject("durationMs")),
            episodePlaybackRate = decodeDoublePresence(
                json.requireObject("episodePlaybackRate")
            ),
            writeRevision = json.requireLong(
                "writeRevision",
                0,
                Int.MAX_VALUE.toLong(),
            ),
            resetEpoch = json.requireLong(
                "resetEpoch",
                0,
                Int.MAX_VALUE.toLong(),
            ),
        )
    }

    private fun decodeLongPresence(json: JSONObject): Presence<Long> =
        when (json.optString("kind")) {
            "Absent" -> {
                json.requireExactKeys("kind")
                Presence.Absent
            }
            "Present" -> {
                json.requireExactKeys("kind", "value")
                Presence.Present(
                    json.requireLong("value", 0, Int.MAX_VALUE.toLong())
                )
            }
            else -> error("unknown long Presence")
        }

    private fun decodeDoublePresence(json: JSONObject): Presence<Double> =
        when (json.optString("kind")) {
            "Absent" -> {
                json.requireExactKeys("kind")
                Presence.Absent
            }
            "Present" -> {
                json.requireExactKeys("kind", "value")
                val value = when (val raw = json.get("value")) {
                    is Int -> raw.toDouble()
                    is Long -> raw.toDouble()
                    is Double -> raw
                    else -> error("playback rate must be numeric")
                }
                require(value.isFinite() && value in 0.5..3.0)
                Presence.Present(value)
            }
            else -> error("unknown playback-rate Presence")
        }

    private fun presenceJson(value: Presence<*>): JSONObject =
        when (value) {
            Presence.Absent -> JSONObject().put("kind", "Absent")
            is Presence.Present ->
                JSONObject().put("kind", "Present").put("value", value.value)
        }

    private fun progressPair(
        startPositionMs: Long,
        startDurationMs: Presence<Long>,
        endPositionMs: Long,
        endDurationMs: Presence<Long>,
    ): Pair<JSONObject, JSONObject> {
        val startDuration = (startDurationMs as? Presence.Present)?.value
        val endDuration = (endDurationMs as? Presence.Present)?.value
        if (
            startDuration == null ||
            endDuration == null ||
            startDuration <= 0 ||
            endDuration <= 0
        ) {
            return presenceJson(Presence.Absent) to
                presenceJson(Presence.Absent)
        }
        val start = min(1.0, max(0.0, startPositionMs.toDouble() / startDuration))
        val end = min(1.0, max(0.0, endPositionMs.toDouble() / endDuration))
        return presenceJson(Presence.Present(start)) to
            presenceJson(Presence.Present(end))
    }

    private companion object {
        val CANONICAL_INSTANT: DateTimeFormatter =
            DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    }
}
