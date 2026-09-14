package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import java.util.concurrent.Executor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingTableIngressTest {
    @get:Rule val temporary = TemporaryFolder()
    private val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

    @Test
    fun `incoming actual table archive is prepared before publication and reopens without rebuilding`() {
        val context = RuntimeEnvironment.getApplication()
        val databaseName = "table-ingress-${UUID.randomUUID()}.db"
        val database = OfflineReadingDatabase(context, databaseName)
        val root = temporary.newFolder("packages")
        val seal = MemoryBindingSeal()
        fun store() = OfflineReadingStore(context, database = database, seal = seal, rootDirectory = root,
            durability = HostReadingFilesystemDurability,
            integrityExecutor = Executor(Runnable::run))
        try {
            val reader = store()
            reader.bindAccountAfterExternalPurge(account)
            val fixtures = File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile, "offline-reading")
            val archive = File(fixtures, "retained-table-context-schema-2.zip")
            val metadata = JSONObject(File(fixtures, "retained-table-context-schema-2.json").readText())
            val media = UUID.fromString(metadata.getJSONObject("manifest").getString("mediaId"))
            reader.enqueue(media, "Retained table", OfflineReadingMediaKind.WebArticle, 7)
            val transfer = requireNotNull(reader.nextRunnableTransfer())
            val prepared = requireNotNull(reader.verifyDownloadedPackage(transfer.id, transfer.stagingName,
                OfflineReadingTransferArtifact(archive, account, 7, archive.length(), metadata.getLong("expanded_bytes"),
                    metadata.getString("package_sha256"))))
            val index = File(prepared.source.extractedDirectory, OFFLINE_READING_TABLE_INDEX_NAME)
            assertTrue("incoming source was exposed without table preparation", index.isFile)
            assertEquals(index.sha256Hex(), prepared.tableIndexSha256)
            assertEquals(prepared.source.extractedDirectory.walkTopDown().filter(File::isFile).sumOf(File::length), prepared.installedBytes)
            assertTrue(reader.publishVerifiedPackage(transfer.id, transfer.stagingName, prepared,
                AttestedOfflineReaderBaseline(account, 7, """{"state":"Empty","revision":41}""")))
            val installed = row(database)
            assertEquals(prepared.tableIndexSha256, installed.getValue("table_index_sha256"))
            assertEquals(prepared.installedBytes.toString(), installed.getValue("size_bytes"))
            val reopened = store()
            assertTrue(reopened.snapshot().items.single().availability is OfflineReadingAvailability.Ready)
            assertEquals(installed, row(database))
            val lease = reopened.open(media)
            assertEquals("cat", JSONObject(lease.resolveEntry(
                "units/00000000-0000-4000-8000-000000000008/7-10-0.json").file.readText()).getString("canonical_text"))
            reopened.closeLease(lease.id)
        } finally {
            database.close()
            context.deleteDatabase(databaseName)
        }
    }

    @Test
    fun `bounded source validity still requires exact sparse target and excerpt joins`() {
        for ((fault, reason) in listOf(
            "table-missing-target" to "table header target has no source cell",
            "table-duplicate-target" to "table header target is duplicated",
            "table-duplicate-cell" to "table source cell coordinate is duplicated",
            "table-excerpt-span" to "table excerpt differs from source geometry",
            "table-excerpt-count" to "table excerpt differs from source table",
        )) {
            val source = OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, fault), account,
                UUID.fromString("11111111-1111-4111-8111-111111111111"), File(temporary.root, fault))
            val error = assertThrows("unattested table references became prepared: $fault", IllegalArgumentException::class.java) {
                prepareOfflineReadingPackage(source)
            }
            assertEquals(reason, error.message)
            for (entry in source.manifest.entries) assertEquals(entry.sha256, File(source.extractedDirectory, entry.path).sha256Hex())
        }
    }

    private fun row(database: OfflineReadingDatabase): Map<String, String?> =
        database.readableDatabase.rawQuery("SELECT * FROM offline_reader_packages", null).use { cursor ->
            check(cursor.moveToFirst())
            cursor.columnNames.mapIndexed { index, name -> name to cursor.getString(index) }.toMap()
                .also { check(!cursor.moveToNext()) }
        }
}
