package app.nexus.android.playback

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

internal const val NATIVE_ACTIVITY_OUTBOX_MAX_SPANS = 100_000
internal const val NATIVE_ACTIVITY_MAX_AGE_MS = 30L * 24 * 60 * 60 * 1_000
private const val NATIVE_ACTIVITY_BATCH_LIMIT = 120
private const val NATIVE_ACTIVITY_BATCH_MAX_BYTES = 48_000
private val NATIVE_ACTIVITY_INSTANT: DateTimeFormatter =
    DateTimeFormatterBuilder().appendInstant(3).toFormatter()

internal sealed interface NativeActivityCapture {
    data object Recording : NativeActivityCapture
    data object Idle : NativeActivityCapture
    data object Paused : NativeActivityCapture

    data class Blocked(val reason: Reason) : NativeActivityCapture {
        enum class Reason { StorageUnavailable, CapacityReached }
    }
}

internal sealed interface NativeActivitySync {
    data object Synced : NativeActivitySync
    data class Pending(val count: Int, val oldestAt: String) : NativeActivitySync
    data class Failed(val count: Int) : NativeActivitySync
}

internal data class NativeActivitySyncSnapshot(
    val capture: NativeActivityCapture,
    val sync: NativeActivitySync,
    val acceptedRevision: Long = 0,
)

internal data class NativeActivityUploadBatch(
    val accountId: UUID,
    val mediaId: UUID,
    val captureKeys: List<UUID>,
    val body: String,
)

internal enum class NativeActivityFailure {
    MediaUnavailable,
    Expired,
    Defect,
}

internal sealed interface NativeActivityEnqueueResult {
    data object Enqueued : NativeActivityEnqueueResult
    data object CapacityReached : NativeActivityEnqueueResult
}

internal interface ActivityOutbox {
    fun enqueue(accountId: UUID, mediaId: UUID, span: JSONObject): NativeActivityEnqueueResult
    fun expireBefore(accountId: UUID, cutoff: Instant)
    fun nextBatch(accountId: UUID): NativeActivityUploadBatch?
    fun acknowledge(batch: NativeActivityUploadBatch)
    fun markFailed(batch: NativeActivityUploadBatch, failure: NativeActivityFailure)
    fun retryFailed(accountId: UUID)
    fun discardFailed(accountId: UUID)
    fun setPaused(accountId: UUID, paused: Boolean)
    fun isPaused(accountId: UUID): Boolean
    fun sync(accountId: UUID, capture: NativeActivityCapture): NativeActivitySyncSnapshot
}

/**
 * Consumption-owned SQLite outbox. The playback service is its sole caller,
 * so the service coroutine remains the serialization boundary for both row
 * mutation and delivery. This store deliberately has no memory fallback.
 */
internal class NativeActivityOutbox(
    context: Context,
    databaseName: String = DATABASE_NAME,
) : SQLiteOpenHelper(context, databaseName, null, DATABASE_VERSION), ActivityOutbox {
    override fun enqueue(
        accountId: UUID,
        mediaId: UUID,
        span: JSONObject,
    ): NativeActivityEnqueueResult {
        val database = writableDatabase
        database.beginTransaction()
        try {
            if (count(database, accountId) >= NATIVE_ACTIVITY_OUTBOX_MAX_SPANS) {
                return NativeActivityEnqueueResult.CapacityReached
            }
            val captureKey = UUID.randomUUID()
            val durableSpan = JSONObject(span.toString())
                .put("captureKey", captureKey.toString())
            val occurredAt = canonicalActivityInstant(durableSpan.getString("occurredAt"))
            database.insertOrThrow(
                TABLE,
                null,
                ContentValues().apply {
                    put("account_id", accountId.toString())
                    put("capture_key", captureKey.toString())
                    put("media_ref", "media:$mediaId")
                    put("modality", "Listening")
                    put("device_class", "Mobile")
                    put("span_json", durableSpan.toString())
                    put("occurred_at", occurredAt)
                    put("created_at", DateTimeFormatter.ISO_INSTANT.format(Instant.now()))
                    put("state", STATE_PENDING)
                },
            )
            database.setTransactionSuccessful()
            return NativeActivityEnqueueResult.Enqueued
        } finally {
            database.endTransaction()
        }
    }

    override fun expireBefore(accountId: UUID, cutoff: Instant) {
        writableDatabase.update(
            TABLE,
            ContentValues().apply { put("state", STATE_FAILED_EXPIRED) },
            "account_id = ? AND state = ? AND occurred_at < ?",
            arrayOf(
                accountId.toString(),
                STATE_PENDING,
                NATIVE_ACTIVITY_INSTANT.format(cutoff),
            ),
        )
    }

    override fun nextBatch(accountId: UUID): NativeActivityUploadBatch? {
        val database = readableDatabase
        database.query(
            TABLE,
            arrayOf("media_ref"),
            "account_id = ? AND state = ?",
            arrayOf(accountId.toString(), STATE_PENDING),
            null,
            null,
            "created_at ASC",
            "1",
        ).use { first ->
            if (!first.moveToFirst()) return null
            val mediaRef = first.getString(0)
            val mediaId = UUID.fromString(mediaRef.removePrefix("media:"))
            val spans = JSONArray()
            val keys = mutableListOf<UUID>()
            database.query(
                TABLE,
                arrayOf("capture_key", "span_json"),
                "account_id = ? AND state = ? AND media_ref = ?",
                arrayOf(accountId.toString(), STATE_PENDING, mediaRef),
                null,
                null,
                "created_at ASC",
                NATIVE_ACTIVITY_BATCH_LIMIT.toString(),
            ).use { rows ->
                while (rows.moveToNext()) {
                    val candidate = JSONObject(rows.getString(1))
                    val trial = JSONArray(spans.toString()).put(candidate)
                    val body = uploadBody(mediaRef, trial)
                    if (body.toByteArray(Charsets.UTF_8).size > NATIVE_ACTIVITY_BATCH_MAX_BYTES) {
                        break
                    }
                    spans.put(candidate)
                    keys += UUID.fromString(rows.getString(0))
                }
            }
            check(keys.isNotEmpty()) { "activity span exceeds the owned batch limit" }
            return NativeActivityUploadBatch(
                accountId = accountId,
                mediaId = mediaId,
                captureKeys = keys,
                body = uploadBody(mediaRef, spans),
            )
        }
    }

    override fun acknowledge(batch: NativeActivityUploadBatch) {
        val database = writableDatabase
        database.beginTransaction()
        try {
            batch.captureKeys.forEach { captureKey ->
                val deleted = database.delete(
                    TABLE,
                    "account_id = ? AND capture_key = ? AND state = ?",
                    arrayOf(batch.accountId.toString(), captureKey.toString(), STATE_PENDING),
                )
                check(deleted == 1) { "activity acknowledgement lost its durable row" }
            }
            incrementAcceptedRevision(database, batch.accountId)
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
    }

    override fun markFailed(batch: NativeActivityUploadBatch, failure: NativeActivityFailure) {
        val state = when (failure) {
            NativeActivityFailure.MediaUnavailable -> STATE_FAILED_MEDIA_UNAVAILABLE
            NativeActivityFailure.Expired -> STATE_FAILED_EXPIRED
            NativeActivityFailure.Defect -> STATE_FAILED_DEFECT
        }
        val database = writableDatabase
        database.beginTransaction()
        try {
            batch.captureKeys.forEach { captureKey ->
                val changed = database.update(
                    TABLE,
                    ContentValues().apply { put("state", state) },
                    "account_id = ? AND capture_key = ? AND state = ?",
                    arrayOf(batch.accountId.toString(), captureKey.toString(), STATE_PENDING),
                )
                check(changed == 1) { "activity failure lost its durable row" }
            }
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
    }

    override fun retryFailed(accountId: UUID) {
        writableDatabase.update(
            TABLE,
            ContentValues().apply { put("state", STATE_PENDING) },
            "account_id = ? AND state != ?",
            arrayOf(accountId.toString(), STATE_PENDING),
        )
    }

    override fun discardFailed(accountId: UUID) {
        writableDatabase.delete(
            TABLE,
            "account_id = ? AND state != ?",
            arrayOf(accountId.toString(), STATE_PENDING),
        )
    }

    override fun setPaused(accountId: UUID, paused: Boolean) {
        val database = writableDatabase
        val values = ContentValues().apply { put("paused", if (paused) 1 else 0) }
        val updated = database.update(
            METADATA_TABLE,
            values,
            "account_id = ?",
            arrayOf(accountId.toString()),
        )
        if (updated == 0) {
            values.put("account_id", accountId.toString())
            values.put("accepted_revision", 0)
            database.insertOrThrow(METADATA_TABLE, null, values)
        } else {
            check(updated == 1) { "activity pause account partition is not unique" }
        }
    }

    override fun isPaused(accountId: UUID): Boolean =
        readableDatabase.rawQuery(
            "SELECT paused FROM $METADATA_TABLE WHERE account_id = ?",
            arrayOf(accountId.toString()),
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                when (val paused = cursor.getInt(0)) {
                    0 -> false
                    1 -> true
                    else -> error("activity pause state is invalid: $paused")
                }
            } else {
                false
            }
        }

    override fun sync(accountId: UUID, capture: NativeActivityCapture): NativeActivitySyncSnapshot {
        val database = readableDatabase
        database.query(
            TABLE,
            arrayOf("state", "created_at"),
            "account_id = ?",
            arrayOf(accountId.toString()),
            null,
            null,
            "created_at ASC",
        ).use { rows ->
            var pending = 0
            var failed = 0
            var oldestPending: String? = null
            while (rows.moveToNext()) {
                if (rows.getString(0) == STATE_PENDING) {
                    pending += 1
                    if (oldestPending == null) oldestPending = rows.getString(1)
                } else {
                    failed += 1
                }
            }
            val sync = when {
                failed > 0 -> NativeActivitySync.Failed(failed)
                pending > 0 -> NativeActivitySync.Pending(pending, checkNotNull(oldestPending))
                else -> NativeActivitySync.Synced
            }
            return NativeActivitySyncSnapshot(
                capture,
                sync,
                acceptedRevision(database, accountId),
            )
        }
    }

    override fun onCreate(database: SQLiteDatabase) {
        createSchema(database)
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        require(oldVersion == 1 && newVersion == DATABASE_VERSION)
        database.execSQL("ALTER TABLE $TABLE RENAME TO ${TABLE}_v1")
        createTable(database)
        database.query(
            "${TABLE}_v1",
            arrayOf(
                "account_id",
                "capture_key",
                "media_ref",
                "modality",
                "device_class",
                "span_json",
                "created_at",
                "state",
            ),
            null,
            null,
            null,
            null,
            null,
        ).use { rows ->
            while (rows.moveToNext()) {
                val spanJson = rows.getString(5)
                val occurredAt = canonicalActivityInstant(
                    JSONObject(spanJson).getString("occurredAt")
                )
                database.insertOrThrow(
                    TABLE,
                    null,
                    ContentValues().apply {
                        put("account_id", rows.getString(0))
                        put("capture_key", rows.getString(1))
                        put("media_ref", rows.getString(2))
                        put("modality", rows.getString(3))
                        put("device_class", rows.getString(4))
                        put("span_json", spanJson)
                        put("occurred_at", occurredAt)
                        put("created_at", rows.getString(6))
                        put("state", rows.getString(7))
                    },
                )
            }
        }
        database.execSQL("DROP TABLE ${TABLE}_v1")
        createIndex(database)
        createMetadataTable(database)
    }

    private fun createSchema(database: SQLiteDatabase) {
        createTable(database)
        createIndex(database)
        createMetadataTable(database)
    }

    private fun createTable(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE $TABLE (
              account_id TEXT NOT NULL,
              capture_key TEXT NOT NULL,
              media_ref TEXT NOT NULL,
              modality TEXT NOT NULL,
              device_class TEXT NOT NULL,
              span_json TEXT NOT NULL,
              occurred_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              state TEXT NOT NULL,
              PRIMARY KEY (account_id, capture_key)
            )
            """.trimIndent(),
        )
    }

    private fun createIndex(database: SQLiteDatabase) {
        database.execSQL(
            "CREATE INDEX activity_outbox_account_state_created ON $TABLE (account_id, state, created_at)"
        )
    }

    private fun createMetadataTable(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE $METADATA_TABLE (
              account_id TEXT NOT NULL PRIMARY KEY,
              accepted_revision INTEGER NOT NULL CHECK (accepted_revision >= 0),
              paused INTEGER NOT NULL CHECK (paused IN (0, 1))
            )
            """.trimIndent(),
        )
    }

    private fun count(database: SQLiteDatabase, accountId: UUID): Int =
        database.rawQuery(
            "SELECT COUNT(*) FROM $TABLE WHERE account_id = ?",
            arrayOf(accountId.toString()),
        ).use { cursor ->
            check(cursor.moveToFirst())
            cursor.getInt(0)
        }

    private fun acceptedRevision(database: SQLiteDatabase, accountId: UUID): Long =
        database.rawQuery(
            "SELECT accepted_revision FROM $METADATA_TABLE WHERE account_id = ?",
            arrayOf(accountId.toString()),
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getLong(0) else 0L
        }

    private fun incrementAcceptedRevision(database: SQLiteDatabase, accountId: UUID) {
        val next = Math.addExact(acceptedRevision(database, accountId), 1L)
        val values = ContentValues().apply { put("accepted_revision", next) }
        val updated = database.update(
            METADATA_TABLE,
            values,
            "account_id = ?",
            arrayOf(accountId.toString()),
        )
        if (updated == 0) {
            values.put("account_id", accountId.toString())
            values.put("paused", 0)
            database.insertOrThrow(METADATA_TABLE, null, values)
        } else {
            check(updated == 1) { "activity revision account partition is not unique" }
        }
    }

    private fun uploadBody(mediaRef: String, spans: JSONArray): String =
        JSONObject()
            .put("clientMutationId", UUID.randomUUID().toString())
            .put("mediaRef", mediaRef)
            .put("deviceClass", "Mobile")
            .put(
                "batch",
                JSONObject().put("modality", "Listening").put("spans", spans),
            )
            .toString()

    private companion object {
        const val DATABASE_NAME = "nexus-consumption-activity.db"
        const val DATABASE_VERSION = 2
        const val TABLE = "activity_outbox"
        const val METADATA_TABLE = "activity_outbox_metadata"
        const val STATE_PENDING = "Pending"
        const val STATE_FAILED_MEDIA_UNAVAILABLE = "FailedMediaUnavailable"
        const val STATE_FAILED_EXPIRED = "FailedExpired"
        const val STATE_FAILED_DEFECT = "FailedDefect"
    }
}

private fun canonicalActivityInstant(raw: String): String {
    val parsed = Instant.parse(raw)
    val canonical = NATIVE_ACTIVITY_INSTANT.format(parsed)
    require(raw == canonical) { "activity occurredAt must be a canonical millisecond instant" }
    return canonical
}
