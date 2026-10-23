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
import app.nexus.android.DeviceSession
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
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import org.json.JSONArray
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
 * `window.nexusQueueSession` (PlayerBridge → ACTION_REQUEST), recording through
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
    private val descriptorReads = Semaphore(4)
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private val controllerListeners = mutableSetOf<Player.Listener>()
    private var publishedCommands: Player.Commands? = null
    private lateinit var recorder: ListeningRecorder
    private lateinit var offline: OfflineStore
    private lateinit var origin: NexusOriginClient
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private val device by lazy { DeviceSession.get(this) }
    private var releaseDevice: (() -> Unit)? = null
    private var releaseStop: (() -> Unit)? = null
    private var account: UUID? = null
    private var store: PlaybackStore? = null
    private var undoQueue: JSONObject? = null
    private var pendingCheckpoint: Pair<PlaybackStore, JSONObject>? = null
    private var documentOwner: MediaSession.ControllerInfo? = null
    private var documentId: String? = null
    private var draft: QueueDraft? = null
    private data class KnownDraft(val id: String, val descriptor: JSONObject, val chapters: Array<JSONObject?>)
    private var knownDraft: KnownDraft? = null
    private var knownDescriptor: JSONObject? = null
    private var knownPreparationId: String? = null
    private var preparing: Job? = null
    private var preparingQueueId: String? = null
    private var offlineUnsubscribe: (() -> Unit)? = null
    private var activationGeneration = 0L
    private data class EndTransition(val queueId: String, val revision: Long, val entryId: String, val loadId: String?)
    private var pendingEnd: EndTransition? = null
    private var source: JSONObject? = null // {kind: "Episode" | "Preview", descriptor} as the web sent it
    private var loadedEntryId: String? = null
    private var loadId: String? = null // a fresh occurrence, including same-media reloads and service restarts
    private var installingSource = false // suppress reentrant listener snapshots, including same-media installs
    private var leased: UUID? = null
    private var sessionShortenPauses: Boolean? = null
    private var error: String? = null
    private var playbackFailed = false
    private var synced = true
    private var consumptionRevision = 0L
    private var installingPosition = false
    private var ticker: Job? = null
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
            override fun addListener(listener: Player.Listener) { controllerListeners.add(listener); super.addListener(listener) }
            override fun removeListener(listener: Player.Listener) { controllerListeners.remove(listener); super.removeListener(listener) }
            override fun getAvailableCommands(): Player.Commands {
                val commands = super.getAvailableCommands().buildUpon()
                    .remove(Player.COMMAND_SEEK_TO_NEXT).remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS).remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                if (hasNextMediaItem()) commands.add(Player.COMMAND_SEEK_TO_NEXT).add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                if (hasPreviousMediaItem()) commands.add(Player.COMMAND_SEEK_TO_PREVIOUS).add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                return commands.build()
            }
            override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)
            override fun play() {
                val key = key()
                val loaded = loadId
                val mine = retireActivation()
                scope.launch { loads.withLock { resume(key, loaded, mine) } }
            }
            override fun prepare() {
                val loaded = loadId
                val mine = retireActivation()
                scope.launch { loads.withLock {
                    if (mine == activationGeneration && loadId == loaded) preparePlayback()
                } }
            }
            override fun stop() = transport("stop")
            override fun seekToNextMediaItem() = transport("next")
            override fun seekToNext() = transport("next")
            override fun seekToPreviousMediaItem() = transport("previous")
            override fun seekToPrevious() = transport("previous")
            override fun hasNextMediaItem(): Boolean = store?.header()?.let {
                !it.isNull("current_index") && it.getInt("current_index") + 1 < it.getInt("count")
            } == true
            override fun hasPreviousMediaItem(): Boolean = store?.header()?.getInt("count")?.let { it > 0 } == true

            override fun pause() {
                val mine = retireActivation()
                scope.launch { loads.withLock {
                    if (mine == activationGeneration) { player.pause(); saveCheckpoint() }
                } }
            }
            override fun seekTo(positionMs: Long) = seekFromController(positionMs)
            override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
                if (mediaItemIndex == currentMediaItemIndex) seekFromController(positionMs)
            }
            override fun seekBack() = seekFromController(currentPosition - seekBackIncrement)
            override fun seekForward() = seekFromController(currentPosition + seekForwardIncrement)
            // Media3 rewinds an ended item before play; resume owns replay authority.
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
            onOnline = ::prepareOffline,
            onRefused = { mediaId ->
                store?.let { retireDescriptor(it, mediaId) }
                error = "listening changed elsewhere. reconnect to review progress."
                synced = false
                publish()
            },
            onTerminal = { saveLane ->
                val playback = store ?: throw IOException("playback account is unbound")
                val endedEntry = loadedEntryId?.takeIf { isEpisode() && playback.queue.nullableString("current_entry_id") == it }
                playback.update { envelope ->
                    saveLane(envelope)
                    val queue = envelope.getJSONObject("queue")
                    if (endedEntry != null) {
                        moveCursor(queue, 1)
                        queue.put("revision", queue.getLong("revision") + 1)
                        envelope.put("checkpoint", JSONObject.NULL)
                    }
                }
                endedEntry?.let { entry ->
                    undoQueue = null
                    pendingEnd = EndTransition(playback.queue.getString("queue_id"), playback.queue.getLong("revision"), entry, loadId)
                }
            },
        )
        offlineUnsubscribe = offline.addListener { scope.launch { prepareOffline() } }
        releaseStop = device.ownPlaybackStop {
            retireActivation()
            loads.withLock {
                try { unbind() }
                finally {
                    // Explicit sign-out discards pending progress after attempting its checkpoint.
                    recorder.retire()
                    pendingCheckpoint = null
                }
            }
        }
        releaseDevice = device.subscribe { scope.launch { adoptDeviceAccount() } }
        scope.launch { adoptDeviceAccount(); device.checkSession() }
    }

    /** Only DeviceSession chooses the namespace; document hellos merely subscribe. */
    private suspend fun adoptDeviceAccount() {
        try { device.initialize() } catch (_: IOException) { return }
        try { loads.withLock {
            val owner = device.accountId()
            if (owner == account) {
                if (owner != null && device.remotelyAdmitted()) {
                    store?.let { recorder.bind(owner, it) }
                    prepareOffline()
                }
                return@withLock
            }
            unbind()
            if (owner != null && owner == device.accountId()) {
                val playback = PlaybackStore(this, owner)
                store = playback
                account = owner
                recorder.bind(owner, playback)
                consumptionRevision = 0
                // A restored checkpoint never starts audio or manufactures a sample.
                restoreCheckpoint()
                prepareOffline()
            }
            publish()
        } } catch (_: IOException) {
            error = "saved playback couldn’t be opened"
            publish()
        } catch (_: JSONException) {
            error = "saved playback couldn’t be opened"
            publish()
        } catch (_: IllegalArgumentException) {
            error = "saved playback couldn’t be opened"
            publish()
        }
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
        device.setPlaybackActive(false)
        releaseDevice?.invoke()
        releaseStop?.invoke()
        player.pause()
        saveCheckpoint()
        accrueSaved()
        prefs.edit { putLong(PAUSES_SAVED_MS, savedMs) }
        player.removeListener(this)
        offlineUnsubscribe?.invoke()
        recorder.close()
        release()
        scope.cancel()
        session.release()
        player.release()
        super.onDestroy()
    }

    private inner class Callback : MediaSession.Callback {
        /** Any controller: queue transport, play/pause and the 15/30 s seeks; the bridge also gets our two actions. */
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
                Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_PREVIOUS,
                Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
                Player.COMMAND_GET_AUDIO_ATTRIBUTES, Player.COMMAND_GET_DEVICE_VOLUME, Player.COMMAND_GET_TRACKS,
            )
            return ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands.build())
                .setAvailablePlayerCommands(player.build())
                .build()
        }

        override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
            if (documentOwner == controller) { draft = null; knownDraft = null; knownDescriptor = null; knownPreparationId = null; documentOwner = null; documentId = null }
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
            val inbound = try { JSONObject(raw) } catch (_: JSONException) { null } // justify-ignore-error: malformed input is answered below.
            val op = inbound?.optString("op")
            val ownsDocument = inbound != null && inbound.optString("document_id") == documentId && controller == documentOwner
            val mine = if (
                (ownsDocument && (
                    (op == "queue_read" && inbound.optBoolean("reconcile")) ||
                    op in setOf("cancelPlayback", "play", "pause", "seekAndPlay", "seek", "skip", "load", "preview", "fence", "unbind", "dismiss", "queue_commit") ||
                    (op == "queue_command" && inbound.optJSONObject("command")?.optString("kind") in setOf("select", "next", "previous", "stop", "clear", "restore"))
                ))
            ) retireActivation() else null
            scope.launch {
                val reply = try {
                    handle(JSONObject(raw), controller, mine)
                } catch (_: JSONException) {
                    // justify-ignore-error: a missing or ill-typed arg is answered, not acted on.
                    failure("Invalid")
                } catch (_: IllegalArgumentException) {
                    // justify-ignore-error: as above, for an id that is not a uuid.
                    failure("Invalid")
                } catch (_: IOException) {
                    // justify-ignore-error: an unsaved queue is refused, preserving its durable predecessor.
                    player.pause()
                    error = "couldn’t confirm queue change"
                    publish()
                    failure("Unavailable")
                }
                val boundedReply = if (reply.toString().toByteArray(Charsets.UTF_8).size > 32 * 1024)
                    failure("Limit") else reply
                val extras = Bundle().apply { putString(ARG_JSON, boundedReply.toString()) }
                result.set(SessionResult(SessionResult.RESULT_SUCCESS, extras))
            }
            return result
        }
    }

    private data class QueueDraft(val begin: JSONObject, val entries: Array<JSONObject?>,
        val controller: MediaSession.ControllerInfo, val document: String)

    // ---- ops ----

    private suspend fun handle(request: JSONObject, controller: MediaSession.ControllerInfo, mine: Long?): JSONObject {
        val op = request.getString("op")
        val document = request.getString("document_id")
        if (op.startsWith("queue_") && request.toString().toByteArray(Charsets.UTF_8).size > PlaybackStore.MESSAGE_BYTES)
            return failure("Limit")
        if (op == "document_detach") return loads.withLock {
            if (documentOwner == controller && documentId == document) {
                draft = null
                knownDraft = null
                knownDescriptor = null
                knownPreparationId = null
                documentOwner = null
                documentId = null
            }
            ok()
        }
        if (op == "hello") {
            adoptDeviceAccount()
            return loads.withLock {
                if (documentOwner != controller || documentId != document) {
                    draft = null; knownDraft = null; knownDescriptor = null; knownPreparationId = null
                }
                documentOwner = controller
                documentId = document
                publish()
                if (account == null) failure("NotConnected") else ok()
            }
        }
        if (documentOwner != controller || documentId != document) return failure("NotConnected")
        if (op == "unbind") return loads.withLock {
            if (mine != activationGeneration) return failure("Stale")
            unbind(); ok()
        }
        if (account == null) return failure("NotConnected")
        if (op.startsWith("known_")) return loads.withLock { knownRequest(request) }
        if (op.startsWith("queue_")) return loads.withLock {
            if (mine != null && mine != activationGeneration) return failure("Stale")
            queueRequest(request, controller, document)
        }
        when (op) {
            "cancelPlayback" -> return loads.withLock {
                if (mine != activationGeneration) failure("Stale") else ok()
            }
            "load" -> {
                val positionMs = if (request.get("position_ms") == JSONObject.NULL) null else {
                    val position = request.getDouble("position_ms")
                    require(position.isFinite() && position >= 0)
                    position.toLong()
                }
                val mediaId = UUID.fromString(request.getString("media_id"))
                val generation = mine
                loads.withLock {
                    if (generation != activationGeneration) return failure("Stale")
                    val descriptor = resolveDescriptor(mediaId)
                    if (generation != activationGeneration) return failure("Stale")
                    if (descriptor == null) return failure("Unavailable")
                    if (!install(descriptor, episode = true, play = request.getBoolean("play"), positionMs = positionMs))
                        return failure(if (generation != activationGeneration) "Stale" else "Unavailable")
                }
            }
            "preview" -> loads.withLock {
                if (mine != activationGeneration) return failure("Stale")
                player.pause(); checkpoint()
                if (!install(request.getJSONObject("descriptor"), episode = false)) return failure("Stale")
            }
            "dismiss" -> loads.withLock {
                if (mine != activationGeneration) return failure("Stale")
                player.pause()
                if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
                if (mine != activationGeneration) return failure("Stale")
                drop()
            }
            else -> loads.withLock {
                if (mine != null && mine != activationGeneration) return failure("Stale")
                // Validate the occurrence at application, after any source replacement finished.
                if (request.getString("key") != key() || request.getString("expected_load_id") != loadId)
                    return failure("Stale")
                when (op) {
                    "chapters" -> {
                        val offset = request.getInt("offset")
                        val limit = request.getInt("limit")
                        require(offset >= 0 && limit in 1..20)
                        val chapters = descriptor()?.optJSONArray("chapters") ?: JSONArray()
                        val page = JSONArray()
                        for (index in offset until minOf(offset + limit, chapters.length())) page.put(chapters.get(index))
                        return JSONObject().put("ok", true).put("chapters", page).put("chapter_count", chapters.length())
                    }
                    "rate" -> {
                        val rate = request.getDouble("value")
                        player.setPlaybackSpeed(rate.toFloat())
                        if (isEpisode()) recorder.pinRate(rate)
                        checkpoint()
                    }
                    "sessionShortenPauses" -> {
                        if (!isEpisode()) return failure("Stale")
                        sessionShortenPauses = request.getBoolean("on")
                        applyShortenPauses()
                        checkpoint()
                    }
                    "seekAndPlay" -> {
                        val position = request.getDouble("position_ms")
                        if (!position.isFinite() || position < 0) return failure("Invalid")
                        if (!isEpisode() || player.playbackState == Player.STATE_ENDED || loadedEntryId != store?.queue?.nullableString("current_entry_id")) return failure("Stale")
                        if (recorder.fenced()) return failure("Fenced")
                        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
                        player.seekTo(minOf(position.toLong(), duration ?: Long.MAX_VALUE))
                        playHere()
                        checkpoint()
                    }
                    "seek", "skip" -> if (!recorder.fenced()) {
                        val position = if (op == "seek") request.getLong("positionMs")
                            else player.currentPosition + request.getLong("deltaMs")
                        restoreEndedSelection()
                        player.seekTo(maxOf(0, position))
                        checkpoint()
                    }
                    "play" -> resume(request.getString("key"), request.getString("expected_load_id"), mine ?: return failure("Stale"))?.let { return failure(it) }
                    "pause" -> {
                        player.pause()
                        checkpoint()
                    }
                    "adopt" -> {
                        val position = request.getJSONObject("position")
                        recorder.adopt(position)
                        installPosition(position)
                    }
                    "fence" -> {
                        player.pause()
                        checkpoint()
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

    /** OS seeks use the same intent and loaded occurrence fences as document commands. */
    private fun seekFromController(positionMs: Long) {
        val loaded = loadId
        val mine = retireActivation()
        scope.launch { loads.withLock {
            if (mine != activationGeneration || loadId != loaded || recorder.fenced()) return@withLock
            restoreEndedSelection()
            player.seekTo(maxOf(0, positionMs))
            saveCheckpoint()
        } }
    }

    /** Called under [loads]; only a fully installed source may publish its occurrence. */
    private suspend fun install(descriptor: JSONObject, episode: Boolean, play: Boolean = true, occurrenceId: String? = null, positionMs: Long? = null): Boolean {
        val mediaId = if (episode) UUID.fromString(descriptor.getString("media_id")) else null
        val generation = activationGeneration
        val authorityRevision = mediaId?.let(recorder::authorityRevision)
        installingSource = true
        try {
            player.stop() // also keeps a pending natural-end advance from taking over (it needs STATE_ENDED)
            if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
            if (generation != activationGeneration) return false
            if (mediaId != null && recorder.authorityRevision(mediaId) != authorityRevision) {
                playbackFailed = true
                return false
            }
            if (mediaId != null) store?.descriptor(mediaId)?.takeIf { it.getLong("reset_epoch") == descriptor.getLong("reset_epoch") }?.let {
                descriptor.put("consumption_override_revision", it.get("consumption_override_revision"))
                if (occurrenceId != loadedEntryId) it.optJSONObject("local_listening")?.let { listening ->
                    descriptor.put("position_ms", if (it.optBoolean("locally_completed")) 0 else listening.getLong("position_ms"))
                }
            }
            if (positionMs != null) {
                val duration = descriptor.nullableLong("duration_ms")?.takeIf { it > 0 }
                descriptor.put("position_ms", minOf(positionMs, duration ?: Long.MAX_VALUE))
            }
            release()
            val nextSource = JSONObject().put("kind", if (episode) "Episode" else "Preview").put("descriptor", descriptor)
            sessionShortenPauses = null
            error = null
            playbackFailed = false
            val file = mediaId?.let { id -> offline.readyAudioFile(id)?.takeIf { offline.open(id) } }
            val offlineOnly = descriptor.optBoolean("offline_only")
            descriptor.remove("offline_only")
            if (file == null && offlineOnly) {
                playbackFailed = true
                error = "needs a connection before offline play"
                drop(keepError = true)
                return false
            }
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
            loadedEntryId = occurrenceId
            pendingEnd = null
            if (mediaId != null) {
                val overrideRevision = descriptor.nullableLong("consumption_override_revision")
                recorder.start(mediaId, descriptor.getLong("reset_epoch"), overrideRevision)
            }
            player.prepare()
            if (play) player.play()
            return true
        } finally {
            installingSource = false
            publish()
        }
    }

    /** Called under loads; acknowledgement follows the installed/resumed occurrence. */
    private suspend fun resume(expectedKey: String?, expectedLoadId: String?, mine: Long): String? {
        if (mine != activationGeneration || expectedKey == null || expectedKey != key() || expectedLoadId != loadId) return "Stale"
        if (recorder.fenced()) return if (reconcile()) "Reconciled" else "Fenced"
        if (isEpisode() && (pendingEnd != null && loadedEntryId != store?.queue?.nullableString("current_entry_id") || !recorder.attached())) {
            val activated = activateCurrent(play = true, checkpoint = pendingEnd == null)
            return if (mine != activationGeneration) "Stale" else if (activated) null else "Unavailable"
        }
        val mediaId = if (isEpisode()) UUID.fromString(key()) else null
        if (mediaId == null || player.playWhenReady || recorder.pending()) { playHere(); return null }
        val loaded = loadId
        val fresh = resolveDescriptor(mediaId)
        if (mine != activationGeneration || loadId != loaded) return "Stale"
        val epoch = recorder.resetEpoch() ?: return "Stale"
        val best = fresh ?: return "Unavailable"
        if (player.playbackState == Player.STATE_ENDED || best.getLong("reset_epoch") != epoch || best.getLong("position_ms") != player.currentPosition) {
            if (!install(best, episode = true, occurrenceId = loadedEntryId))
                return if (mine != activationGeneration) "Stale" else "Unavailable"
        } else {
            recorder.refresh(best.nullableLong("consumption_override_revision"))
            playHere()
        }
        return null
    }

    /** Read the current playback owner; no position write follows an authority installation. */
    private suspend fun reconcile(): Boolean {
        val loaded = source
        val mediaId = if (isEpisode()) UUID.fromString(key()) else return true
        // A timed-out preparation can still be draining this episode's old writes.
        if (!recorder.fence()) return false
        if (loaded !== source) return false
        val fresh = try {
            descriptorReads.withPermit { origin.player(mediaId) }
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
        store?.let { retainDescriptor(it, mediaId, fresh) }
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
        val mediaId = if (isEpisode()) key() else null
        if (mediaId != null) store?.update { envelope ->
            envelope.getJSONObject("descriptors").optJSONObject(mediaId)?.apply {
                put("reset_epoch", position.getLong("reset_epoch"))
                put("position_ms", position.getLong("position_ms"))
                put("consumption_override_revision", position.get("consumption_override_revision"))
                remove("local_listening"); remove("locally_completed")
            }
        }
        saveCheckpoint()
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

    private fun drop(keepError: Boolean = false) {
        release()
        player.stop()
        player.clearMediaItems()
        source = null
        loadId = null
        loadedEntryId = null
        pendingEnd = null
        sessionShortenPauses = null
        if (!keepError) { error = null; playbackFailed = false }
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

    /** A page's already-authorized descriptor is only an outage candidate, never a substitute for an origin refusal. */
    private fun knownRequest(request: JSONObject): JSONObject {
        if (request.toString().toByteArray(Charsets.UTF_8).size > PlaybackStore.MESSAGE_BYTES) return failure("Limit")
        val id = request.getString("preparation_id")
        when (request.getString("op")) {
            "known_begin" -> {
                val descriptor = request.getJSONObject("descriptor")
                UUID.fromString(descriptor.getString("media_id"))
                val count = request.getInt("count")
                require(count in 0..100 && !descriptor.has("chapters"))
                knownDraft = KnownDraft(id, JSONObject(descriptor.toString()), arrayOfNulls(count))
                knownPreparationId = id
                knownDescriptor = null
            }
            "known_chunk" -> {
                val input = knownDraft?.takeIf { it.id == id } ?: return failure("Stale")
                val offset = request.getInt("offset")
                val chapters = request.getJSONArray("chapters")
                require(offset >= 0 && chapters.length() in 1..20 && offset + chapters.length() <= input.chapters.size)
                for (index in 0 until chapters.length()) {
                    val chapter = chapters.getJSONObject(index)
                    require(chapter.getString("title").codePointCount(0, chapter.getString("title").length) in 1..300)
                    require(chapter.getLong("start_ms") >= 0 && (chapter.nullableLong("end_ms") ?: 0) >= 0)
                    val previous = input.chapters[offset + index]
                    if (previous != null && previous.toString() != chapter.toString()) return failure("Stale")
                }
                for (index in 0 until chapters.length()) input.chapters[offset + index] = chapters.getJSONObject(index)
            }
            "known_commit" -> {
                val input = knownDraft?.takeIf { it.id == id } ?: return failure("Stale")
                if (input.chapters.any { it == null }) return failure("Stale")
                knownDescriptor = input.descriptor.put("chapters", JSONArray(input.chapters.toList()))
                knownDraft = null
            }
            "known_cancel" -> if (knownPreparationId == id) { knownDraft = null; knownDescriptor = null; knownPreparationId = null }
            else -> return failure("Invalid")
        }
        return ok()
    }

    /** A document draft is memory only; every durable command shares the source/load mutex. */
    private suspend fun queueRequest(request: JSONObject, controller: MediaSession.ControllerInfo, document: String): JSONObject {
        val playback = store ?: return failure("NotConnected")
        val queue = playback.queue
        when (request.getString("op")) {
            "queue_read" -> {
                if (request.optBoolean("reconcile")) { retireActivation(); player.pause(); checkpoint() }
                return ok()
            }
            "queue_page" -> {
                if (request.getString("expected_revision") != queue.getLong("revision").toString()) return failure("Stale")
                val offset = request.getInt("offset")
                val limit = request.getInt("limit")
                require(offset >= 0 && limit in 1..100)
                val entries = queue.getJSONArray("entries")
                val page = JSONArray()
                for (index in offset until minOf(offset + limit, entries.length())) page.put(entries.get(index))
                return ok().put("entries", page)
            }
            "queue_begin" -> {
                val begin = JSONObject(request.toString()).apply { remove("id"); remove("op"); remove("document_id") }
                UUID.fromString(begin.getString("queue_id"))
                val count = begin.getInt("count")
                if (count !in 0..PlaybackStore.MAX_ENTRIES) return failure("Limit")
                PlaybackStore.validateSource(begin.optJSONObject("source"))
                val existing = draft
                if (existing != null && existing.begin.getString("queue_id") == begin.getString("queue_id"))
                    return if (existing.begin.toString() == begin.toString()) ok() else failure("Stale")
                if (begin.nullableString("expected_revision") != queue.getLong("revision").toString()) return failure("Stale")
                draft = QueueDraft(begin, arrayOfNulls(count), controller, document)
                return ok()
            }
            "queue_chunk" -> {
                val input = draft ?: return failure("Stale")
                if (input.controller != controller || input.document != document || input.begin.getString("queue_id") != request.getString("queue_id")) return failure("Stale")
                val offset = request.getInt("offset")
                val entries = request.getJSONArray("entries")
                require(offset >= 0 && entries.length() in 1..100 && offset + entries.length() <= input.entries.size)
                for (index in 0 until entries.length()) {
                    val entry = entries.getJSONObject(index)
                    PlaybackStore.validateEntry(entry)
                    val previous = input.entries[offset + index]
                    if (previous != null && (previous.getString("id") != entry.getString("id") || previous.getString("media_id") != entry.getString("media_id"))) return failure("Stale")
                }
                for (index in 0 until entries.length()) input.entries[offset + index] = entries.getJSONObject(index)
                return ok()
            }
            "queue_cancel" -> {
                if (draft?.begin?.getString("queue_id") == request.getString("queue_id")) draft = null
                return ok()
            }
            "queue_commit" -> {
                val id = request.getString("queue_id")
                if (queue.getString("queue_id") == id) return ok()
                val input = draft ?: return failure("Stale")
                if (input.controller != controller || input.document != document || input.begin.getString("queue_id") != id || input.entries.any { it == null }) return failure("Stale")
                if (input.begin.nullableString("expected_revision") != queue.getLong("revision").toString()) return failure("Stale")
                val next = JSONObject().put("queue_id", id).put("entries", JSONArray(input.entries.toList()))
                    .put("current_entry_id", input.begin.get("current_entry_id")).put("source", input.begin.get("source"))
                    .put("revision", queue.getLong("revision") + 1)
                PlaybackStore.validateQueue(next)
                val generation = retireActivation()
                player.pause()
                checkpoint()
                if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
                if (generation != activationGeneration) return failure("Stale")
                playback.update {
                    it.put("queue", next).put("checkpoint", JSONObject.NULL)
                    trimDescriptors(it, queue)
                }
                undoQueue = JSONObject(queue.toString())
                draft = null
                drop()
                prepareOffline()
                return ok()
            }
            "queue_command" -> return queueCommand(request)
            else -> return failure("Invalid")
        }
    }

    private fun moveCursor(queue: JSONObject, delta: Int) {
        val entries = queue.getJSONArray("entries")
        val current = queue.nullableString("current_entry_id")
        val index = (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == current }
        val next = if (index == null) { if (delta < 0) entries.length() - 1 else -1 }
            else if (delta < 0) maxOf(0, index - 1) else index + 1
        queue.put("current_entry_id", if (next in 0 until entries.length()) entries.getJSONObject(next).getString("id") else JSONObject.NULL)
    }

    private suspend fun queueCommand(request: JSONObject): JSONObject {
        val playback = store ?: return failure("NotConnected")
        val old = playback.queue
        val next = JSONObject(old.toString())
        val command = request.getJSONObject("command")
        val kind = command.getString("kind")
        val entries = next.getJSONArray("entries")
        val current = next.nullableString("current_entry_id")
        val currentIndex = (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == current } ?: -1
        val exact = request.getString("queue_id") == old.getString("queue_id") && request.getString("expected_revision") == old.getLong("revision").toString()
        var play = player.playWhenReady
        var activate = false
        var positionMs: Long? = null
        when (kind) {
            "append", "insert-next" -> {
                val entry = command.getJSONObject("entry")
                PlaybackStore.validateEntry(entry)
                val existing = (0 until entries.length()).map(entries::getJSONObject).firstOrNull { it.getString("id") == entry.getString("id") }
                if (existing != null) return if (request.getString("queue_id") == old.getString("queue_id") && existing.getString("media_id") == entry.getString("media_id")) ok() else failure("Stale")
                if (!exact) return failure("Stale")
                if (entries.length() == PlaybackStore.MAX_ENTRIES) return failure("Limit")
                val list = (0 until entries.length()).map(entries::getJSONObject).toMutableList()
                list.add(if (kind == "append" || currentIndex < 0) list.size else currentIndex + 1, entry)
                next.put("entries", JSONArray(list))
                if (current == null) next.put("current_entry_id", entry.getString("id"))
                if (current == null) { play = false; activate = true }
            }
            "move-before" -> {
                if (currentIndex < 0) return failure("Invalid")
                val id = command.getString("entry_id")
                val before = command.nullableString("before_entry_id")
                val index = (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == id } ?: return failure("Stale")
                val destination = if (before == null) entries.length() else (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == before } ?: return failure("Stale")
                if (index <= currentIndex || destination <= currentIndex) return failure("Invalid")
                if (index == destination || index + 1 == destination) return if (request.getString("queue_id") == old.getString("queue_id")) ok() else failure("Stale")
                if (!exact) return failure("Stale")
                val list = (0 until entries.length()).map(entries::getJSONObject).toMutableList()
                val entry = list.removeAt(index)
                list.add(if (before == null) list.size else list.indexOfFirst { it.getString("id") == before }, entry)
                next.put("entries", JSONArray(list))
            }
            "remove" -> {
                val id = command.getString("entry_id")
                val index = (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == id }
                    ?: return if (request.getString("queue_id") == old.getString("queue_id")) ok() else failure("Stale")
                if (currentIndex < 0) return failure("Invalid")
                if (!exact) return failure("Stale")
                if (index < currentIndex || (index == currentIndex && (!command.getBoolean("failed_current") || !playbackFailed))) return failure("Invalid")
                if (index == currentIndex) { moveCursor(next, 1); activate = true; play = false }
                entries.remove(index)
            }
            "select" -> {
                if (command.get("position_ms") != JSONObject.NULL) {
                    val position = command.getDouble("position_ms")
                    require(position.isFinite() && position >= 0)
                    positionMs = position.toLong()
                }
                val id = command.getString("entry_id")
                if ((0 until entries.length()).none { entries.getJSONObject(it).getString("id") == id }) return failure("Stale")
                if (!exact) return if (positionMs == null && request.getString("queue_id") == old.getString("queue_id") && current == id) ok() else failure("Stale")
                next.put("current_entry_id", id)
                play = command.getBoolean("play")
                activate = true
            }
            "next", "previous" -> {
                if (!exact) return failure("Stale")
                if (kind == "previous" && current != null && player.currentPosition > 3_000 && loadedEntryId == current) {
                    retireActivation(); player.seekTo(0); checkpoint(); return ok()
                }
                moveCursor(next, if (kind == "next") 1 else -1)
                if (current == null) play = false
                activate = true
            }
            "stop" -> {
                if (!exact && source != null) return failure("Stale")
                val generation = retireActivation()
                player.pause(); checkpoint()
                if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
                if (generation != activationGeneration) return failure("Stale")
                drop(); return ok()
            }
            "restore" -> {
                if (!exact) return failure("Stale")
                val previous = undoQueue ?: return failure("Stale")
                next.put("queue_id", UUID.randomUUID().toString()).put("entries", previous.getJSONArray("entries"))
                    .put("current_entry_id", previous.get("current_entry_id")).put("source", previous.get("source"))
                activate = true; play = false
            }
            "clear" -> {
                if (!exact && entries.length() == 0 && next.isNull("source")) return ok()
                if (!exact) return failure("Stale")
                next.put("queue_id", UUID.randomUUID().toString()).put("entries", JSONArray())
                    .put("current_entry_id", JSONObject.NULL).put("source", JSONObject.NULL)
                activate = true; play = false
            }
            else -> return failure("Invalid")
        }
        PlaybackStore.validateQueue(next)
        val changed = next.toString() != old.toString()
        val selectionChanged = next.nullableString("current_entry_id") != current || kind == "clear" || kind == "restore"
        var generation = activationGeneration
        if (activate || selectionChanged) {
            generation = retireActivation()
            player.pause()
            checkpoint()
            if (selectionChanged && !recorder.stop()) throw IOException("listening checkpoint was not persisted")
            if (generation != activationGeneration) return failure("Stale")
        }
        if (changed) playback.update {
            next.put("revision", old.getLong("revision") + 1)
            it.put("queue", next)
            if (selectionChanged) it.put("checkpoint", JSONObject.NULL)
            trimDescriptors(it, if (kind == "clear") old else null)
        }
        if (changed) undoQueue = if (kind == "clear") JSONObject(old.toString()) else null
        val activated = !activate || activateCurrent(play, checkpoint = !selectionChanged, positionMs = positionMs)
        if (positionMs != null) {
            if (generation != activationGeneration) return failure("Stale")
            if (!activated) return failure("Unavailable")
        }
        prepareOffline()
        publish()
        return ok()
    }

    /** Retain authority for this queue and its one undo offer; old replacements cannot grow a device cache. */
    private fun trimDescriptors(envelope: JSONObject, previous: JSONObject?) {
        val keep = HashSet<String>()
        for (queue in listOfNotNull(envelope.getJSONObject("queue"), previous)) {
            val entries = queue.getJSONArray("entries")
            for (index in 0 until entries.length()) keep.add(entries.getJSONObject(index).getString("media_id"))
        }
        val descriptors = envelope.getJSONObject("descriptors")
        for (id in descriptors.keys().asSequence().toList()) if (id !in keep) descriptors.remove(id)
    }

    private fun transport(kind: String) {
        val mine = retireActivation()
        scope.launch { loads.withLock {
            if (mine != activationGeneration) return@withLock
            val playback = store ?: return@withLock
            queueCommand(JSONObject().put("queue_id", playback.queue.getString("queue_id"))
                .put("expected_revision", playback.queue.getLong("revision").toString())
                .put("command", JSONObject().put("kind", kind)))
        } }
    }

    private fun restoreEndedSelection() {
        val transition = pendingEnd ?: return
        val playback = store ?: return
        if (transition.loadId == loadId && playback.queue.getString("queue_id") == transition.queueId && playback.queue.getLong("revision") == transition.revision) {
            playback.update {
                val queue = it.getJSONObject("queue")
                queue.put("current_entry_id", transition.entryId).put("revision", transition.revision + 1)
            }
        }
        pendingEnd = null
    }

    private fun retireActivation(): Long = ++activationGeneration

    /** Explicit account departure pauses before checkpoint/delivery suspension, even when saving fails. */
    private suspend fun unbind() {
        retireActivation()
        preparing?.cancelAndJoin()
        draft = null
        knownDraft = null
        knownDescriptor = null
        knownPreparationId = null
        player.pause()
        var failed: IOException? = null
        try {
            pendingCheckpoint?.let { (playback, checkpoint) -> playback.update { it.put("checkpoint", checkpoint) }; pendingCheckpoint = null }
            checkpoint()
            if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
        } catch (error: IOException) { failed = error }
        try { recorder.unbind() } catch (error: IOException) { failed = error }
        account = null
        store = null
        undoQueue = null
        drop()
        if (failed != null) throw failed
    }

    private var lastCheckpoint = 0L
    private fun saveCheckpoint() {
        try { checkpoint(); lastCheckpoint = SystemClock.elapsedRealtime() }
        catch (_: IOException) { // justify-ignore-error: audio stops and the unsaved checkpoint remains available for retry.
            retireActivation(); player.pause(); error = "couldn’t confirm queue change"; publish()
        }
    }

    private fun checkpoint() {
        val playback = store ?: return
        if (!isEpisode() || loadedEntryId == null || loadedEntryId != playback.queue.nullableString("current_entry_id")) return
        val descriptor = descriptor() ?: return
        val listening = JSONObject().put("position_ms", maxOf(0, player.currentPosition))
            .put("duration_ms", player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: descriptor.get("duration_ms"))
            .put("expected_reset_epoch", recorder.resetEpoch() ?: descriptor.getLong("reset_epoch"))
            .put("episode_playback_rate", player.playbackParameters.speed.toString().toDouble())
        val checkpoint = JSONObject().put("entry_id", loadedEntryId).put("listening", listening)
            .put("consumption_override_revision", recorder.overrideRevision() ?: JSONObject.NULL)
            .put("shorten_pauses", player.skipSilenceEnabled)
        pendingCheckpoint = playback to checkpoint
        playback.update { it.put("checkpoint", checkpoint) }
        pendingCheckpoint = null
    }

    private suspend fun restoreCheckpoint() {
        val playback = store ?: return
        val entry = playback.header().optJSONObject("current_entry") ?: return drop()
        val mediaId = UUID.fromString(entry.getString("media_id"))
        if (playback.descriptor(mediaId) == null || offline.readyAudioFile(mediaId) == null) return drop()
        activateCurrent(play = false, checkpoint = true, refresh = false)
    }

    private suspend fun activateCurrent(play: Boolean, checkpoint: Boolean, refresh: Boolean = true, positionMs: Long? = null): Boolean {
        val playback = store ?: return false
        val header = playback.header()
        val entry = header.optJSONObject("current_entry")
        if (entry == null) { drop(); return true }
        val entryId = entry.getString("id")
        if (loadedEntryId == entryId && source != null && recorder.attached() && checkpoint && positionMs == null) {
            if (play) return resume(key(), loadId, activationGeneration) == null
            player.pause()
            return true
        }
        val generation = activationGeneration
        val descriptor = resolveDescriptor(UUID.fromString(entry.getString("media_id")), refresh)
        if (generation != activationGeneration || store !== playback || playback.queue.nullableString("current_entry_id") != entryId) return false
        if (descriptor == null) { drop(keepError = true); return false }
        if (checkpoint) playback.value.optJSONObject("checkpoint")?.takeIf { it.getString("entry_id") == entryId }?.let {
            val listening = it.getJSONObject("listening")
            if (listening.getLong("expected_reset_epoch") == descriptor.getLong("reset_epoch") &&
                it.nullableLong("consumption_override_revision") == descriptor.nullableLong("consumption_override_revision")) {
                descriptor.put("position_ms", listening.getLong("position_ms"))
                    .put("playback_rate", listening.getDouble("episode_playback_rate"))
                    .put("pause_shortening_mode", if (it.getBoolean("shorten_pauses")) "Natural" else "Off")
            }
        }
        if (!install(descriptor, episode = true, play = play, occurrenceId = entryId, positionMs = positionMs)) return false
        if (positionMs != null) checkpoint()
        return true
    }

    /** Resource refusal retires retained authority; interrupted admission keeps prepared local files. */
    private suspend fun resolveDescriptor(mediaId: UUID, refresh: Boolean = true): JSONObject? {
        val playback = store ?: return null
        val generation = activationGeneration
        val factRevision = recorder.factRevision(mediaId)
        val authorityRevision = recorder.authorityRevision(mediaId)
        var transportFailed = !refresh
        if (refresh) {
            val fresh = try {
                descriptorReads.withPermit { origin.player(mediaId) }
            } catch (_: IOException) {
                // justify-ignore-error: transport loss permits only explicit prepared offline authority.
                null
            } catch (failure: NexusOriginError) {
                if (failure.status !in setOf(401, 408, 426, 429) && failure.status < 500) {
                    retireDescriptor(playback, mediaId)
                    if (store !== playback || generation != activationGeneration) return null
                    playbackFailed = true
                    error = "episode unavailable"
                    publish()
                    return null
                }
                null // unavailable service; existing offline authority still requires its complete file.
            }
            if (store !== playback || generation != activationGeneration || recorder.authorityRevision(mediaId) != authorityRevision) return null
            if (fresh != null) {
                retainDescriptor(playback, mediaId, fresh,
                    recorder.hasPending(mediaId) || recorder.factRevision(mediaId) != factRevision)
            } else {
                transportFailed = true
                knownDescriptor?.takeIf { it.getString("media_id") == mediaId.toString() }?.let {
                    retainDescriptor(playback, mediaId, JSONObject(it.toString()), preserveLocal = true)
                }
            }
            if (knownDescriptor?.getString("media_id") == mediaId.toString()) knownDescriptor = null
        }
        if (store !== playback || generation != activationGeneration) return null
        val retained = playback.descriptor(mediaId)
        if (retained == null || (transportFailed && offline.readyAudioFile(mediaId)?.isFile != true)) {
            playbackFailed = true
            error = "needs a connection before offline play"
            publish()
            return null
        }
        val listening = retained.optJSONObject("local_listening")
        if (listening != null && listening.getLong("expected_reset_epoch") == retained.getLong("reset_epoch")) {
            retained.put("position_ms", if (retained.optBoolean("locally_completed")) 0 else listening.getLong("position_ms"))
            if (!listening.isNull("episode_playback_rate")) retained.put("playback_rate", listening.getDouble("episode_playback_rate"))
        }
        retained.put("offline_only", transportFailed)
        return retained
    }

    /** One refusal fences every earlier read and removes both saved and page-provided playback authority. */
    private fun retireDescriptor(playback: PlaybackStore, mediaId: UUID) {
        if (store !== playback) return
        recorder.retireAuthority(mediaId)
        if (knownDescriptor?.getString("media_id") == mediaId.toString()) knownDescriptor = null
        playback.update { it.getJSONObject("descriptors").remove(mediaId.toString()) }
    }

    private fun retainDescriptor(playback: PlaybackStore, mediaId: UUID, fresh: JSONObject, preserveLocal: Boolean = false) {
        playback.update { envelope ->
            val descriptors = envelope.getJSONObject("descriptors")
            val previous = descriptors.optJSONObject(mediaId.toString())
            if (previous != null && previous.getLong("reset_epoch") > fresh.getLong("reset_epoch")) return@update
            if (previous != null && previous.getLong("reset_epoch") == fresh.getLong("reset_epoch")) {
                if ((previous.nullableLong("consumption_override_revision") ?: 0L) > (fresh.nullableLong("consumption_override_revision") ?: 0L))
                    fresh.put("consumption_override_revision", previous.get("consumption_override_revision"))
                if (preserveLocal) previous.optJSONObject("local_listening")?.let {
                    fresh.put("local_listening", it).put("locally_completed", previous.optBoolean("locally_completed"))
                }
            }
            descriptors.put(mediaId.toString(), fresh)
        }
    }

    /** Four workers, not ten thousand jobs; online queue acknowledgement never waits for preparation. */
    private fun prepareOffline() {
        val playback = store ?: return
        val queueId = playback.queue.getString("queue_id")
        if (preparing?.isActive == true && preparingQueueId == queueId) return
        preparing?.cancel()
        preparingQueueId = queueId
        val entries = playback.queue.getJSONArray("entries")
        val ids = (0 until entries.length()).map { UUID.fromString(entries.getJSONObject(it).getString("media_id")) }.distinct()
            .filter { offline.readyAudioFile(it)?.isFile == true && playback.descriptor(it) == null }
        preparing = scope.launch {
            var index = 0
            coroutineScope {
                List(4) { async {
                    while (index < ids.size) {
                        val mediaId = ids[index++]
                        val factRevision = recorder.factRevision(mediaId)
                        val authorityRevision = recorder.authorityRevision(mediaId)
                        val fresh = try { descriptorReads.withPermit { origin.player(mediaId) } }
                        catch (_: IOException) { continue } // justify-ignore-error: a later network/download event retries preparation.
                        catch (failure: NexusOriginError) {
                            if (failure.status !in setOf(401, 408, 426, 429) && failure.status < 500)
                                retireDescriptor(playback, mediaId)
                            continue
                        }
                        loads.withLock {
                            if (store === playback && playback.queue.getString("queue_id") == queueId && recorder.authorityRevision(mediaId) == authorityRevision && offline.readyAudioFile(mediaId)?.isFile == true)
                                retainDescriptor(playback, mediaId, fresh,
                                    recorder.hasPending(mediaId) || recorder.factRevision(mediaId) != factRevision)
                        }
                    }
                } }.awaitAll()
            }
        }
    }

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
        device.setPlaybackActive(isPlaying)
        if (isPlaying) { error = null; playbackFailed = false }
        // at the end the recorder settles instead of writing
        if (player.playbackState != Player.STATE_ENDED) recorder.playing(isPlaying)
        accrueSaved()
        ticker?.cancel()
        if (isPlaying) {
            ticker = scope.launch {
                while (true) {
                    delay(1_000)
                    accrueSaved()
                    if (SystemClock.elapsedRealtime() - lastCheckpoint >= 15_000) saveCheckpoint()
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
                val generation = activationGeneration
                val endedLoad = loadId
                if (recorder.ended()) scope.launch {
                    loads.withLock {
                        publish()
                        if (activationGeneration == generation && loadId == endedLoad && player.playbackState == Player.STATE_ENDED)
                            activateCurrent(play = true, checkpoint = false)
                    }
                } else error = "couldn’t confirm queue change"
            }
        }
        publish()
    }

    override fun onPositionDiscontinuity(oldPosition: PositionInfo, newPosition: PositionInfo, reason: Int) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK && !installingPosition) {
            retireActivation()
            restoreEndedSelection()
            recorder.seeked(oldPosition.positionMs)
            saveCheckpoint()
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
        playbackFailed = isEpisode() && loadedEntryId != null && loadedEntryId == store?.queue?.nullableString("current_entry_id")
        this.error = getString(R.string.player_source_failure)
        publish()
    }

    // ---- snapshot ----

    private fun snapshot(): JSONObject = JSONObject()
        .put("snapshot_id", ++nextSnapshotId)
        .put("source", source?.let { JSONObject().put("kind", it.getString("kind"))
            .put("descriptor", if (isEpisode()) JSONObject(it.getJSONObject("descriptor").toString()).apply {
                remove("chapters"); remove("local_listening"); remove("locally_completed")
            } else it.getJSONObject("descriptor")) } ?: JSONObject.NULL)
        .put("queue", store?.header()?.put("can_restore", undoQueue != null) ?: JSONObject.NULL)
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
        .put("playback_failed", playbackFailed)
        .put("synced", synced)
        .put("consumptionRevision", consumptionRevision)

    private fun publish() {
        // Source replacement publishes only after the descriptor owns the installed media item.
        if (installingSource || key() != player.currentMediaItem?.mediaId) return
        val commands = session.player.availableCommands
        if (commands != publishedCommands) {
            publishedCommands = commands
            for (listener in controllerListeners.toList()) listener.onAvailableCommandsChanged(commands)
        }
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
