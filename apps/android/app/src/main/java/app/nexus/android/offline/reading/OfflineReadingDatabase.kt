package app.nexus.android.offline.reading

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.time.Instant
import java.util.UUID

internal class OfflineReadingDatabase(
    context: Context,
    databaseName: String = DATABASE_NAME,
) : SQLiteOpenHelper(context, databaseName, null, DATABASE_VERSION) {
    override fun onConfigure(database: SQLiteDatabase) {
        database.setForeignKeyConstraintsEnabled(true)
        database.enableWriteAheadLogging()
    }

    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE offline_reader_binding (
                id TEXT NOT NULL PRIMARY KEY,
                singleton_id INTEGER NOT NULL UNIQUE,
                binding_id TEXT NOT NULL UNIQUE,
                account_id TEXT NOT NULL UNIQUE,
                binding_seal BLOB NOT NULL,
                remote_authorization_required INTEGER NOT NULL DEFAULT 0,
                bound_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE offline_reader_purges (
                id TEXT NOT NULL PRIMARY KEY,
                binding_id TEXT NOT NULL UNIQUE,
                reason TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                FOREIGN KEY(binding_id) REFERENCES offline_reader_binding(binding_id)
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE offline_reader_account_transitions (
                id TEXT NOT NULL PRIMARY KEY,
                singleton_id INTEGER NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                target_account_id TEXT,
                requested_at TEXT NOT NULL
            )
            """.trimIndent()
        )
        createPackageTables(database, replacement = false)
        database.execSQL(
            """
            CREATE TABLE offline_reader_transfers (
                id TEXT NOT NULL PRIMARY KEY,
                binding_id TEXT NOT NULL,
                media_id TEXT NOT NULL,
                requested_title TEXT NOT NULL,
                requested_media_kind TEXT NOT NULL,
                state_json TEXT NOT NULL,
                automatic_restart_count INTEGER NOT NULL,
                staging_name TEXT NOT NULL,
                requested_at TEXT NOT NULL,
                reader_generation INTEGER CHECK(reader_generation > 0),
                preparation_started_at TEXT,
                retry_not_before TEXT,
                UNIQUE(binding_id, media_id),
                FOREIGN KEY(binding_id) REFERENCES offline_reader_binding(binding_id)
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE offline_reader_progress_baselines (
                id TEXT NOT NULL PRIMARY KEY,
                binding_id TEXT NOT NULL,
                media_id TEXT NOT NULL,
                reader_generation INTEGER NOT NULL,
                server_snapshot_json TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE(binding_id, media_id),
                FOREIGN KEY(binding_id) REFERENCES offline_reader_binding(binding_id)
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE offline_reader_progress_pending (
                id TEXT NOT NULL PRIMARY KEY,
                binding_id TEXT NOT NULL,
                media_id TEXT NOT NULL,
                reader_generation INTEGER NOT NULL,
                reader_revision_key TEXT NOT NULL,
                base_server_revision INTEGER NOT NULL,
                locator_json TEXT NOT NULL,
                sync_state TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(binding_id, media_id),
                FOREIGN KEY(binding_id) REFERENCES offline_reader_binding(binding_id)
            )
            """.trimIndent()
        )
    }

    private fun createPackageTables(database: SQLiteDatabase, replacement: Boolean) {
        val packages = if (replacement) "offline_reader_packages_new" else "offline_reader_packages"
        val removals = if (replacement) "offline_reader_removals_new" else "offline_reader_removals"
        database.execSQL(
            """
            CREATE TABLE ${packages} (
                id TEXT NOT NULL PRIMARY KEY,
                binding_id TEXT NOT NULL,
                media_id TEXT NOT NULL,
                media_kind TEXT NOT NULL,
                title TEXT NOT NULL,
                reader_generation INTEGER NOT NULL,
                reader_revision_key TEXT NOT NULL,
                package_schema_version INTEGER NOT NULL,
                reader_contract_version INTEGER NOT NULL,
                minimum_bundle_version INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                installed_at TEXT NOT NULL,
                table_index_sha256 TEXT,
                conversion_refusal TEXT,
                UNIQUE(binding_id, media_id),
                FOREIGN KEY(binding_id) REFERENCES offline_reader_binding(binding_id)
            )
            """.trimIndent()
        )
        database.execSQL(
            """
            CREATE TABLE ${removals} (
                id TEXT NOT NULL PRIMARY KEY,
                package_id TEXT NOT NULL UNIQUE,
                requested_at TEXT NOT NULL,
                FOREIGN KEY(package_id) REFERENCES ${packages}(id)
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        check(oldVersion in setOf(1, 3) && newVersion == 4) {
            "unsupported offline reading database upgrade $oldVersion to $newVersion"
        }
        if (oldVersion == 1) {
            migrateCursorSources(database)
            database.execSQL("ALTER TABLE offline_reader_transfers ADD COLUMN reader_generation INTEGER CHECK(reader_generation > 0)")
            database.execSQL("ALTER TABLE offline_reader_transfers ADD COLUMN preparation_started_at TEXT")
            // Rebuild the two related tables within SQLiteOpenHelper's upgrade
            // transaction. Keep foreign keys enabled throughout the replacement.
            createPackageTables(database, replacement = true)
            val columns = "id, binding_id, media_id, media_kind, title, reader_generation, reader_revision_key, package_schema_version, reader_contract_version, minimum_bundle_version, size_bytes, installed_at"
            database.execSQL("INSERT INTO offline_reader_packages_new($columns) SELECT $columns FROM offline_reader_packages")
            database.execSQL("INSERT INTO offline_reader_removals_new SELECT id, package_id, requested_at FROM offline_reader_removals")
            database.execSQL("DROP TABLE offline_reader_removals")
            database.execSQL("DROP TABLE offline_reader_packages")
            database.execSQL("ALTER TABLE offline_reader_packages_new RENAME TO offline_reader_packages")
            database.execSQL("ALTER TABLE offline_reader_removals_new RENAME TO offline_reader_removals")
            database.rawQuery("PRAGMA foreign_key_check", null).use { check(!it.moveToFirst()) }
        }
        database.execSQL("ALTER TABLE offline_reader_transfers ADD COLUMN retry_not_before TEXT")
    }

    private fun migrateCursorSources(database: SQLiteDatabase) {
        database.rawQuery(
            "SELECT id, server_snapshot_json FROM offline_reader_progress_baselines ORDER BY id",
            emptyArray(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val root = StrictJson.parse(cursor.text("server_snapshot_json").toByteArray())
                    as StrictJson.ObjectValue
                if (root.fields.getValue("state").requireString() == "Empty") {
                    OfflineReaderStateValidator.requireCursorSnapshot(root.toJson())
                    continue
                }
                require(root.fields.keys == setOf("state", "revision", "locator"))
                // Schema 1 recorded no source. The last observed current generation
                // cannot establish which publication supplied the stored locator.
                val migrated = StrictJson.ObjectValue(root.fields + (
                    "source" to StrictJson.ObjectValue(mapOf("kind" to StrictJson.StringValue("Unresolved")))
                )).toJson()
                OfflineReaderStateValidator.requireCursorSnapshot(migrated)
                database.execSQL(
                    "UPDATE offline_reader_progress_baselines SET server_snapshot_json = ? WHERE id = ?",
                    arrayOf(migrated, cursor.text("id")),
                )
            }
        }
    }

    companion object {
        internal const val DATABASE_NAME = "offline_reading.db"
        private const val DATABASE_VERSION = 4
    }
}

internal fun SQLiteDatabase.transaction(action: SQLiteDatabase.() -> Unit) {
    beginTransaction()
    try {
        action()
        setTransactionSuccessful()
    } finally {
        endTransaction()
    }
}

internal fun SQLiteDatabase.queryOne(
    sql: String,
    arguments: Array<String> = emptyArray(),
    map: (Cursor) -> Unit,
): Boolean = rawQuery(sql, arguments).use { cursor ->
    if (!cursor.moveToFirst()) return@use false
    map(cursor)
    check(!cursor.moveToNext())
    true
}

internal fun Cursor.uuid(name: String): UUID = UUID.fromString(getString(getColumnIndexOrThrow(name)))
internal fun Cursor.instant(name: String): Instant = Instant.parse(getString(getColumnIndexOrThrow(name)))
internal fun Cursor.text(name: String): String = getString(getColumnIndexOrThrow(name))
internal fun Cursor.long(name: String): Long = getLong(getColumnIndexOrThrow(name))
internal fun Cursor.int(name: String): Int = getInt(getColumnIndexOrThrow(name))
