package app.nexus.android.playback

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.Player.PositionInfo
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSession.ConnectionResult
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import app.nexus.android.R
import app.nexus.android.offline.OfflineStore
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

// the device's player prefs as today's app stores them, so the default and the counter survive the upgrade
private const val PREFS = "nexus.player"
private const val SHORTEN_PAUSES = "pause-shortening.device-default" // "Natural" | "Off"
private const val PAUSES_SAVED_MS = "pause-shortening.saved-on-device-ms"

/**
 * The device's one audio engine on android: ExoPlayer behind a media session
 * (notification, lock screen, media buttons), driven by the web over
 * `window.nexusPlayback` (PlayerBridge → ACTION_REQUEST), recording through
 * [ListeningRecorder] and pushing a snapshot (ACTION_EVENT) on every change and
 * each second while playing. A downloaded episode plays from its offline file
 * under an [OfflineStore] lease held while it is loaded. Every play, from the
 * web or a controller, goes through [resume].
 */
@OptIn(UnstableApi::class)
class NexusPlaybackService : MediaSessionService(), Player.Listener {
    companion object {
        const val ACTION_REQUEST = "app.nexus.Player.Request"
        const val ACTION_EVENT = "app.nexus.Player.Event"
        const val ARG_JSON = "json"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val loads = Mutex()
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private lateinit var recorder: ListeningRecorder
    private lateinit var offline: OfflineStore
    private lateinit var origin: NexusOriginClient
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private var account: UUID? = null
    private var source: JSONObject? = null // {kind: "Episode" | "Preview", descriptor} as the web sent it
    private var leased: UUID? = null
    private var sessionShortenPauses: Boolean? = null
    private var error: String? = null
    private var synced = true
    private var consumptionRevision = 0L
    private var installingPosition = false
    private var ticker: Job? = null
    private var resuming: Job? = null // a resume awaiting the server's descriptor
    private var savedMs = 0L
    private var savedFrom: Pair<Long, Long>? = null // (elapsed, position) where the current shortened stretch began

    override fun onCreate() {
        super.onCreate()
        offline = OfflineStore.get(this)
        origin = NexusOriginClient()
        savedMs = prefs.getLong(PAUSES_SAVED_MS, 0)
        val http = OkHttpDataSource.Factory(OkHttpClient()).setUserAgent("NexusAndroid/1")
        val files = DefaultDataSource.Factory(this, http) // file:// for a downloaded episode, else http(s)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(files))
            .setAudioAttributes(
                AudioAttributes.Builder().setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).setUsage(C.USAGE_MEDIA).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        // the notification, lock screen and media buttons play through resume(), like the web
        val controlled = object : ForwardingPlayer(player) {
            override fun play() = resume()

            override fun pause() {
                resuming?.cancel()
                super.pause()
            }

            // media3 rewinds an ended item before play(); resume() decides where a replay starts
            override fun seekToDefaultPosition() {
                if (playbackState != Player.STATE_ENDED) super.seekToDefaultPosition()
            }
        }
        session = MediaSession.Builder(this, controlled).setCallback(Callback()).build()
        player.addListener(this)
        recorder = ListeningRecorder(
            context = this,
            scope = scope,
            origin = origin,
            outbox = ActivityOutbox(File(filesDir, "player/activity.json")),
            sample = {
                val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
                ListeningRecorder.Sample(
                    maxOf(0, player.currentPosition),
                    duration ?: descriptor()?.presence("durationMs")?.let { (it as Number).toLong() },
                )
            },
            onAdopt = ::installPosition,
            onAccepted = { consumptionRevision += 1; publish() },
            onSynced = {
                synced = it
                publish()
            },
            onSettled = ::advance,
        )
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val result = super.onStartCommand(intent, flags, startId)
        if (intent == null) {
            // a sticky restart after process death has nothing to play
            stopSelf(startId)
            return START_NOT_STICKY
        }
        return result
    }

    override fun onDestroy() {
        accrueSaved()
        prefs.edit { putLong(PAUSES_SAVED_MS, savedMs) }
        player.removeListener(this)
        recorder.close()
        release()
        scope.cancel()
        session.release()
        player.release()
        super.onDestroy()
    }

    private inner class Callback : MediaSession.Callback {
        /** Any controller: play/pause and the 15/30 s seeks, no previous/next; the bridge also gets our two actions. */
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): ConnectionResult {
            val commands = ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
            if (isBridge(controller)) {
                commands.add(SessionCommand(ACTION_REQUEST, Bundle.EMPTY))
                commands.add(SessionCommand(ACTION_EVENT, Bundle.EMPTY))
            }
            val player = Player.Commands.Builder().addAll(
                Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP,
                Player.COMMAND_SEEK_TO_DEFAULT_POSITION, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
                Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
                Player.COMMAND_GET_AUDIO_ATTRIBUTES, Player.COMMAND_GET_VOLUME, Player.COMMAND_GET_DEVICE_VOLUME,
                Player.COMMAND_SET_VOLUME, Player.COMMAND_GET_TRACKS,
            )
            return ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands.build())
                .setAvailablePlayerCommands(player.build())
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            val raw = args.getString(ARG_JSON)
            if (!isBridge(controller) || customCommand.customAction != ACTION_REQUEST || raw == null) {
                return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
            }
            val result = SettableFuture.create<SessionResult>()
            scope.launch {
                val reply = try {
                    handle(JSONObject(raw))
                } catch (_: JSONException) {
                    // justify-ignore-error: a missing or ill-typed arg is answered, not acted on.
                    failure("Invalid")
                } catch (_: IllegalArgumentException) {
                    // justify-ignore-error: as above, for an id that is not a uuid.
                    failure("Invalid")
                }
                val extras = Bundle().apply { putString(ARG_JSON, reply.toString()) }
                result.set(SessionResult(SessionResult.RESULT_SUCCESS, extras))
            }
            return result
        }
    }

    // ---- ops (design §5.3; P5 adds sessionShortenPauses) ----

    private suspend fun handle(request: JSONObject): JSONObject {
        val op = request.getString("op")
        if (op == "hello") {
            val accountId = UUID.fromString(request.getString("accountId"))
            val switched = account != null && account != accountId
            recorder.bind(accountId) // first: nothing of the previous account is written with these cookies
            account = accountId
            if (switched) consumptionRevision = 0
            if (switched) loads.withLock { drop() }
            return ok()
        }
        if (account == null) return failure("NotConnected")
        when (op) {
            "load" -> load(request.getJSONObject("descriptor"), episode = true)
            "preview" -> load(request.getJSONObject("descriptor"), episode = false)
            "dismiss" -> loads.withLock {
                player.pause()
                recorder.stop()
                drop()
            }
            "volume" -> player.volume = request.getDouble("value").toFloat()
            "shortenPauses" -> {
                prefs.edit { putString(SHORTEN_PAUSES, if (request.getBoolean("on")) "Natural" else "Off") }
                applyShortenPauses()
            }
            else -> {
                if (request.getString("key") != key()) return failure("Stale")
                when (op) {
                    "play" -> resume(request.optJSONObject("descriptor"))
                    "pause" -> {
                        resuming?.cancel()
                        player.pause()
                    }
                    "seek" -> if (!recorder.fenced()) player.seekTo(request.getLong("positionMs"))
                    "skip" -> if (!recorder.fenced()) player.seekTo(maxOf(0, player.currentPosition + request.getLong("deltaMs")))
                    "rate" -> {
                        val rate = request.getDouble("value")
                        player.setPlaybackSpeed(rate.toFloat())
                        if (isEpisode()) recorder.pinRate(rate)
                    }
                    "adopt" -> {
                        val position = request.getJSONObject("position")
                        recorder.adopt(position)
                        installPosition(position)
                    }
                    "fence" -> {
                        resuming?.cancel()
                        player.pause()
                        recorder.fence()
                    }
                    "reconcile" -> if (!reconcile()) return failure("Unavailable")
                    "sessionShortenPauses" -> {
                        if (!isEpisode()) return failure("Stale")
                        sessionShortenPauses = if (request.isNull("on")) null else request.getBoolean("on")
                        applyShortenPauses()
                    }
                    else -> return failure("Invalid")
                }
            }
        }
        return ok()
    }

    /** Replaces the source once the outgoing episode's last write settled (≤ 2 s) and starts it. */
    private suspend fun load(descriptor: JSONObject, episode: Boolean) = loads.withLock {
        val mediaId = if (episode) UUID.fromString(descriptor.getString("mediaId")) else null
        player.stop() // also keeps a pending natural-end advance from taking over (it needs STATE_ENDED)
        recorder.stop()
        release()
        source = JSONObject().put("kind", if (episode) "Episode" else "Preview").put("descriptor", descriptor)
        sessionShortenPauses = null
        error = null
        val file = mediaId?.let { id -> offline.audioFile(id)?.takeIf { offline.open(id) } }
        if (file != null) leased = mediaId
        val metadata = MediaMetadata.Builder()
            .setTitle(descriptor.getString("title"))
            .setArtist(if (episode) descriptor.presence("subtitle") as String? else descriptor.getString("source"))
            .setArtworkUri((descriptor.presence(if (episode) "artworkUrl" else "imageUrl") as String?)?.toUri())
            .build()
        val uri = file?.toUri() ?: descriptor.getString(if (episode) "streamUrl" else "audioUrl").toUri()
        player.setMediaItem(
            MediaItem.Builder().setUri(uri).setMediaId(key()!!).setMediaMetadata(metadata).build(),
            if (episode) descriptor.getLong("positionMs") else 0,
        )
        player.setPlaybackSpeed(if (episode) descriptor.getDouble("playbackRate").toFloat() else 1f)
        applyShortenPauses()
        if (mediaId != null) {
            val overrideRevision = descriptor.presence("consumptionOverrideRevision")?.let { (it as Number).toLong() }
            recorder.start(mediaId, descriptor.getLong("resetEpoch"), overrideRevision)
        }
        player.prepare()
        player.play()
    }

    /**
     * A play. While this device holds a sample the server may not have (playing, or a write
     * queued), in place. Otherwise it asks the server (2 s; unanswered, the page's [given]
     * descriptor stands in when it knows a reset this session has not): an answer that moved
     * the session (another position or epoch, or the end; P1 replays a finished episode from 0)
     * is loaded, else the session resumes here under the answer's override revision.
     */
    private fun resume(given: JSONObject? = null) {
        val mediaId = if (isEpisode()) UUID.fromString(key()) else null
        resuming?.cancel()
        if (recorder.fenced()) {
            // Retry reads authority only; a subsequent play is the new activity.
            resuming = scope.launch { reconcile() }
            return
        }
        if (mediaId == null || player.playWhenReady || recorder.pending()) return playHere()
        val loaded = source
        resuming = scope.launch {
            val fresh = withTimeoutOrNull(2_000) {
                try {
                    origin.player(mediaId)
                } catch (_: IOException) {
                    // justify-ignore-error: unreachable; the page's descriptor or this session stands in.
                    null
                } catch (_: NexusOriginError) {
                    // justify-ignore-error: as above; the next write meets any refusal.
                    null
                }
            }
            val epoch = recorder.resetEpoch()
            if (source !== loaded || epoch == null) return@launch
            val best = fresh ?: given?.takeIf { it.getLong("resetEpoch") > epoch } ?: return@launch playHere()
            val moved = player.playbackState == Player.STATE_ENDED || best.getLong("resetEpoch") != epoch ||
                best.getLong("positionMs") != player.currentPosition
            if (moved) return@launch load(best, episode = true)
            recorder.refresh(best.presence("consumptionOverrideRevision")?.let { (it as Number).toLong() })
            playHere()
        }
    }

    /** Read the current playback owner; no position write follows an authority installation. */
    private suspend fun reconcile(): Boolean {
        val loaded = source
        val mediaId = if (isEpisode()) UUID.fromString(key()) else return true
        // A timed-out preparation can still be draining this episode's old writes.
        recorder.fence()
        if (loaded !== source) return false
        val fresh = try {
            origin.player(mediaId)
        } catch (_: IOException) {
            // justify-ignore-error: saving remains fenced; the visible retry reads authority again.
            null
        } catch (_: NexusOriginError) {
            // justify-ignore-error: as above, including an unavailable episode.
            null
        }
        if (loaded !== source) return false
        if (fresh == null) {
            error = "Listening position unavailable. Retry to sync progress."
            synced = false
            publish()
            return false
        }
        recorder.adopt(fresh)
        installPosition(fresh)
        error = null
        synced = true
        publish()
        return true
    }

    private fun installPosition(position: JSONObject) {
        installingPosition = true
        try {
            player.seekTo(position.getLong("positionMs"))
            player.pause()
        } finally {
            installingPosition = false
        }
        descriptor()?.put("resetEpoch", position.getLong("resetEpoch"))
            ?.put("consumptionOverrideRevision", position.getJSONObject("consumptionOverrideRevision"))
        error = null
        synced = true
        publish()
    }

    private fun playHere() {
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
        player.prepare() // after a playback error this retries the source
        player.play()
    }

    /** The recorder settled a natural end; the next lectern episode plays if the ended one is still here. */
    private fun advance(mediaId: UUID, next: JSONObject?) {
        if (next == null || key() != mediaId.toString() || player.playbackState != Player.STATE_ENDED) return
        scope.launch { load(next, episode = true) }
    }

    private fun drop() {
        release()
        player.stop()
        player.clearMediaItems()
        source = null
        sessionShortenPauses = null
        error = null
        applyShortenPauses()
        publish()
    }

    private fun release() {
        leased?.let(offline::close)
        leased = null
    }

    private fun descriptor(): JSONObject? = source?.getJSONObject("descriptor")

    private fun isEpisode(): Boolean = source?.getString("kind") == "Episode"

    private fun key(): String? = descriptor()?.getString(if (isEpisode()) "mediaId" else "target")

    // ---- pause shortening (P5: session override ?? podcast mode ?? device default) and time saved ----

    private fun shortenPausesDefault(): Boolean = prefs.getString(SHORTEN_PAUSES, null) == "Natural"

    private fun shortenPauses(): Boolean = when {
        source == null -> shortenPausesDefault()
        !isEpisode() -> false
        else -> sessionShortenPauses
            ?: descriptor()?.presence("pauseShorteningMode")?.let { it == "Natural" }
            ?: shortenPausesDefault()
    }

    private fun applyShortenPauses() {
        player.skipSilenceEnabled = shortenPauses()
    }

    /**
     * Time saved = media time advanced ÷ speed − wall time, over a stretch of playing
     * with silence skipped (exoplayer's position already counts the skipped frames).
     * A seek, speed or skip-silence change discards the partial stretch.
     */
    private fun accrueSaved(discard: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        val from = savedFrom
        if (from != null && !discard) {
            val gained = (player.currentPosition - from.second) / player.playbackParameters.speed - (now - from.first)
            savedMs = maxOf(0, savedMs + gained.toLong())
        }
        val stretch = player.isPlaying && player.skipSilenceEnabled && isEpisode()
        if (from != null && !stretch) prefs.edit { putLong(PAUSES_SAVED_MS, savedMs) }
        savedFrom = if (stretch) now to player.currentPosition else null
    }

    // ---- player events ----

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) error = null
        // at the end the recorder settles instead of writing
        if (player.playbackState != Player.STATE_ENDED) recorder.playing(isPlaying)
        accrueSaved()
        ticker?.cancel()
        if (isPlaying) {
            ticker = scope.launch {
                while (true) {
                    delay(1_000)
                    accrueSaved()
                    publish()
                }
            }
        }
        publish()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) {
            player.pause() // ended means paused, as in the browser: a later seek does not resume by itself
            if (isEpisode()) recorder.ended()
        }
        publish()
    }

    override fun onPositionDiscontinuity(oldPosition: PositionInfo, newPosition: PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK && !installingPosition) {
            recorder.seeked(oldPosition.positionMs)
            accrueSaved(discard = true)
        }
        publish()
    }

    override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
        accrueSaved(discard = true)
        publish()
    }

    override fun onSkipSilenceEnabledChanged(skipSilenceEnabled: Boolean) {
        accrueSaved(discard = true)
        publish()
    }

    override fun onPlayerError(error: PlaybackException) {
        this.error = getString(R.string.player_source_failure)
        publish()
    }

    override fun onVolumeChanged(volume: Float) = publish()

    // ---- snapshot ----

    private fun snapshot(): JSONObject = JSONObject()
        .put("source", source ?: JSONObject.NULL)
        .put(
            "phase",
            when {
                source == null -> "Paused"
                player.playbackState == Player.STATE_ENDED -> "Ended"
                player.isPlaying -> "Playing"
                player.playbackState == Player.STATE_BUFFERING && player.playWhenReady -> "Buffering"
                else -> "Paused"
            },
        )
        .put("positionMs", maxOf(0, player.currentPosition))
        .put("durationMs", player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0)
        .put("bufferedMs", maxOf(0, player.bufferedPosition))
        .put("rate", player.playbackParameters.speed.toDouble())
        .put("volume", player.volume.toDouble())
        .put("shortenPauses", shortenPauses())
        .put("shortenPausesSession", sessionShortenPauses ?: JSONObject.NULL)
        .put("shortenPausesDefault", shortenPausesDefault())
        .put("shortenPausesSavedMs", savedMs)
        .put("error", error ?: JSONObject.NULL)
        .put("synced", synced)
        .put("consumptionRevision", consumptionRevision)

    private fun publish() {
        val event = SessionCommand(ACTION_EVENT, Bundle.EMPTY)
        val args = Bundle().apply { putString(ARG_JSON, snapshot().toString()) }
        for (controller in session.connectedControllers) {
            if (isBridge(controller)) session.sendCustomCommand(controller, event, args)
        }
    }

    /** MainActivity's controller: this app's, but not media3's own notification controller. */
    private fun isBridge(controller: MediaSession.ControllerInfo): Boolean =
        controller.packageName == packageName && !session.isMediaNotificationController(controller)

    private fun ok(): JSONObject = JSONObject().put("ok", true).put("snapshot", snapshot())

    private fun failure(code: String): JSONObject = JSONObject().put("ok", false).put("error", code)
}

/** A `Presence` field's value, or null when Absent. */
private fun JSONObject.presence(key: String): Any? = getJSONObject(key).opt("value")
