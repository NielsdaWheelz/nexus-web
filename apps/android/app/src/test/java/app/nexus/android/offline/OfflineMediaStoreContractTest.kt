package app.nexus.android.offline

import androidx.media3.common.C
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheSpan
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.ContentMetadataMutations
import androidx.media3.exoplayer.offline.Download
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.lang.reflect.Proxy
import java.net.Proxy as NetworkProxy
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
    fun `media HTTP client is direct and has no whole-transfer deadline`() {
        val client = SafeHttpClient().client

        assertEquals(NetworkProxy.NO_PROXY, client.proxy)
        assertEquals(0, client.callTimeoutMillis)
        assertEquals(OFFLINE_PREFLIGHT_DEADLINE.toMillis().toInt(), client.connectTimeoutMillis)
        assertEquals(OFFLINE_PREFLIGHT_DEADLINE.toMillis().toInt(), client.readTimeoutMillis)
    }

    @Test
    fun `durable mutation retries swallowed index writes and verifies readback`() {
        var stored: String? = null
        var writes = 0
        assertTrue(
            ensureDurableMutation(
                expected = "persisted",
                read = { stored },
                write = {
                    writes += 1
                    if (writes == 1) {
                        throw IOException("transient")
                    }
                    stored = it
                },
            )
        )
        assertEquals(2, writes)

        assertFalse(
            ensureDurableMutation(
                expected = "expected",
                read = { "stale" },
                write = {},
            )
        )
    }

    @Test
    fun `durable removal retries swallowed index deletes and fails closed`() {
        var stored: String? = "persisted"
        var removals = 0
        assertTrue(
            ensureDurableRemoval(
                read = { stored },
                remove = {
                    removals += 1
                    if (removals == 1) {
                        throw IOException("transient")
                    }
                    stored = null
                },
            )
        )
        assertEquals(2, removals)

        assertFalse(
            ensureDurableRemoval(
                read = { "still present" },
                remove = {},
            )
        )
    }

    @Test
    fun `active removal waits for manager observation while terminal removal can mark directly`() {
        listOf(
            Download.STATE_QUEUED,
            Download.STATE_STOPPED,
            Download.STATE_DOWNLOADING,
            Download.STATE_RESTARTING,
        ).forEach { state ->
            assertTrue(removalRequiresManagerObservation(state))
        }
        listOf(
            Download.STATE_COMPLETED,
            Download.STATE_FAILED,
            Download.STATE_REMOVING,
        ).forEach { state ->
            assertFalse(removalRequiresManagerObservation(state))
        }
    }

    @Test
    fun `system limit fence excludes terminal removing and repair-required rows`() {
        listOf(
            Download.STATE_QUEUED,
            Download.STATE_DOWNLOADING,
            Download.STATE_RESTARTING,
        ).forEach { state ->
            assertTrue(
                requiresSystemLimitFence(state, Download.STOP_REASON_NONE)
            )
        }
        assertTrue(
            requiresSystemLimitFence(
                Download.STATE_STOPPED,
                OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
            )
        )
        assertFalse(
            requiresSystemLimitFence(
                Download.STATE_STOPPED,
                OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON,
            )
        )
        listOf(
            Download.STATE_COMPLETED,
            Download.STATE_FAILED,
            Download.STATE_REMOVING,
        ).forEach { state ->
            assertFalse(
                requiresSystemLimitFence(state, Download.STOP_REASON_NONE)
            )
        }
    }

    @Test
    fun `notification repair never regresses newer or equal precedence durable state`() {
        assertTrue(
            durableStateSupersedes(
                Download.STATE_DOWNLOADING,
                Download.STOP_REASON_NONE,
                11,
                Download.STATE_REMOVING,
                Download.STOP_REASON_NONE,
                10,
            )
        )
        assertTrue(
            durableStateSupersedes(
                Download.STATE_REMOVING,
                Download.STOP_REASON_NONE,
                10,
                Download.STATE_DOWNLOADING,
                Download.STOP_REASON_NONE,
                10,
            )
        )
        assertFalse(
            durableStateSupersedes(
                Download.STATE_DOWNLOADING,
                Download.STOP_REASON_NONE,
                10,
                Download.STATE_REMOVING,
                Download.STOP_REASON_NONE,
                10,
            )
        )
        assertFalse(
            durableStateSupersedes(
                Download.STATE_STOPPED,
                OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
                10,
                Download.STATE_COMPLETED,
                Download.STOP_REASON_NONE,
                10,
            )
        )
    }

    @Test
    fun `notification repair never writes through an unreadable durable row`() {
        var reads = 0
        var writes = 0
        val observed = observeDurableNotification(
            notification = "stale",
            read = {
                reads += 1
                if (reads == 1) {
                    throw IOException("transient read failure")
                }
                "newer"
            },
            write = {
                writes += 1
            },
            matches = { expected, actual -> expected == actual },
            supersedes = { durable, _ -> durable == "newer" },
        )

        assertEquals("newer", observed)
        assertEquals(0, writes)
    }

    @Test
    fun `zero resume deletes spans length and redirected URI metadata`() {
        var removedKey: String? = null
        var metadataMutations: ContentMetadataMutations? = null
        val operations = mutableListOf<String>()
        var keyPresent = true
        val cache = Proxy.newProxyInstance(
            Cache::class.java.classLoader,
            arrayOf(Cache::class.java),
        ) { _, method, arguments ->
            when (method.name) {
                "getKeys" -> if (keyPresent) setOf("download-id") else emptySet<String>()
                "removeResource" -> {
                    operations.add("spans")
                    removedKey = arguments?.get(0) as String
                    keyPresent = false
                    null
                }
                "applyContentMetadataMutations" -> {
                    operations.add("metadata")
                    metadataMutations = arguments?.get(1) as ContentMetadataMutations
                    null
                }
                else -> error("unexpected Cache call ${method.name}")
            }
        } as Cache

        removeCachedResource(cache, "download-id")

        assertEquals("download-id", removedKey)
        assertEquals(listOf("metadata", "spans"), operations)
        assertEquals(
            setOf(
                ContentMetadata.KEY_CONTENT_LENGTH,
                ContentMetadata.KEY_REDIRECTED_URI,
            ),
            metadataMutations?.removedValues?.toSet(),
        )
    }

    @Test
    fun `cache cleanup does not create an absent resource key`() {
        val cache = Proxy.newProxyInstance(
            Cache::class.java.classLoader,
            arrayOf(Cache::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "getKeys" -> emptySet<String>()
                else -> error("unexpected Cache call ${method.name}")
            }
        } as Cache

        removeCachedResource(cache, "absent-download")
    }

    @Test
    fun `cache cleanup releases a metadata-only empty key`() {
        val operations = mutableListOf<String>()
        var keyPresent = true
        val hole = CacheSpan(
            "download-id",
            0,
            C.LENGTH_UNSET.toLong(),
        )
        val cache = Proxy.newProxyInstance(
            Cache::class.java.classLoader,
            arrayOf(Cache::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "getKeys" -> if (keyPresent) setOf("download-id") else emptySet<String>()
                "applyContentMetadataMutations" -> operations.add("metadata")
                "removeResource" -> operations.add("spans")
                "startReadWriteNonBlocking" -> {
                    operations.add("acquire-hole")
                    hole
                }
                "releaseHoleSpan" -> {
                    operations.add("release-hole")
                    keyPresent = false
                    null
                }
                else -> error("unexpected Cache call ${method.name}")
            }
        } as Cache

        removeCachedResource(cache, "download-id")

        assertEquals(
            listOf("metadata", "spans", "acquire-hole", "release-hole"),
            operations,
        )
        assertFalse(keyPresent)
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
