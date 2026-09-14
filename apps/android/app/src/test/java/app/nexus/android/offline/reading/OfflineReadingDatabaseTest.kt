package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingDatabaseTest {
    @Test
    fun `version one rebuild preserves package removal and pending rows without archive digest`() {
        val context = RuntimeEnvironment.getApplication()
        val name = "reading-upgrade-${UUID.randomUUID()}.db"
        try {
            val binding = UUID.randomUUID().toString()
            val media = UUID.randomUUID().toString()
            val installed = UUID.randomUUID().toString()
            val revision = "a".repeat(64)
            val now = "2026-09-13T00:00:00Z"
            val before: Map<String, Map<String, String?>>
            OfflineReadingDatabase(context, name).use { owner ->
                val db = owner.writableDatabase
                // Restore the historical columns before opening the actual upgrade.
                db.execSQL("ALTER TABLE offline_reader_packages ADD COLUMN package_sha256 TEXT NOT NULL DEFAULT '${"b".repeat(64)}'")
                db.execSQL("ALTER TABLE offline_reader_packages DROP COLUMN table_index_sha256")
                db.execSQL("ALTER TABLE offline_reader_packages DROP COLUMN conversion_refusal")
                db.execSQL("ALTER TABLE offline_reader_transfers DROP COLUMN reader_generation")
                db.execSQL("ALTER TABLE offline_reader_transfers DROP COLUMN preparation_started_at")
                db.execSQL("INSERT INTO offline_reader_binding VALUES(?, 1, ?, ?, ?, 1, ?)",
                    arrayOf(UUID.randomUUID().toString(), binding, UUID.randomUUID().toString(), byteArrayOf(1), now))
                db.execSQL("INSERT INTO offline_reader_packages(id,binding_id,media_id,media_kind,title,reader_generation,reader_revision_key,package_schema_version,reader_contract_version,minimum_bundle_version,size_bytes,installed_at) VALUES(?, ?, ?, 'WebArticle', 'Retained', 7, ?, 1, 1, 1, 1234, ?)",
                    arrayOf(installed, binding, media, revision, now))
                db.execSQL("INSERT INTO offline_reader_removals VALUES(?, ?, ?)", arrayOf(UUID.randomUUID().toString(), installed, now))
                db.execSQL("INSERT INTO offline_reader_progress_baselines VALUES(?, ?, ?, 7, ?, ?)",
                    arrayOf(UUID.randomUUID().toString(), binding, media, """{"state":"Empty","revision":41}""", now))
                db.execSQL("INSERT INTO offline_reader_progress_pending VALUES(?, ?, ?, 7, ?, 41, ?, 'Pending', ?)",
                    arrayOf(UUID.randomUUID().toString(), binding, media, revision, """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":7,"progression":null,"total_progression":null,"position":null},"text":{"quote":"text","quote_prefix":"reader ","quote_suffix":null}}""", now))
                before = tables.associateWith { row(db, it).filterKeys { key -> key != "package_sha256" } }
                // Only version 1 upgrades to the current schema.
                db.version = 1
            }
            OfflineReadingDatabase(context, name).use { owner ->
                val db = owner.writableDatabase
                assertEquals(3, db.version)
                assertEquals("database upgrade changed retained rows", before, tables.associateWith {
                    row(db, it).filterKeys { key -> key != "table_index_sha256" && key != "conversion_refusal" }
                })
                assertNull("upgrade invented a derived table index", row(db, "offline_reader_packages").getValue("table_index_sha256"))
                assertNull("upgrade invented a converter refusal", row(db, "offline_reader_packages").getValue("conversion_refusal"))
                db.rawQuery("PRAGMA table_info(offline_reader_packages)", null).use { cursor ->
                    while (cursor.moveToNext()) assertFalse(cursor.getString(1) == "package_sha256")
                }
                db.rawQuery("PRAGMA foreign_key_check", null).use { assertFalse(it.moveToFirst()) }
                db.rawQuery("PRAGMA foreign_key_list(offline_reader_removals)", null).use {
                    assertTrue(it.moveToFirst())
                    assertEquals("offline_reader_packages", it.getString(2))
                }
            }
        } finally {
            context.deleteDatabase(name)
        }
    }

    private val tables = listOf("offline_reader_packages", "offline_reader_removals",
        "offline_reader_progress_baselines", "offline_reader_progress_pending")

    private fun row(db: SQLiteDatabase, table: String): Map<String, String?> =
        db.rawQuery("SELECT * FROM $table", null).use { cursor ->
            check(cursor.moveToFirst())
            cursor.columnNames.mapIndexed { index, name -> name to cursor.getString(index) }.toMap()
                .also { check(!cursor.moveToNext()) }
        }
}
