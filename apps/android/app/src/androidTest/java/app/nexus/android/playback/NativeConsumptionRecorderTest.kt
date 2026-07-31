package app.nexus.android.playback

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nexus.android.RetryPolicies
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NativeConsumptionRecorderTest {
    private val instrumentation =
        InstrumentationRegistry.getInstrumentation()

    @Test
    fun networkExhaustionAndAuthFailureRemainTypedPersistenceSuspensions() {
        assertSuspension(
            putFailure = IOException("offline"),
            getResponse = { throw IOException("offline") },
            expected = PersistenceSuspension.Network,
            expectedGetCount = RetryPolicies.SAME_SYSTEM_CLIENT_RECOVERY.size,
        )
        assertSuspension(
            putResponse = NexusOriginResponse(401, ""),
            getResponse = { error("401 must not enter same-credential recovery") },
            expected = PersistenceSuspension.AuthExpired,
            expectedGetCount = 0,
        )
    }

    private fun assertSuspension(
        putFailure: IOException? = null,
        putResponse: NexusOriginResponse? = null,
        getResponse: suspend () -> NexusOriginResponse,
        expected: PersistenceSuspension,
        expectedGetCount: Int,
    ) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val suspended = CountDownLatch(1)
        var observed: PlayerPersistence = PlayerPersistence.Ready
        var getCount = 0
        val transport = object : NexusOriginTransport {
            override suspend fun getListeningState(
                mediaId: UUID,
            ): NexusOriginResponse {
                getCount += 1
                return getResponse()
            }

            override suspend fun putListeningState(
                mediaId: UUID,
                jsonBody: String,
            ): NexusOriginResponse {
                putFailure?.let { throw it }
                return checkNotNull(putResponse)
            }

            override suspend fun postListeningActivity(
                jsonBody: String,
            ): NexusOriginResponse = NexusOriginResponse(204, "")
        }
        lateinit var recorder: NativeConsumptionRecorder
        instrumentation.runOnMainSync {
            recorder = NativeConsumptionRecorder(
                context = null,
                scope = scope,
                client = transport,
                readPlayback = {
                    RecorderPlaybackSample(1_000, Presence.Present(10_000))
                },
                onListeningStateAccepted = {},
                onListeningStateAdopted = {},
                onPersistenceChanged = {
                    observed = it
                    if (
                        it is PlayerPersistence.Suspended &&
                        it.reason == expected
                    ) {
                        suspended.countDown()
                    }
                },
                retryDelay = {},
            )
            recorder.install(SESSION_ID, descriptor(), Presence.Present(1.0))
            recorder.flush()
        }
        try {
            assertTrue(
                "Expected $expected persistence suspension.",
                suspended.await(5, TimeUnit.SECONDS),
            )
            assertEquals(expectedGetCount, getCount)
            assertEquals(
                expected,
                (observed as PlayerPersistence.Suspended).reason,
            )
        } finally {
            instrumentation.runOnMainSync(recorder::close)
            scope.cancel()
        }
    }

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

    private companion object {
        val SESSION_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000001")
        val MEDIA_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000002")
    }
}
