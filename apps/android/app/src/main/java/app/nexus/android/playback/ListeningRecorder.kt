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
 * The durable record of what this device plays: the episode's listening
 * position (PUT, epoch-fenced, newest sample wins), its Listening activity
 * spans (through the outbox) and the settle of its natural end, all with the
 * WebView's cookies so none of it needs the page. Every method and callback
 * runs on the service's main thread.
 */
internal class ListeningRecorder(
    context: Context,
    private val scope: CoroutineScope,
    private val origin: NexusOriginClient,
    private val outbox: ActivityOutbox,
    private val sample: () -> Sample,
    private val onAdopt: (positionMs: Long) -> Unit,
    private val onSynced: (Boolean) -> Unit,
    private val onSettled: (mediaId: UUID, next: JSONObject?) -> Unit,
) {
    data class Sample(val positionMs: Long, val durationMs: Long?)

    private class Episode(val mediaId: UUID, var resetEpoch: Long, var overrideRevision: Long?) {
        var rate: Double? = null // set by the listener this session; absent keeps the stored rate
        var span: Span? = null // open while playing
    }

    private class Span(val startElapsed: Long, val startPositionMs: Long)

    /** A listening PUT or a natural-end settle, sent in order, one at a time. */
    private class Write(val mediaId: UUID, val body: JSONObject, val settle: Boolean)

    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val wallOffsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    private var account: UUID? = null
    private var episode: Episode? = null
    private var tick: Job? = null
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
        connectivity.registerDefaultNetworkCallback(network)
    }

    /** The account the WebView's cookies belong to; another account's pending writes and spans are dropped. */
    fun bind(accountId: UUID) {
        if (account != accountId) {
            tick?.cancel()
            episode = null
            lane.clear()
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
        write(ep)
    }

    /** Whether this device holds a listening sample of the episode that the server may not have. */
    fun pending(): Boolean {
        val ep = episode ?: return false
        return ep.span != null || lane.any { !it.settle && it.mediaId == ep.mediaId }
    }

    fun resetEpoch(): Long? = episode?.resetEpoch

    /** A resume in place under the server's descriptor: its override revision is the end's fence. */
    fun refresh(overrideRevision: Long?) {
        episode?.overrideRevision = overrideRevision
    }

    /** A reset elsewhere: later writes carry the new epoch, queued ones are stale. */
    fun adopt(resetEpoch: Long) {
        val ep = episode ?: return
        ep.resetEpoch = resetEpoch
        lane.removeAll { !it.settle && it.mediaId == ep.mediaId }
    }

    fun playing(on: Boolean) {
        val ep = episode ?: return
        tick?.cancel()
        closeSpan(ep)
        if (on) {
            ep.span = openSpan()
            tick = scope.launch {
                while (true) {
                    delay(TICK_MS)
                    closeSpan(ep)
                    ep.span = openSpan()
                    write(ep)
                }
            }
        } else {
            write(ep)
        }
    }

    fun seeked(fromMs: Long) {
        val ep = episode ?: return
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
            .put("clientMutationId", UUID.randomUUID().toString())
            .put("kind", "SettleNaturalEnd")
            .put("mediaId", ep.mediaId.toString())
            .put("terminalListening", listening(ep))
            .put("expectedConsumptionOverrideRevision", presence(ep.overrideRevision))
        lane.addLast(Write(ep.mediaId, body, settle = true))
        send()
    }

    /**
     * The episode's last write, awaited for at most 2 s (offline it stays queued); then no episode is recorded.
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
        // newest wins: a queued sample of the same episode is replaced, never reordered past a settle
        if (lane.lastOrNull()?.let { !it.settle && it.mediaId == ep.mediaId } == true) lane.removeLast()
        lane.addLast(Write(ep.mediaId, listening(ep), settle = false))
        send()
    }

    private fun send() {
        if (sending?.isActive == true || account == null) return
        sending = scope.launch {
            while (true) {
                val write = lane.firstOrNull() ?: break
                if (!deliver(write)) {
                    setSynced(false)
                    return@launch retryLater()
                }
                if (lane.firstOrNull() === write) lane.removeFirst() // unless a newer sample replaced it
                failures = 0
                setSynced(true)
            }
        }
    }

    /** True when the write is done with (delivered or refused), false to keep it queued and retry. */
    private suspend fun deliver(write: Write): Boolean {
        try {
            if (!write.settle) {
                origin.putListening(write.mediaId, write.body)
                return true
            }
            val next = origin.consumptionCommand(write.body).getJSONObject("nextItem").optJSONObject("value")
            onSettled(write.mediaId, next?.getJSONObject("activation")?.optJSONObject("descriptor"))
            return true
        } catch (error: NexusOriginError) {
            if (retryable(error.status)) return false
            val current = error.details?.optJSONObject("current")
            val ep = episode
            if (error.status == 409 && current != null && !write.settle && ep?.mediaId == write.mediaId) {
                // a reset elsewhere: adopt the server's epoch and position
                ep.resetEpoch = current.getLong("resetEpoch")
                lane.removeAll { it !== write && !it.settle && it.mediaId == write.mediaId }
                onAdopt(current.getLong("positionMs"))
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
                    val body = JSONObject().put("mediaRef", "media:${batch.mediaId}").put("deviceClass", "Mobile")
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

    private fun retryable(status: Int): Boolean = status == 401 || status == 408 || status == 429 || status >= 500

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
            .put("captureKey", UUID.randomUUID().toString())
            // one clock for start and duration, so consecutive spans never overlap
            .put("occurredAt", SPAN_INSTANT.format(Instant.ofEpochMilli(wallOffsetMs + span.startElapsed)))
            .put("durationMs", elapsedMs)
            .put("progressStart", progress(span.startPositionMs, now.durationMs))
            .put("progressEnd", progress(endMs, now.durationMs))
            .put("mediaPositionStartMs", presence(span.startPositionMs))
            .put("mediaPositionEndMs", presence(endMs))
        outbox.add(accountId, ep.mediaId, record)
        upload()
    }

    private fun listening(ep: Episode): JSONObject {
        val now = sample()
        return JSONObject()
            .put("positionMs", now.positionMs)
            .put("durationMs", presence(now.durationMs))
            .put("episodePlaybackRate", presence(ep.rate))
            .put("expectedResetEpoch", ep.resetEpoch)
    }

    private fun progress(positionMs: Long, durationMs: Long?): JSONObject =
        presence(durationMs?.takeIf { it > 0 }?.let { minOf(1.0, positionMs.toDouble() / it) })

    private fun presence(value: Any?): JSONObject =
        JSONObject().put("kind", if (value == null) "Absent" else "Present").putOpt("value", value)
}
