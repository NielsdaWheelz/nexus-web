package app.nexus.android.playback

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.SilenceSkippingAudioProcessor
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import app.nexus.android.R
import app.nexus.android.offline.OfflineMediaStore
import app.nexus.android.offline.OfflinePlaybackSource
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.max
import kotlin.time.Duration.Companion.milliseconds

internal const val NATIVE_PLAYER_TIMELINE_INTERVAL_MS = 250L

internal val NEXUS_PLAYER_COMMAND_IDS: Set<Int> = linkedSetOf(
    Player.COMMAND_PLAY_PAUSE,
    Player.COMMAND_PREPARE,
    Player.COMMAND_STOP,
    Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
    Player.COMMAND_SEEK_BACK,
    Player.COMMAND_SEEK_FORWARD,
    Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
    Player.COMMAND_GET_TIMELINE,
    Player.COMMAND_GET_METADATA,
    Player.COMMAND_GET_AUDIO_ATTRIBUTES,
    Player.COMMAND_GET_VOLUME,
    Player.COMMAND_GET_DEVICE_VOLUME,
    Player.COMMAND_SET_VOLUME,
    Player.COMMAND_GET_TRACKS,
)

@SuppressLint("WrongConstant")
@OptIn(UnstableApi::class)
private fun nexusPlayerCommands(): Player.Commands {
    // The collection is a closed registry of Player.Command constants. The
    // IntDef type is erased only by the collection-to-vararg conversion.
    return Player.Commands.Builder()
        .addAll(*NEXUS_PLAYER_COMMAND_IDS.toIntArray())
        .build()
}

internal val NEXUS_CUSTOM_SESSION_ACTIONS: Set<String> = setOf(
    "Connect",
    "GetSnapshot",
    "LoadCanonical",
    "LoadPreview",
    "SetPlaybackRateState",
    "SetSessionPauseShorteningMode",
    "ClearSessionPauseShorteningMode",
    "SetDeviceDefaultPauseShorteningMode",
    "InstallPodcastPlaybackSettings",
    "Drain",
    "AdoptListeningState",
    "RetryPersistence",
    "Dismiss",
    "AcknowledgeNaturalEnd",
).mapTo(linkedSetOf()) { "app.nexus.Player.$it" }

@OptIn(UnstableApi::class)
internal fun audioOffloadPreferences(
    naturalPauseShortening: Boolean,
): TrackSelectionParameters.AudioOffloadPreferences =
    TrackSelectionParameters.AudioOffloadPreferences.Builder()
        .setAudioOffloadMode(
            if (naturalPauseShortening) {
                TrackSelectionParameters.AudioOffloadPreferences
                    .AUDIO_OFFLOAD_MODE_DISABLED
            } else {
                TrackSelectionParameters.AudioOffloadPreferences
                    .AUDIO_OFFLOAD_MODE_ENABLED
            }
        )
        .setIsSpeedChangeSupportRequired(true)
        .build()

internal fun installPauseShorteningMode(
    natural: Boolean,
    installOffloadPreference: (Boolean) -> Unit,
    setSkipSilenceEnabled: (Boolean) -> Unit,
    skipSilenceEnabled: () -> Boolean,
): Boolean =
    try {
        if (natural) {
            installOffloadPreference(true)
            setSkipSilenceEnabled(true)
        } else {
            setSkipSilenceEnabled(false)
            installOffloadPreference(false)
        }
        skipSilenceEnabled() == natural
    } catch (_: RuntimeException) {
        false
    }

internal fun resolvePauseShortening(
    deviceDefault: PauseShorteningMode,
    podcastOverride: Presence<PauseShorteningMode>,
    sessionOverride: Presence<PauseShorteningMode>,
): Pair<PauseShorteningMode, PauseShorteningProvenance> =
    when (sessionOverride) {
        is Presence.Present ->
            sessionOverride.value to PauseShorteningProvenance.Session
        Presence.Absent -> when (podcastOverride) {
            is Presence.Present ->
                podcastOverride.value to PauseShorteningProvenance.Podcast
            Presence.Absent ->
                deviceDefault to PauseShorteningProvenance.Device
        }
    }

internal fun activityDiscontinuityRequiresSplit(reason: Int): Boolean =
    reason != Player.DISCONTINUITY_REASON_SILENCE_SKIP

@OptIn(UnstableApi::class)
class NexusPlaybackService : MediaSessionService(), Player.Listener {
    private sealed interface LoadedSession {
        val sessionKey: UUID

        data class Canonical(
            override val sessionKey: UUID,
            val session: AudioSession,
            var rateState: PlaybackRateState.Canonical,
            val initialSession: AudioSession = session,
            val initialRateState: PlaybackRateState.Canonical = rateState,
            val podcastId: UUID? = (
                rateState.podcastPreference as?
                    Presence.Present<PodcastRatePreference>
                )?.value?.podcastId,
            var sessionMode: Presence<PauseShorteningMode> = Presence.Absent,
        ) : LoadedSession

        data class Preview(
            override val sessionKey: UUID,
            val descriptor: PreviewDescriptor,
            var rateState: PlaybackRateState.Preview = PlaybackRateState.Preview(),
            val initialDescriptor: PreviewDescriptor = descriptor,
        ) : LoadedSession
    }

    private lateinit var player: ExoPlayer
    private lateinit var mediaSession: MediaSession
    private lateinit var preferences: NexusPlayerPreferences
    private lateinit var audioProcessorChain: DefaultAudioSink.DefaultAudioProcessorChain
    private lateinit var savedTime: SavedTimeAccounting
    private lateinit var consumptionRecorder: NativeConsumptionRecorder
    private lateinit var offlineMediaStore: OfflineMediaStore
    private lateinit var remoteMediaSourceFactory: DefaultMediaSourceFactory
    private val loadErrorHandlingPolicy = DefaultLoadErrorHandlingPolicy()
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var timelineJob: Job? = null
    private var webVisible = false
    private var accountId: UUID? = null
    private var loaded: LoadedSession? = null
    private var failure: Presence<PlayerFailure> = Presence.Absent
    private var persistence: PlayerPersistence = PlayerPersistence.Ready
    private var sampleRateHz = 0
    private var discontinuityPrepared = false
    private var naturalEndCapturePending = false
    private var persistenceDrained = false
    private var activePlaybackSource: OfflinePlaybackSource? = null

    override fun onCreate() {
        super.onCreate()
        preferences = NexusPlayerPreferences(this)
        savedTime = SavedTimeAccounting(preferences.savedOnDeviceMs())
        val silenceProcessor = SilenceSkippingAudioProcessor()
        val sonicProcessor = SonicAudioProcessor()
        audioProcessorChain = DefaultAudioSink.DefaultAudioProcessorChain(
            emptyArray<AudioProcessor>(),
            silenceProcessor,
            sonicProcessor,
        )
        val audioSink = DefaultAudioSink.Builder(this)
            .setAudioProcessorChain(audioProcessorChain)
            .build()
        val renderersFactory: RenderersFactory = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(
                context: Context,
                enableFloatOutput: Boolean,
                enableAudioTrackPlaybackParams: Boolean,
            ): AudioSink = audioSink
        }
        offlineMediaStore = OfflineMediaStore.get(this)
        remoteMediaSourceFactory =
            DefaultMediaSourceFactory(offlineMediaStore.remotePlaybackDataSourceFactory)
                .setLoadErrorHandlingPolicy(loadErrorHandlingPolicy)
        val audioAttributes = AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .setUsage(C.USAGE_MEDIA)
            .build()
        player = ExoPlayer.Builder(this, renderersFactory, remoteMediaSourceFactory)
            .setAudioAttributes(audioAttributes, true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setAudioOffloadPreferences(
                audioOffloadPreferences(naturalPauseShortening = false)
            )
            .build()
        consumptionRecorder = NativeConsumptionRecorder(
            context = this,
            scope = serviceScope,
            client = NexusOriginClient(),
            readPlayback = ::recorderPlaybackSample,
            onListeningStateAccepted = ::installAcceptedListeningState,
            onListeningStateAdopted = ::installRecoveredListeningState,
            onPersistenceChanged = ::installPersistence,
        )
        player.addListener(this)
        player.addAnalyticsListener(
            object : AnalyticsListener {
                override fun onAudioInputFormatChanged(
                    eventTime: AnalyticsListener.EventTime,
                    format: Format,
                    decoderReuseEvaluation: DecoderReuseEvaluation?,
                ) {
                    checkpointSavedTime()
                    sampleRateHz = format.sampleRate.coerceAtLeast(0)
                    startSavedTimeEpoch()
                }
            }
        )
        mediaSession = MediaSession.Builder(this, player)
            .setCallback(SessionCallback())
            .build()
    }

    override fun onGetSession(
        controllerInfo: MediaSession.ControllerInfo,
    ): MediaSession = mediaSession

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        val result = super.onStartCommand(intent, flags, startId)
        if (intent == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        return result
    }

    override fun onDestroy() {
        checkpointSavedTime()
        releasePlaybackSource()
        consumptionRecorder.close()
        timelineJob?.cancel()
        serviceScope.cancel()
        mediaSession.release()
        player.release()
        super.onDestroy()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) {
            handleNaturalEnd()
            return
        }
        publishSnapshot()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        failure = clearPlaybackFailureAfterObservedRecovery(failure, isPlaying)
        if (!isPlaying) {
            checkpointSavedTime()
        } else {
            startSavedTimeEpoch()
        }
        if (!(player.playbackState == Player.STATE_ENDED && !isPlaying)) {
            consumptionRecorder.onPlayingChanged(
                isPlaying && loaded is LoadedSession.Canonical
            )
        }
        publishSnapshot()
    }

    override fun onPlayerError(error: PlaybackException) {
        failure = Presence.Present(
            PlayerFailure(
                code = "SourcePlaybackFailed",
                message = getString(R.string.player_source_failure),
            )
        )
        checkpointSavedTime()
        consumptionRecorder.onPlayingChanged(false)
        publishSnapshot()
    }

    override fun onVolumeChanged(volume: Float) {
        publishSnapshot()
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        if (activityDiscontinuityRequiresSplit(reason)) {
            if (!discontinuityPrepared) {
                consumptionRecorder.beforeManualDiscontinuity()
            }
            checkpointSavedTime()
            startSavedTimeEpoch()
            discontinuityPrepared = false
            consumptionRecorder.afterManualDiscontinuity()
        }
        publishSnapshot()
    }

    private inner class SessionCallback : MediaSession.Callback {
        override fun onPlayerCommandRequest(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            playerCommand: Int,
        ): Int {
            if (
                playerCommandBlockedByLifecycleBarrier(
                    playerCommand = playerCommand,
                    naturalEndCapturePending = naturalEndCapturePending,
                    pendingNaturalEnd = matchingPendingReceipt() is Presence.Present,
                    persistenceDrained = persistenceDrained,
                )
            ) {
                return SessionResult.RESULT_ERROR_INVALID_STATE
            }
            if (playerCommand in CHECKPOINTED_PLAYER_COMMANDS) {
                checkpointSavedTime()
            }
            if (playerCommand in SEEK_PLAYER_COMMANDS) {
                prepareForDiscontinuity()
            }
            return SessionResult.RESULT_SUCCESS
        }

        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                .buildUpon()
                .apply {
                    if (
                        isTrustedNexusController(
                            applicationContext.packageName,
                            controller.packageName,
                        )
                    ) {
                        NEXUS_CUSTOM_SESSION_ACTIONS.forEach {
                            add(SessionCommand(it, Bundle.EMPTY))
                        }
                        add(SessionCommand(ACTION_WEB_VISIBILITY, Bundle.EMPTY))
                        add(SessionCommand(ACTION_EVENT, Bundle.EMPTY))
                    }
                }
                .build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .setAvailablePlayerCommands(nexusPlayerCommands())
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            if (
                !isTrustedNexusController(
                    applicationContext.packageName,
                    controller.packageName,
                )
            ) {
                return Futures.immediateFuture(
                    SessionResult(SessionError.ERROR_PERMISSION_DENIED)
                )
            }
            if (customCommand.customAction == ACTION_WEB_VISIBILITY) {
                setWebVisible(args.getBoolean(ARG_VISIBLE))
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
            val raw = args.getString(ARG_COMMAND_JSON)
                ?: return immediateReply(null)
            val parsed = PlayerWire.parseCommand(raw)
            val command = (parsed as? PlayerCommandParseResult.Accepted)?.command
                ?: return immediateReply(
                    when (parsed) {
                        is PlayerCommandParseResult.Rejected ->
                            PlayerWire.rejected(
                                parsed.requestId,
                                PlayerRejectionCode.InvalidRequest,
                            )
                        else -> null
                    }
                )
            if (actionFor(command) != customCommand.customAction) {
                return immediateReply(
                    PlayerWire.rejected(
                        command.requestId,
                        PlayerRejectionCode.InvalidRequest,
                    )
                )
            }
            if (command is PlayerCommand.Drain) {
                return drainReply(command)
            }
            return immediateReply(handleCommand(command))
        }
    }

    private fun handleCommand(command: PlayerCommand): String {
        return when (command) {
            is PlayerCommand.Connect -> connect(command)
            is PlayerCommand.GetSnapshot ->
                PlayerWire.snapshot(
                    command.requestId,
                    snapshot(),
                    matchingPendingReceipt(),
                )
            is PlayerCommand.LoadCanonical -> loadCanonical(command)
            is PlayerCommand.LoadPreview -> loadPreview(command)
            is PlayerCommand.Play -> {
                sessionMutation(command) {
                    player.prepare()
                    player.play()
                }
            }
            is PlayerCommand.Pause -> sessionMutation(command) {
                checkpointSavedTime()
                consumptionRecorder.flush()
                player.pause()
            }
            is PlayerCommand.SeekTo -> sessionMutation(command) {
                checkpointSavedTime()
                prepareForDiscontinuity()
                player.seekTo(command.positionMs)
                startSavedTimeEpoch()
            }
            is PlayerCommand.SkipBy -> sessionMutation(command) {
                checkpointSavedTime()
                prepareForDiscontinuity()
                player.seekTo(max(0, player.currentPosition + command.deltaMs))
                startSavedTimeEpoch()
            }
            is PlayerCommand.SetVolume -> sessionMutation(command) {
                player.volume = command.volume.toFloat()
                publishSnapshot()
            }
            is PlayerCommand.SetPlaybackRateState ->
                setPlaybackRateState(command)
            is PlayerCommand.SetSessionPauseShorteningMode -> {
                canonicalSessionCommandRejection(command)?.let { return it }
                checkpointSavedTime()
                val canonical = loaded as LoadedSession.Canonical
                canonical.sessionMode = Presence.Present(command.mode)
                applyPauseShortening()
                startSavedTimeEpoch()
                publishSnapshot()
                PlayerWire.accepted(command.requestId)
            }
            is PlayerCommand.ClearSessionPauseShorteningMode -> {
                canonicalSessionCommandRejection(command)?.let { return it }
                checkpointSavedTime()
                val canonical = loaded as LoadedSession.Canonical
                canonical.sessionMode = Presence.Absent
                applyPauseShortening()
                startSavedTimeEpoch()
                publishSnapshot()
                PlayerWire.accepted(command.requestId)
            }
            is PlayerCommand.SetDeviceDefaultPauseShorteningMode -> {
                checkpointSavedTime()
                preferences.setDeviceDefaultMode(command.mode)
                applyPauseShortening()
                startSavedTimeEpoch()
                publishSnapshot()
                PlayerWire.accepted(command.requestId)
            }
            is PlayerCommand.InstallPodcastPlaybackSettings ->
                installPodcastPlaybackSettings(command)
            is PlayerCommand.Drain ->
                PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.PlayerUnavailable,
                )
            is PlayerCommand.AdoptListeningState -> {
                canonicalSessionCommandRejection(command)?.let { return it }
                checkpointSavedTime()
                val canonical = loaded as LoadedSession.Canonical
                val adoptedPreferred = when (
                    val episodeRate = command.listeningState.episodePlaybackRate
                ) {
                    is Presence.Present -> episodeRate.value
                    Presence.Absent -> when (
                        val podcastPreference = canonical.rateState.podcastPreference
                    ) {
                        is Presence.Present ->
                            (
                                podcastPreference.value.value as?
                                    Presence.Present<Double>
                                )?.value ?: 1.0
                        Presence.Absent -> 1.0
                    }
                }
                val adoptedRateState = canonical.rateState.copy(
                    episodeRate = command.listeningState.episodePlaybackRate,
                    preferred = adoptedPreferred,
                    base = if (canonical.rateState.temporaryNormal) {
                        1.0
                    } else {
                        adoptedPreferred
                    },
                )
                canonical.session.descriptor.let { descriptor ->
                    loaded = canonical.copy(
                        session = canonical.session.copy(
                            descriptor = descriptor.copy(
                                positionMs = command.listeningState.positionMs,
                                writeRevision = command.listeningState.writeRevision,
                                resetEpoch = command.listeningState.resetEpoch,
                                durationMs = command.listeningState.durationMs,
                                playbackRate = adoptedRateState.toResolution(),
                            )
                        ),
                        rateState = adoptedRateState,
                    )
                }
                player.pause()
                prepareForDiscontinuity()
                player.seekTo(command.listeningState.positionMs)
                player.playbackParameters =
                    PlaybackParameters(adoptedRateState.base.toFloat())
                startSavedTimeEpoch()
                consumptionRecorder.adoptListeningState(command.listeningState)
                persistenceDrained = false
                publishSnapshot()
                PlayerWire.accepted(command.requestId)
            }
            is PlayerCommand.RetryPersistence -> {
                canonicalSessionCommandRejection(command)?.let { return it }
                consumptionRecorder.retryPersistence()
                PlayerWire.accepted(command.requestId)
            }
            is PlayerCommand.Dismiss -> sessionMutation(command, allowPendingEnd = true) {
                dismiss()
            }
            is PlayerCommand.AcknowledgeNaturalEnd ->
                acknowledgeNaturalEnd(command)
        }
    }

    private fun connect(command: PlayerCommand.Connect): String {
        val previous = accountId
        if (previous != null && previous != command.accountId) {
            dismiss(discardRecorder = true)
        }
        preferences.discardForeignReceipt(command.accountId)
        accountId = command.accountId
        consumptionRecorder.retryPersistence()
        return PlayerWire.connected(
            command.requestId,
            snapshot(),
            matchingPendingReceipt(),
        )
    }

    private fun loadCanonical(command: PlayerCommand.LoadCanonical): String {
        loadReplayReply(command.sessionKey, command)?.let { return it }
        if (command.rateState.toResolution() != command.session.descriptor.playbackRate) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.InvalidRequest,
            )
        }
        val connectedAccount = accountId ?: return PlayerWire.rejected(
            command.requestId,
            PlayerRejectionCode.AccountMismatch,
        )
        checkpointSavedTime()
        releasePlaybackSource()
        persistenceDrained = false
        val descriptor = command.session.descriptor
        loaded = LoadedSession.Canonical(
            command.sessionKey,
            command.session,
            command.rateState,
        )
        failure = Presence.Absent
        val source = offlineMediaStore.resolvePlaybackSource(
            accountId = connectedAccount,
            mediaId = descriptor.mediaId,
            remoteUri = Uri.parse(descriptor.streamUrl),
        ).getOrElse {
            player.stop()
            player.clearMediaItems()
            consumptionRecorder.dismiss()
            failure = Presence.Present(
                PlayerFailure(
                    code = "OfflineSourceUnavailable",
                    message = getString(R.string.player_source_failure),
                )
            )
            publishSnapshot()
            return PlayerWire.accepted(command.requestId)
        }
        activePlaybackSource = source
        consumptionRecorder.install(
            command.sessionKey,
            descriptor,
            command.rateState.episodeRate,
        )
        val itemBuilder = MediaItem.Builder()
            .setUri(source.uri)
            .setMediaId(command.session.descriptor.mediaId.toString())
            .setMediaMetadata(canonicalMetadata(command.session.descriptor))
        source.customCacheKey?.let(itemBuilder::setCustomCacheKey)
        val mediaSource = DefaultMediaSourceFactory(source.dataSourceFactory)
            .setLoadErrorHandlingPolicy(loadErrorHandlingPolicy)
            .createMediaSource(itemBuilder.build())
        player.setMediaSource(mediaSource, command.session.descriptor.positionMs)
        player.playbackParameters = PlaybackParameters(command.rateState.base.toFloat())
        if (!applyPauseShortening()) {
            publishSnapshot()
            return PlayerWire.accepted(command.requestId)
        }
        player.prepare()
        player.play()
        startSavedTimeEpoch()
        publishSnapshot()
        return PlayerWire.accepted(command.requestId)
    }

    private fun loadPreview(command: PlayerCommand.LoadPreview): String {
        loadReplayReply(command.sessionKey, command)?.let { return it }
        checkpointSavedTime()
        releasePlaybackSource()
        persistenceDrained = false
        consumptionRecorder.dismiss()
        loaded = LoadedSession.Preview(command.sessionKey, command.descriptor)
        failure = Presence.Absent
        if (!applyPauseShortening()) {
            publishSnapshot()
            return PlayerWire.accepted(command.requestId)
        }
        player.playbackParameters = PlaybackParameters(1f)
        player.setMediaSource(
            remoteMediaSourceFactory.createMediaSource(
                MediaItem.Builder()
                .setUri(command.descriptor.audioUrl)
                .setMediaId(command.descriptor.target)
                .setMediaMetadata(previewMetadata(command.descriptor))
                .build()
            )
        )
        player.prepare()
        player.play()
        savedTime.clearEpoch()
        publishSnapshot()
        return PlayerWire.accepted(command.requestId)
    }

    private fun loadReplayReply(
        sessionKey: UUID,
        command: PlayerCommand,
    ): String? {
        val pending = matchingPendingReceipt()
        val current = loaded
        if (current?.sessionKey == sessionKey) {
            val identical = when {
                current is LoadedSession.Canonical && command is PlayerCommand.LoadCanonical ->
                    current.initialSession == command.session &&
                        current.initialRateState == command.rateState
                current is LoadedSession.Preview && command is PlayerCommand.LoadPreview ->
                    current.initialDescriptor == command.descriptor
                else -> false
            }
            return if (identical) {
                PlayerWire.accepted(command.requestId)
            } else {
                PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.InvalidRequest,
                )
            }
        }
        if (pending is Presence.Present || naturalEndCapturePending) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.NaturalEndPending,
            )
        }
        return null
    }

    private fun setPlaybackRateState(
        command: PlayerCommand.SetPlaybackRateState,
    ): String {
        sessionCommandRejection(command)?.let { return it }
        val current = loaded
        when {
            current is LoadedSession.Canonical &&
                command.rateState is PlaybackRateState.Canonical -> {
                if (
                    command.rateState.podcastPreference !=
                    current.rateState.podcastPreference
                ) {
                    return PlayerWire.rejected(
                        command.requestId,
                        PlayerRejectionCode.InvalidRequest,
                    )
                }
                checkpointSavedTime()
                loaded = current.copy(
                    session = current.session.copy(
                        descriptor = current.session.descriptor.copy(
                            playbackRate = command.rateState.toResolution(),
                        )
                    ),
                    rateState = command.rateState,
                )
                player.playbackParameters =
                    PlaybackParameters(command.rateState.base.toFloat())
                consumptionRecorder.updateEpisodeRate(
                    command.rateState.episodeRate
                )
                startSavedTimeEpoch()
                publishSnapshot()
            }
            current is LoadedSession.Preview &&
                command.rateState is PlaybackRateState.Preview -> {
                current.rateState = command.rateState
                player.playbackParameters =
                    PlaybackParameters(command.rateState.base.toFloat())
                publishSnapshot()
            }
            else ->
                return PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.InvalidRequest,
                )
        }
        return PlayerWire.accepted(command.requestId)
    }

    private fun installPodcastPlaybackSettings(
        command: PlayerCommand.InstallPodcastPlaybackSettings,
    ): String {
        sessionCommandRejection(command)?.let { return it }
        val current = loaded as? LoadedSession.Canonical
            ?: return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.InvalidRequest,
            )
        val activePodcastId = current.podcastId
            ?: (
                current.rateState.podcastPreference as?
                    Presence.Present<PodcastRatePreference>
                )?.value?.podcastId
        if (
            activePodcastId != command.podcastId ||
            command.rateState.episodeRate != current.rateState.episodeRate
        ) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.InvalidRequest,
            )
        }
        val expectedPodcastPreference = when (val subscription = command.subscription) {
            Presence.Absent -> Presence.Absent
            is Presence.Present -> Presence.Present(
                PodcastRatePreference(
                    podcastId = command.podcastId,
                    value = subscription.value.defaultPlaybackSpeed,
                )
            )
        }
        if (command.rateState.podcastPreference != expectedPodcastPreference) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.InvalidRequest,
            )
        }

        checkpointSavedTime()
        val installedPauseMode = when (val subscription = command.subscription) {
            Presence.Absent -> Presence.Absent
            is Presence.Present -> subscription.value.pauseShorteningMode
        }
        loaded = current.copy(
            session = current.session.copy(
                descriptor = current.session.descriptor.copy(
                    playbackRate = command.rateState.toResolution(),
                    pauseShorteningMode = installedPauseMode,
                )
            ),
            rateState = command.rateState,
        )
        player.playbackParameters =
            PlaybackParameters(command.rateState.base.toFloat())
        consumptionRecorder.updateEpisodeRate(command.rateState.episodeRate)
        applyPauseShortening()
        startSavedTimeEpoch()
        publishSnapshot()
        return PlayerWire.accepted(command.requestId)
    }

    private fun sessionMutation(
        command: PlayerCommand.SessionCommand,
        allowPendingEnd: Boolean = false,
        mutation: () -> Unit,
    ): String {
        sessionCommandRejection(command, allowPendingEnd)?.let { return it }
        mutation()
        return PlayerWire.accepted(command.requestId)
    }

    private fun sessionCommandRejection(
        command: PlayerCommand.SessionCommand,
        allowPendingEnd: Boolean = false,
    ): String? {
        if (loaded?.sessionKey != command.sessionKey) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.StaleSession,
            )
        }
        if (naturalEndCapturePending) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.NaturalEndPending,
            )
        }
        if (
            persistenceDrained &&
            (
                command is PlayerCommand.Play ||
                    command is PlayerCommand.Pause ||
                    command is PlayerCommand.SeekTo ||
                    command is PlayerCommand.SkipBy
                )
        ) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.PlayerUnavailable,
            )
        }
        if (!allowPendingEnd && matchingPendingReceipt() is Presence.Present) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.NaturalEndPending,
            )
        }
        return null
    }

    private fun canonicalSessionCommandRejection(
        command: PlayerCommand.SessionCommand,
    ): String? =
        sessionCommandRejection(command)
            ?: if (loaded !is LoadedSession.Canonical) {
                PlayerWire.rejected(
                    command.requestId,
                    PlayerRejectionCode.InvalidRequest,
                )
            } else {
                null
            }

    private fun PlaybackRateState.Canonical.toResolution(): PlaybackRateResolution {
        val sourceAndValue = when (episodeRate) {
            is Presence.Present ->
                PlaybackRateResolution.Source.Episode to episodeRate.value
            Presence.Absent -> when (podcastPreference) {
                is Presence.Present -> when (val podcast = podcastPreference.value.value) {
                    is Presence.Present ->
                        PlaybackRateResolution.Source.Podcast to podcast.value
                    Presence.Absent ->
                        PlaybackRateResolution.Source.Product to 1.0
                }
                Presence.Absent ->
                    PlaybackRateResolution.Source.Product to 1.0
            }
        }
        check(kotlin.math.abs(sourceAndValue.second - preferred) < 0.000_001)
        return PlaybackRateResolution(
            value = sourceAndValue.second,
            source = sourceAndValue.first,
            podcastPreference = podcastPreference,
        )
    }

    private fun acknowledgeNaturalEnd(
        command: PlayerCommand.AcknowledgeNaturalEnd,
    ): String {
        if (
            !preferences.acknowledgeNaturalEnd(
                command.sessionKey,
                command.clientMutationId,
            )
        ) {
            return PlayerWire.rejected(
                command.requestId,
                PlayerRejectionCode.StaleSession,
            )
        }
        publishSnapshot()
        return PlayerWire.accepted(command.requestId)
    }

    private fun drainReply(
        command: PlayerCommand.Drain,
    ): ListenableFuture<SessionResult> {
        canonicalSessionCommandRejection(command)?.let {
            return immediateReply(it)
        }
        if (persistenceDrained) {
            return immediateReply(PlayerWire.accepted(command.requestId))
        }
        checkpointSavedTime()
        persistenceDrained = true
        val future = SettableFuture.create<SessionResult>()
        consumptionRecorder.drain(
            deadlineMs = NATIVE_PLAYER_COMMAND_DEADLINE_MS - 250,
        ) {
            future.set(sessionResult(PlayerWire.accepted(command.requestId)))
        }
        return future
    }

    private fun dismiss(discardRecorder: Boolean = false) {
        checkpointSavedTime()
        releasePlaybackSource()
        if (discardRecorder) {
            consumptionRecorder.discardPending()
            naturalEndCapturePending = false
        } else {
            consumptionRecorder.dismiss()
        }
        persistenceDrained = false
        player.stop()
        player.clearMediaItems()
        player.setSkipSilenceEnabled(false)
        loaded = null
        failure = Presence.Absent
        persistence = PlayerPersistence.Ready
        savedTime.clearEpoch()
        publishSnapshot()
    }

    private fun handleNaturalEnd() {
        checkpointSavedTime()
        val canonical = loaded as? LoadedSession.Canonical
        if (canonical == null) {
            publishSnapshot()
            return
        }
        releasePlaybackSource()
        if (
            matchingPendingReceipt() is Presence.Present ||
            naturalEndCapturePending
        ) {
            publishSnapshot()
            return
        }
        val account = accountId ?: return
        naturalEndCapturePending = true
        consumptionRecorder.captureNaturalEnd { terminal ->
            if (accountId != account) {
                naturalEndCapturePending = false
                return@captureNaturalEnd
            }
            val descriptor = canonical.session.descriptor
            val receipt = PendingNaturalEnd(
                accountId = account,
                sessionKey = canonical.sessionKey,
                mediaId = descriptor.mediaId,
                origin = canonical.session.origin,
                clientMutationId = UUID.randomUUID(),
                terminalListening = TerminalListening(
                    positionMs = terminal.positionMs,
                    durationMs = terminal.durationMs,
                    episodePlaybackRate = terminal.episodePlaybackRate,
                    expectedWriteRevision = terminal.writeRevision,
                    expectedResetEpoch = terminal.resetEpoch,
                ),
                expectedConsumptionOverrideRevision =
                    descriptor.consumptionOverrideRevision,
            )
            preferences.setPendingNaturalEnd(receipt)
            naturalEndCapturePending = false
            publishSnapshot()
            broadcast(PlayerWire.naturalEndPending(receipt))
        }
    }

    private fun releasePlaybackSource() {
        activePlaybackSource?.close()
        activePlaybackSource = null
    }

    private fun recorderPlaybackSample(): RecorderPlaybackSample {
        val canonical = loaded as? LoadedSession.Canonical
        val duration = player.duration
            .takeIf { it != C.TIME_UNSET && it >= 0 }
            ?.let(Presence<Long>::Present)
            ?: canonical?.session?.descriptor?.durationMs
            ?: Presence.Absent
        return RecorderPlaybackSample(
            positionMs = max(0, player.currentPosition),
            durationMs = duration,
        )
    }

    private fun installAcceptedListeningState(state: ListeningState) {
        val current = loaded as? LoadedSession.Canonical ?: return
        val nextRateState = current.rateState.withEpisodeRate(
            state.episodePlaybackRate
        )
        loaded = current.copy(
            session = current.session.copy(
                descriptor = current.session.descriptor.copy(
                    positionMs = state.positionMs,
                    durationMs = state.durationMs,
                    writeRevision = state.writeRevision,
                    resetEpoch = state.resetEpoch,
                    playbackRate = nextRateState.toResolution(),
                )
            ),
            rateState = nextRateState,
        )
        player.playbackParameters = PlaybackParameters(nextRateState.base.toFloat())
        publishSnapshot()
    }

    private fun installRecoveredListeningState(state: ListeningState) {
        val current = loaded as? LoadedSession.Canonical ?: return
        checkpointSavedTime()
        player.pause()
        val nextRateState = current.rateState.withEpisodeRate(
            state.episodePlaybackRate
        )
        loaded = current.copy(
            session = current.session.copy(
                descriptor = current.session.descriptor.copy(
                    positionMs = state.positionMs,
                    durationMs = state.durationMs,
                    writeRevision = state.writeRevision,
                    resetEpoch = state.resetEpoch,
                    playbackRate = nextRateState.toResolution(),
                )
            ),
            rateState = nextRateState,
        )
        player.playbackParameters = PlaybackParameters(nextRateState.base.toFloat())
        prepareForDiscontinuity()
        player.seekTo(state.positionMs)
        startSavedTimeEpoch()
        publishSnapshot()
    }

    private fun PlaybackRateState.Canonical.withEpisodeRate(
        episodeRate: Presence<Double>,
    ): PlaybackRateState.Canonical {
        val nextPreferred = when (episodeRate) {
            is Presence.Present -> episodeRate.value
            Presence.Absent -> when (podcastPreference) {
                is Presence.Present ->
                    (
                        podcastPreference.value.value as?
                            Presence.Present<Double>
                        )?.value ?: 1.0
                Presence.Absent -> 1.0
            }
        }
        return copy(
            episodeRate = episodeRate,
            preferred = nextPreferred,
            base = if (temporaryNormal) 1.0 else nextPreferred,
        )
    }

    private fun installPersistence(next: PlayerPersistence) {
        if (persistence == next) {
            return
        }
        persistence = next
        val message = (next as? PlayerPersistence.Suspended)?.message
        installPersistenceNotification(message)
        if (next is PlayerPersistence.Suspended && ::mediaSession.isInitialized) {
            mediaSession.sendError(
                SessionError(
                    when (next.reason) {
                        PersistenceSuspension.Network -> SessionError.ERROR_IO
                        PersistenceSuspension.AuthExpired ->
                            SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED
                    },
                    next.message,
                )
            )
        }
        publishSnapshot()
    }

    private fun installPersistenceNotification(message: String?) {
        if (!::player.isInitialized) {
            return
        }
        val index = player.currentMediaItemIndex
        val item = player.currentMediaItem ?: return
        if (index == C.INDEX_UNSET) {
            return
        }
        val ordinaryArtist = when (val current = loaded) {
            is LoadedSession.Canonical ->
                (current.session.descriptor.subtitle as? Presence.Present)?.value
            is LoadedSession.Preview -> current.descriptor.source
            null -> null
        }
        val metadata = item.mediaMetadata
            .buildUpon()
            .setArtist(message ?: ordinaryArtist)
            .setDescription(message)
            .build()
        player.replaceMediaItem(
            index,
            item.buildUpon().setMediaMetadata(metadata).build(),
        )
    }

    private fun prepareForDiscontinuity() {
        if (discontinuityPrepared) {
            return
        }
        discontinuityPrepared = true
        consumptionRecorder.beforeManualDiscontinuity()
    }

    private fun snapshot(): PlayerSnapshot {
        val current = loaded ?: return PlayerSnapshot.Absent(
            deviceDefaultPauseShorteningMode = preferences.deviceDefaultMode(),
            pauseShorteningSavedOnDeviceMs = savedTime.totalMs,
        )
        val phase = phase()
        val positionMs = max(0, player.currentPosition)
        val durationMs = player.duration.takeIf { it != C.TIME_UNSET && it >= 0 } ?: 0
        val bufferedMs = max(positionMs, player.bufferedPosition)
        val commonPause = pauseShorteningSnapshot()
        return when (current) {
            is LoadedSession.Canonical ->
                PlayerSnapshot.Canonical(
                    sessionKey = current.sessionKey,
                    session = current.session,
                    phase = phase,
                    positionMs = positionMs,
                    durationMs = durationMs,
                    bufferedMs = bufferedMs,
                    volume = player.volume.toDouble(),
                    observedBaseRate = player.playbackParameters.speed.toDouble(),
                    rateState = current.rateState,
                    persistence = persistence,
                    playbackFailure = failure,
                    pauseShortening = commonPause,
                )
            is LoadedSession.Preview ->
                PlayerSnapshot.Preview(
                    sessionKey = current.sessionKey,
                    descriptor = current.descriptor,
                    phase = phase,
                    positionMs = positionMs,
                    durationMs = durationMs,
                    bufferedMs = bufferedMs,
                    volume = player.volume.toDouble(),
                    observedBaseRate = player.playbackParameters.speed.toDouble(),
                    rateState = current.rateState,
                    persistence = PlayerPersistence.Ready,
                    playbackFailure = failure,
                    pauseShortening = commonPause.copy(
                        podcastOverride = Presence.Absent,
                        sessionOverride = Presence.Absent,
                        effectiveMode = PauseShorteningMode.Off,
                    ),
                )
        }
    }

    private fun phase(): PlaybackPhase {
        return when {
            player.playbackState == Player.STATE_ENDED -> PlaybackPhase.Ended
            player.playbackState == Player.STATE_BUFFERING -> PlaybackPhase.Buffering
            player.isPlaying -> PlaybackPhase.Playing
            else -> PlaybackPhase.Paused
        }
    }

    private fun pauseShorteningSnapshot(): PauseShorteningSnapshot {
        val device = preferences.deviceDefaultMode()
        val canonical = loaded as? LoadedSession.Canonical
        val podcast = canonical?.session?.descriptor?.pauseShorteningMode
            ?: Presence.Absent
        val session = canonical?.sessionMode ?: Presence.Absent
        val (effective, provenance) =
            resolvePauseShortening(device, podcast, session)
        return PauseShorteningSnapshot(
            deviceDefaultMode = device,
            podcastOverride = podcast,
            sessionOverride = session,
            effectiveMode = effective,
            provenance = provenance,
            savedOnDeviceMs = savedTime.totalMs,
        )
    }

    private fun applyPauseShortening(): Boolean {
        val natural = loaded is LoadedSession.Canonical &&
            pauseShorteningSnapshot().effectiveMode == PauseShorteningMode.Natural
        val installed = installPauseShorteningMode(
            natural = natural,
            installOffloadPreference = ::installAudioOffloadPreference,
            setSkipSilenceEnabled = player::setSkipSilenceEnabled,
            skipSilenceEnabled = { player.skipSilenceEnabled },
        )
        if (!installed) {
            player.pause()
            consumptionRecorder.onPlayingChanged(false)
            failure = Presence.Present(
                PlayerFailure(
                    code = "PauseShorteningUnavailable",
                    message = getString(R.string.player_pause_shortening_failure),
                )
            )
            return false
        }
        val currentFailure = failure
        if (
            currentFailure is Presence.Present &&
            currentFailure.value.code == "PauseShorteningUnavailable"
        ) {
            failure = Presence.Absent
        }
        return true
    }

    private fun installAudioOffloadPreference(naturalPauseShortening: Boolean) {
        val current = player.trackSelectionParameters
        val requested = audioOffloadPreferences(naturalPauseShortening)
        if (current.audioOffloadPreferences != requested) {
            player.trackSelectionParameters = current.buildUpon()
                .setAudioOffloadPreferences(requested)
                .build()
        }
    }

    private fun startSavedTimeEpoch() {
        val canonical = loaded as? LoadedSession.Canonical
        val eligible = canonical != null &&
            player.skipSilenceEnabled &&
            player.isPlaying
        savedTime.startEpoch(
            audioProcessorChain.skippedOutputFrameCount,
            max(0, player.currentPosition),
            sampleRateHz,
            canonical?.rateState?.base ?: 1.0,
            eligible,
        )
    }

    private fun checkpointSavedTime() {
        val canonical = loaded as? LoadedSession.Canonical
        val added = savedTime.checkpoint(
            audioProcessorChain.skippedOutputFrameCount,
            max(0, if (::player.isInitialized) player.currentPosition else 0),
            sampleRateHz,
            canonical?.rateState?.base ?: 1.0,
            canonical != null &&
                ::player.isInitialized &&
                player.skipSilenceEnabled,
        )
        if (added > 0) {
            preferences.setSavedOnDeviceMs(savedTime.totalMs)
        }
    }

    private fun matchingPendingReceipt(): Presence<PendingNaturalEnd> {
        val pending = preferences.pendingNaturalEnd()
        val account = accountId
        return if (
            pending is Presence.Present &&
            account != null &&
            pending.value.accountId == account
        ) {
            pending
        } else {
            Presence.Absent
        }
    }

    private fun publishSnapshot() {
        if (!::mediaSession.isInitialized) {
            return
        }
        if (
            playerSnapshotBlockedByNaturalEnd(
                canonicalLoaded = loaded is LoadedSession.Canonical,
                playbackState = player.playbackState,
                pendingNaturalEnd = matchingPendingReceipt() is Presence.Present,
            )
        ) {
            return
        }
        broadcast(PlayerWire.snapshotChanged(snapshot()))
    }

    private fun broadcast(message: String) {
        mediaSession.broadcastCustomCommand(
            SessionCommand(ACTION_EVENT, Bundle.EMPTY),
            Bundle().apply { putString(ARG_REPLY_JSON, message) },
        )
    }

    private fun setWebVisible(visible: Boolean) {
        webVisible = visible
        timelineJob?.cancel()
        timelineJob = null
        if (!visible) {
            return
        }
        publishSnapshot()
        timelineJob = serviceScope.launch {
            while (isActive && webVisible) {
                delay(NATIVE_PLAYER_TIMELINE_INTERVAL_MS.milliseconds)
                if (loaded != null) {
                    publishSnapshot()
                }
            }
        }
    }

    private fun immediateReply(reply: String?): ListenableFuture<SessionResult> {
        return Futures.immediateFuture(sessionResult(reply))
    }

    private fun sessionResult(reply: String?): SessionResult {
        val extras = Bundle()
        if (reply != null) {
            extras.putString(ARG_REPLY_JSON, reply)
        }
        return SessionResult(
            if (reply == null) {
                SessionResult.RESULT_ERROR_BAD_VALUE
            } else {
                SessionResult.RESULT_SUCCESS
            },
            extras,
        )
    }

    private fun canonicalMetadata(descriptor: CanonicalDescriptor): MediaMetadata {
        return MediaMetadata.Builder()
            .setTitle(descriptor.title)
            .setArtist((descriptor.subtitle as? Presence.Present)?.value)
            .apply {
                (descriptor.artworkUrl as? Presence.Present)?.value?.let {
                    setArtworkUri(android.net.Uri.parse(it))
                }
            }
            .build()
    }

    private fun previewMetadata(descriptor: PreviewDescriptor): MediaMetadata {
        return MediaMetadata.Builder()
            .setTitle(descriptor.title)
            .setArtist(descriptor.source)
            .apply {
                (descriptor.imageUrl as? Presence.Present)?.value?.let {
                    setArtworkUri(android.net.Uri.parse(it))
                }
            }
            .build()
    }

    companion object {
        internal val CHECKPOINTED_PLAYER_COMMANDS = setOf(
            Player.COMMAND_PLAY_PAUSE,
            Player.COMMAND_STOP,
            Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
            Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_PREVIOUS,
            Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            Player.COMMAND_SEEK_TO_NEXT,
            Player.COMMAND_SEEK_TO_MEDIA_ITEM,
            Player.COMMAND_SEEK_BACK,
            Player.COMMAND_SEEK_FORWARD,
        )
        private val SEEK_PLAYER_COMMANDS = CHECKPOINTED_PLAYER_COMMANDS -
            setOf(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_STOP)
        internal val PENDING_END_BLOCKED_PLAYER_COMMANDS =
            CHECKPOINTED_PLAYER_COMMANDS - Player.COMMAND_STOP

        const val ARG_COMMAND_JSON = "commandJson"
        const val ARG_REPLY_JSON = "replyJson"
        const val ARG_VISIBLE = "visible"
        const val ACTION_EVENT = "app.nexus.Player.Event"
        const val ACTION_WEB_VISIBILITY = "app.nexus.Player.WebVisibility"

        internal fun actionFor(command: PlayerCommand): String =
            "app.nexus.Player.${command.javaClass.simpleName}"
    }
}

internal fun clearPlaybackFailureAfterObservedRecovery(
    failure: Presence<PlayerFailure>,
    isPlaying: Boolean,
): Presence<PlayerFailure> =
    if (isPlaying) Presence.Absent else failure

internal fun isTrustedNexusController(
    applicationPackageName: String,
    controllerPackageName: String,
): Boolean =
    applicationPackageName == controllerPackageName

internal fun playerCommandBlockedByLifecycleBarrier(
    playerCommand: Int,
    naturalEndCapturePending: Boolean,
    pendingNaturalEnd: Boolean,
    persistenceDrained: Boolean,
): Boolean =
    (
        naturalEndCapturePending &&
            playerCommand in NexusPlaybackService.CHECKPOINTED_PLAYER_COMMANDS
        ) ||
        (
            (pendingNaturalEnd || persistenceDrained) &&
                playerCommand in NexusPlaybackService.PENDING_END_BLOCKED_PLAYER_COMMANDS
            )

internal fun playerSnapshotBlockedByNaturalEnd(
    canonicalLoaded: Boolean,
    playbackState: Int,
    pendingNaturalEnd: Boolean,
): Boolean =
    canonicalLoaded &&
        playbackState == Player.STATE_ENDED &&
        !pendingNaturalEnd
