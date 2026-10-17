package app.nexus.android.playback

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import androidx.core.util.AtomicFile
import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.time.Instant
import java.util.UUID

private const val TAG = "ListeningRecorder"
private const val TICK_MS = 15_000L
private val RETRY_MS = longArrayOf(2_000, 5_000, 15_000, 60_000)

/**
 * Records listening positions (epoch-fenced, newest sample wins), activity
 * spans and natural ends with the WebView's cookies, without needing the page.
 * Activity spans and the ordered position/settle lane each persist in an atomic
 * file. Every method and callback runs on the service's main thread.
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
    private val onSettled: (mediaId: UUID, next: JSONObject?) -> Unit,
) {
    data class Sample(val positionMs: Long, val durationMs: Long?)

    private class Episode(val mediaId: UUID, var resetEpoch: Long, var overrideRevision: Long?) {
        var rate: Double? = null // set by the listener this session; absent keeps the stored rate
        var span: Span? = null // open while playing
        var fenced = false
        var active = false
    }

    private class Span(val startElapsed: Long, val startPositionMs: Long)

    /** A listening PUT or a natural-end settle, sent in order, one at a time. */
    private class Write(val accountId: UUID, val mediaId: UUID, val body: JSONObject, val settle: Boolean) {
        var nextSelected = false
        var next: JSONObject? = null
    }

    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val wallOffsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    private var account: UUID? = null
    private var episode: Episode? = null
    private var tick: Job? = null
    private val laneFile = AtomicFile(File(context.filesDir, "player/listening.json"))
    private val lane = ArrayDeque<Write>()
    private var sending: Job? = null
    private var uploading: Job? = null
    private var retry: Job? = null
    private var failures = 0
    private var synced = true

    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) scope.launch { kick() }
        }
    }

    init {
        try {
            val saved = JSONArray(String(laneFile.readFully(), Charsets.UTF_8))
            for (i in 0 until saved.length()) {
                val entry = saved.getJSONObject(i)
                lane.addLast(Write(
                    UUID.fromString(entry.getString("accountId")),
                    UUID.fromString(entry.getString("mediaId")),
                    entry.getJSONObject("body"),
                    entry.getBoolean("settle"),
                ).apply {
                    nextSelected = entry.getBoolean("nextSelected")
                    next = entry.optJSONObject("next")
                })
            }
        } catch (_: FileNotFoundException) {
            // justify-ignore-error: this device has no saved listening writes yet.
        }
        connectivity.registerDefaultNetworkCallback(network)
    }

    /** The account the WebView's cookies belong to; another account's pending writes and spans are dropped. */
    fun bind(accountId: UUID) {
        if (account != accountId) {
            tick?.cancel()
            episode = null
            lane.removeAll { it.accountId != accountId }
            account = accountId
        }
        outbox.retain(accountId)
        kick()
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

    fun resetEpoch(): Long? = episode?.resetEpoch
    fun fenced(): Boolean = episode?.fenced == true

    /** A resume in place under the server's descriptor: its override revision is the end's fence. */
    fun refresh(overrideRevision: Long?) {
        episode?.overrideRevision = overrideRevision
    }

    /** A reset elsewhere: later writes carry the new epoch, queued ones are stale. */
    fun adopt(position: JSONObject) {
        val ep = episode ?: return
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
        lane.removeAll { it.mediaId == ep.mediaId }
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
        val playing = ep.span != null
        closeSpan(ep, fromMs)
        if (playing) ep.span = openSpan()
        write(ep)
    }

    /** Settles the end with the terminal position, fenced by the epoch and the override revision seen at load. */
    fun ended() {
        val ep = episode ?: return
        tick?.cancel()
        closeSpan(ep)
        val body = JSONObject()
            .put("terminal_listening", listening(ep))
            .put("expected_override_revision", ep.overrideRevision ?: JSONObject.NULL)
        val accountId = account ?: return
        lane.addLast(Write(accountId, ep.mediaId, body, settle = true))
        queueChanged()
    }

    /**
     * The episode's last write, awaited for at most 2 s (offline it stays in the saved lane).
     * Then no episode is recorded.
     * A paused episode's position is already written or queued; writing it again would undo a newer position
     * another device wrote since.
     */
    suspend fun stop() {
        val ep = episode ?: return
        tick?.cancel()
        val playing = ep.span != null
        closeSpan(ep)
        if (playing) write(ep)
        episode = null
        withTimeoutOrNull(2_000) { sending?.join() }
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
        queueChanged()
    }

    private fun queueChanged() {
        setSynced(false)
        if (persistLane()) send() else retryLater()
    }

    private fun persistLane(): Boolean {
        var stream: FileOutputStream? = null
        try {
            val saved = JSONArray()
            for (write in lane) {
                saved.put(JSONObject()
                    .put("accountId", write.accountId.toString())
                    .put("mediaId", write.mediaId.toString())
                    .put("body", write.body)
                    .put("settle", write.settle)
                    .put("nextSelected", write.nextSelected)
                    .put("next", write.next ?: JSONObject.NULL))
            }
            val bytes = saved.toString().toByteArray(Charsets.UTF_8)
            stream = laneFile.startWrite()
            stream.write(bytes)
            stream.fd.sync()
            laneFile.finishWrite(stream)
            // AtomicFile logs some commit failures instead of throwing them.
            if (!laneFile.readFully().contentEquals(bytes)) throw IOException("listening lane was not replaced")
            return true
        } catch (error: IOException) {
            // justify-ignore-error: keep the in-memory lane, but do not send or acknowledge its fence.
            stream?.let(laneFile::failWrite)
            setSynced(false)
            Log.w(TAG, "listening writes not persisted", error)
            return false
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
                if (!persistLane()) return false
                onAccepted()
                return true
            }
            if (!write.nextSelected) {
                val items = origin.lectern().getJSONArray("items")
                if (account != write.accountId) return true
                var afterEnded = false
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    val activation = item.getJSONObject("activation")
                    if (afterEnded && activation.getString("kind") == "FooterAudio") {
                        write.next = activation.getJSONObject("descriptor")
                        break
                    }
                    if (item.getJSONObject("media_summary").getString("media_id") == write.mediaId.toString()) {
                        afterEnded = true
                    }
                }
                // Keep this selection on a lost answer: the settle may already have removed its row.
                write.nextSelected = true
            }
            if (!persistLane()) return false
            origin.settleNaturalEnd(write.mediaId, write.body)
            if (account != write.accountId) return true
            onAccepted()
            onSettled(write.mediaId, write.next)
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
