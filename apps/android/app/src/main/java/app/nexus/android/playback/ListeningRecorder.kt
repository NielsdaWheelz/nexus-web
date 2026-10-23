package app.nexus.android.playback

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.util.UUID

private const val TAG = "ListeningRecorder"
private const val TICK_MS = 15_000L
private val RETRY_MS = longArrayOf(2_000, 5_000, 15_000, 60_000)

/**
 * Records listening positions (epoch-fenced, newest sample wins), activity
 * spans and natural ends with the WebView's cookies, without needing the page.
 * Activity spans keep their outbox; the ordered position/settle lane commits
 * in the account playback envelope alongside queue transitions. Every method and callback runs on the service's main thread.
 */
internal class ListeningRecorder(
    context: Context,
    private val scope: CoroutineScope,
    private val origin: NexusOriginClient,
    private val outbox: ActivityOutbox,
    private val sample: () -> Sample,
    private val onAdopt: (position: JSONObject) -> Unit,
    private val onAccepted: () -> Unit,
    private val onSynced: (Boolean) -> Unit,
    private val onTerminal: (saveLane: (JSONObject) -> Unit) -> Unit,
    private val onRefused: (mediaId: UUID) -> Unit,
    private val onOnline: () -> Unit,
) {
    data class Sample(val positionMs: Long, val durationMs: Long?)

    private class Episode(val mediaId: UUID, var resetEpoch: Long, var overrideRevision: Long?) {
        var rate: Double? = null // set by the listener this session; absent keeps the stored rate
        var span: Span? = null // open while playing
        var fenced = false
        var active = false
        var ended = false
    }

    private class Span(val startElapsed: Long, val startPositionMs: Long)

    /** A listening PUT or a natural-end settle, sent in order, one at a time. */
    private class Write(val accountId: UUID, val mediaId: UUID, val body: JSONObject, val settle: Boolean)

    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val wallOffsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    private var account: UUID? = null
    private var episode: Episode? = null
    private var tick: Job? = null
    private var store: PlaybackStore? = null
    private val lane = ArrayDeque<Write>()
    private var sending: Job? = null
    private var uploading: Job? = null
    private var retry: Job? = null
    private var failures = 0
    private var synced = true
    private val factRevisions = mutableMapOf<UUID, Long>()
    private val authorityRevisions = mutableMapOf<UUID, Long>()

    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) scope.launch { kick(); onOnline() }
        }
    }

    init {
        connectivity.registerDefaultNetworkCallback(network)
    }

    /** Cookies may change only after unbind has suspended delivery and retained the old account file. */
    suspend fun bind(accountId: UUID, playback: PlaybackStore) {
        if (account == accountId) return kick()
        unbind()
        store = playback
        account = accountId
        val saved = playback.value.getJSONArray("lane")
        for (i in 0 until saved.length()) {
            val item = saved.getJSONObject(i)
            lane.addLast(Write(accountId, UUID.fromString(item.getString("media_id")),
                item.getJSONObject("body"), item.getBoolean("settle")))
        }
        outbox.retain(accountId)
        kick()
    }

    suspend fun unbind() {
        tick?.cancel()
        account = null
        sending?.cancelAndJoin()
        uploading?.cancelAndJoin()
        retry?.cancel()
        episode = null
        if (store != null && !persistLane()) throw IOException("listening checkpoint was not persisted")
        lane.clear()
        factRevisions.clear()
        authorityRevisions.clear()
        store = null
    }

    fun start(mediaId: UUID, resetEpoch: Long, overrideRevision: Long?) {
        episode = Episode(mediaId, resetEpoch, overrideRevision)
    }

    fun pinRate(rate: Double) {
        val ep = episode ?: return
        ep.rate = rate
        if (ep.active && !ep.fenced) write(ep)
    }

    /** Whether this device holds a listening sample of the episode that the server may not have. */
    fun pending(): Boolean {
        val ep = episode ?: return false
        return ep.span != null || lane.any { !it.settle && it.mediaId == ep.mediaId }
    }

    fun attached(): Boolean = episode != null
    fun resetEpoch(): Long? = episode?.resetEpoch
    fun overrideRevision(): Long? = episode?.overrideRevision
    fun authorityRevision(mediaId: UUID): Long = authorityRevisions[mediaId] ?: 0L
    fun retireAuthority(mediaId: UUID) { authorityRevisions[mediaId] = authorityRevision(mediaId) + 1 }
    fun factRevision(mediaId: UUID): Long = factRevisions[mediaId] ?: 0L
    fun hasPending(mediaId: UUID): Boolean = lane.any { it.mediaId == mediaId } ||
        episode?.let { it.mediaId == mediaId && it.span != null } == true
    private fun changedFact(mediaId: UUID) { factRevisions[mediaId] = factRevision(mediaId) + 1 }
    fun fenced(): Boolean = episode?.fenced == true

    /** A resume in place under the server's descriptor: its override revision is the end's fence. */
    fun refresh(overrideRevision: Long?) {
        episode?.overrideRevision = overrideRevision
    }

    /** A reset elsewhere: later writes carry the new epoch, queued ones are stale. */
    fun adopt(position: JSONObject) {
        val ep = episode ?: return
        changedFact(ep.mediaId)
        ep.resetEpoch = position.getLong("reset_epoch")
        ep.overrideRevision = position.nullableLong("consumption_override_revision")
        ep.active = false
        ep.fenced = false
        lane.removeAll { !it.settle && it.mediaId == ep.mediaId }
        queueChanged()
    }

    /** The service pauses first, then drains and retires every old write of this episode. */
    suspend fun fence(): Boolean {
        val ep = episode ?: return true
        ep.fenced = true
        tick?.cancel()
        closeSpan(ep)
        sending?.join()
        lane.removeAll { !it.settle && it.mediaId == ep.mediaId }
        ep.active = false
        val saved = persistLane()
        if (!saved) retryLater()
        return saved
    }

    fun playing(on: Boolean) {
        val ep = episode ?: return
        if (ep.fenced) return
        tick?.cancel()
        closeSpan(ep)
        if (on) {
            ep.active = true
            ep.span = openSpan()
            write(ep)
            tick = scope.launch {
                while (true) {
                    delay(TICK_MS)
                    closeSpan(ep)
                    ep.span = openSpan()
                    write(ep)
                }
            }
        } else if (ep.active) {
            write(ep)
        }
    }

    fun seeked(fromMs: Long) {
        val ep = episode ?: return
        if (ep.fenced) return
        ep.active = true
        ep.ended = false
        val playing = ep.span != null
        closeSpan(ep, fromMs)
        if (playing) ep.span = openSpan()
        write(ep)
    }

    /** Settles the end with the terminal position, fenced by the epoch and the override revision seen at load. */
    fun ended(): Boolean {
        val ep = episode ?: return false
        val accountId = account ?: return false
        if (ep.ended) return true
        tick?.cancel()
        closeSpan(ep)
        val body = JSONObject()
            .put("terminal_listening", listening(ep))
            .put("expected_override_revision", ep.overrideRevision ?: JSONObject.NULL)
        val write = Write(accountId, ep.mediaId, body, settle = true)
        lane.addLast(write)
        changedFact(ep.mediaId)
        return try {
            // The service includes the next cursor in THIS atomic recorder save.
            onTerminal { envelope -> saveLane(envelope) }
            ep.active = false
            ep.ended = true
            setSynced(false)
            send()
            true
        } catch (error: IOException) {
            lane.remove(write)
            setSynced(false)
            Log.w(TAG, "terminal playback state not persisted", error)
            false
        }
    }

    /**
     * The episode's last write, awaited for at most 2 s (offline it stays in the saved lane).
     * Then no episode is recorded.
     * A paused episode's position is already written or queued; writing it again would undo a newer position
     * another device wrote since.
     */
    suspend fun stop(): Boolean {
        val ep = episode ?: return store == null || persistLane()
        tick?.cancel()
        val playing = ep.span != null
        closeSpan(ep)
        if (playing) write(ep)
        episode = null
        withTimeoutOrNull(2_000) { sending?.join() }
        return persistLane()
    }

    /** Explicit sign-out retires every pending effect before its files are purged. */
    suspend fun retire() {
        tick?.cancel()
        retry?.cancel()
        sending?.cancel()
        uploading?.cancel()
        sending?.join()
        uploading?.join()
        account = null
        episode = null
        lane.clear()
        factRevisions.clear()
        authorityRevisions.clear()
        store = null
        outbox.clear()
    }

    fun close() {
        connectivity.unregisterNetworkCallback(network)
        tick?.cancel()
    }

    private fun kick() {
        send()
        upload()
    }

    private fun write(ep: Episode) {
        val accountId = account ?: return
        // newest wins: a queued sample of the same episode is replaced, never reordered past a settle
        if (lane.lastOrNull()?.let { !it.settle && it.mediaId == ep.mediaId } == true) lane.removeLast()
        lane.addLast(Write(accountId, ep.mediaId, listening(ep), settle = false))
        changedFact(ep.mediaId)
        queueChanged()
    }

    private fun queueChanged() {
        setSynced(false)
        if (persistLane()) send() else retryLater()
    }

    private fun saveLane(envelope: JSONObject) {
        val saved = JSONArray()
        val descriptors = envelope.getJSONObject("descriptors")
        for (write in lane) {
            saved.put(JSONObject().put("media_id", write.mediaId.toString())
                .put("body", write.body).put("settle", write.settle))
            val retained = descriptors.optJSONObject(write.mediaId.toString()) ?: continue
            val listening = if (write.settle) write.body.getJSONObject("terminal_listening") else write.body
            if (retained.getLong("reset_epoch") <= listening.getLong("expected_reset_epoch")) {
                retained.put("local_listening", JSONObject(listening.toString()))
                    .put("locally_completed", write.settle)
            }
        }
        envelope.put("lane", saved)
    }

    private fun persistLane(): Boolean {
        val playback = store ?: return false
        return try {
            playback.update(::saveLane)
            true
        } catch (error: IOException) {
            // justify-ignore-error: keep the in-memory lane, but do not send or acknowledge its fence.
            setSynced(false)
            Log.w(TAG, "listening writes not persisted", error)
            false
        }
    }

    private fun send() {
        if (sending?.isActive == true || account == null) return
        if (lane.isNotEmpty()) setSynced(false)
        if (!persistLane()) return retryLater()
        sending = scope.launch {
            while (true) {
                val write = lane.firstOrNull() ?: break
                if (!deliver(write)) {
                    setSynced(false)
                    return@launch retryLater()
                }
                if (lane.firstOrNull() === write) lane.removeFirst() // unless a newer sample replaced it
                if (!persistLane()) return@launch retryLater()
                failures = 0
            }
            setSynced(true)
        }
    }

    /** True when the write is done with (delivered or refused), false to keep it queued and retry. */
    private suspend fun deliver(write: Write): Boolean {
        if (account != write.accountId) return true
        try {
            if (!write.settle) {
                val position = origin.putListening(write.mediaId, write.body)
                if (account != write.accountId) return true
                val epoch = position.getLong("reset_epoch")
                val override = position.get("consumption_override_revision")
                episode?.takeIf { it.mediaId == write.mediaId && it.resetEpoch == epoch }?.overrideRevision =
                    position.nullableLong("consumption_override_revision")
                // Its own preceding heartbeat may have just completed it. The end retains
                // its captured epoch, so unread/reset still supersede the queued event.
                for (queued in lane) {
                    if (queued.settle && queued.mediaId == write.mediaId &&
                        queued.body.getJSONObject("terminal_listening").getLong("expected_reset_epoch") == epoch) {
                        queued.body.put("expected_override_revision", override)
                    }
                }
                store?.update { envelope ->
                    envelope.getJSONObject("descriptors").optJSONObject(write.mediaId.toString())
                        ?.takeIf { it.getLong("reset_epoch") == epoch }
                        ?.put("consumption_override_revision", override)
                }
                if (!persistLane()) return false
                changedFact(write.mediaId)
                onAccepted()
                return true
            }
            origin.settleNaturalEnd(write.mediaId, write.body)
            if (account != write.accountId) return true
            val epoch = write.body.getJSONObject("terminal_listening").getLong("expected_reset_epoch")
            val revision = (write.body.nullableLong("expected_override_revision") ?: 0L) + 1
            store?.update { envelope ->
                envelope.getJSONObject("descriptors").optJSONObject(write.mediaId.toString())
                    ?.takeIf { it.getLong("reset_epoch") == epoch }
                    ?.put("consumption_override_revision", revision)
            }
            episode?.takeIf { it.mediaId == write.mediaId && it.resetEpoch == epoch }?.overrideRevision = revision
            changedFact(write.mediaId)
            onAccepted()
            return true
        } catch (error: NexusOriginError) {
            if (retryable(error.status)) return false
            val current = error.details?.optJSONObject("current")
            val ep = episode
            if (error.status == 409 && current != null && !write.settle && ep?.mediaId == write.mediaId) {
                // a reset elsewhere: adopt the server's epoch and position
                val fenced = ep.fenced
                adopt(current)
                ep.fenced = fenced
                lane.removeAll { it !== write && !it.settle && it.mediaId == write.mediaId }
                onAdopt(current)
            } else {
                if (write.settle || error.status == 409) try {
                    onRefused(write.mediaId)
                    if (!write.settle) lane.removeAll { it !== write && !it.settle && it.mediaId == write.mediaId &&
                        it.body.getLong("expected_reset_epoch") == write.body.getLong("expected_reset_epoch") }
                }
                catch (_: IOException) { return false } // justify-ignore-error: retain the terminal record until authority retirement is durable.
                Log.w(TAG, "dropped a refused ${if (write.settle) "settle" else "listening write"}", error)
            }
            return true
        } catch (_: IOException) {
            // justify-ignore-error: offline or unreachable; the write stays queued and is retried.
            return false
        }
    }

    private fun upload() {
        val accountId = account ?: return
        if (uploading?.isActive == true) return
        uploading = scope.launch {
            while (true) {
                val batch = outbox.next(accountId) ?: break
                try {
                    val spans = JSONObject().put("modality", "Listening").put("spans", JSONArray(batch.spans))
                    val body = JSONObject().put("media_id", batch.mediaId.toString()).put("device_class", "Mobile")
                    origin.postActivity(body.put("batch", spans))
                } catch (error: NexusOriginError) {
                    if (retryable(error.status)) return@launch retryLater()
                    Log.w(TAG, "dropped a refused activity batch", error)
                } catch (_: IOException) {
                    // justify-ignore-error: offline or unreachable; the spans stay in the outbox.
                    return@launch retryLater()
                }
                outbox.remove(batch)
            }
        }
    }

    // 426 keeps the saved queues for the corrected app to resume after its update.
    private fun retryable(status: Int): Boolean =
        status == 401 || status == 408 || status == 426 || status == 429 || status >= 500

    private fun retryLater() {
        failures += 1
        retry?.cancel()
        retry = scope.launch {
            delay(RETRY_MS[minOf(failures, RETRY_MS.size) - 1])
            kick()
        }
    }

    private fun setSynced(value: Boolean) {
        if (synced == value) return
        synced = value
        onSynced(value)
    }

    private fun openSpan() = Span(SystemClock.elapsedRealtime(), sample().positionMs)

    private fun closeSpan(ep: Episode, endPositionMs: Long? = null) {
        val span = ep.span ?: return
        ep.span = null
        val accountId = account ?: return
        val elapsedMs = SystemClock.elapsedRealtime() - span.startElapsed
        if (elapsedMs !in 1..30_000) return // a suspended process's gap is not listening evidence
        val now = sample()
        val endMs = endPositionMs ?: now.positionMs
        val record = JSONObject()
            .put("capture_key", UUID.randomUUID().toString())
            // one clock for start and duration, so consecutive spans never overlap
            .put("occurred_at", SPAN_INSTANT.format(Instant.ofEpochMilli(wallOffsetMs + span.startElapsed)))
            .put("duration_ms", elapsedMs)
            .put("progress_start", progress(span.startPositionMs, now.durationMs))
            .put("progress_end", progress(endMs, now.durationMs))
            .put("media_position_start_ms", span.startPositionMs)
            .put("media_position_end_ms", endMs)
        outbox.add(accountId, ep.mediaId, record)
        upload()
    }

    private fun listening(ep: Episode): JSONObject {
        val now = sample()
        return JSONObject()
            .put("position_ms", now.positionMs)
            .put("duration_ms", now.durationMs ?: JSONObject.NULL)
            .put("episode_playback_rate", ep.rate ?: JSONObject.NULL)
            .put("expected_reset_epoch", ep.resetEpoch)
    }

    private fun progress(positionMs: Long, durationMs: Long?): Any =
        durationMs?.takeIf { it > 0 }?.let { minOf(1.0, positionMs.toDouble() / it) } ?: JSONObject.NULL
}

/** A nullable JSON integer: null for JSON null. */
internal fun JSONObject.nullableLong(key: String): Long? = if (isNull(key)) null else getLong(key)
