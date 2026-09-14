package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingTablePreparationTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `derived table failure preserves attested source and exact progress through offline rebuild`() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "table-preparation-${UUID.randomUUID()}.db"
        val database = OfflineReadingDatabase(context, databaseName)
        val root = temporary.newFolder("packages")
        val binding = UUID.randomUUID()
        val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        val media = UUID.fromString("00000000-0000-4000-8000-000000000007")
        val packageId = UUID.randomUUID()
        val seal = MemoryBindingSeal()
        val fixtures = File(File(System.getProperty("nexus.testdata.offlineReadingContract")
            ?: error("testdata root is missing")).parentFile, "offline-reading")
        val metadata = JSONObject(File(fixtures, "retained-table-context-schema-2.json").readText())
        val archive = File(fixtures, "retained-table-context-schema-2.zip")
        val directory = File(root, "$binding/$packageId")
        check(directory.parentFile!!.mkdir()) // The fixture owns its live binding root.
        val verified = OfflineReadingPackageVerifier().verifyAndExtract(
            OfflineReadingTransferArtifact(archive, account, 7, archive.length(),
                metadata.getLong("expanded_bytes"), metadata.getString("package_sha256")),
            account, media, directory)
        val prepared = prepareOfflineReadingPackage(verified)
        val index = File(directory, OFFLINE_READING_TABLE_INDEX_NAME)
        assertEquals(directory.walkTopDown().filter(File::isFile).sumOf(File::length), prepared.installedBytes)
        assertEquals(index.sha256Hex(), prepared.tableIndexSha256)
        SQLiteDatabase.openDatabase(index.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT rows, columns FROM source_tables", null).use {
                assertTrue(it.moveToFirst()); assertEquals(2L, it.getLong(0)); assertEquals(1L, it.getLong(1))
                assertFalse(it.moveToNext())
            }
            db.rawQuery("SELECT start, end FROM cell_sources ORDER BY id", null).use {
                assertTrue(it.moveToFirst()); assertEquals(0L, it.getLong(0)); assertEquals(6L, it.getLong(1))
                assertTrue(it.moveToNext()); assertEquals(7L, it.getLong(0)); assertEquals(10L, it.getLong(1))
                assertFalse(it.moveToNext())
            }
            db.rawQuery("SELECT row_start, column_start FROM explicit_headers", null).use {
                assertTrue(it.moveToFirst()); assertEquals(0L, it.getLong(0)); assertEquals(0L, it.getLong(1))
                assertFalse(it.moveToNext())
            }
        }
        val manifest = verified.manifest
        val now = "2026-09-14T00:00:00Z"
        val locator = """{"kind":"web","target":{"fragment_id":"00000000-0000-4000-8000-000000000008"},"locations":{"text_offset":7,"progression":null,"total_progression":null,"position":null},"text":{"quote":"cat","quote_prefix":null,"quote_suffix":null}}"""
        database.writableDatabase.transaction {
            execSQL("INSERT INTO offline_reader_binding VALUES(?, 1, ?, ?, ?, 1, ?)",
                arrayOf(UUID.randomUUID().toString(), binding.toString(), account.toString(), seal.create(binding, account), now))
            execSQL("INSERT INTO offline_reader_packages VALUES(?, ?, ?, 'WebArticle', ?, 7, ?, 2, 1, 2, ?, ?, ?, NULL)",
                arrayOf(packageId.toString(), binding.toString(), media.toString(), manifest.title,
                    manifest.readerRevisionKey, prepared.installedBytes, now, prepared.tableIndexSha256))
            execSQL("INSERT INTO offline_reader_progress_baselines VALUES(?, ?, ?, 7, ?, ?)",
                arrayOf(UUID.randomUUID().toString(), binding.toString(), media.toString(), """{"state":"Empty","revision":41}""", now))
            execSQL("INSERT INTO offline_reader_progress_pending VALUES(?, ?, ?, 7, ?, 41, ?, 'Pending', ?)",
                arrayOf(UUID.randomUUID().toString(), binding.toString(), media.toString(), manifest.readerRevisionKey, locator, now))
        }
        val original = row(database.readableDatabase, "offline_reader_packages")
        val pending = row(database.readableDatabase, "offline_reader_progress_pending")
        val baseline = row(database.readableDatabase, "offline_reader_progress_baselines")
        index.writeBytes(byteArrayOf(0))
        var failStagingSync = true
        // Files and SQLite are real. Only the external durability boundary fails.
        val durability = object : OfflineReadingDurability {
            override fun syncTree(directory: File) {
                if (failStagingSync) throw IOException("derived candidate could not be made durable")
                HostReadingFilesystemDurability.syncTree(directory)
            }
            override fun syncDirectory(directory: File) = HostReadingFilesystemDurability.syncDirectory(directory)
        }
        fun store() = OfflineReadingStore(context, database = database, seal = seal,
            rootDirectory = root, durability = durability, integrityExecutor = Executor(Runnable::run),
            progressOriginFactory = OfflineReaderProgressOriginFactory {
                error("local conversion must not reach the progress origin")
            })
        try {
            val reader = store()
            assertEquals("failed table preparation exposed an unready package", OfflineReadingAvailability.UpgradeRequired,
                reader.snapshot().items.single().availability)
            assertEquals(original, row(database.readableDatabase, "offline_reader_packages"))
            assertEquals(pending, row(database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(database.readableDatabase, "offline_reader_progress_baselines"))
            assertThrows(IllegalStateException::class.java) { reader.open(media) }
            for (entry in manifest.entries) assertEquals(entry.sha256, File(directory, entry.path).sha256Hex())
            failStagingSync = false
            val retried = reader.retry(media)
            ShadowLog.getLogsForTag("OfflineReading").forEach { event ->
                println("native_table_rebuild_log=" + event.msg)
                event.throwable?.printStackTrace(System.out)
            }
            assertTrue(retried.items.single().availability is OfflineReadingAvailability.Ready)
            val installed = row(database.readableDatabase, "offline_reader_packages")
            assertNotEquals(packageId.toString(), installed.getValue("id"))
            assertEquals(manifest.readerRevisionKey, installed.getValue("reader_revision_key"))
            assertEquals(pending, row(database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(database.readableDatabase, "offline_reader_progress_baselines"))
            val rebuilt = File(root, "$binding/${installed.getValue("id")}")
            assertEquals(File(rebuilt, OFFLINE_READING_TABLE_INDEX_NAME).sha256Hex(), installed.getValue("table_index_sha256"))
            assertEquals(rebuilt.walkTopDown().filter(File::isFile).sumOf(File::length), installed.getValue("size_bytes")!!.toLong())
            for (entry in manifest.entries) assertEquals(entry.sha256, File(rebuilt, entry.path).sha256Hex())
            assertFalse(directory.exists())
            val reopened = store()
            val lease = reopened.open(media)
            assertEquals(locator, (lease.progress as NativeReaderProgressView.Pending).deviceLocatorJson)
            assertEquals("cat", JSONObject(lease.resolveEntry(
                "units/00000000-0000-4000-8000-000000000008/7-10-0.json").file.readText()).getString("canonical_text"))
            assertThrows(IllegalArgumentException::class.java) { lease.resolveEntry(OFFLINE_READING_TABLE_INDEX_NAME) }
            reopened.closeLease(lease.id)
            assertEquals(installed, row(database.readableDatabase, "offline_reader_packages"))
        } finally {
            database.close()
            context.deleteDatabase(databaseName)
        }
    }

    private fun row(database: SQLiteDatabase, table: String): Map<String, String?> =
        database.rawQuery("SELECT * FROM $table", null).use { cursor ->
            check(cursor.moveToFirst())
            cursor.columnNames.mapIndexed { index, name -> name to cursor.getString(index) }.toMap()
                .also { check(!cursor.moveToNext()) }
        }
}
