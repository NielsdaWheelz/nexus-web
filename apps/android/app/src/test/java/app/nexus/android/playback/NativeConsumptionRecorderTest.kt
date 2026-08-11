package app.nexus.android.playback

import app.nexus.android.RetryPolicies
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.util.UUID

class NativeConsumptionRecorderTest {
    @Test
    fun `closed listening span has a stable capture key before origin delivery`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            var elapsed = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(1_000) },
                elapsed = { elapsed },
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)

            recorder.onPlayingChanged(true)
            elapsed = 10_000
            recorder.onPlayingChanged(false)
            settle()

            val span = JSONObject(transport.activityBodies.single())
                .getJSONObject("batch")
                .getJSONArray("spans")
                .getJSONObject(0)
            assertNotNull(UUID.fromString(span.getString("captureKey")))
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `retry while persistence is Ready performs no recovery GET`() =
        runBlocking {
            val transport = FakeOriginTransport()
            var getCount = 0
            transport.getResponse = {
                getCount += 1
                listeningEnvelope(
                    writeRevision = 1,
                    resetEpoch = 1,
                    positionMs = 0,
                )
            }
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(0) },
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)

            recorder.retryPersistence()
            settle()

            assertEquals(0, getCount)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `account switch durably closes activity without an authenticated origin call`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val outbox = InMemoryActivityOutbox()
            var elapsed = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(2_000) },
                elapsed = { elapsed },
                activityOutbox = outbox,
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.0),
            )
            recorder.onPlayingChanged(true)
            elapsed = 1_000

            recorder.discardPending()
            settle()

            assertTrue(transport.putBodies.isEmpty())
            assertTrue(transport.activityBodies.isEmpty())
            assertTrue(
                outbox.sync(ACCOUNT_ID, NativeActivityCapture.Idle).sync is
                    NativeActivitySync.Pending
            )
            recorder.close()
        }

    @Test
    fun `source replacement retires ambiguous heartbeat before immediate natural end`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val pending = CompletableDeferred<NexusOriginResponse>()
            transport.putResponse = { pending.await() }
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(9_000) },
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)
            recorder.flush()
            settle()
            assertEquals(1, transport.putBodies.size)

            recorder.install(
                SESSION_ID_B,
                descriptor().copy(mediaId = MEDIA_ID_B),
                Presence.Absent,
            )
            var capture: NaturalEndCapture? = null
            recorder.captureNaturalEnd { capture = it }

            assertNotNull(capture)
            assertEquals(1L, capture?.writeRevision)
            assertEquals(1L, capture?.resetEpoch)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `account replacement clears ambiguous heartbeat before immediate natural end`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val pending = CompletableDeferred<NexusOriginResponse>()
            transport.putResponse = { pending.await() }
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(9_000) },
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)
            recorder.flush()
            settle()
            assertEquals(1, transport.putBodies.size)

            recorder.discardPending()
            recorder.install(
                SESSION_ID_B,
                descriptor().copy(mediaId = MEDIA_ID_B),
                Presence.Absent,
            )
            var capture: NaturalEndCapture? = null
            recorder.captureNaturalEnd { capture = it }

            assertNotNull(capture)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `cadence ticks at five seconds and heartbeats exactly at fifteen`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            val requestedDelays = Channel<Long>(Channel.UNLIMITED)
            val permits = Channel<Unit>(Channel.UNLIMITED)
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(1_000) },
                cadenceDelay = { milliseconds ->
                    requestedDelays.send(milliseconds)
                    permits.receive()
                },
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)
            recorder.onPlayingChanged(true)

            repeat(2) {
                assertEquals(
                    NATIVE_RECORDER_CADENCE_TICK_MS,
                    requestedDelays.receive(),
                )
                permits.send(Unit)
                settle()
            }
            assertTrue(transport.putBodies.isEmpty())

            assertEquals(
                NATIVE_RECORDER_CADENCE_TICK_MS,
                requestedDelays.receive(),
            )
            permits.send(Unit)
            settle()

            assertEquals(1, transport.putBodies.size)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `absent episode rate still emits an owned heartbeat`() = runBlocking {
        val transport = FakeOriginTransport()
        transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
        var position = 1_000L
        val recorder = recorder(
            CoroutineScope(coroutineContext),
            transport,
            read = { sample(position) },
        )
        recorder.install(SESSION_ID, descriptor(), Presence.Absent)

        recorder.flush()
        settle()

        val body = JSONObject(transport.putBodies.single())
        assertEquals(
            "Absent",
            body.getJSONObject("episodePlaybackRate").getString("kind"),
        )
        recorder.discardPending()
        recorder.close()
    }

    @Test
    fun `natural end waits for in flight heartbeat and captures accepted fences`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val pending = CompletableDeferred<NexusOriginResponse>()
            transport.putResponse = {
                transport.lastPutBody = it
                pending.await()
            }
            var position = 4_000L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(position) },
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.5),
            )
            recorder.flush()
            settle()
            position = 5_000
            var capture: NaturalEndCapture? = null

            recorder.captureNaturalEnd { capture = it }
            assertEquals(null, capture)
            pending.complete(
                heartbeatSuccess(
                    transport.lastPutBody,
                    writeRevision = 9,
                    resetEpoch = 3,
                    positionMs = 4_000,
                )
            )
            settle()

            assertNotNull(capture)
            assertEquals(5_000L, capture?.positionMs)
            assertEquals(9L, capture?.writeRevision)
            assertEquals(3L, capture?.resetEpoch)
            recorder.close()
        }

    @Test
    fun `offline natural end captures last accepted fence after bounded recovery`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val pending = CompletableDeferred<NexusOriginResponse>()
            transport.putResponse = { pending.await() }
            transport.getResponse = { throw IOException("offline") }
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(5_000) },
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.0),
            )
            recorder.flush()
            settle()
            var capture: NaturalEndCapture? = null
            recorder.captureNaturalEnd { capture = it }

            pending.completeExceptionally(IOException("ambiguous PUT"))
            settle(40)

            assertNotNull(capture)
            assertEquals(1L, capture?.writeRevision)
            assertEquals(1L, capture?.resetEpoch)
            recorder.close()
        }

    @Test
    fun `natural end retries ambiguity retained by an earlier network suspension`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { throw IOException("offline PUT") }
            transport.getResponse = { throw IOException("offline GET") }
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(5_000) },
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.0),
            )
            recorder.flush()
            settle(40)
            var capture: NaturalEndCapture? = null

            recorder.captureNaturalEnd { capture = it }
            settle(40)

            assertNotNull(capture)
            assertEquals(1L, capture?.writeRevision)
            assertEquals(1L, capture?.resetEpoch)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `drain awaits its send and retires generation until adopt`() = runBlocking {
        val transport = FakeOriginTransport()
        val pending = CompletableDeferred<NexusOriginResponse>()
        transport.putResponse = {
            transport.lastPutBody = it
            pending.await()
        }
        val recorder = recorder(
            CoroutineScope(coroutineContext),
            transport,
            read = { sample(6_000) },
        )
        recorder.install(
            SESSION_ID,
            descriptor(),
            Presence.Present(1.0),
        )
        var drained = false

        recorder.drain(5_000) { drained = true }
        settle()
        assertFalse(drained)
        pending.complete(
            heartbeatSuccess(transport.lastPutBody, writeRevision = 4)
        )
        settle()
        assertTrue(drained)

        recorder.onPlayingChanged(true)
        recorder.flush()
        settle()
        assertEquals(1, transport.putBodies.size)

        transport.putResponse = { heartbeatSuccess(it, writeRevision = 5) }
        recorder.adoptListeningState(
            listeningState(writeRevision = 4, resetEpoch = 1)
        )
        recorder.flush()
        settle()
        assertEquals(2, transport.putBodies.size)
        recorder.discardPending()
        recorder.close()
    }

    @Test
    fun `recovery adopts a newer reset epoch before another send`() = runBlocking {
        val transport = FakeOriginTransport()
        transport.putResponse = { NexusOriginResponse(500, "") }
        transport.getResponse = {
            listeningEnvelope(
                writeRevision = 8,
                resetEpoch = 2,
                positionMs = 0,
            )
        }
        val adopted = mutableListOf<ListeningState>()
        val recorder = recorder(
            CoroutineScope(coroutineContext),
            transport,
            read = { sample(7_000) },
            adopted = adopted::add,
        )
        recorder.install(
            SESSION_ID,
            descriptor(),
            Presence.Present(1.0),
        )

        recorder.flush()
        settle()

        assertEquals(1, adopted.size)
        assertEquals(0L, adopted.single().positionMs)
        assertEquals(2L, adopted.single().resetEpoch)
        recorder.discardPending()
        recorder.close()
    }

    @Test
    fun `transient activity failure retains the durable span without an in-memory retry loop`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            transport.activityResponse = { NexusOriginResponse(500, "") }
            var elapsed = 0L
            var position = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(position) },
                elapsed = { elapsed },
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.0),
            )
            recorder.onPlayingChanged(true)
            elapsed = 1_000
            position = 1_000
            recorder.onPlayingChanged(false)
            settle(40)

            assertEquals(1, transport.activityBodies.size)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `owned activity error codes classify failed rows and later spans continue`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            val responses = ArrayDeque(
                listOf(
                    NexusOriginResponse(400, errorEnvelope("E_ACTIVITY_EXPIRED")),
                    NexusOriginResponse(404, errorEnvelope("E_MEDIA_NOT_FOUND")),
                    NexusOriginResponse(403, errorEnvelope("E_MEDIA_NOT_FOUND")),
                    NexusOriginResponse(403, errorEnvelope("E_FORBIDDEN")),
                )
            )
            transport.activityResponse = { responses.removeFirst() }
            val outbox = InMemoryActivityOutbox()
            var elapsed = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(elapsed) },
                elapsed = { elapsed },
                activityOutbox = outbox,
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)

            repeat(4) {
                recorder.onPlayingChanged(true)
                elapsed += 1_000
                recorder.onPlayingChanged(false)
                settle()
            }

            assertEquals(
                listOf(
                    NativeActivityFailure.Expired,
                    NativeActivityFailure.MediaUnavailable,
                    NativeActivityFailure.Defect,
                    NativeActivityFailure.Defect,
                ),
                outbox.failureReasons,
            )
            assertEquals(4, transport.activityBodies.size)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `manual persistence retry replays an auth retained capture key`() = runBlocking {
        val transport = FakeOriginTransport()
        transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
        val responses = ArrayDeque(
            listOf(
                NexusOriginResponse(401, errorEnvelope("E_UNAUTHENTICATED")),
                NexusOriginResponse(204, ""),
            )
        )
        transport.activityResponse = { responses.removeFirst() }
        transport.getResponse = {
            listeningEnvelope(writeRevision = 2, resetEpoch = 1, positionMs = 0)
        }
        val outbox = InMemoryActivityOutbox()
        val persistence = mutableListOf<PlayerPersistence>()
        var elapsed = 0L
        val recorder = recorder(
            CoroutineScope(coroutineContext),
            transport,
            read = { sample(elapsed) },
            elapsed = { elapsed },
            persistence = persistence::add,
            activityOutbox = outbox,
        )
        recorder.install(SESSION_ID, descriptor(), Presence.Absent)
        recorder.onPlayingChanged(true)
        elapsed = 1_000
        recorder.onPlayingChanged(false)
        settle()
        val firstCaptureKey = activityCaptureKey(transport.activityBodies.single())
        assertEquals(0L, recorder.activitySync().acceptedRevision)
        assertTrue(
            persistence.last() is PlayerPersistence.Suspended &&
                (persistence.last() as PlayerPersistence.Suspended).reason ==
                PersistenceSuspension.AuthExpired
        )

        recorder.retryPersistence()
        settle()

        assertEquals(2, transport.activityBodies.size)
        assertEquals(firstCaptureKey, activityCaptureKey(transport.activityBodies.last()))
        assertEquals(1L, recorder.activitySync().acceptedRevision)
        assertEquals(PlayerPersistence.Ready, persistence.last())
        assertEquals(
            NativeActivitySync.Synced,
            outbox.sync(ACCOUNT_ID, NativeActivityCapture.Idle).sync,
        )
        recorder.discardPending()
        recorder.close()
    }

    @Test
    fun `capacity block keeps draining and resumes an active capture after acknowledgement`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            val accepted = CompletableDeferred<NexusOriginResponse>()
            transport.activityResponse = { accepted.await() }
            val outbox = InMemoryActivityOutbox(maxSpans = 1)
            var elapsed = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(elapsed) },
                elapsed = { elapsed },
                activityOutbox = outbox,
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Absent)
            recorder.onPlayingChanged(true)
            elapsed = 1_000
            recorder.flush()
            settle()
            elapsed = 2_000
            recorder.flush()

            assertEquals(
                NativeActivityCapture.Blocked(
                    NativeActivityCapture.Blocked.Reason.CapacityReached
                ),
                recorder.activitySync().capture,
            )
            accepted.complete(NexusOriginResponse(204, ""))
            settle()

            assertEquals(NativeActivityCapture.Recording, recorder.activitySync().capture)
            assertEquals(NativeActivitySync.Synced, recorder.activitySync().sync)
            assertEquals(1L, recorder.activitySync().acceptedRevision)
            recorder.onPlayingChanged(false)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `local expiry removes an old row before uploading a mixed-age durable batch`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val outbox = InMemoryActivityOutbox()
            outbox.enqueue(
                ACCOUNT_ID,
                MEDIA_ID,
                JSONObject().put("occurredAt", "2023-10-01T00:00:00.000Z"),
            )
            outbox.enqueue(
                ACCOUNT_ID,
                MEDIA_ID,
                JSONObject().put("occurredAt", "2023-11-14T00:00:00.000Z"),
            )

            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(0) },
                activityOutbox = outbox,
            )
            settle()

            val uploaded = JSONObject(transport.activityBodies.single())
                .getJSONObject("batch")
                .getJSONArray("spans")
            assertEquals(1, uploaded.length())
            assertEquals(
                "2023-11-14T00:00:00.000Z",
                uploaded.getJSONObject(0).getString("occurredAt"),
            )
            assertEquals(listOf(NativeActivityFailure.Expired), outbox.failureReasons)
            assertEquals(NativeActivitySync.Failed(1), recorder.activitySync().sync)
            assertEquals(1L, recorder.activitySync().acceptedRevision)
            recorder.close()
        }

    @Test
    fun `failed row retry and discard remain partitioned to the connected account`() =
        runBlocking {
            val transport = FakeOriginTransport()
            val outbox = InMemoryActivityOutbox()
            val foreignAccountId = UUID.fromString(
                "00000000-0000-4000-8000-000000000006"
            )
            listOf(ACCOUNT_ID, foreignAccountId).forEach { accountId ->
                outbox.enqueue(
                    accountId,
                    MEDIA_ID,
                    JSONObject().put("occurredAt", "2023-11-14T00:00:00.000Z"),
                )
                outbox.markFailed(
                    requireNotNull(outbox.nextBatch(accountId)),
                    NativeActivityFailure.Defect,
                )
            }
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(0) },
                activityOutbox = outbox,
            )

            recorder.retryFailedActivity()
            settle()

            assertEquals(1, transport.activityBodies.size)
            assertEquals(NativeActivitySync.Synced, recorder.activitySync().sync)
            assertEquals(
                NativeActivitySync.Failed(1),
                outbox.sync(foreignAccountId, NativeActivityCapture.Idle).sync,
            )

            outbox.enqueue(
                ACCOUNT_ID,
                MEDIA_ID,
                JSONObject().put("occurredAt", "2023-11-14T00:00:00.000Z"),
            )
            outbox.markFailed(
                requireNotNull(outbox.nextBatch(ACCOUNT_ID)),
                NativeActivityFailure.MediaUnavailable,
            )
            recorder.discardFailedActivity()

            assertEquals(NativeActivitySync.Synced, recorder.activitySync().sync)
            assertEquals(
                NativeActivitySync.Failed(1),
                outbox.sync(foreignAccountId, NativeActivityCapture.Idle).sync,
            )
            recorder.close()
        }

    @Test
    fun `durable Activity pause closes capture and survives recorder recreation`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            val outbox = InMemoryActivityOutbox()
            var elapsed = 0L
            val first = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(elapsed) },
                elapsed = { elapsed },
                activityOutbox = outbox,
            )
            first.install(SESSION_ID, descriptor(), Presence.Absent)
            first.onPlayingChanged(true)
            elapsed = 1_000

            first.setActivityPaused(true)
            settle()

            assertEquals(1, transport.activityBodies.size)
            assertEquals(NativeActivityCapture.Paused, first.activitySync().capture)
            assertTrue(outbox.isPaused(ACCOUNT_ID))
            elapsed = 2_000
            first.flush()
            settle()
            assertEquals(1, transport.activityBodies.size)
            first.close()

            val recovered = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(elapsed) },
                elapsed = { elapsed },
                activityOutbox = outbox,
            )
            assertEquals(NativeActivityCapture.Paused, recovered.activitySync().capture)
            recovered.install(SESSION_ID_B, descriptor(), Presence.Absent)
            recovered.onPlayingChanged(true)
            assertEquals(NativeActivityCapture.Paused, recovered.activitySync().capture)

            recovered.setActivityPaused(false)
            assertEquals(NativeActivityCapture.Recording, recovered.activitySync().capture)
            elapsed = 3_000
            recovered.setActivityPaused(true)
            settle()
            assertEquals(2, transport.activityBodies.size)
            recovered.close()
        }

    @Test
    fun `manual seek splits Listening activity at source-time endpoints`() =
        runBlocking {
            val transport = FakeOriginTransport()
            transport.putResponse = { heartbeatSuccess(it, writeRevision = 2) }
            var elapsed = 0L
            var position = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(position) },
                elapsed = { elapsed },
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.0),
            )
            recorder.onPlayingChanged(true)

            elapsed = 1_000
            position = 1_000
            recorder.beforeManualDiscontinuity()
            settle()
            position = 5_000
            recorder.afterManualDiscontinuity()
            elapsed = 2_000
            position = 6_000
            recorder.onPlayingChanged(false)
            settle()

            assertEquals(2, transport.activityBodies.size)
            assertActivityEndpoints(transport.activityBodies[0], 0, 1_000)
            assertActivityEndpoints(transport.activityBodies[1], 5_000, 6_000)
            recorder.discardPending()
            recorder.close()
        }

    @Test
    fun `reset adoption closes activity and does not bridge reset position`() =
        runBlocking {
            val transport = FakeOriginTransport()
            var elapsed = 0L
            var position = 0L
            val recorder = recorder(
                CoroutineScope(coroutineContext),
                transport,
                read = { sample(position) },
                elapsed = { elapsed },
            )
            recorder.install(
                SESSION_ID,
                descriptor(),
                Presence.Present(1.0),
            )
            recorder.onPlayingChanged(true)
            elapsed = 1_000
            position = 1_000

            recorder.adoptListeningState(
                listeningState(
                    writeRevision = 2,
                    resetEpoch = 2,
                    positionMs = 0,
                )
            )
            position = 0
            recorder.onPlayingChanged(false)
            settle()

            assertEquals(1, transport.activityBodies.size)
            assertActivityEndpoints(transport.activityBodies.single(), 0, 1_000)
            recorder.discardPending()
            recorder.close()
        }

    private fun recorder(
        scope: CoroutineScope,
        transport: FakeOriginTransport,
        read: () -> RecorderPlaybackSample,
        adopted: (ListeningState) -> Unit = {},
        elapsed: () -> Long = { 0 },
        persistence: (PlayerPersistence) -> Unit = {},
        cadenceDelay: suspend (Long) -> Unit = { delay(it) },
        activityOutbox: ActivityOutbox = InMemoryActivityOutbox(),
    ): NativeConsumptionRecorder =
        NativeConsumptionRecorder(
            context = null,
            scope = scope,
            client = transport,
            activityOutbox = activityOutbox,
            readPlayback = read,
            onListeningStateAccepted = {},
            onListeningStateAdopted = adopted,
            onPersistenceChanged = persistence,
            onActivitySyncChanged = {},
            elapsedNow = elapsed,
            wallNow = { 1_700_000_000_000 },
            retryDelay = {},
            cadenceDelay = cadenceDelay,
        ).also { it.openActivityOutbox(ACCOUNT_ID) }

    private suspend fun settle(times: Int = 12) {
        repeat(times) { yield() }
    }

    private fun sample(positionMs: Long): RecorderPlaybackSample =
        RecorderPlaybackSample(
            positionMs,
            Presence.Present(10_000),
        )

    private fun assertActivityEndpoints(
        raw: String,
        expectedStartMs: Long,
        expectedEndMs: Long,
    ) {
        val span = JSONObject(raw)
            .getJSONObject("batch")
            .getJSONArray("spans")
            .getJSONObject(0)
        assertEquals(
            expectedStartMs,
            span.getJSONObject("mediaPositionStartMs").getLong("value"),
        )
        assertEquals(
            expectedEndMs,
            span.getJSONObject("mediaPositionEndMs").getLong("value"),
        )
    }

    private fun activityCaptureKey(raw: String): String = JSONObject(raw)
        .getJSONObject("batch")
        .getJSONArray("spans")
        .getJSONObject(0)
        .getString("captureKey")

    private fun errorEnvelope(code: String): String = JSONObject()
        .put(
            "error",
            JSONObject()
                .put("code", code)
                .put("message", "classified test response"),
        )
        .toString()

    private fun descriptor(): CanonicalDescriptor =
        CanonicalDescriptor(
            mediaId = MEDIA_ID,
            title = "Episode",
            subtitle = Presence.Absent,
            streamUrl = "https://audio.example/episode.mp3",
            sourceUrl = "https://podcast.example/episode",
            positionMs = 0,
            writeRevision = 1,
            resetEpoch = 1,
            playbackRate = PlaybackRateResolution(
                1.0,
                PlaybackRateResolution.Source.Episode,
                Presence.Absent,
            ),
            pauseShorteningMode = Presence.Absent,
            consumptionOverrideRevision = Presence.Absent,
            durationMs = Presence.Present(10_000),
            artworkUrl = Presence.Absent,
            chapters = emptyList(),
        )

    private fun listeningState(
        writeRevision: Long,
        resetEpoch: Long,
        positionMs: Long = 1_000,
    ): ListeningState =
        ListeningState(
            positionMs = positionMs,
            durationMs = Presence.Present(10_000),
            episodePlaybackRate = Presence.Present(1.0),
            writeRevision = writeRevision,
            resetEpoch = resetEpoch,
        )

    private fun heartbeatSuccess(
        requestRaw: String,
        writeRevision: Long,
        resetEpoch: Long = 1,
        positionMs: Long = 1_000,
    ): NexusOriginResponse {
        val request = JSONObject(requestRaw)
        val data = listeningStateJson(
            writeRevision,
            resetEpoch,
            positionMs,
        )
        return NexusOriginResponse(
            200,
            JSONObject()
                .put(
                    "data",
                    JSONObject()
                        .put("listeningState", data)
                        .put(
                            "heartbeatGeneration",
                            request.getString("heartbeatGeneration"),
                        )
                        .put(
                            "heartbeatSequence",
                            request.getLong("heartbeatSequence"),
                        ),
                )
                .toString(),
        )
    }

    private fun listeningEnvelope(
        writeRevision: Long,
        resetEpoch: Long,
        positionMs: Long,
    ): NexusOriginResponse =
        NexusOriginResponse(
            200,
            JSONObject()
                .put(
                    "data",
                    listeningStateJson(writeRevision, resetEpoch, positionMs),
                )
                .toString(),
        )

    private fun listeningStateJson(
        writeRevision: Long,
        resetEpoch: Long,
        positionMs: Long,
    ): JSONObject =
        JSONObject()
            .put("positionMs", positionMs)
            .put(
                "durationMs",
                JSONObject().put("kind", "Present").put("value", 10_000),
            )
            .put(
                "episodePlaybackRate",
                JSONObject().put("kind", "Present").put("value", 1.0),
            )
            .put("writeRevision", writeRevision)
            .put("resetEpoch", resetEpoch)

    private class FakeOriginTransport : NexusOriginTransport {
        val putBodies = mutableListOf<String>()
        val activityBodies = mutableListOf<String>()
        var lastPutBody = ""
        var putResponse: suspend (String) -> NexusOriginResponse = {
            error("unexpected PUT")
        }
        var getResponse: suspend () -> NexusOriginResponse = {
            error("unexpected GET")
        }
        var activityResponse: suspend (String) -> NexusOriginResponse = {
            NexusOriginResponse(204, "")
        }

        override suspend fun getListeningState(mediaId: UUID): NexusOriginResponse =
            getResponse()

        override suspend fun putListeningState(
            mediaId: UUID,
            jsonBody: String,
        ): NexusOriginResponse {
            putBodies += jsonBody
            lastPutBody = jsonBody
            return putResponse(jsonBody)
        }

        override suspend fun postListeningActivity(
            jsonBody: String,
        ): NexusOriginResponse {
            activityBodies += jsonBody
            return activityResponse(jsonBody)
        }
    }

    private class InMemoryActivityOutbox(
        private val maxSpans: Int = NATIVE_ACTIVITY_OUTBOX_MAX_SPANS,
    ) : ActivityOutbox {
        private data class Row(
            val accountId: UUID,
            val mediaId: UUID,
            val captureKey: UUID,
            val span: JSONObject,
            var failure: NativeActivityFailure? = null,
        )

        private val rows = mutableListOf<Row>()
        private val acceptedRevisions = mutableMapOf<UUID, Long>()
        private val pausedAccounts = mutableSetOf<UUID>()
        val failureReasons: List<NativeActivityFailure>
            get() = rows.mapNotNull(Row::failure)

        override fun enqueue(
            accountId: UUID,
            mediaId: UUID,
            span: JSONObject,
        ): NativeActivityEnqueueResult {
            if (rows.count { it.accountId == accountId } >= maxSpans) {
                return NativeActivityEnqueueResult.CapacityReached
            }
            rows += Row(accountId, mediaId, UUID.randomUUID(), JSONObject(span.toString()))
            return NativeActivityEnqueueResult.Enqueued
        }

        override fun expireBefore(accountId: UUID, cutoff: Instant) {
            rows.filter {
                it.accountId == accountId &&
                    it.failure == null &&
                    Instant.parse(it.span.getString("occurredAt")) < cutoff
            }.forEach { it.failure = NativeActivityFailure.Expired }
        }

        override fun nextBatch(accountId: UUID): NativeActivityUploadBatch? {
            val first = rows.firstOrNull {
                it.accountId == accountId && it.failure == null
            } ?: return null
            val selected = rows.filter {
                it.accountId == accountId &&
                    it.mediaId == first.mediaId &&
                    it.failure == null
            }.take(120)
            val spans = JSONArray()
            selected.forEach { row ->
                spans.put(JSONObject(row.span.toString()).put("captureKey", row.captureKey.toString()))
            }
            return NativeActivityUploadBatch(
                accountId,
                first.mediaId,
                selected.map(Row::captureKey),
                JSONObject()
                    .put("clientMutationId", UUID.randomUUID().toString())
                    .put("mediaRef", "media:${first.mediaId}")
                    .put("deviceClass", "Mobile")
                    .put("batch", JSONObject().put("modality", "Listening").put("spans", spans))
                    .toString(),
            )
        }

        override fun acknowledge(batch: NativeActivityUploadBatch) {
            rows.removeAll {
                it.accountId == batch.accountId &&
                    it.captureKey in batch.captureKeys &&
                    it.failure == null
            }
            acceptedRevisions[batch.accountId] = Math.addExact(
                acceptedRevisions[batch.accountId] ?: 0,
                1,
            )
        }

        override fun markFailed(batch: NativeActivityUploadBatch, failure: NativeActivityFailure) {
            rows.filter {
                it.accountId == batch.accountId &&
                    it.captureKey in batch.captureKeys &&
                    it.failure == null
            }.forEach { it.failure = failure }
        }

        override fun retryFailed(accountId: UUID) {
            rows.filter { it.accountId == accountId }.forEach { it.failure = null }
        }

        override fun discardFailed(accountId: UUID) {
            rows.removeAll { it.accountId == accountId && it.failure != null }
        }

        override fun setPaused(accountId: UUID, paused: Boolean) {
            if (paused) pausedAccounts += accountId else pausedAccounts -= accountId
        }

        override fun isPaused(accountId: UUID): Boolean = accountId in pausedAccounts

        override fun sync(
            accountId: UUID,
            capture: NativeActivityCapture,
        ): NativeActivitySyncSnapshot {
            val accountRows = rows.filter { it.accountId == accountId }
            val failed = accountRows.count { it.failure != null }
            val pending = accountRows.size - failed
            return NativeActivitySyncSnapshot(
                capture,
                when {
                    failed > 0 -> NativeActivitySync.Failed(failed)
                    pending > 0 ->
                        NativeActivitySync.Pending(pending, "2023-11-14T22:13:20Z")
                    else -> NativeActivitySync.Synced
                },
                acceptedRevisions[accountId] ?: 0,
            )
        }
    }

    private companion object {
        val SESSION_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000001")
        val SESSION_ID_B: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000003")
        val MEDIA_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000002")
        val MEDIA_ID_B: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000004")
        val ACCOUNT_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000005")
    }
}
