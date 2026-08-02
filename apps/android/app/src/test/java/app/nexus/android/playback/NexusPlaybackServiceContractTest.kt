package app.nexus.android.playback

import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionParameters
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NexusPlaybackServiceContractTest {
    @Test
    fun `pause shortening install is ordered safely and reports failure`() {
        val naturalCalls = mutableListOf<String>()
        assertTrue(
            installPauseShorteningMode(
                natural = true,
                installOffloadPreference = {
                    naturalCalls += "offload:$it"
                },
                setSkipSilenceEnabled = {
                    naturalCalls += "skip:$it"
                },
                skipSilenceEnabled = { true },
            )
        )
        assertEquals(listOf("offload:true", "skip:true"), naturalCalls)

        val offCalls = mutableListOf<String>()
        assertTrue(
            installPauseShorteningMode(
                natural = false,
                installOffloadPreference = {
                    offCalls += "offload:$it"
                },
                setSkipSilenceEnabled = {
                    offCalls += "skip:$it"
                },
                skipSilenceEnabled = { false },
            )
        )
        assertEquals(listOf("skip:false", "offload:false"), offCalls)

        assertFalse(
            installPauseShorteningMode(
                natural = true,
                installOffloadPreference = {},
                setSkipSilenceEnabled = {},
                skipSilenceEnabled = { false },
            )
        )
        assertFalse(
            installPauseShorteningMode(
                natural = true,
                installOffloadPreference = {
                    throw IllegalStateException("processor unavailable")
                },
                setSkipSilenceEnabled = {},
                skipSilenceEnabled = { true },
            )
        )
    }

    @Test
    fun `pause shortening resolves session then podcast then device`() {
        assertEquals(
            PauseShorteningMode.Off to PauseShorteningProvenance.Session,
            resolvePauseShortening(
                deviceDefault = PauseShorteningMode.Natural,
                podcastOverride = Presence.Present(PauseShorteningMode.Natural),
                sessionOverride = Presence.Present(PauseShorteningMode.Off),
            ),
        )
        assertEquals(
            PauseShorteningMode.Natural to PauseShorteningProvenance.Podcast,
            resolvePauseShortening(
                deviceDefault = PauseShorteningMode.Off,
                podcastOverride = Presence.Present(PauseShorteningMode.Natural),
                sessionOverride = Presence.Absent,
            ),
        )
        assertEquals(
            PauseShorteningMode.Natural to PauseShorteningProvenance.Device,
            resolvePauseShortening(
                deviceDefault = PauseShorteningMode.Natural,
                podcastOverride = Presence.Absent,
                sessionOverride = Presence.Absent,
            ),
        )
    }

    @Test
    fun `real discontinuities split activity but silence skip does not`() {
        assertTrue(
            activityDiscontinuityRequiresSplit(
                Player.DISCONTINUITY_REASON_SEEK
            )
        )
        assertFalse(
            activityDiscontinuityRequiresSplit(
                Player.DISCONTINUITY_REASON_SILENCE_SKIP
            )
        )
    }

    @Test
    fun `Natural requires PCM while Off permits speed-capable offload`() {
        val natural = audioOffloadPreferences(naturalPauseShortening = true)
        val off = audioOffloadPreferences(naturalPauseShortening = false)

        assertEquals(
            TrackSelectionParameters.AudioOffloadPreferences
                .AUDIO_OFFLOAD_MODE_DISABLED,
            natural.audioOffloadMode,
        )
        assertEquals(
            TrackSelectionParameters.AudioOffloadPreferences
                .AUDIO_OFFLOAD_MODE_ENABLED,
            off.audioOffloadMode,
        )
        assertTrue(off.isSpeedChangeSupportRequired)
    }

    @Test
    fun `Nexus custom protocol is granted only to the app controller`() {
        assertTrue(
            isTrustedNexusController(
                "app.nexus.android.debug",
                "app.nexus.android.debug",
            )
        )
        assertFalse(
            isTrustedNexusController(
                "app.nexus.android.debug",
                "com.example.controller",
            )
        )
    }

    @Test
    fun `custom commands exclude standard transport operations`() {
        assertEquals(
            setOf(
                "Connect",
                "GetSnapshot",
                "LoadCanonical",
                "LoadPreview",
                "SetPlaybackRateState",
                "SetSessionPauseShorteningMode",
                "ClearSessionPauseShorteningMode",
                "SetDeviceDefaultPauseShorteningMode",
                "InstallPodcastPlaybackSettings",
                "Drain",
                "AdoptListeningState",
                "RetryPersistence",
                "Dismiss",
                "AcknowledgeNaturalEnd",
            ).mapTo(linkedSetOf()) { "app.nexus.Player.$it" },
            NEXUS_CUSTOM_SESSION_ACTIONS,
        )
        setOf("Play", "Pause", "SeekTo", "SkipBy", "SetVolume").forEach {
            assertFalse(
                NEXUS_CUSTOM_SESSION_ACTIONS.contains("app.nexus.Player.$it")
            )
        }
    }

    @Test
    fun `standard player commands cannot replace the public HTTPS media item`() {
        assertTrue(NEXUS_PLAYER_COMMAND_IDS.contains(Player.COMMAND_PLAY_PAUSE))
        assertTrue(
            NEXUS_PLAYER_COMMAND_IDS.contains(
                Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM
            )
        )
        assertTrue(NEXUS_PLAYER_COMMAND_IDS.contains(Player.COMMAND_SET_VOLUME))

        assertFalse(NEXUS_PLAYER_COMMAND_IDS.contains(Player.COMMAND_SET_MEDIA_ITEM))
        assertFalse(
            NEXUS_PLAYER_COMMAND_IDS.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS)
        )
        assertFalse(
            NEXUS_PLAYER_COMMAND_IDS.contains(Player.COMMAND_SET_SPEED_AND_PITCH)
        )
    }

    @Test
    fun `controller capabilities enforce the natural end lifecycle barrier`() {
        val captureCommands = availableNexusPlayerCommandIds(
            naturalEndCapturePending = true,
            pendingNaturalEnd = false,
            persistenceDrained = false,
        )
        assertFalse(captureCommands.contains(Player.COMMAND_STOP))
        assertFalse(captureCommands.contains(Player.COMMAND_PLAY_PAUSE))
        assertTrue(captureCommands.contains(Player.COMMAND_SET_VOLUME))

        val pendingReceiptCommands = availableNexusPlayerCommandIds(
            naturalEndCapturePending = false,
            pendingNaturalEnd = true,
            persistenceDrained = false,
        )
        assertTrue(pendingReceiptCommands.contains(Player.COMMAND_STOP))
        assertFalse(pendingReceiptCommands.contains(Player.COMMAND_PLAY_PAUSE))
        assertFalse(
            pendingReceiptCommands.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
        )
    }

    @Test
    fun `drain blocks mutations but preserves teardown and read capabilities`() {
        val drainedCommands = availableNexusPlayerCommandIds(
            naturalEndCapturePending = false,
            pendingNaturalEnd = false,
            persistenceDrained = true,
        )

        assertTrue(drainedCommands.contains(Player.COMMAND_STOP))
        assertFalse(drainedCommands.contains(Player.COMMAND_PLAY_PAUSE))
        assertFalse(drainedCommands.contains(Player.COMMAND_SEEK_FORWARD))
        assertTrue(drainedCommands.contains(Player.COMMAND_GET_TIMELINE))
        assertTrue(drainedCommands.contains(Player.COMMAND_SET_VOLUME))
    }

    @Test
    fun `Ended is not published until the natural end receipt is durable`() {
        assertTrue(
            playerSnapshotBlockedByNaturalEnd(
                canonicalLoaded = true,
                playbackState = Player.STATE_ENDED,
                pendingNaturalEnd = false,
            )
        )
        assertFalse(
            playerSnapshotBlockedByNaturalEnd(
                canonicalLoaded = true,
                playbackState = Player.STATE_ENDED,
                pendingNaturalEnd = true,
            )
        )
        assertFalse(
            playerSnapshotBlockedByNaturalEnd(
                canonicalLoaded = false,
                playbackState = Player.STATE_ENDED,
                pendingNaturalEnd = false,
            )
        )
    }

    @Test
    fun `observed playback recovery clears only an existing failure`() {
        val failure = Presence.Present(
            PlayerFailure("SourcePlaybackFailed", "Audio could not be played.")
        )

        assertSame(
            failure,
            clearPlaybackFailureAfterObservedRecovery(failure, isPlaying = false),
        )
        assertEquals(
            Presence.Absent,
            clearPlaybackFailureAfterObservedRecovery(failure, isPlaying = true),
        )
    }
}
