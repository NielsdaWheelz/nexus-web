package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.IOException
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyActivationTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `failed atomic activation retains original then offline retry preserves exact pending rows`() {
        for ((hasTable, html) in listOf(
            true to "<table><tr><td rowspan=\"65534\">reader text</td></tr></table>",
            false to "<p>reader text</p>",
        )) {
            val fixture = InstalledLegacyReadingFixture(temporary.newFolder(), html)
            val context = fixture.context
            val database = fixture.database
            val root = fixture.root
            val binding = fixture.binding
            val packageId = fixture.packageId
            val media = fixture.media
            val seal = fixture.seal
            val installedDirectory = fixture.installedDirectory
            val reader = fixture.reader
            val revision = fixture.revision
            val locator = fixture.locator
            val pending = row(database.readableDatabase, "offline_reader_progress_pending")
            val baseline = row(database.readableDatabase, "offline_reader_progress_baselines")
            val originalPackage = row(database.readableDatabase, "offline_reader_packages")
            var failCommitSync = true
            val durability = object : OfflineReadingDurability {
                override fun syncTree(directory: File) = HostReadingFilesystemDurability.syncTree(directory)
                override fun syncDirectory(directory: File) {
                    if (directory == File(root, binding.toString()) && failCommitSync) {
                        failCommitSync = false
                        throw IOException("disk failure after candidate rename, before installed row commit")
                    }
                    HostReadingFilesystemDurability.syncDirectory(directory)
                }
            }
            // Conversion must not reach the network to rescue an old generation,
            // so the only origin this scenario can construct refuses to exist.
            fun openStore() = OfflineReadingStore(context, database = database, seal = seal,
                rootDirectory = root, durability = durability, integrityExecutor = Executor(Runnable::run),
                progressOriginFactory = OfflineReaderProgressOriginFactory {
                    error("local conversion must not reach the progress origin")
                })
            try {
                val store = openStore()
                assertEquals("failed conversion must remain locally retryable", OfflineReadingAvailability.UpgradeRequired,
                    store.snapshot().items.single().availability)
                assertTrue(reader.contentEquals(File(installedDirectory, "reader.json").readBytes()))
                assertEquals(packageId.toString(), row(database.readableDatabase, "offline_reader_packages").getValue("id"))
                assertEquals("failed activation changed original package metadata", originalPackage,
                    row(database.readableDatabase, "offline_reader_packages"))
                assertThrows(IllegalStateException::class.java) { store.open(media) }
                assertEquals(pending, row(database.readableDatabase, "offline_reader_progress_pending"))
                assertEquals(baseline, row(database.readableDatabase, "offline_reader_progress_baselines"))
                // The stored binding requires remote authorization; local conversion must not.
                val retried = store.retry(media)
                assertTrue(retried.items.single().availability is OfflineReadingAvailability.Ready)
                database.readableDatabase.rawQuery("SELECT count(*) FROM offline_reader_progress_pending", null).use {
                    check(it.moveToFirst())
                    assertEquals("migration changed durable pending intent", 1L, it.getLong(0))
                }
                assertEquals("migration changed durable pending intent", pending, row(database.readableDatabase, "offline_reader_progress_pending"))
                assertEquals("migration changed canonical baseline", baseline, row(database.readableDatabase, "offline_reader_progress_baselines"))
                val installed = row(database.readableDatabase, "offline_reader_packages")
                assertEquals("2", installed.getValue("package_schema_version"))
                assertNotEquals(packageId.toString(), installed.getValue("id"))
                assertNotEquals(revision, installed.getValue("reader_revision_key"))
                assertEquals("7", installed.getValue("reader_generation"))
                val finalDirectory = File(root, "$binding/${installed.getValue("id")}")
                assertEquals(finalDirectory.walkTopDown().filter(File::isFile).sumOf(File::length),
                    installed.getValue("size_bytes")!!.toLong())
                if (hasTable) {
                    assertEquals(File(finalDirectory, OFFLINE_READING_TABLE_INDEX_NAME).sha256Hex(), installed.getValue("table_index_sha256"))
                } else assertNull("table-free conversion invented a derived index", installed.getValue("table_index_sha256"))
                assertFalse(installedDirectory.exists())
                val lease = openStore().open(media)
                assertEquals(7L, lease.readerGeneration)
                val progress = lease.progress as NativeReaderProgressView.Pending
                assertEquals(locator, progress.deviceLocatorJson)
                val descriptor = JSONObject(lease.resolveEntry("descriptor.json").file.readText())
                val unit = JSONObject(lease.resolveEntry(descriptor.getJSONObject("first_unit_ref").getString("key")).file.readText())
                assertEquals("reader text", unit.getString("canonical_text"))
                assertEquals("intro", unit.getString("fragment_id"))
                assertEquals(0L, unit.getLong("start_cp"))
                if (hasTable) {
                    assertTrue(!descriptor.isNull("table_metadata_ref"))
                    assertThrows(IllegalArgumentException::class.java) { lease.resolveEntry(OFFLINE_READING_TABLE_INDEX_NAME) }
                }
            } finally {
                fixture.close()
            }
        }
    }

    @Test
    fun `known original grapheme limitation is durable until explicit retry without losing source or progress`() {
        // q has no precomposed acute form. This is valid original NFC text and
        // exactly one 65,537-code-point grapheme after an ordinary prefix.
        val canonical = "reader text q" + "\u0301".repeat(65_536)
        val fixture = InstalledLegacyReadingFixture(temporary.newFolder(), "<p>$canonical</p>", canonical)
        val original = row(fixture.database.readableDatabase, "offline_reader_packages")
        val pending = row(fixture.database.readableDatabase, "offline_reader_progress_pending")
        val baseline = row(fixture.database.readableDatabase, "offline_reader_progress_baselines")
        val originalHash = File(fixture.installedDirectory, "reader.json").sha256Hex()
        val migration = File(fixture.root, "${fixture.binding}/.staging/${fixture.packageId}.migration")
        var attempts = 0
        val durability = object : OfflineReadingDurability {
            override fun syncTree(directory: File) = HostReadingFilesystemDurability.syncTree(directory)
            override fun syncDirectory(directory: File) {
                if (directory == File(migration, "publication")) attempts += 1
                HostReadingFilesystemDurability.syncDirectory(directory)
            }
        }
        fun openStore(database: OfflineReadingDatabase) = OfflineReadingStore(
            fixture.context, database = database, seal = fixture.seal,
            rootDirectory = fixture.root, durability = durability,
            integrityExecutor = Executor(Runnable::run),
            progressOriginFactory = OfflineReaderProgressOriginFactory { error("local refusal must not contact the origin") },
        )
        try {
            assertTrue(fixture.reader.size < OFFLINE_READING_MAX_READER_JSON_BYTES)
            val declared = JSONObject(File(fixture.installedDirectory, "manifest.json").readText()).getJSONArray("entries").getJSONObject(0)
            assertEquals(fixture.reader.size.toLong(), declared.getLong("sizeBytes"))
            assertEquals(originalHash, declared.getString("sha256"))
            assertEquals(canonical, JSONObject(fixture.reader.toString(Charsets.UTF_8)).getJSONArray("fragments").getJSONObject(0).getString("canonicalText"))
            val store = openStore(fixture.database)
            assertEquals(OfflineReadingAvailability.UpgradeFailed, store.snapshot().items.single().availability)
            assertEquals(1, attempts)
            assertThrows(IllegalStateException::class.java) { store.open(fixture.media) }
            val refused = original + ("conversion_refusal" to "GraphemeExceedsUnitCapacity")
            assertEquals("known limitation changed another installed field", refused, row(fixture.database.readableDatabase, "offline_reader_packages"))
            store.reconcile()
            assertEquals("automatic reconciliation repeated the refused conversion", 1, attempts)
            fixture.database.close()
            OfflineReadingDatabase(fixture.context, fixture.databaseName).use { reopened ->
                val retained = openStore(reopened)
                assertEquals(OfflineReadingAvailability.UpgradeFailed, retained.snapshot().items.single().availability)
                assertEquals("process recreation repeated the refused conversion", 1, attempts)
                assertEquals(refused, row(reopened.readableDatabase, "offline_reader_packages"))
                assertEquals(pending, row(reopened.readableDatabase, "offline_reader_progress_pending"))
                assertEquals(baseline, row(reopened.readableDatabase, "offline_reader_progress_baselines"))
                val retried = retained.retry(fixture.media)
                assertEquals("explicit retry did not attempt the original source", 2, attempts)
                assertEquals(OfflineReadingAvailability.UpgradeFailed, retried.items.single().availability)
                assertEquals(refused, row(reopened.readableDatabase, "offline_reader_packages"))
                assertEquals(pending, row(reopened.readableDatabase, "offline_reader_progress_pending"))
                assertEquals(baseline, row(reopened.readableDatabase, "offline_reader_progress_baselines"))
                assertEquals(originalHash, File(fixture.installedDirectory, "reader.json").sha256Hex())
                assertTrue(fixture.reader.contentEquals(File(fixture.installedDirectory, "reader.json").readBytes()))
            }
        } finally { fixture.close() }
    }

    @Test
    fun `filesystem preparation failure stays retryable and does not become a converter refusal`() {
        val fixture = InstalledLegacyReadingFixture(temporary.newFolder())
        val original = row(fixture.database.readableDatabase, "offline_reader_packages")
        val pending = row(fixture.database.readableDatabase, "offline_reader_progress_pending")
        val baseline = row(fixture.database.readableDatabase, "offline_reader_progress_baselines")
        val migration = File(fixture.root, "${fixture.binding}/.staging/${fixture.packageId}.migration")
        var fail = true
        val durability = object : OfflineReadingDurability {
            override fun syncTree(directory: File) = HostReadingFilesystemDurability.syncTree(directory)
            override fun syncDirectory(directory: File) {
                if (fail && directory == File(migration, "publication")) {
                    fail = false
                    throw IOException("controlled filesystem failure before derived units")
                }
                HostReadingFilesystemDurability.syncDirectory(directory)
            }
        }
        try {
            val store = OfflineReadingStore(fixture.context, database = fixture.database, seal = fixture.seal,
                rootDirectory = fixture.root, durability = durability, integrityExecutor = Executor(Runnable::run))
            assertFalse("filesystem fault did not reach preparation", fail)
            assertEquals(OfflineReadingAvailability.UpgradeRequired, store.snapshot().items.single().availability)
            assertEquals(original, row(fixture.database.readableDatabase, "offline_reader_packages"))
            assertEquals(pending, row(fixture.database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(fixture.database.readableDatabase, "offline_reader_progress_baselines"))
            assertTrue(fixture.reader.contentEquals(File(fixture.installedDirectory, "reader.json").readBytes()))
            store.reconcile()
            assertTrue("resource recovery did not retry conversion", store.snapshot().items.single().availability is OfflineReadingAvailability.Ready)
            assertNull(row(fixture.database.readableDatabase, "offline_reader_packages").getValue("conversion_refusal"))
            assertEquals(pending, row(fixture.database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(fixture.database.readableDatabase, "offline_reader_progress_baselines"))
        } finally { fixture.close() }
    }

    @Test
    fun `ordinary source mapping failure propagates without a durable converter limitation`() {
        // Deliberately inconsistent attested local bytes exercise the defect
        // branch; this fixture is NOT an admitted-source capacity witness.
        val fixture = InstalledLegacyReadingFixture(temporary.newFolder(), "<p>other words</p>")
        try {
            val original = row(fixture.database.readableDatabase, "offline_reader_packages")
            val pending = row(fixture.database.readableDatabase, "offline_reader_progress_pending")
            val baseline = row(fixture.database.readableDatabase, "offline_reader_progress_baselines")
            val executor = Executors.newSingleThreadExecutor()
            try {
                val completed = CountDownLatch(1)
                var result: OfflineReadingReconciliationOutcome? = null
                val store = OfflineReadingStore(fixture.context, database = fixture.database, seal = fixture.seal,
                    rootDirectory = fixture.root, durability = HostReadingFilesystemDurability,
                    integrityExecutor = executor, reconcileOnInit = false)
                store.reconcileAsync { result = it; completed.countDown() }
                assertTrue("converter defect did not complete its existing async owner", completed.await(10, TimeUnit.SECONDS))
                val failed = result as? OfflineReadingReconciliationOutcome.Failed
                assertTrue("converter defect was relabeled as readiness or resource deferral", failed != null)
                assertTrue("mapping failure lost its original cause", failed!!.cause is IllegalArgumentException)
                assertThrows(IllegalStateException::class.java) { store.open(fixture.media) }
            } finally { executor.shutdownNow() }
            assertEquals(original, row(fixture.database.readableDatabase, "offline_reader_packages"))
            assertEquals(pending, row(fixture.database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(fixture.database.readableDatabase, "offline_reader_progress_baselines"))
            assertTrue(fixture.reader.contentEquals(File(fixture.installedDirectory, "reader.json").readBytes()))
        } finally { fixture.close() }
    }

    @Test
    fun `explicit retry survives an older reconciliation held in another package durability`() {
        val canonical = "reader text q" + "\u0301".repeat(65_536)
        val refused = InstalledLegacyReadingFixture(temporary.newFolder(), "<p>$canonical</p>", canonical)
        val other = InstalledLegacyReadingFixture(temporary.newFolder())
        val executor = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val retried = CountDownLatch(1)
        var attempts = 0
        var holdOther = true
        var laterCallbackDelivered = false
        var failedSchedulerCompleted = false
        val databaseFile = refused.context.getDatabasePath(refused.databaseName)
        val ownPublication = File(refused.root, "${refused.binding}/.staging/${refused.packageId}.migration/publication")
        val otherPublication = File(refused.root, "${refused.binding}/.staging/${other.packageId}.migration/publication")
        val durability = object : OfflineReadingDurability {
            override fun syncDirectory(directory: File) {
                if (directory == ownPublication) {
                    attempts += 1
                    if (attempts == 2) retried.countDown()
                }
                HostReadingFilesystemDurability.syncDirectory(directory)
            }
            override fun syncTree(directory: File) {
                if (directory == otherPublication && holdOther) {
                    holdOther = false
                    entered.countDown()
                    check(release.await(10, TimeUnit.SECONDS)) { "controlled durability was not released" }
                }
                HostReadingFilesystemDurability.syncTree(directory)
            }
        }
        try {
            val initial = OfflineReadingStore(refused.context, database = refused.database, seal = refused.seal,
                rootDirectory = refused.root, durability = durability, integrityExecutor = Executor(Runnable::run))
            assertEquals(OfflineReadingAvailability.UpgradeFailed, initial.snapshot().items.single().availability)
            assertEquals(1, attempts)
            val pending = row(refused.database.readableDatabase, "offline_reader_progress_pending")
            val baseline = row(refused.database.readableDatabase, "offline_reader_progress_baselines")
            // Add a second independently valid retained source to the same
            // installed binding. No source payload or expected text is rewritten.
            other.installedDirectory.copyRecursively(File(refused.root, "${refused.binding}/${other.packageId}"))
            refused.database.writableDatabase.transaction {
                for (table in listOf("offline_reader_packages", "offline_reader_progress_baselines", "offline_reader_progress_pending")) {
                    val values = android.content.ContentValues()
                    for ((name, value) in row(other.database.readableDatabase, table)) {
                        when {
                            name == "binding_id" -> values.put(name, refused.binding.toString())
                            value == null -> values.putNull(name)
                            else -> values.put(name, value)
                        }
                    }
                    insertOrThrow(table, null, values)
                }
            }
            val store = OfflineReadingStore(refused.context, database = refused.database, seal = refused.seal,
                rootDirectory = refused.root, durability = durability, integrityExecutor = executor,
                reconcileOnInit = false)
            OfflineReadingScheduler.runnerStarted()
            store.reconcile()
            assertTrue("second source did not reach its real durability boundary", entered.await(10, TimeUnit.SECONDS))
            // Callback delivery has real downstream SQLite work: the existing
            // stale-policy scheduler callback must not strand later consumers.
            ShadowLog.clear()
            store.reconcileAsync {
                refused.database.close()
                assertTrue(databaseFile.setReadable(false, false))
                assertFalse("controlled scheduler database read remains available", databaseFile.canRead())
            }
            store.recoverStalePolicyJob { failedSchedulerCompleted = true }
            store.reconcileAsync {
                assertTrue(databaseFile.setReadable(true, true))
                laterCallbackDelivered = true
            }
            // The run captured the old refusal before blocking outside the
            // store monitor. Live-runner reconciliation permits this command.
            store.retry(refused.media)
            store.retry(refused.media)
            release.countDown()
            assertTrue("explicit retry disappeared behind the active reconciliation", retried.await(10, TimeUnit.SECONDS))
            executor.submit {}.get(10, TimeUnit.SECONDS)
            assertEquals("overlapping retries did not coalesce", 2, attempts)
            assertTrue("scheduler failure stranded the later completion", laterCallbackDelivered)
            assertFalse("failed scheduler callback reported completion", failedSchedulerCompleted)
            assertTrue("scheduler callback lost its original SQLite defect", ShadowLog.getLogsForTag("OfflineReading").any {
                it.msg == "reconciliation callback failed" && it.throwable is android.database.sqlite.SQLiteException
            })
            val item = store.snapshot().items.single { it.mediaId == refused.media }
            assertEquals(OfflineReadingAvailability.UpgradeFailed, item.availability)
            assertTrue(store.snapshot().items.single { it.mediaId == other.media }.availability is OfflineReadingAvailability.Ready)
            for ((table, expected) in listOf("offline_reader_progress_pending" to pending, "offline_reader_progress_baselines" to baseline)) {
                refused.database.readableDatabase.rawQuery("SELECT * FROM $table WHERE media_id = ?", arrayOf(refused.media.toString())).use { cursor ->
                    assertTrue(cursor.moveToFirst())
                    val retained = cursor.columnNames.mapIndexed { index, name -> name to cursor.getString(index) }.toMap()
                    assertEquals(expected, retained)
                    assertFalse(cursor.moveToNext())
                }
            }
            assertTrue(refused.reader.contentEquals(File(refused.installedDirectory, "reader.json").readBytes()))
        } finally {
            release.countDown()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
            OfflineReadingScheduler.runnerStopped()
            assertTrue(databaseFile.setReadable(true, true))
            refused.close()
            other.close()
        }
    }

    @Test
    fun `failed initial store read completes its owner and permits reconciliation after recovery`() {
        val fixture = InstalledLegacyReadingFixture(temporary.newFolder())
        val original = row(fixture.database.readableDatabase, "offline_reader_packages")
        val pending = row(fixture.database.readableDatabase, "offline_reader_progress_pending")
        val baseline = row(fixture.database.readableDatabase, "offline_reader_progress_baselines")
        val databaseFile = fixture.context.getDatabasePath(fixture.databaseName)
        fixture.database.close()
        try {
            assertTrue(databaseFile.isFile)
            assertTrue(databaseFile.setReadable(false, false))
            assertFalse("controlled store read remains available", databaseFile.canRead())
            val store = OfflineReadingStore(fixture.context, database = fixture.database, seal = fixture.seal,
                rootDirectory = fixture.root, durability = HostReadingFilesystemDurability,
                integrityExecutor = Executor(Runnable::run), reconcileOnInit = false)
            var failed: OfflineReadingReconciliationOutcome? = null
            var synchronousFailure: Exception? = null
            try {
                store.reconcileAsync { failed = it }
            } catch (error: Exception) {
                synchronousFailure = error
            }
            assertNull("initial store read escaped its owned reconciliation boundary", synchronousFailure)
            assertTrue("failed initial notification orphaned the reconciliation owner", failed is OfflineReadingReconciliationOutcome.Failed)
            assertTrue("store read lost its SQLite cause", (failed as OfflineReadingReconciliationOutcome.Failed).cause is android.database.sqlite.SQLiteException)
            assertTrue(fixture.reader.contentEquals(File(fixture.installedDirectory, "reader.json").readBytes()))
            assertTrue(databaseFile.setReadable(true, true))
            assertTrue(databaseFile.canRead())
            assertEquals(original, row(fixture.database.readableDatabase, "offline_reader_packages"))
            var recovered: OfflineReadingReconciliationOutcome? = null
            store.reconcileAsync { recovered = it }
            assertTrue("failed initial read left reconciliation claimed after recovery", recovered is OfflineReadingReconciliationOutcome.Ready)
            assertTrue((recovered as OfflineReadingReconciliationOutcome.Ready).snapshot.items.single().availability is OfflineReadingAvailability.Ready)
            assertEquals(pending, row(fixture.database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(fixture.database.readableDatabase, "offline_reader_progress_baselines"))
        } finally {
            assertTrue(databaseFile.setReadable(true, true))
            fixture.close()
        }
    }

    @Test
    fun `ready job inspection reports unavailable store then recovers exact installed state`() {
        val fixture = InstalledLegacyReadingFixture(temporary.newFolder())
        val executor = Executors.newSingleThreadExecutor()
        val databaseFile = fixture.context.getDatabasePath(fixture.databaseName)
        try {
            val store = OfflineReadingStore(fixture.context, database = fixture.database, seal = fixture.seal,
                rootDirectory = fixture.root, durability = HostReadingFilesystemDurability,
                integrityExecutor = executor, reconcileOnInit = false)
            val prepared = CountDownLatch(1)
            var preparation: OfflineReadingReconciliationOutcome? = null
            store.reconcileAsync { preparation = it; prepared.countDown() }
            assertTrue("initial real package preparation did not complete", prepared.await(10, TimeUnit.SECONDS))
            assertTrue(preparation is OfflineReadingReconciliationOutcome.Ready)
            val installed = row(fixture.database.readableDatabase, "offline_reader_packages")
            val pending = row(fixture.database.readableDatabase, "offline_reader_progress_pending")
            val baseline = row(fixture.database.readableDatabase, "offline_reader_progress_baselines")
            val installedDirectory = File(fixture.root, "${fixture.binding}/${installed.getValue("id")}")
            val manifest = File(installedDirectory, "manifest.json").readBytes()
            fixture.database.close()
            assertTrue(databaseFile.setReadable(false, false))
            assertFalse("controlled prepared store remains readable", databaseFile.canRead())
            val inspected = CountDownLatch(1)
            var inspection: OfflineReadingReconciliationOutcome? = null
            var synchronousFailure: Exception? = null
            try {
                store.reconcileForJob { inspection = it; inspected.countDown() }
            } catch (error: Exception) {
                synchronousFailure = error
            }
            assertNull("ready job inspection escaped before its owned executor boundary", synchronousFailure)
            assertTrue("ready job inspection stranded its completion", inspected.await(10, TimeUnit.SECONDS))
            assertTrue("unavailable prepared store became a ready job", inspection is OfflineReadingReconciliationOutcome.Failed)
            assertTrue("job inspection lost the original SQLite cause",
                (inspection as OfflineReadingReconciliationOutcome.Failed).cause is android.database.sqlite.SQLiteException)
            assertTrue(manifest.contentEquals(File(installedDirectory, "manifest.json").readBytes()))
            assertTrue(databaseFile.setReadable(true, true))
            assertTrue(databaseFile.canRead())
            assertEquals(installed, row(fixture.database.readableDatabase, "offline_reader_packages"))
            assertThrows(IllegalStateException::class.java) { store.open(fixture.media) }
            val recovered = CountDownLatch(1)
            var recovery: OfflineReadingReconciliationOutcome? = null
            store.reconcileForJob { recovery = it; recovered.countDown() }
            assertTrue("recovered job inspection stranded reconciliation", recovered.await(10, TimeUnit.SECONDS))
            assertTrue("recovered job did not regain prepared readiness", recovery is OfflineReadingReconciliationOutcome.Ready)
            assertTrue((recovery as OfflineReadingReconciliationOutcome.Ready).snapshot.items.single().availability is OfflineReadingAvailability.Ready)
            assertEquals(installed, row(fixture.database.readableDatabase, "offline_reader_packages"))
            assertEquals(pending, row(fixture.database.readableDatabase, "offline_reader_progress_pending"))
            assertEquals(baseline, row(fixture.database.readableDatabase, "offline_reader_progress_baselines"))
        } finally {
            assertTrue(databaseFile.setReadable(true, true))
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
            fixture.close()
        }
    }

    private fun row(database: SQLiteDatabase, table: String): Map<String, String?> =
        database.rawQuery("SELECT * FROM $table", null).use { cursor ->
            assertTrue("retained $table row is absent", cursor.moveToFirst())
            cursor.columnNames.mapIndexed { index, name -> name to cursor.getString(index) }.toMap()
                .also { check(!cursor.moveToNext()) }
        }
}
