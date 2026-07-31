package app.nexus.android.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.SilenceSkippingAudioProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

@OptIn(UnstableApi::class)
class PauseShorteningProcessorTest {
    @Test
    fun `stock Media3 processor skips long silence only when enabled`() {
        val off = SilenceSkippingAudioProcessor()
        off.setEnabled(false)
        off.configure(AudioFormat(SAMPLE_RATE_HZ, 1, C.ENCODING_PCM_16BIT))
        off.flush()
        assertFalse(off.isActive)
        assertEquals(0, off.skippedFrames)

        val natural = SilenceSkippingAudioProcessor()
        natural.setEnabled(true)
        natural.configure(AudioFormat(SAMPLE_RATE_HZ, 1, C.ENCODING_PCM_16BIT))
        natural.flush()

        val input = ByteBuffer
            .allocateDirect(SAMPLE_RATE_HZ * SILENCE_SECONDS * Short.SIZE_BYTES)
            .order(ByteOrder.nativeOrder())
        repeat(SAMPLE_RATE_HZ * SILENCE_SECONDS) {
            input.putShort(0)
        }
        input.flip()

        var outputBytes = 0
        while (input.hasRemaining()) {
            val before = input.position()
            natural.queueInput(input)
            val drainedBytes = consumeOutput(natural)
            outputBytes += drainedBytes
            check(input.position() > before || drainedBytes > 0)
        }
        natural.queueEndOfStream()
        var drainIterations = 0
        while (!natural.isEnded && drainIterations < MAX_DRAIN_ITERATIONS) {
            outputBytes += consumeOutput(natural)
            drainIterations += 1
        }
        assertTrue(natural.isEnded)

        assertTrue(natural.skippedFrames > 0)
        assertTrue(outputBytes < SAMPLE_RATE_HZ * SILENCE_SECONDS * Short.SIZE_BYTES)
    }

    private fun consumeOutput(processor: SilenceSkippingAudioProcessor): Int {
        val output = processor.output
        val bytes = output.remaining()
        output.position(output.limit())
        return bytes
    }

    private companion object {
        const val SAMPLE_RATE_HZ = 48_000
        const val SILENCE_SECONDS = 2
        const val MAX_DRAIN_ITERATIONS = 100
    }
}
