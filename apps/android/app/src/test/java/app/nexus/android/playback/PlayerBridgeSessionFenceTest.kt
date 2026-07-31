package app.nexus.android.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class PlayerBridgeSessionFenceTest {
    @Test
    fun `stale snapshot event cannot roll command fence back after load B`() {
        val fence = PlayerBridgeSessionFence()
        fence.acceptedLoad(SESSION_B)

        fence.observeSnapshotEvent(SESSION_A)

        assertEquals(SESSION_B, fence.currentSessionKey)
    }

    @Test
    fun `stale natural end event after exact acknowledgement is ignored`() {
        val fence = PlayerBridgeSessionFence()
        val receipt = receipt(SESSION_A, MUTATION_A)
        fence.acceptedLoad(SESSION_A)
        fence.installPendingNaturalEnd(receipt)
        fence.acceptedAcknowledge(MUTATION_A)

        assertFalse(fence.acceptNaturalEndEvent(receipt))
        assertEquals(null, fence.pendingNaturalEndMutationId)
    }

    @Test
    fun `headless pending receipt accepts only its exact acknowledgement`() {
        val fence = PlayerBridgeSessionFence()
        fence.installSnapshot(null)
        fence.installPendingNaturalEnd(receipt(SESSION_A, MUTATION_A))

        assertTrue(
            fence.acceptsSessionCommand(
                PlayerCommand.AcknowledgeNaturalEnd(
                    requestId = REQUEST_ID,
                    sessionKey = SESSION_A,
                    clientMutationId = MUTATION_A,
                )
            )
        )
        assertFalse(
            fence.acceptsSessionCommand(
                PlayerCommand.AcknowledgeNaturalEnd(
                    requestId = REQUEST_ID,
                    sessionKey = SESSION_B,
                    clientMutationId = MUTATION_A,
                )
            )
        )
    }

    @Test
    fun `controller reconnect replaces stale active session with authoritative Absent`() {
        val fence = PlayerBridgeSessionFence()
        fence.acceptedLoad(SESSION_B)
        val pending = receipt(SESSION_A, MUTATION_A)

        fence.installControllerReconnect(
            sessionKey = null,
            receipt = pending,
        )

        assertEquals(null, fence.currentSessionKey)
        assertEquals(SESSION_A, fence.pendingNaturalEndSessionKey)
        assertEquals(MUTATION_A, fence.pendingNaturalEndMutationId)
    }

    private fun receipt(
        sessionKey: UUID,
        mutationId: UUID,
    ): PendingNaturalEnd =
        PendingNaturalEnd(
            accountId = ACCOUNT_ID,
            sessionKey = sessionKey,
            mediaId = MEDIA_ID,
            origin = PlayerOrigin.Direct,
            clientMutationId = mutationId,
            terminalListening = TerminalListening(
                positionMs = 10,
                durationMs = Presence.Present(10),
                episodePlaybackRate = Presence.Absent,
                expectedWriteRevision = 1,
                expectedResetEpoch = 1,
            ),
            expectedConsumptionOverrideRevision = Presence.Absent,
        )

    private companion object {
        val ACCOUNT_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000001")
        val SESSION_A: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000002")
        val SESSION_B: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000003")
        val MEDIA_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000004")
        val MUTATION_A: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000005")
        val REQUEST_ID: UUID =
            UUID.fromString("00000000-0000-4000-8000-000000000006")
    }
}
