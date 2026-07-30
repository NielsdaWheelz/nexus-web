package app.nexus.android.offline

import androidx.media3.common.C
import androidx.media3.exoplayer.offline.Download
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

class OfflineMediaStoreContractTest {
    @Test
    fun `canonical WebKit origin rule never contains a path`() {
        assertEquals(
            "https://nexus.example",
            canonicalOriginRule("https://nexus.example/"),
        )
        assertEquals(
            "http://10.0.2.2:3000",
            canonicalOriginRule("http://10.0.2.2:3000"),
        )
    }

    @Test
    fun `parses full explicit open and suffix single ranges`() {
        assertEquals(
            RequestedByteRange.Satisfiable(0, 100, null),
            RequestedByteRange.parse(null, 100),
        )
        assertEquals(
            RequestedByteRange.Satisfiable(10, 11, "bytes 10-20/100"),
            RequestedByteRange.parse("bytes=10-20", 100),
        )
        assertEquals(
            RequestedByteRange.Satisfiable(90, 10, "bytes 90-99/100"),
            RequestedByteRange.parse("bytes=90-", 100),
        )
        assertEquals(
            RequestedByteRange.Satisfiable(95, 5, "bytes 95-99/100"),
            RequestedByteRange.parse("bytes=-5", 100),
        )
    }

    @Test
    fun `rejects malformed multiple and out of bounds ranges`() {
        listOf(
            "bytes=100-",
            "bytes=20-10",
            "bytes=0-1,4-5",
            "bytes=",
            "items=0-1",
            "bytes=-0",
            "bytes=--",
        ).forEach { header ->
            assertEquals(
                "expected 416 classification for $header",
                RequestedByteRange.Unsatisfiable,
                RequestedByteRange.parse(header, 100),
            )
        }
    }

    @Test
    fun `accepts ID3 and valid MPEG frame headers`() {
        assertTrue(
            ProgressiveContainerVerifier.accepts(
                "audio/mpeg",
                byteArrayOf('I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte()),
            )
        )
        assertTrue(
            ProgressiveContainerVerifier.accepts(
                "audio/mpeg",
                byteArrayOf(0xff.toByte(), 0xfb.toByte(), 0x90.toByte()),
            )
        )
        assertFalse(
            ProgressiveContainerVerifier.accepts(
                "audio/mpeg",
                byteArrayOf(0xff.toByte(), 0xfb.toByte(), 0x00),
            )
        )
    }

    @Test
    fun `requires ftyp and an audio compatible MP4 brand`() {
        val m4aHeader = byteArrayOf(
            0, 0, 0, 24,
            'f'.code.toByte(), 't'.code.toByte(), 'y'.code.toByte(), 'p'.code.toByte(),
            'M'.code.toByte(), '4'.code.toByte(), 'A'.code.toByte(), ' '.code.toByte(),
            0, 0, 0, 0,
            'i'.code.toByte(), 's'.code.toByte(), 'o'.code.toByte(), 'm'.code.toByte(),
        )
        assertTrue(ProgressiveContainerVerifier.accepts("audio/mp4", m4aHeader))
        assertFalse(
            ProgressiveContainerVerifier.accepts(
                "audio/mp4",
                m4aHeader.copyOf().also { it[4] = 'm'.code.toByte() },
            )
        )
        assertFalse(
            ProgressiveContainerVerifier.accepts(
                "audio/mp4",
                m4aHeader.copyOf().also {
                    "avc1".toByteArray().copyInto(it, destinationOffset = 8)
                    "avc1".toByteArray().copyInto(it, destinationOffset = 16)
                },
            )
        )
    }

    @Test
    fun `preflight cancellation fences calls attached before or after cancel`() {
        var firstCanceled = false
        val beforeAttach = PreflightCancellation()
        beforeAttach.cancel()
        beforeAttach.attach { firstCanceled = true }
        assertTrue("expected an already canceled preflight to abort its attached call", firstCanceled)
        assertTrue(beforeAttach.isCanceled())

        var secondCanceled = false
        val afterAttach = PreflightCancellation()
        afterAttach.attach { secondCanceled = true }
        assertFalse(secondCanceled)
        afterAttach.cancel()
        assertTrue("expected cancellation to abort an already attached call", secondCanceled)
    }

    @Test
    fun `account and generation fence every delayed admission`() {
        val expected = UUID.fromString("22222222-2222-4222-8222-222222222222")
        val other = UUID.fromString("33333333-3333-4333-8333-333333333333")
        assertTrue(admissionIsCurrent(false, expected, 7, expected, 7))
        assertFalse(admissionIsCurrent(true, expected, 7, expected, 7))
        assertFalse(admissionIsCurrent(false, expected, 7, other, 7))
        assertFalse(admissionIsCurrent(false, expected, 7, expected, 8))
        assertFalse(admissionIsCurrent(false, expected, 7, null, 7))
    }

    @Test
    fun `reserve boundary rejects the byte that would cross 512 MiB`() {
        assertTrue(
            preservesStorageReserve(
                OFFLINE_STORAGE_RESERVE_BYTES + 1,
                1,
            )
        )
        assertFalse(
            preservesStorageReserve(
                OFFLINE_STORAGE_RESERVE_BYTES,
                1,
            )
        )
        assertTrue(
            preservesStorageReserve(
                OFFLINE_STORAGE_RESERVE_BYTES,
                0,
            )
        )
        assertFalse(preservesStorageReserve(Long.MAX_VALUE, Long.MAX_VALUE))
    }

    @Test
    fun `projects every Media3 state including restarting and system limit`() {
        val ready = NativeLocalAvailability.Ready(
            100,
            "audio/mpeg",
            Instant.parse("2026-07-30T12:34:56Z"),
        )
        assertEquals(
            NativeLocalAvailability.Queued(QueueReason.WaitingForUnmetered),
            projection(Download.STATE_QUEUED, queueReason = QueueReason.WaitingForUnmetered),
        )
        assertEquals(
            NativeLocalAvailability.Queued(QueueReason.SystemLimit),
            projection(
                Download.STATE_STOPPED,
                stopReason = OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
            ),
        )
        assertEquals(
            NativeLocalAvailability.Downloading(47, Presence.Present(100)),
            projection(Download.STATE_DOWNLOADING, bytes = 47, total = 100),
        )
        assertEquals(ready, projection(Download.STATE_COMPLETED, ready = ready))
        assertEquals(
            NativeLocalAvailability.Failed,
            projection(Download.STATE_COMPLETED, ready = null),
        )
        assertEquals(NativeLocalAvailability.Failed, projection(Download.STATE_FAILED))
        assertEquals(NativeLocalAvailability.Removing, projection(Download.STATE_REMOVING))
        assertEquals(NativeLocalAvailability.Restarting, projection(Download.STATE_RESTARTING))
    }

    @Test
    fun `unknown Media3 state and stop reason defect`() {
        assertThrows(IllegalStateException::class.java) {
            projection(Download.STATE_STOPPED, stopReason = 99)
        }
        assertThrows(IllegalStateException::class.java) {
            projection(99)
        }
    }

    private fun projection(
        state: Int,
        stopReason: Int = Download.STOP_REASON_NONE,
        bytes: Long = 0,
        total: Long = C.LENGTH_UNSET.toLong(),
        ready: NativeLocalAvailability.Ready? = null,
        queueReason: QueueReason = QueueReason.Capacity,
    ): NativeLocalAvailability {
        return projectMedia3State(
            state,
            stopReason,
            bytes,
            total,
            Presence.Absent,
            queueReason,
            ready,
        )
    }
}
