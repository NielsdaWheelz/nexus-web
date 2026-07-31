package app.nexus.android.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class SavedTimeAccountingTest {
    @Test
    fun `admits skipped frames only against same epoch source advance`() {
        val accounting = SavedTimeAccounting(initialTotalMs = 10)
        accounting.startEpoch(
            skippedFrames = 0,
            sourcePositionMs = 1_000,
            sampleRateHz = 48_000,
            baseRate = 2.0,
            eligible = true,
        )

        assertEquals(
            250,
            accounting.checkpoint(
                skippedFrames = 24_000,
                sourcePositionMs = 1_700,
                sampleRateHz = 48_000,
                baseRate = 2.0,
                eligible = true,
            ),
        )
        assertEquals(260, accounting.totalMs)
    }

    @Test
    fun `caps processor ahead frames by positive source movement`() {
        val accounting = SavedTimeAccounting(initialTotalMs = 0)
        accounting.startEpoch(0, 0, 1_000, 1.0, true)

        assertEquals(
            200,
            accounting.checkpoint(
                skippedFrames = 900,
                sourcePositionMs = 200,
                sampleRateHz = 1_000,
                baseRate = 1.0,
                eligible = true,
            ),
        )
    }

    @Test
    fun `off preview rollback and format or rate boundaries count nothing`() {
        val accounting = SavedTimeAccounting(initialTotalMs = 0)
        accounting.startEpoch(100, 100, 1_000, 1.0, false)
        assertEquals(0, accounting.checkpoint(200, 200, 1_000, 1.0, false))

        accounting.startEpoch(200, 200, 1_000, 1.0, true)
        assertEquals(0, accounting.checkpoint(150, 400, 1_000, 1.0, true))
        assertEquals(0, accounting.checkpoint(250, 500, 48_000, 1.0, true))
        assertEquals(0, accounting.checkpoint(350, 600, 48_000, 1.5, true))
        assertEquals(0, accounting.totalMs)
    }

    @Test
    fun `nonpositive source movement discards ambiguous processor work`() {
        val accounting = SavedTimeAccounting(initialTotalMs = 5)
        accounting.startEpoch(0, 1_000, 1_000, 1.0, true)
        assertEquals(0, accounting.checkpoint(500, 1_000, 1_000, 1.0, true))
        assertEquals(0, accounting.checkpoint(700, 900, 1_000, 1.0, true))
        assertEquals(5, accounting.totalMs)
    }
}
