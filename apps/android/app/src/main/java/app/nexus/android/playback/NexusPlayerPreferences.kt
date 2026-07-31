package app.nexus.android.playback

import android.content.Context
import app.nexus.android.webkit.requireExactKeys
import org.json.JSONObject
import kotlin.math.min

internal class NexusPlayerPreferences(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun deviceDefaultMode(): PauseShorteningMode {
        val raw = preferences.getString(DEVICE_DEFAULT_MODE, null)
            ?: return PauseShorteningMode.Off
        return PauseShorteningMode.valueOf(raw)
    }

    fun setDeviceDefaultMode(mode: PauseShorteningMode) {
        check(preferences.edit().putString(DEVICE_DEFAULT_MODE, mode.name).commit())
    }

    fun savedOnDeviceMs(): Long {
        val value = preferences.getLong(SAVED_ON_DEVICE_MS, 0)
        check(value >= 0)
        return value
    }

    fun setSavedOnDeviceMs(value: Long) {
        require(value >= 0)
        check(preferences.edit().putLong(SAVED_ON_DEVICE_MS, value).commit())
    }

    fun pendingNaturalEnd(): Presence<PendingNaturalEnd> {
        val raw = preferences.getString(PENDING_NATURAL_END, null)
            ?: return Presence.Absent
        val wrapper = app.nexus.android.webkit.strictJsonObject(raw)
        return when (wrapper.getString("kind")) {
            "Present" -> {
                wrapper.requireExactKeys("kind", "value")
                Presence.Present(
                    PlayerWire.decodePendingNaturalEnd(
                        wrapper.getJSONObject("value").toString()
                    )
                )
            }
            else -> error("invalid pending-natural-end Presence")
        }
    }

    /**
     * Synchronous commit is the receipt durability barrier: callers publish
     * Ended only after this returns.
     */
    fun setPendingNaturalEnd(receipt: PendingNaturalEnd) {
        val encoded = JSONObject()
            .put("kind", "Present")
            .put(
                "value",
                JSONObject(PlayerWire.encodePendingNaturalEnd(receipt)),
            )
            .toString()
        check(preferences.edit().putString(PENDING_NATURAL_END, encoded).commit())
    }

    fun acknowledgeNaturalEnd(
        sessionKey: java.util.UUID,
        clientMutationId: java.util.UUID,
    ): Boolean {
        val pending = pendingNaturalEnd()
        if (
            pending !is Presence.Present ||
            pending.value.sessionKey != sessionKey ||
            pending.value.clientMutationId != clientMutationId
        ) {
            return false
        }
        check(preferences.edit().remove(PENDING_NATURAL_END).commit())
        return true
    }

    fun discardForeignReceipt(accountId: java.util.UUID) {
        val pending = pendingNaturalEnd()
        if (pending is Presence.Present && pending.value.accountId != accountId) {
            check(preferences.edit().remove(PENDING_NATURAL_END).commit())
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "nexus.player"
        const val DEVICE_DEFAULT_MODE = "pause-shortening.device-default"
        const val SAVED_ON_DEVICE_MS = "pause-shortening.saved-on-device-ms"
        const val PENDING_NATURAL_END = "natural-end.pending"
    }
}

/**
 * Conservative skipped-frame accounting. Each checkpoint admits only the
 * processor work that can be paired with positive source-time movement from
 * the same format/rate epoch.
 */
internal class SavedTimeAccounting(initialTotalMs: Long) {
    private data class Epoch(
        val skippedFrames: Long,
        val sourcePositionMs: Long,
        val sampleRateHz: Int,
        val baseRate: Double,
        val eligible: Boolean,
    )

    var totalMs: Long = initialTotalMs
        private set

    private var epoch: Epoch? = null

    init {
        require(initialTotalMs >= 0)
    }

    fun startEpoch(
        skippedFrames: Long,
        sourcePositionMs: Long,
        sampleRateHz: Int,
        baseRate: Double,
        eligible: Boolean,
    ) {
        require(skippedFrames >= 0)
        require(sourcePositionMs >= 0)
        require(sampleRateHz >= 0)
        require(baseRate.isFinite() && baseRate > 0)
        epoch = Epoch(
            skippedFrames,
            sourcePositionMs,
            sampleRateHz,
            baseRate,
            eligible,
        )
    }

    fun checkpoint(
        skippedFrames: Long,
        sourcePositionMs: Long,
        sampleRateHz: Int,
        baseRate: Double,
        eligible: Boolean,
    ): Long {
        require(skippedFrames >= 0)
        require(sourcePositionMs >= 0)
        require(sampleRateHz >= 0)
        require(baseRate.isFinite() && baseRate > 0)
        val previous = epoch
        val current = Epoch(
            skippedFrames,
            sourcePositionMs,
            sampleRateHz,
            baseRate,
            eligible,
        )
        epoch = current
        if (
            previous == null ||
            !previous.eligible ||
            !eligible ||
            previous.sampleRateHz <= 0 ||
            sampleRateHz != previous.sampleRateHz ||
            kotlin.math.abs(baseRate - previous.baseRate) > RATE_TOLERANCE ||
            skippedFrames < previous.skippedFrames
        ) {
            return 0
        }
        val frameDelta = skippedFrames - previous.skippedFrames
        val sourceDeltaMs = sourcePositionMs - previous.sourcePositionMs
        if (frameDelta <= 0 || sourceDeltaMs <= 0) {
            return 0
        }
        val processorSourceMs = framesToMilliseconds(frameDelta, sampleRateHz)
        val admittedSourceMs = min(processorSourceMs, sourceDeltaMs)
        val savedMs = (admittedSourceMs / previous.baseRate).toLong()
        if (savedMs <= 0) {
            return 0
        }
        totalMs = saturatingAdd(totalMs, savedMs)
        return savedMs
    }

    fun clearEpoch() {
        epoch = null
    }

    private fun framesToMilliseconds(frames: Long, sampleRateHz: Int): Long {
        val seconds = frames / sampleRateHz
        val remainder = frames % sampleRateHz
        return saturatingAdd(
            saturatingMultiply(seconds, 1_000),
            remainder * 1_000 / sampleRateHz,
        )
    }

    private fun saturatingMultiply(value: Long, multiplier: Long): Long {
        if (value > Long.MAX_VALUE / multiplier) {
            return Long.MAX_VALUE
        }
        return value * multiplier
    }

    private fun saturatingAdd(left: Long, right: Long): Long {
        if (right > Long.MAX_VALUE - left) {
            return Long.MAX_VALUE
        }
        return left + right
    }

    private companion object {
        const val RATE_TOLERANCE = 0.000_001
    }
}
