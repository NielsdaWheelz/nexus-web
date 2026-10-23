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

// only the time-saved counter is a device preference; podcast absence means silence skipping off.
private const val PREFS = "nexus.player"
private const val PAUSES_SAVED_MS = "pause-shortening.saved-on-device-ms"

/**
 * The device's one audio engine on android: ExoPlayer behind a media session
 * (notification, lock screen, media buttons), driven by the web over
 * `window.nexusAudioSession` (PlayerBridge → ACTION_REQUEST), recording through
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
        private var nextSnapshotId = 0L
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
    private var loadId: String? = null // a fresh occurrence, including same-media reloads and service restarts
    private var installingSource = false // suppress reentrant listener snapshots, including same-media installs
    private var leased: UUID? = null
    private var sessionShortenPauses: Boolean? = null
    private var error: String? = null
    private var synced = true
    private var consumptionRevision = 0L
    private var installingPosition = false
    private var ticker: Job? = null
    private var playbackIntent = 0L
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
            override fun play() {
                val key = key()
                val loaded = loadId
                val mine = invalidatePlayback()
                scope.launch { resume(null, key, loaded, mine) }
            }

            override fun prepare() {
                val loaded = loadId
                val mine = invalidatePlayback()
                scope.launch {
                    loads.withLock {
                        if (mine == playbackIntent && loadId == loaded) preparePlayback()
                    }
                }
            }

            override fun pause() {
                val mine = invalidatePlayback()
                scope.launch { loads.withLock { if (mine == playbackIntent) player.pause() } }
            }

            override fun stop() {
                val mine = invalidatePlayback()
                scope.launch { loads.withLock { if (mine == playbackIntent) player.stop() } }
            }

            override fun seekTo(positionMs: Long) = seekFromController(positionMs)

            override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
                if (mediaItemIndex == currentMediaItemIndex) seekFromController(positionMs)
            }

            override fun seekBack() = seekFromController(currentPosition - seekBackIncrement)

            override fun seekForward() = seekFromController(currentPosition + seekForwardIncrement)

            // media3 rewinds an ended item before play(); resume decides where a replay starts.
            override fun seekToDefaultPosition() {
                if (playbackState != Player.STATE_ENDED) seekFromController(0)
            }

            override fun seekToDefaultPosition(mediaItemIndex: Int) {
                if (mediaItemIndex == currentMediaItemIndex) seekToDefaultPosition()
            }
        }
        session = MediaSession.Builder(this, controlled).setCallback(Callback()).build()
        player.addListener(this)
        recorder = ListeningRecorder(
            context = this,
            scope = scope,
            origin = origin,
            outbox = ActivityOutbox(File(filesDir, "player/spans.json")),
            sample = {
                val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
                ListeningRecorder.Sample(
                    maxOf(0, player.currentPosition),
                    duration ?: descriptor()?.nullableLong(if (isEpisode()) "duration_ms" else "durationMs"),
                )
            },
            onAdopt = ::installPosition,
            onAccepted = { consumptionRevision += 1; publish() },
            onSynced = {
                synced = it
                publish()
            },
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
                Player.COMMAND_GET_AUDIO_ATTRIBUTES, Player.COMMAND_GET_DEVICE_VOLUME, Player.COMMAND_GET_TRACKS,
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

    // ---- ops ----

    private suspend fun handle(request: JSONObject): JSONObject {
        val op = request.getString("op")
        if (op == "hello") {
            val accountId = UUID.fromString(request.getString("accountId"))
            val switched = account != null && account != accountId
            if (switched) invalidatePlayback()
            return loads.withLock {
                recorder.bind(accountId) // first: nothing of the previous account is written with these cookies
                account = accountId
                if (switched) consumptionRevision = 0
                if (switched) drop()
                publish()
                ok()
            }
        }
        if (account == null) return failure("NotConnected")
        val mine = when (op) {
            "cancelPlayback", "load", "preview", "dismiss", "play", "pause", "seekAndPlay", "seek", "skip", "fence" -> invalidatePlayback()
            else -> playbackIntent
        }
        when (op) {
            "cancelPlayback" -> return ok()
            "load", "preview" -> {
                if (!load(request.getJSONObject("descriptor"), episode = op == "load", mine = mine)) return failure("Stale")
            }
            "dismiss" -> loads.withLock {
                if (mine != playbackIntent) return failure("Stale")
                player.pause()
                recorder.stop()
                drop()
            }
            "play" -> resume(request.optJSONObject("descriptor"), request.getString("key"), request.getString("expected_load_id"), mine)?.let { return failure(it) }
            else -> loads.withLock {
                // Validate the occurrence after any dispatched source replacement drains.
                if (request.getString("key") != key() || request.getString("expected_load_id") != loadId) return failure("Stale")
                if (op in setOf("pause", "seekAndPlay", "seek", "skip", "fence") && mine != playbackIntent) return failure("Stale")
                when (op) {
                    "pause" -> player.pause()
                    "seekAndPlay" -> {
                        val position = request.getDouble("position_ms")
                        if (!position.isFinite() || position < 0) return failure("Invalid")
                        if (!isEpisode() || player.playbackState == Player.STATE_ENDED) return failure("Stale")
                        if (recorder.fenced()) return failure("Fenced")
                        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
                        player.seekTo(minOf(position.toLong(), duration ?: Long.MAX_VALUE))
                        playHere()
                    }
                    "seek", "skip" -> if (!recorder.fenced()) {
                        val position = if (op == "seek") request.getLong("positionMs")
                            else player.currentPosition + request.getLong("deltaMs")
                        player.seekTo(maxOf(0, position))
                    }
                    "rate" -> {
                        val rate = request.getDouble("value")
                        player.setPlaybackSpeed(rate.toFloat())
                        if (isEpisode()) recorder.pinRate(rate)
                    }
                    "sessionShortenPauses" -> {
                        if (!isEpisode()) return failure("Stale")
                        sessionShortenPauses = request.getBoolean("on")
                        applyShortenPauses()
                    }
                    "adopt" -> {
                        val position = request.getJSONObject("position")
                        recorder.adopt(position)
                        installPosition(position)
                    }
                    "fence" -> {
                        player.pause()
                        if (!recorder.fence()) return failure("Unavailable")
                    }
                    "reconcile" -> if (!reconcile()) return failure("Unavailable")
                    else -> return failure("Invalid")
                }
                publish()
            }
        }
        return ok()
    }

    /** OS seeks join native playback ordering without redirecting a stale source's command. */
    private fun seekFromController(positionMs: Long) {
        val loaded = loadId
        val mine = invalidatePlayback()
        scope.launch {
            loads.withLock {
                if (mine != playbackIntent || loadId != loaded || recorder.fenced()) return@withLock
                player.seekTo(maxOf(0, positionMs))
            }
        }
    }

    /** Retires pending resume/advance work; a dispatched installation still drains under the lock. */
    private fun invalidatePlayback(): Long = ++playbackIntent

    /** Replaces the source once the outgoing episode's last write settled (≤ 2 s) and starts it. */
    private suspend fun load(descriptor: JSONObject, episode: Boolean, mine: Long): Boolean = loads.withLock {
        if (mine != playbackIntent) return false
        install(descriptor, episode)
        true
    }

    /** Called only while holding loads. */
    private suspend fun install(descriptor: JSONObject, episode: Boolean) {
        val mediaId = if (episode) UUID.fromString(descriptor.getString("media_id")) else null
        installingSource = true
        try {
            player.stop() // also keeps a pending natural-end advance from taking over (it needs STATE_ENDED)
            recorder.stop()
            release()
            val nextSource = JSONObject().put("kind", if (episode) "Episode" else "Preview").put("descriptor", descriptor)
            sessionShortenPauses = null
            error = null
            val file = mediaId?.let { id -> offline.audioFile(id)?.takeIf { offline.open(id) } }
            if (file != null) leased = mediaId
            val metadata = MediaMetadata.Builder()
                .setTitle(descriptor.getString("title"))
                .setArtist(if (episode) descriptor.nullableString("subtitle") else descriptor.getString("source"))
                .setArtworkUri(descriptor.nullableString(if (episode) "artwork_url" else "imageUrl")?.toUri())
                .build()
            val uri = file?.toUri() ?: descriptor.getString(if (episode) "stream_url" else "audioUrl").toUri()
            player.setMediaItem(
                MediaItem.Builder().setUri(uri).setMediaId(mediaId?.toString() ?: descriptor.getString("target")).setMediaMetadata(metadata).build(),
                if (episode) descriptor.getLong("position_ms") else 0,
            )
            player.setPlaybackSpeed(if (episode) descriptor.getDouble("playback_rate").toFloat() else 1f)
            player.skipSilenceEnabled = episode && descriptor.nullableString("pause_shortening_mode") == "Natural"
            // Listener snapshots can only expose the new source once its settings are installed.
            source = nextSource
            loadId = UUID.randomUUID().toString()
            if (mediaId != null) {
                val overrideRevision = descriptor.nullableLong("consumption_override_revision")
                recorder.start(mediaId, descriptor.getLong("reset_epoch"), overrideRevision)
            }
            player.prepare()
            player.play()
        } finally {
            installingSource = false
        }
        publish()
    }

    /**
     * A play. While this device holds a sample the server may not have (playing, or a write
     * queued), in place. Otherwise it asks the server (2 s; unanswered, the page's [given]
     * descriptor stands in when it knows a reset this session has not): an answer that moved
     * the session (another position or epoch, or the end; P1 replays a finished episode from 0)
     * is loaded, else the session resumes here under the answer's override revision.
     */
    private suspend fun resume(given: JSONObject?, expectedKey: String?, expectedLoadId: String?, mine: Long): String? = loads.withLock {
        if (mine != playbackIntent || expectedKey == null || expectedKey != key() || expectedLoadId != loadId) return "Stale"
        if (recorder.fenced()) return if (reconcile()) "Reconciled" else "Fenced"
        val mediaId = if (isEpisode()) UUID.fromString(key()) else null
        if (mediaId == null || player.playWhenReady || recorder.pending()) {
            playHere()
            return null
        }
        val loaded = loadId
        val fresh = try {
            withTimeoutOrNull(2_000) { origin.player(mediaId) }
        } catch (_: IOException) {
            // justify-ignore-error: an unanswered ordinary resume retains its approved offline policy.
            null
        } catch (refusal: NexusOriginError) {
            if (mine != playbackIntent || loadId != loaded) return "Stale"
            error = if (refusal.status == 401) "sign in to resume playback."
                else "the server refused this episode’s playback state. reload and try again."
            publish()
            return if (refusal.status == 401) "Unauthenticated" else "AuthorityRefused"
        }
        val epoch = recorder.resetEpoch()
        if (mine != playbackIntent || loadId != loaded || epoch == null) return "Stale"
        val best = fresh ?: given?.takeIf { it.getLong("reset_epoch") > epoch }
        if (best != null && (player.playbackState == Player.STATE_ENDED ||
            best.getLong("reset_epoch") != epoch || best.getLong("position_ms") != player.currentPosition)) install(best, episode = true)
        else {
            if (best != null) recorder.refresh(best.nullableLong("consumption_override_revision"))
            playHere()
        }
        null
    }

    /** Read the current playback owner; no position write follows an authority installation. */
    private suspend fun reconcile(): Boolean {
        val loaded = source
        val mediaId = if (isEpisode()) UUID.fromString(key()) else return true
        // A timed-out preparation can still be draining this episode's old writes.
        if (!recorder.fence()) return false
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
            player.seekTo(position.getLong("position_ms"))
            player.pause()
        } finally {
            installingPosition = false
        }
        descriptor()?.put("reset_epoch", position.getLong("reset_epoch"))
            ?.put("consumption_override_revision", position.get("consumption_override_revision"))
        error = null
        synced = true
        publish()
    }

    private fun playHere() {
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
        preparePlayback()
        player.play()
    }

    /** Preparing after stop/error reloads the media, including through a media-session controller. */
    private fun preparePlayback() {
        if (player.playbackState == Player.STATE_IDLE && source != null) loadId = UUID.randomUUID().toString()
        player.prepare()
        publish()
    }

    /** The recorder settled a natural end; the next lectern episode plays if the ended one is still here. */
    private fun advance(loaded: String?, mine: Long, next: JSONObject?) {
        if (next == null) return
        scope.launch {
            loads.withLock {
                if (mine != playbackIntent || loadId != loaded || player.playbackState != Player.STATE_ENDED) return@withLock
                install(next, episode = true)
            }
        }
    }

    private fun drop() {
        release()
        player.stop()
        player.clearMediaItems()
        source = null
        loadId = null
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

    private fun key(): String? = descriptor()?.getString(if (isEpisode()) "media_id" else "target")

    // ---- this load's silence choice, podcast default (absent means off), and time saved ----

    private fun applyShortenPauses() {
        player.skipSilenceEnabled = isEpisode() &&
            (sessionShortenPauses ?: (descriptor()?.nullableString("pause_shortening_mode") == "Natural"))
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
            if (isEpisode()) {
                val mine = playbackIntent
                val loaded = loadId
                recorder.ended { next -> advance(loaded, mine, next) }
            }
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

    // ---- snapshot ----

    private fun snapshot(): JSONObject = JSONObject()
        .put("snapshot_id", ++nextSnapshotId)
        .put("source", source ?: JSONObject.NULL)
        .put("load_id", loadId ?: JSONObject.NULL)
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
        // Keep the float's shortest decimal; widening it directly invents persistence precision.
        .put("rate", player.playbackParameters.speed.toString().toDouble())
        .put("shortenPauses", player.skipSilenceEnabled)
        .put("shortenPausesSavedMs", savedMs)
        .put("error", error ?: JSONObject.NULL)
        .put("synced", synced)
        .put("consumptionRevision", consumptionRevision)

    private fun publish() {
        // Source replacement publishes only after the descriptor owns the installed media item.
        if (installingSource || key() != player.currentMediaItem?.mediaId) return
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

/** A nullable JSON string: null for JSON null. */
private fun JSONObject.nullableString(key: String): String? = if (isNull(key)) null else getString(key)
