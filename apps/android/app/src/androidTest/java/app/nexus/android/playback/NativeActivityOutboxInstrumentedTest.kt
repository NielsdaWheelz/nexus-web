package app.nexus.android.playback

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class NativeActivityOutboxInstrumentedTest {
    @Test
    fun committedSpanSurvivesStoreRecreationAndReplaysItsOriginalCaptureKey() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "activity-outbox-${UUID.randomUUID()}.db"
        val accountId = UUID.randomUUID()
        val mediaId = UUID.randomUUID()
        val first = NativeActivityOutbox(context, databaseName)
        assertEquals(
            NativeActivityEnqueueResult.Enqueued,
            first.enqueue(accountId, mediaId, span()),
        )
        val firstBatch = requireNotNull(first.nextBatch(accountId))
        first.close()

        val recovered = NativeActivityOutbox(context, databaseName)
        val replay = requireNotNull(recovered.nextBatch(accountId))
        assertEquals(firstBatch.captureKeys, replay.captureKeys)
        assertNotNull(JSONObject(replay.body).getString("clientMutationId"))
        assertNull(recovered.nextBatch(UUID.randomUUID()))
        recovered.acknowledge(replay)
        assertEquals(NativeActivitySync.Synced, recovered.sync(accountId, NativeActivityCapture.Idle).sync)
        assertEquals(1L, recovered.sync(accountId, NativeActivityCapture.Idle).acceptedRevision)
        recovered.setPaused(accountId, true)
        recovered.close()

        val afterProcessRecreation = NativeActivityOutbox(context, databaseName)
        assertEquals(
            1L,
            afterProcessRecreation.sync(accountId, NativeActivityCapture.Idle).acceptedRevision,
        )
        assertEquals(true, afterProcessRecreation.isPaused(accountId))
        afterProcessRecreation.close()
        assertEquals(true, context.deleteDatabase(databaseName))
    }

    @Test
    fun versionOneUpgradePreservesAPendingRowAndBackfillsItsOccurrenceInstant() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val databaseName = "activity-outbox-v1-${UUID.randomUUID()}.db"
        val accountId = UUID.randomUUID()
        val mediaId = UUID.randomUUID()
        val captureKey = UUID.randomUUID()
        val legacy = object : SQLiteOpenHelper(context, databaseName, null, 1) {
            override fun onCreate(database: SQLiteDatabase) {
                database.execSQL(
                    """
                    CREATE TABLE activity_outbox (
                      account_id TEXT NOT NULL,
                      capture_key TEXT NOT NULL,
                      media_ref TEXT NOT NULL,
                      modality TEXT NOT NULL,
                      device_class TEXT NOT NULL,
                      span_json TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      state TEXT NOT NULL,
                      PRIMARY KEY (account_id, capture_key)
                    )
                    """.trimIndent(),
                )
                database.execSQL(
                    "CREATE INDEX activity_outbox_account_state_created " +
                        "ON activity_outbox (account_id, state, created_at)"
                )
            }

            override fun onUpgrade(
                database: SQLiteDatabase,
                oldVersion: Int,
                newVersion: Int,
            ) = error("unexpected test upgrade")
        }
        legacy.writableDatabase.insertOrThrow(
            "activity_outbox",
            null,
            ContentValues().apply {
                put("account_id", accountId.toString())
                put("capture_key", captureKey.toString())
                put("media_ref", "media:$mediaId")
                put("modality", "Listening")
                put("device_class", "Mobile")
                put("span_json", span().put("captureKey", captureKey.toString()).toString())
                put("created_at", "2026-08-10T00:00:01.000Z")
                put("state", "Pending")
            },
        )
        legacy.close()

        val upgraded = NativeActivityOutbox(context, databaseName)
        val replay = requireNotNull(upgraded.nextBatch(accountId))
        assertEquals(listOf(captureKey), replay.captureKeys)
        assertEquals(
            "2026-08-10T00:00:00.000Z",
            JSONObject(replay.body)
                .getJSONObject("batch")
                .getJSONArray("spans")
                .getJSONObject(0)
                .getString("occurredAt"),
        )
        assertEquals(0L, upgraded.sync(accountId, NativeActivityCapture.Idle).acceptedRevision)
        upgraded.close()
        assertEquals(true, context.deleteDatabase(databaseName))
    }

    private fun span(): JSONObject = JSONObject()
        .put("occurredAt", "2026-08-10T00:00:00.000Z")
        .put("durationMs", 10_000)
        .put("progressStart", JSONObject().put("kind", "Absent"))
        .put("progressEnd", JSONObject().put("kind", "Absent"))
        .put(
            "mediaPositionStartMs",
            JSONObject().put("kind", "Present").put("value", 0),
        )
        .put(
            "mediaPositionEndMs",
            JSONObject().put("kind", "Present").put("value", 10_000),
        )
}
