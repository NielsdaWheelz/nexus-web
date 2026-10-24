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
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.util.UUID

private const val TAG = "ListeningRecorder"
private const val TICK_MS = 15_000L
private val RETRY_MS = longArrayOf(2_000, 5_000, 15_000, 60_000)

/**
 * The native consumption writer. Absolute samples retry under their captured reset
 * epoch; natural ends retain their override fence. A sequence identifies only the
 * local fact being settled and never crosses the origin boundary. Every fact,
 * receipt and queue continuation commits through the same playback envelope.
 */
internal class ListeningRecorder(
    context: Context,
    private val scope: CoroutineScope,
    private val origin: NexusOriginClient,
    private val outbox: ActivityOutbox,
    private val sample: () -> Sample,
    private val onAdopt: (observation: JSONObject) -> Unit,
    private val onAccepted: () -> Unit,
    private val onSynced: (Boolean) -> Unit,
    private val onTerminal: (saveLane: (JSONObject) -> Unit) -> Unit,
    private val onRefused: (mediaId: UUID) -> Unit,
    private val onSaveFailed: () -> Unit,
) {
    data class Sample(val positionMs: Long, val durationMs: Long?)
    private class Episode(val mediaId: UUID, var resetEpoch: Long, var overrideRevision: Long?) {
        var rate: Double? = null
        var span: Span? = null
        var fenced = false
        var active = false
        var ended = false
    }
    private class Span(val startElapsed: Long, val startPositionMs: Long)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val wallOffsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    private var account: UUID? = null
    private var episode: Episode? = null
    private var tick: Job? = null
    private var store: PlaybackStore? = null
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
    init { connectivity.registerDefaultNetworkCallback(network) }

    suspend fun bind(accountId: UUID, playback: PlaybackStore) {
        if (account == accountId) return kick()
        unbind()
        store = playback
        account = accountId
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
        store = null
    }
    fun start(mediaId: UUID, resetEpoch: Long, overrideRevision: Long?) {
        episode = Episode(mediaId, resetEpoch, overrideRevision)
    }
    fun checkpoint() { episode?.takeIf { it.active && !it.fenced && !it.ended }?.let(::write) }
    fun pinRate(rate: Double) {
        val ep = episode ?: return
        ep.rate = rate
        if (ep.active && !ep.fenced) write(ep)
    }
    fun pending(): Boolean = episode?.let { hasPending(it.mediaId) } == true
    fun attached(): Boolean = episode != null
    fun resetEpoch(): Long? = episode?.resetEpoch
    fun overrideRevision(): Long? = episode?.overrideRevision
    fun hasPending(mediaId: UUID): Boolean = store?.value?.let { PlaybackStore.facts(it) }
        ?.any { it.getString("media_id") == mediaId.toString() } == true ||
        episode?.let { it.mediaId == mediaId && it.span != null } == true
    fun fenced(): Boolean = episode?.fenced == true
    fun refresh(overrideRevision: Long?) { episode?.overrideRevision = overrideRevision }

    /** Canonical resets retire old facts; they never relabel them under a new epoch. */
    fun observe(observations: List<JSONObject>) {
        store?.observe(observations)
        refreshEpisode()
    }
    private fun refreshEpisode() {
        val ep = episode ?: return
        val current = store?.record(ep.mediaId)?.optJSONObject("observed") ?: return
        val state = current.getJSONObject("state")
        ep.overrideRevision = state.nullableLong("consumption_override_revision")
        if (ep.resetEpoch != state.getLong("reset_epoch")) {
            tick?.cancel()
            closeSpan(ep)
            ep.resetEpoch = state.getLong("reset_epoch")
            ep.active = false
            ep.fenced = false
            ep.ended = false
            onAdopt(current)
        }
    }
    fun adopt(observation: JSONObject) {
        observe(listOf(observation))
        episode?.takeIf { it.mediaId.toString() == observation.getString("media_id") }?.apply { fenced = false; active = false }
    }
    fun retry(mediaId: UUID) {
        val playback = store ?: return
        playback.update { envelope ->
            val record = PlaybackStore.record(envelope, mediaId.toString())
            record.put("source_unavailable", false)
            record.optJSONObject("local")?.put("disposition", "Pending")
        }
        kick()
    }
    suspend fun fence(): Boolean {
        val ep = episode ?: return true
        ep.fenced = true
        tick?.cancel()
        closeSpan(ep)
        // Already dispatched samples retain their epoch; a later reset refuses them without blocking local commands.
        ep.active = false
        return true
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
                    try { write(ep) } catch (_: IOException) {
                        // justify-ignore-error: pause and expose the unsaved local checkpoint for explicit retry.
                        onSaveFailed()
                        return@launch
                    }
                }
            }
        } else if (ep.active) write(ep)
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
    fun ended(): Boolean {
        val ep = episode ?: return false
        if (account == null) return false
        if (ep.ended) return true
        tick?.cancel()
        closeSpan(ep)
        val body = JSONObject().put("terminal_listening", listening(ep))
            .put("expected_override_revision", ep.overrideRevision ?: JSONObject.NULL)
        return try {
            onTerminal { envelope -> addFact(envelope, ep, body, true) }
            ep.active = false
            ep.ended = true
            setSynced(false)
            send()
            true
        } catch (error: IOException) {
            setSynced(false)
            Log.w(TAG, "terminal playback state not persisted", error)
            onSaveFailed()
            false
        }
    }
    suspend fun stop(): Boolean {
        val ep = episode ?: return true
        tick?.cancel()
        val playing = ep.span != null
        closeSpan(ep)
        if (playing) write(ep)
        episode = null
        // Local activation never waits for a remote write or network timeout.
        return true
    }
    suspend fun retire() {
        unbind()
        outbox.clear()
    }
    fun close() { connectivity.unregisterNetworkCallback(network); tick?.cancel() }
    private fun kick() { send(); upload() }
    private fun addFact(envelope: JSONObject, ep: Episode, body: JSONObject, settle: Boolean) {
        val facts = PlaybackStore.facts(envelope).toMutableList()
        val sample = if (settle) body.getJSONObject("terminal_listening") else body
        val completed = PlaybackStore.record(envelope, ep.mediaId.toString()).optJSONObject("local")?.optBoolean("completed") == true ||
            PlaybackStore.record(envelope, ep.mediaId.toString()).optJSONObject("observed")?.getJSONObject("state")?.nullableString("consumption_override_status") == "finished"
        val crossing = PlaybackStore.threshold(sample) && !completed
        // Preserve the threshold sample until its own receipt, including across backwards seeks.
        val last = facts.lastOrNull()
        if (!settle && last != null && !last.getBoolean("settle") && !last.getBoolean("barrier") &&
            last.getString("media_id") == ep.mediaId.toString()) facts.removeAt(facts.lastIndex)
        val sequence = envelope.getLong("fact_sequence") + 1
        envelope.put("fact_sequence", sequence)
        val fact = JSONObject().put("sequence", sequence).put("media_id", ep.mediaId.toString())
            .put("body", body).put("settle", settle).put("barrier", settle || crossing)
        facts.add(fact)
        envelope.put("lane", JSONArray(facts))
        PlaybackStore.projectFact(envelope, fact)
    }
    private fun write(ep: Episode) {
        val playback = store ?: return
        playback.update { addFact(it, ep, listening(ep), false) }
        setSynced(false)
        send()
    }
    private fun send() {
        val playback = store ?: return
        val accountId = account ?: return
        if (sending?.isActive == true) return
        sending = scope.launch {
            while (store === playback && account == accountId) {
                val fact = PlaybackStore.facts(playback.value).firstOrNull {
                    playback.record(UUID.fromString(it.getString("media_id")))?.getBoolean("source_unavailable") != true
                } ?: break
                if (!deliver(accountId, playback, JSONObject(fact.toString()))) {
                    setSynced(false)
                    return@launch retryLater()
                }
                failures = 0
            }
            setSynced(PlaybackStore.facts(playback.value).isEmpty())
        }
    }
    private suspend fun deliver(accountId: UUID, playback: PlaybackStore, fact: JSONObject): Boolean {
        val mediaId = UUID.fromString(fact.getString("media_id"))
        val sequence = fact.getLong("sequence")
        val settle = fact.getBoolean("settle")
        val body = fact.getJSONObject("body")
        try {
            val observation = if (settle) origin.settleNaturalEnd(mediaId, body) else origin.putListening(mediaId, body)
            if (store !== playback || account != accountId) return true
            PlaybackStore.validateObservation(observation)
            playback.update { envelope ->
                val current = PlaybackStore.record(envelope, mediaId.toString()).optJSONObject("observed")
                val state = observation.getJSONObject("state")
                val epoch = state.getLong("reset_epoch")
                val receiptCurrent = current == null || current.getString("consumption_revision").toBigInteger() <= observation.getString("consumption_revision").toBigInteger()
                val lane = PlaybackStore.facts(envelope).filter { it.getLong("sequence") != sequence }
                if (!settle && receiptCurrent) for (queued in lane) {
                    if (queued.getLong("sequence") > sequence && queued.getString("media_id") == mediaId.toString() &&
                        queued.getBoolean("settle") && PlaybackStore.sample(queued).getLong("expected_reset_epoch") == epoch)
                        queued.getJSONObject("body").put("expected_override_revision", state.get("consumption_override_revision"))
                }
                envelope.put("lane", JSONArray(lane))
                val record = PlaybackStore.record(envelope, mediaId.toString())
                if (record.optJSONObject("local")?.getString("sequence")?.toLong() == sequence && settle && receiptCurrent)
                    record.getJSONObject("local").getJSONObject("terminal").put("expected_override_revision", state.get("consumption_override_revision"))
                PlaybackStore.adoptObservation(envelope, observation)
                if (sequence > record.getLong("ack_sequence")) record.put("ack_sequence", sequence).put("ack_revision", observation.getString("consumption_revision"))
            }
            refreshEpisode()
            onAccepted()
            return true
        } catch (error: NexusOriginError) {
            if (store !== playback || account != accountId) return true
            if (retryable(error.status)) return false
            if (error.status in setOf(403, 404, 410)) {
                playback.update { envelope ->
                    val record = PlaybackStore.record(envelope, mediaId.toString()).put("source_unavailable", true)
                    record.optJSONObject("local")?.put("disposition", "SourceUnavailable")
                }
                onRefused(mediaId)
                return true
            }
            val current = error.details?.optJSONObject("current")
            if (error.status != 409 || current == null) throw error
            PlaybackStore.validateObservation(current)
            // Refusal observation and exact fact retirement share the same durable publication.
            playback.update { envelope ->
                PlaybackStore.adoptObservation(envelope, current)
                envelope.put("lane", JSONArray(PlaybackStore.facts(envelope).filter { it.getLong("sequence") != sequence }))
            }
            refreshEpisode()
            Log.w(TAG, "refused listening fact", error)
            return true
        } catch (_: IOException) {
            // justify-ignore-error: retain the exact durable fact for retry; newer facts keep their own identities.
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
