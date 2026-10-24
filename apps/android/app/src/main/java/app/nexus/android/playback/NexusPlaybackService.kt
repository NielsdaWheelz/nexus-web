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
import app.nexus.android.LocalStateError
import app.nexus.android.R
import app.nexus.android.offline.OfflineStore
import app.nexus.android.offline.EpisodeLease
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
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.sync.withLock
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
 * `window.nexusPlayer` (PlayerBridge → ACTION_REQUEST), recording through
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
    private var offlineUnsubscribe: (() -> Unit)? = null
    private var activationGeneration = 0L
    private data class EndTransition(val queueId: String, val revision: Long, val entryId: String, val loadId: String?)
    private var pendingEnd: EndTransition? = null
    private var source: JSONObject? = null // {kind: "Episode" | "Preview", descriptor} as the web sent it
    private var loadedEntryId: String? = null
    private var loadId: String? = null // a fresh occurrence, including same-media reloads and service restarts
    private var installingSource = false // suppress reentrant listener snapshots, including same-media installs
    private var leased: EpisodeLease? = null
    private data class Activation(val descriptor: JSONObject, val lease: EpisodeLease?, val localRepair: LocalStateError? = null)
    private data class RemoteActivation(val mediaId: UUID, val accountId: UUID, val generation: Long, val response: JSONObject?, val refused: Boolean, val localRepair: LocalStateError?)
    private var savingFailed = false
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
                scope.launch {
                    val prepared = prepareActivation(resumeMediaId())
                    loads.withLock { resume(key, loaded, mine, prepared) }
                }
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
            onSaveFailed = ::listeningSaveFailed,
            onAccepted = { consumptionRevision += 1; publish() },
            onSynced = {
                synced = it
                publish()
            },
            onRefused = { mediaId ->
                if (key() == mediaId.toString()) error = if (leased != null) "original no longer available · downloaded copy kept" else "original no longer available · listening saved locally"
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
        offlineUnsubscribe = offline.addListener { scope.launch { publish() } }
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
                }
                return@withLock
            }
            unbind()
            if (owner != null && owner == device.accountId()) {
                val playback = PlaybackStore.open(this, owner)
                store = playback
                playback.onListeningChanged = { scope.launch { publish() } }
                account = owner
                recorder.bind(owner, playback)
                consumptionRevision = 0
                // A restored checkpoint never starts audio or manufactures a sample.
                restoreCheckpoint()
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
        store?.onListeningChanged = null
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
            if (documentOwner == controller) { draft = null; documentOwner = null; documentId = null }
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
                } catch (localError: LocalStateError) {
                    error = "downloaded content needs repair · open downloads to review"
                    publish()
                    failure(localError.code)
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
                documentOwner = null
                documentId = null
            }
            ok()
        }
        if (op == "hello") {
            adoptDeviceAccount()
            return loads.withLock {
                if (documentOwner != controller || documentId != document) {
                    draft = null
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
        if (op == "observe_consumption") return loads.withLock {
            require(request.keys().asSequence().toSet() == setOf("id", "op", "document_id", "account_id", "observations"))
            if (request.getString("account_id") != account.toString()) return failure("AccountMismatch")
            val observations = request.getJSONArray("observations")
            if (observations.length() > 100 || request.toString().toByteArray(Charsets.UTF_8).size > 32 * 1024) return failure("Limit")
            recorder.observe((0 until observations.length()).map(observations::getJSONObject))
            store?.collect(device.catalog.consumptionRevision())
            ok()
        }
        if (op == "retry_listening") return loads.withLock {
            require(request.keys().asSequence().toSet() == setOf("id", "op", "document_id", "media_id"))
            recorder.retry(UUID.fromString(request.getString("media_id"))); ok()
        }
        val prepared = prepareRequest(request)
        if (op.startsWith("queue_")) return loads.withLock {
            if (mine != null && mine != activationGeneration) return failure("Stale")
            queueRequest(request, controller, document, prepared)
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
                    val activation = resolveDescriptor(mediaId, prepared = prepared)
                    if (generation != activationGeneration) { activation?.lease?.close(); return failure("Stale") }
                    if (activation == null) return failure("Unavailable")
                    if (!install(activation.descriptor, episode = true, play = request.getBoolean("play"), positionMs = positionMs, lease = activation.lease, localRepair = activation.localRepair))
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
                        val position = if (op == "seek") request.getLong("position_ms")
                            else player.currentPosition + request.getLong("delta_ms")
                        restoreEndedSelection()
                        player.seekTo(maxOf(0, position))
                        checkpoint()
                    }
                    "play" -> resume(request.getString("key"), request.getString("expected_load_id"), mine ?: return failure("Stale"), prepared)?.let { return failure(it) }
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
                    "reconcile" -> if (!reconcile(prepared)) return failure("Unavailable")
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
    private suspend fun install(descriptor: JSONObject, episode: Boolean, play: Boolean = true, occurrenceId: String? = null, positionMs: Long? = null, lease: EpisodeLease? = null, localRepair: LocalStateError? = null): Boolean {
        val mediaId = if (episode) UUID.fromString(descriptor.getString("media_id")) else null
        val generation = activationGeneration
        installingSource = true
        var installedLease = false
        try {
            player.stop() // also keeps a pending natural-end advance from taking over (it needs STATE_ENDED)
            if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
            if (generation != activationGeneration) return false
            if (positionMs != null) {
                val duration = descriptor.nullableLong("duration_ms")?.takeIf { it > 0 }
                descriptor.put("position_ms", minOf(positionMs, duration ?: Long.MAX_VALUE))
            }
            release()
            val nextSource = JSONObject().put("kind", if (episode) "Episode" else "Preview").put("descriptor", descriptor)
                .put("package_id", lease?.packageId?.toString() ?: JSONObject.NULL)
                .put("local_content_repair", localRepair != null)
            sessionShortenPauses = null
            error = localRepair?.let { "downloaded content needs repair · streaming current version" }
            playbackFailed = false
            val file = lease?.audioFile
            leased = lease
            installedLease = true
            val metadata = MediaMetadata.Builder()
                .setTitle(descriptor.getString("title"))
                .setArtist(if (episode) descriptor.nullableString("subtitle") else descriptor.getString("source"))
                .setArtworkUri(if (lease != null) lease.artworkFile?.toUri() else descriptor.nullableString(if (episode) "artwork_url" else "imageUrl")?.toUri())
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
            if (!installedLease) lease?.close()
            installingSource = false
            publish()
        }
    }

    /** Called under loads; acknowledgement follows the installed/resumed occurrence. */
    private suspend fun resume(expectedKey: String?, expectedLoadId: String?, mine: Long, prepared: RemoteActivation?): String? {
        if (mine != activationGeneration || expectedKey == null || expectedKey != key() || expectedLoadId != loadId) return "Stale"
        if (recorder.fenced()) return if (reconcile(prepared)) "Reconciled" else "Fenced"
        if (isEpisode() && (pendingEnd != null && loadedEntryId != store?.queue?.nullableString("current_entry_id") || !recorder.attached())) {
            val activated = activateCurrent(play = true, checkpoint = pendingEnd == null, prepared = prepared)
            return if (mine != activationGeneration) "Stale" else if (activated) null else "Unavailable"
        }
        val mediaId = if (isEpisode()) UUID.fromString(key()) else null
        if (mediaId == null || leased != null && player.playbackState != Player.STATE_ENDED || player.playWhenReady || recorder.pending()) { playHere(); return null }
        val loaded = loadId
        val fresh = resolveDescriptor(mediaId, prepared = prepared)
        if (mine != activationGeneration || loadId != loaded) { fresh?.lease?.close(); return "Stale" }
        val epoch = recorder.resetEpoch() ?: run { fresh?.lease?.close(); return "Stale" }
        val best = fresh?.descriptor ?: return "Unavailable"
        if (player.playbackState == Player.STATE_ENDED || best.getLong("reset_epoch") != epoch || best.getLong("position_ms") != player.currentPosition) {
            if (!install(best, episode = true, occurrenceId = loadedEntryId, lease = fresh.lease, localRepair = fresh.localRepair))
                return if (mine != activationGeneration) "Stale" else "Unavailable"
        } else {
            fresh.lease?.close()
            if (fresh.localRepair != null) {
                source?.put("local_content_repair", true)
                error = "downloaded content needs repair · streaming current version"
            }
            recorder.refresh(best.nullableLong("consumption_override_revision"))
            playHere()
        }
        return null
    }

    /** Read the current playback owner; no position write follows an authority installation. */
    private suspend fun reconcile(prepared: RemoteActivation?): Boolean {
        val loaded = source
        val generation = activationGeneration
        val mediaId = if (isEpisode()) UUID.fromString(key()) else return true
        // A timed-out preparation can still be draining this episode's old writes.
        if (!recorder.fence()) return false
        if (loaded !== source || generation != activationGeneration) return false
        val observation = if (leased != null) store?.record(mediaId)?.optJSONObject("observed") else
            prepared?.takeIf { it.mediaId == mediaId && it.accountId == account && it.generation == activationGeneration }?.response?.getJSONObject("observation")
        if (loaded !== source || generation != activationGeneration) return false
        if (observation == null) {
            error = "listening position unavailable · retry to sync progress"
            synced = false
            publish()
            return false
        }
        recorder.adopt(observation)
        installPosition(observation)
        if (prepared?.localRepair != null) source?.put("local_content_repair", true)
        error = if (source?.optBoolean("local_content_repair") == true) "downloaded content needs repair · streaming current version" else null
        synced = true
        publish()
        return true
    }

    private fun installPosition(observation: JSONObject) {
        if (!isEpisode() || observation.getString("media_id") != key()) return
        val state = observation.getJSONObject("state")
        installingPosition = true
        try {
            player.pause()
            player.seekTo(state.nullableLong("position_ms") ?: 0L)
        } finally { installingPosition = false }
        descriptor()?.put("reset_epoch", state.getLong("reset_epoch"))
            ?.put("consumption_override_revision", state.get("consumption_override_revision"))
            ?.put("position_ms", state.nullableLong("position_ms") ?: 0L)
        saveCheckpoint()
        error = null
        synced = !recorder.pending()
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
        leased?.close()
        leased = null
    }

    private fun descriptor(): JSONObject? = source?.getJSONObject("descriptor")

    private fun isEpisode(): Boolean = source?.getString("kind") == "Episode"

    private fun key(): String? = descriptor()?.getString(if (isEpisode()) "media_id" else "target")

    private suspend fun queueRequest(request: JSONObject, controller: MediaSession.ControllerInfo, document: String, prepared: RemoteActivation?): JSONObject {
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
                return ok()
            }
            "queue_command" -> return queueCommand(request, prepared)
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

    private suspend fun queueCommand(request: JSONObject, prepared: RemoteActivation?): JSONObject {
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
        val admittedPreparation = prepared?.takeIf { it.accountId == account && it.generation == generation }
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
        val activated = !activate || activateCurrent(play, checkpoint = !selectionChanged, positionMs = positionMs, prepared = admittedPreparation?.copy(generation = generation))
        if (positionMs != null) {
            if (generation != activationGeneration) return failure("Stale")
            if (!activated) return failure("Unavailable")
        }
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
        scope.launch {
            val playback = store ?: return@launch
            val request = JSONObject().put("op", "queue_command").put("queue_id", playback.queue.getString("queue_id"))
                .put("expected_revision", playback.queue.getLong("revision").toString())
                .put("command", JSONObject().put("kind", kind))
            val prepared = prepareRequest(request)
            loads.withLock {
                if (mine == activationGeneration) queueCommand(request, prepared)
            }
        }
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
        draft = null
        player.pause()
        var failed: IOException? = null
        try {
            pendingCheckpoint?.let { (playback, checkpoint) -> playback.update { it.put("checkpoint", checkpoint) }; pendingCheckpoint = null }
            checkpoint()
            if (!recorder.stop()) throw IOException("listening checkpoint was not persisted")
        } catch (error: IOException) { failed = error }
        try { recorder.unbind() } catch (error: IOException) { failed = error }
        account = null
        store?.onListeningChanged = null
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
        if (!isEpisode()) return
        recorder.checkpoint()
        val descriptor = descriptor() ?: return
        val mediaId = key() ?: return
        playback.update { envelope ->
            PlaybackStore.record(envelope, mediaId).put("playback_rate", player.playbackParameters.speed.toString().toDouble())
                .put("pause_shortening_mode", if (player.skipSilenceEnabled) "Natural" else "Off")
        }
        val listening = JSONObject().put("position_ms", maxOf(0, player.currentPosition))
            .put("duration_ms", player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: descriptor.get("duration_ms"))
            .put("expected_reset_epoch", recorder.resetEpoch() ?: descriptor.getLong("reset_epoch"))
            .put("episode_playback_rate", player.playbackParameters.speed.toString().toDouble())
        if (loadedEntryId == null || loadedEntryId != playback.queue.nullableString("current_entry_id")) return
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
        val lease = try { offline.openEpisode(mediaId) }
        catch (_: LocalStateError) {
            // justify-ignore-error: retain the selected queue and local repair condition; streaming remains independently admissible.
            error = "downloaded content needs repair · open downloads to review"
            playbackFailed = true
            return drop(keepError = true)
        } ?: return drop()
        lease.close()
        activateCurrent(play = false, checkpoint = true, refresh = false)
    }

    private suspend fun activateCurrent(play: Boolean, checkpoint: Boolean, refresh: Boolean = true, positionMs: Long? = null, prepared: RemoteActivation? = null): Boolean {
        val playback = store ?: return false
        val header = playback.header()
        val entry = header.optJSONObject("current_entry")
        if (entry == null) { drop(); return true }
        val entryId = entry.getString("id")
        if (loadedEntryId == entryId && source != null && recorder.attached() && checkpoint && positionMs == null) {
            if (play) return resume(key(), loadId, activationGeneration, prepared) == null
            player.pause()
            return true
        }
        val generation = activationGeneration
        val activation = resolveDescriptor(UUID.fromString(entry.getString("media_id")), refresh, prepared)
        if (generation != activationGeneration || store !== playback || playback.queue.nullableString("current_entry_id") != entryId) { activation?.lease?.close(); return false }
        if (activation == null) { drop(keepError = true); return false }
        val descriptor = activation.descriptor
        if (checkpoint) playback.value.optJSONObject("checkpoint")?.takeIf { it.getString("entry_id") == entryId }?.let {
            val listening = it.getJSONObject("listening")
            if (listening.getLong("expected_reset_epoch") == descriptor.getLong("reset_epoch") &&
                it.nullableLong("consumption_override_revision") == descriptor.nullableLong("consumption_override_revision")) {
                descriptor.put("position_ms", listening.getLong("position_ms"))
                    .put("playback_rate", listening.getDouble("episode_playback_rate"))
                    .put("pause_shortening_mode", if (it.getBoolean("shorten_pauses")) "Natural" else "Off")
            }
        }
        if (!install(descriptor, episode = true, play = play, occurrenceId = entryId, positionMs = positionMs, lease = activation.lease, localRepair = activation.localRepair)) return false
        if (positionMs != null) checkpoint()
        return true
    }

    private fun currentMediaId(): UUID? = store?.header()?.optJSONObject("current_entry")?.let {
        UUID.fromString(it.getString("media_id"))
    }

    private fun resumeMediaId(): UUID? = if (pendingEnd != null || !recorder.attached()) currentMediaId()
        else if (isEpisode()) key()?.let(UUID::fromString) else null

    /** Capture a candidate on the main thread; origin reads never hold the playback mutation lock. */
    private suspend fun prepareRequest(request: JSONObject): RemoteActivation? {
        val op = request.getString("op")
        if (op == "load") return prepareActivation(UUID.fromString(request.getString("media_id")))
        if (op == "reconcile") return prepareActivation(resumeMediaId())
        if (op == "play") {
            if (!recorder.fenced() && pendingEnd == null && recorder.attached() && (leased != null || player.playWhenReady || recorder.pending())) return null
            return prepareActivation(resumeMediaId())
        }
        if (op != "queue_command") return null
        val queue = store?.queue ?: return null
        val command = request.getJSONObject("command")
        val kind = command.getString("kind")
        val entries = queue.getJSONArray("entries")
        val current = queue.nullableString("current_entry_id")
        val index = (0 until entries.length()).firstOrNull { entries.getJSONObject(it).getString("id") == current }
        val target = when (kind) {
            "select" -> (0 until entries.length()).map(entries::getJSONObject).firstOrNull { it.getString("id") == command.getString("entry_id") }
            "next", "previous" -> {
                if (kind == "previous" && current != null && player.currentPosition > 3_000 && loadedEntryId == current) return null
                val next = if (index == null) { if (kind == "previous") entries.length() - 1 else -1 }
                    else if (kind == "previous") maxOf(0, index - 1) else index + 1
                if (next in 0 until entries.length()) entries.getJSONObject(next) else null
            }
            "append", "insert-next" -> if (current == null) command.getJSONObject("entry") else null
            "restore" -> undoQueue?.let { previous ->
                val id = previous.nullableString("current_entry_id")
                val saved = previous.getJSONArray("entries")
                (0 until saved.length()).map(saved::getJSONObject).firstOrNull { it.getString("id") == id }
            }
            "remove" -> if (command.getString("entry_id") == current && index != null && index + 1 < entries.length()) entries.getJSONObject(index + 1) else null
            else -> null
        }
        return prepareActivation(target?.let { UUID.fromString(it.getString("media_id")) })
    }

    private suspend fun prepareActivation(mediaId: UUID?): RemoteActivation? {
        if (mediaId == null) return null
        val owner = account ?: return null
        val generation = activationGeneration
        if (leased != null && key() == mediaId.toString()) return null
        var localRepair: LocalStateError? = null
        try { offline.openEpisode(mediaId)?.let { it.close(); return null } }
        catch (failure: LocalStateError) { localRepair = failure }
        if (!device.remotelyAdmitted()) return localRepair?.let { RemoteActivation(mediaId, owner, generation, null, false, it) }
        return try { RemoteActivation(mediaId, owner, generation, descriptorReads.withPermit { origin.player(mediaId) }, false, localRepair) }
        catch (_: IOException) {
            // justify-ignore-error: the command applies its captured failure only if its intent still owns the occurrence.
            RemoteActivation(mediaId, owner, generation, null, false, localRepair)
        } catch (failure: NexusOriginError) {
            RemoteActivation(mediaId, owner, generation, null, failure.status in setOf(403, 404, 410), localRepair)
        }
    }

    /** A package lease is the complete local authority; origin admission applies only to streams. */
    private fun resolveDescriptor(mediaId: UUID, refresh: Boolean = true, prepared: RemoteActivation? = null): Activation? {
        val playback = store ?: return null
        var localRepair: LocalStateError? = null
        val lease = try { offline.openEpisode(mediaId) }
        catch (failure: LocalStateError) { localRepair = failure; null }
        if (lease != null) {
            var handedOff = false
            try {
                recorder.observe(listOf(lease.playbackBaseline.getJSONObject("observation")))
                playback.baseline(mediaId, lease.playbackBaseline)
                val record = checkNotNull(playback.record(mediaId)) { "episode baseline missing" }
                val state = record.getJSONObject("observed").getJSONObject("state")
                val local = record.optJSONObject("local")?.takeIf { it.getLong("reset_epoch") == state.getLong("reset_epoch") }
                val completed = local?.getBoolean("completed") ?: (state.nullableString("consumption_override_status") == "finished")
                val descriptor = JSONObject(lease.rendition.toString()).put("media_id", mediaId.toString())
                    .put("duration_ms", local?.nullableLong("duration_ms") ?: state.nullableLong("duration_ms") ?: lease.audioDurationMs ?: lease.rendition.nullableLong("duration_ms") ?: JSONObject.NULL)
                    .put("position_ms", if (completed) 0L else local?.getLong("position_ms") ?: state.nullableLong("position_ms") ?: 0L)
                    .put("reset_epoch", state.getLong("reset_epoch"))
                    .put("consumption_override_revision", state.get("consumption_override_revision"))
                    .put("playback_rate", record.getDouble("playback_rate"))
                    .put("pause_shortening_mode", record.get("pause_shortening_mode"))
                handedOff = true
                return Activation(descriptor, lease)
            } finally {
                if (!handedOff) lease.close()
            }
        }
        if (!refresh || !device.remotelyAdmitted()) {
            playbackFailed = true
            error = if (localRepair != null) "downloaded content needs repair · open downloads to review" else "not downloaded · connect or skip"
            publish()
            return null
        }
        val remote = prepared?.takeIf { it.mediaId == mediaId && it.accountId == account && it.generation == activationGeneration }
        val activation = remote?.response
        if (activation == null) {
            playbackFailed = true
            error = if (localRepair != null || remote?.localRepair != null) "downloaded content needs repair · current episode couldn’t open"
                else if (remote?.refused == true) "episode unavailable · skip" else "episode unavailable · retry or skip"
            publish()
            return null
        }
        recorder.observe(listOf(activation.getJSONObject("observation")))
        val descriptor = activation.getJSONObject("descriptor")
        playback.update { it.getJSONObject("descriptors").put(mediaId.toString(), descriptor) }
        return Activation(descriptor, null, localRepair ?: remote?.localRepair)
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

    private fun listeningSaveFailed() {
        if (savingFailed) return
        savingFailed = true
        player.pause()
        error = "couldn’t save listening progress · retry"
        synced = false
        publish()
        savingFailed = false
    }

    private fun persistRecording(change: () -> Unit) {
        if (savingFailed) return
        try { change() } catch (_: IOException) {
            // justify-ignore-error: a failed checkpoint pauses playback and cannot be acknowledged as saved.
            listeningSaveFailed()
        }
    }

    // ---- player events ----

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        device.setPlaybackActive(isPlaying)
        if (isPlaying) {
            error = if (source?.optBoolean("local_content_repair") == true) "downloaded content needs repair · streaming current version" else null
            playbackFailed = false
        }
        // at the end the recorder settles instead of writing
        if (player.playbackState != Player.STATE_ENDED) persistRecording { recorder.playing(isPlaying) }
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
                    val prepared = prepareActivation(currentMediaId())
                    loads.withLock {
                        publish()
                        if (activationGeneration == generation && loadId == endedLoad && player.playbackState == Player.STATE_ENDED)
                            activateCurrent(play = true, checkpoint = false, prepared = prepared)
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
            persistRecording { recorder.seeked(oldPosition.positionMs) }
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
        .put("source", source?.let { JSONObject().put("kind", it.getString("kind")).put("package_id", it.get("package_id"))
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
        .put("position_ms", maxOf(0, player.currentPosition))
        .put("duration_ms", player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0)
        .put("buffered_ms", maxOf(0, player.bufferedPosition))
        // Keep the float's shortest decimal; widening it directly invents persistence precision.
        .put("rate", player.playbackParameters.speed.toString().toDouble())
        .put("shorten_pauses", player.skipSilenceEnabled)
        .put("shorten_pauses_saved_ms", savedMs)
        .put("error", error ?: JSONObject.NULL)
        .put("playback_failed", playbackFailed)
        .put("synced", synced)
        .put("consumption_revision", consumptionRevision)
        .put("listening_revision", ListeningPublication.revision().toString())

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
