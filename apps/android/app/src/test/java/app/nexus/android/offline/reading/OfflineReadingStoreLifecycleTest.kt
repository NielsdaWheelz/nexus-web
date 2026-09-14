package app.nexus.android.offline.reading

import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineNetworkPolicyStore
import app.nexus.android.offline.StorageAdmissionPolicy
import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingStoreLifecycleTest {
    private lateinit var context: Context
    private lateinit var root: File
    private lateinit var databaseName: String
    private val seal = MemoryBindingSeal()
    private val scheduler = RecordingScheduler()
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val nextAccountId = UUID.fromString("33333333-3333-4333-8333-333333333333")
    private val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(
            OfflineNetworkPolicyStore.PREFERENCE_FILE,
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
        databaseName = "offline-reading-${UUID.randomUUID()}.db"
        root = kotlin.io.path.createTempDirectory("offline-reading-store").toFile()
    }

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
        root.deleteRecursively()
    }

    @Test
    fun `schema one cursor migration preserves pending identity without inventing provenance`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val before = store(database)
        before.bindAccountAfterExternalPurge(accountId)
        before.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(before, before.nextRunnableTransfer()!!))
        val installed = before.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        before.saveReaderProgress(mediaId, installed.readerGeneration, installed.readerRevisionKey, locator)
        val pending = before.pendingSyncCandidates(mediaId).single()
        // Restore the actual v1 shape and cursor payload before reopening its upgrade.
        database.writableDatabase.execSQL(
            "UPDATE offline_reader_progress_baselines SET server_snapshot_json = ?",
            arrayOf("""{"state":"Positioned","revision":6,"locator":$locator}"""),
        )
        database.writableDatabase.execSQL("ALTER TABLE offline_reader_transfers DROP COLUMN reader_generation")
        database.writableDatabase.execSQL("ALTER TABLE offline_reader_transfers DROP COLUMN preparation_started_at")
        database.writableDatabase.execSQL("ALTER TABLE offline_reader_packages ADD COLUMN package_sha256 TEXT NOT NULL DEFAULT '${"b".repeat(64)}'")
        database.writableDatabase.version = 1
        database.close()

        val migratedDatabase = OfflineReadingDatabase(context, databaseName)
        val migrated = store(migratedDatabase)
        assertEquals(pending, migrated.pendingSyncCandidates(mediaId).single())
        val ready = migrated.snapshot().items.single().availability as OfflineReadingAvailability.Ready
        val progress = ready.progress as NativeReaderProgressView.Pending
        val baseline = StrictJson.parse(progress.baselineJson.toByteArray()) as StrictJson.ObjectValue
        assertEquals(6L, baseline.fields.getValue("revision").requireLong())
        assertEquals("Unresolved", (baseline.fields.getValue("source") as StrictJson.ObjectValue)
            .fields.getValue("kind").requireString())
        assertTrue(strictJsonSemanticallyEqual(baseline.fields.getValue("locator"), StrictJson.parse(locator.toByteArray())))
        assertEquals(locator, progress.deviceLocatorJson)
        migratedDatabase.close()
    }

    @Test
    fun `SQLite and files survive recreate then lease gates removal and account switch purges`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertEquals(1, scheduler.admissions)
        assertTrue(publishRealPackage(first, first.nextRunnableTransfer()!!))
        val firstLease = first.open(mediaId)
        assertTrue(firstLease.resolveEntry("descriptor.json").file.readText().contains("reader_contract_version"))
        first.closeLease(firstLease.id)
        firstDatabase.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        val reopenedSnapshot = reopened.snapshot()
        assertEquals(1, reopenedSnapshot.items.size)
        assertTrue(
            reopenedSnapshot.items.single().availability is OfflineReadingAvailability.Ready
        )

        val heldLease = reopened.open(mediaId)
        reopened.remove(mediaId)
        assertTrue(
            reopened.snapshot().items.single().availability is OfflineReadingAvailability.Removing
        )
        reopened.closeLease(heldLease.id)
        assertTrue(reopened.snapshot().items.isEmpty())

        reopened.enqueue(mediaId, "Second copy", OfflineReadingMediaKind.WebArticle, 7)
        reopened.beginAccountTransition(nextAccountId)
        assertTrue(reopened.snapshot().items.isEmpty())
        reopenedDatabase.close()

        val transitionDatabase = OfflineReadingDatabase(context, databaseName)
        val duringTransition = store(transitionDatabase)
        assertTrue(duringTransition.snapshot().items.isEmpty())
        duringTransition.completeAccountTransition(nextAccountId)
        assertTrue(duringTransition.snapshot().items.isEmpty())
        assertFalse(root.walkTopDown().any { it.isFile })
        transitionDatabase.close()
    }

    @Test
    fun `retirement during actual prepared-directory durability cannot publish or recreate account files`() {
        val fixtures = File(File(System.getProperty("nexus.testdata.offlineReadingContract")
            ?: error("testdata root is missing")).parentFile, "offline-reading")
        val metadata = org.json.JSONObject(File(fixtures, "retained-table-context-schema-2.json").readText())
        val source = File(fixtures, "retained-table-context-schema-2.zip")
        val tableMedia = UUID.fromString("00000000-0000-4000-8000-000000000007")
        for (retirement in listOf("Stop", "BeginTransition", "Purge")) {
            val name = "$databaseName-durability-$retirement"
            val database = OfflineReadingDatabase(context, name)
            lateinit var owner: OfflineReadingStore
            lateinit var transfer: OfflineReadingTransfer
            var observed = false
            val boundary = object : OfflineReadingDurability {
                override fun syncDirectory(directory: File) = HostReadingFilesystemDurability.syncDirectory(directory)
                override fun syncTree(directory: File) {
                    assertTrue("durability boundary did not receive the real prepared index",
                        File(directory, OFFLINE_READING_TABLE_INDEX_NAME).isFile)
                    observed = true
                    if (retirement == "Stop") owner.systemStopped(transfer.id, transfer.stagingName)
                    else {
                        owner.beginAccountTransition(null)
                        if (retirement == "Purge") owner.completeAccountTransition(null)
                    }
                    // Stop/purge causes a real missing-directory failure. Begin alone leaves
                    // the directory readable, so only the authority checkpoint can fence it.
                    HostReadingFilesystemDurability.syncDirectory(directory)
                }
            }
            try {
                owner = store(database, durabilityPort = boundary)
                owner.bindAccountAfterExternalPurge(accountId)
                owner.enqueue(tableMedia, "Table", OfflineReadingMediaKind.WebArticle, 7)
                transfer = owner.nextRunnableTransfer()!!
                val archive = owner.stagingArchiveFor(transfer)
                source.copyTo(archive)
                val artifact = OfflineReadingTransferArtifact(archive, accountId, 7, archive.length(),
                    metadata.getLong("expanded_bytes"), metadata.getString("package_sha256"))
                var prepared: PreparedOfflineReadingPackage? = null
                val missing = try {
                    prepared = owner.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
                    null
                } catch (error: java.nio.file.NoSuchFileException) { error }
                assertTrue(observed)
                assertEquals("retired preparation surfaced its removed staging directory", null, missing)
                assertEquals("retired preparation escaped as ready to publish", null, prepared)
                assertFalse(owner.snapshot().items.any { it is OfflineReadingItemSnapshot.PackageItem })
                val bindingDirectory = File(root, transfer.bindingId.toString())
                if (retirement == "Purge") assertFalse("prepared work recreated the purged account", bindingDirectory.exists())
                else {
                    assertFalse(File(bindingDirectory, ".staging/${transfer.stagingName}.verified").exists())
                    if (retirement == "Stop") assertTrue(
                        storedRow(database, "offline_reader_transfers", tableMedia).getValue("staging_name") != transfer.stagingName)
                    else assertEquals(OfflineReadingAccountTransitionView.Logout, owner.pendingAccountTransition())
                }
            } finally {
                database.close()
                context.deleteDatabase(name)
            }
        }
    }

    @Test
    fun `a live zero-byte verified member remains a contract failure`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val truncated = OfflineReadingPackageVerifierPort { artifact, account, media, destination ->
            OfflineReadingPackageVerifier().verifyAndExtract(artifact, account, media, destination).also {
                // External filesystem damage after byte verification, before the derived read.
                File(destination, "descriptor.json").writeBytes(byteArrayOf())
            }
        }
        try {
            val owner = store(database, truncated)
            owner.bindAccountAfterExternalPurge(accountId)
            owner.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
            val transfer = owner.nextRunnableTransfer()!!
            val artifact = buildWebArticleReadingPackage(mediaId, "Verified copy")
                .stageArtifact(owner.stagingArchiveFor(transfer), accountId)
            assertThrows("a zero-byte member was treated as retired missing staging", IllegalArgumentException::class.java) {
                owner.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
            }
            assertFalse(owner.snapshot().items.any { it is OfflineReadingItemSnapshot.PackageItem })
        } finally { database.close() }
    }

    @Test
    fun `system stop fences a publish while verification work runs outside store monitor`() {
        val verifiedOutsideMonitor = CountDownLatch(1)
        val release = CountDownLatch(1)
        // Real verification, then hold the thread outside the store monitor so the system
        // stop can land between install step 5 (verify) and steps 7-8 (publish).
        val blocking = OfflineReadingPackageVerifierPort { artifact, account, media, destination ->
            val verified = OfflineReadingPackageVerifier()
                .verifyAndExtract(artifact, account, media, destination)
            verifiedOutsideMonitor.countDown()
            check(release.await(5, TimeUnit.SECONDS))
            verified
        }
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database, blocking)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = store.nextRunnableTransfer()!!
        val artifact = buildWebArticleReadingPackage(mediaId, "Verified copy")
            .stageArtifact(store.stagingArchiveFor(transfer), accountId)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val publish = executor.submit<Boolean> {
                val verified = store.verifyDownloadedPackage(
                    transfer.id,
                    transfer.stagingName,
                    artifact,
                ) ?: return@submit false
                store.publishVerifiedPackage(
                    transfer.id,
                    transfer.stagingName,
                    verified,
                    AttestedOfflineReaderBaseline(
                        accountId, 7, "{\"state\":\"Empty\",\"revision\":0}"
                    ),
                )
            }
            assertTrue(verifiedOutsideMonitor.await(2, TimeUnit.SECONDS))
            val stopped = executor.submit<Unit> {
                store.systemStopped(transfer.id, transfer.stagingName)
            }
            stopped.get(2, TimeUnit.SECONDS)
            release.countDown()
            assertFalse(publish.get(2, TimeUnit.SECONDS))
        } finally {
            release.countDown()
            executor.shutdownNow()
            database.close()
        }
    }

    @Test
    fun `corrupted installed member cannot be leased and reconcile converges recovery`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        store.saveReaderProgress(mediaId, installed.readerGeneration, installed.readerRevisionKey, locator)
        val pending = store.pendingSyncCandidates(mediaId).single()
        var intentId = ""
        database.readableDatabase.queryOne("SELECT id FROM offline_reader_progress_pending") { intentId = it.text("id") }
        root.walkTopDown().single { it.name == "descriptor.json" }.writeText("corrupt")

        store.reconcile()
        assertThrows(IllegalStateException::class.java) { store.open(mediaId) }
        val recovery = store.snapshot().items.single().availability as OfflineReadingAvailability.Transfer
        assertEquals(
            ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
            recovery.state,
        )
        assertEquals("content recovery discarded pending intent", listOf(pending), store.pendingSyncCandidates(mediaId))
        database.close()
        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        assertEquals(pending, reopened.pendingSyncCandidates(mediaId).single())
        reopenedDatabase.readableDatabase.queryOne("SELECT id FROM offline_reader_progress_pending") {
            assertEquals(intentId, it.text("id"))
        }
        reopened.retry(mediaId)
        assertTrue(publishRealPackage(reopened, reopened.nextRunnableTransfer()!!))
        assertEquals(pending, reopened.pendingSyncCandidates(mediaId).single())
        reopenedDatabase.close()
    }

    @Test
    fun `retained copy captures same-source intent when current generation has advanced`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Retained copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = store.nextRunnableTransfer()!!
        val artifact = buildWebArticleReadingPackage(mediaId, "Retained copy", 7)
            .stageArtifact(store.stagingArchiveFor(transfer), accountId)
        val verified = store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)!!
        assertTrue(store.publishVerifiedPackage(transfer.id, transfer.stagingName, verified,
            AttestedOfflineReaderBaseline(accountId, 8, "{\"state\":\"Empty\",\"revision\":9}")))
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        val captured = runCatching { store.saveReaderProgress(mediaId, 7, installed.readerRevisionKey, locator) }
        assertTrue("a retained copy could not durably retain its source-bound position: ${captured.exceptionOrNull()}", captured.isSuccess)
        assertTrue(captured.getOrThrow() is NativeReaderProgressView.ContentChanged)
        val changed = captured.getOrThrow() as NativeReaderProgressView.ContentChanged
        assertEquals("{\"kind\":\"Publication\",\"reader_generation\":7}", changed.sourceJson)
        assertEquals(locator, changed.deviceLocatorJson)
        assertTrue(store.pendingSyncCandidates(mediaId).isEmpty())
        database.close()
        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        val lease = reopened.open(mediaId)
        assertEquals(changed, lease.progress)
        reopenedDatabase.readableDatabase.queryOne("SELECT reader_generation, base_server_revision, locator_json FROM offline_reader_progress_pending") {
            assertEquals(7L, it.long("reader_generation"))
            assertEquals(9L, it.long("base_server_revision"))
            assertEquals(locator, it.text("locator_json"))
        }
        reopened.closeLease(lease.id)
        reopenedDatabase.close()
    }

    @Test
    fun `every enumerated failure deletes and fences staging bytes`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Failed copy", OfflineReadingMediaKind.WebArticle, 7)
        ReadingFailureReason.entries.forEachIndexed { index, reason ->
            val transfer = store.nextRunnableTransfer()!!
            val archive = store.stagingArchiveFor(transfer).apply {
                writeBytes(byteArrayOf(1, 2, 3))
            }
            val verified = archive.parentFile!!.resolve("${transfer.stagingName}.verified").apply {
                mkdirs()
                resolve("reader.json").writeText("partial")
            }

            assertTrue(
                store.updateTransferState(
                    transfer.id,
                    transfer.stagingName,
                    ReadingTransferState.Failed(reason),
                )
            )
            assertFalse("archive remained for $reason", archive.exists())
            assertFalse("verified tree remained for $reason", verified.exists())
            assertEquals(
                ReadingTransferState.Failed(reason),
                (store.snapshot().items.single().availability as
                    OfflineReadingAvailability.Transfer).state,
            )
            assertEquals(null, store.nextRunnableTransfer())
            if (index != ReadingFailureReason.entries.lastIndex) {
                store.retry(mediaId)
            }
        }
        database.close()
    }

    @Test
    fun `requested media kind is durable and mismatched verified package cannot publish`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        val queued = store.enqueue(mediaId, "Wrong kind", OfflineReadingMediaKind.Pdf, 7)

        assertEquals(OfflineReadingMediaKind.Pdf, queued.items.single().mediaKind)
        val transfer = store.nextRunnableTransfer()!!
        // A conforming WebArticle package for a durable Pdf request must fail at the
        // verification step, before any baseline fetch or publication is possible.
        val artifact = buildWebArticleReadingPackage(mediaId, "Wrong kind")
            .stageArtifact(store.stagingArchiveFor(transfer), accountId)
        assertThrows(IllegalArgumentException::class.java) {
            store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
        }
        assertTrue(store.snapshot().items.single().availability is OfflineReadingAvailability.Transfer)
        database.close()
    }

    @Test
    fun `blocked installed verifier never exposes ready or blocks lifecycle calls`() {
        val initialDatabase = OfflineReadingDatabase(context, databaseName)
        val initial = store(initialDatabase)
        initial.bindAccountAfterExternalPurge(accountId)
        initial.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(initial, initial.nextRunnableTransfer()!!))
        initialDatabase.close()

        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val blockedVerifier = OfflineReadingInstalledPackageVerifierPort { installed, directory ->
            entered.countDown()
            try {
                check(release.await(5, TimeUnit.SECONDS))
                OfflineReadingInstalledPackageVerifier().membersAreValid(installed, directory)
            } finally {
                finished.countDown()
            }
        }
        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val reopened = store(
                reopenedDatabase,
                installedVerifier = blockedVerifier,
                integrityExecutor = executor,
            )
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            val startedAt = System.nanoTime()
            assertTrue(reopened.snapshot().items.isEmpty())
            assertThrows(IllegalStateException::class.java) { reopened.open(mediaId) }
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt) < 2_000)
            assertTrue(reopened.beginAccountTransition(nextAccountId).items.isEmpty())
        } finally {
            release.countDown()
            assertTrue(finished.await(2, TimeUnit.SECONDS))
            executor.shutdownNow()
            reopenedDatabase.close()
        }
    }

    @Test
    fun `cold process reconciliation spends one restart then converges stale active work`() {
        OfflineReadingScheduler.runnerStopped()
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Interrupted copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = first.nextRunnableTransfer()!!
        assertTrue(
            first.updateTransferState(
                transfer.id,
                transfer.stagingName,
                ReadingTransferState.Downloading(3, 10),
            )
        )
        firstDatabase.close()

        val restartDatabase = OfflineReadingDatabase(context, databaseName)
        val restarted = store(restartDatabase)
        val restartingState = (restarted.snapshot().items.single().availability as
            OfflineReadingAvailability.Transfer).state
        assertEquals(
            ReadingTransferState.Restarting(1, ReadingRestartReason.Interrupted),
            restartingState,
        )
        restartDatabase.close()

        val stoppedDatabase = OfflineReadingDatabase(context, databaseName)
        val stopped = store(stoppedDatabase)
        val stoppedState = (stopped.snapshot().items.single().availability as
            OfflineReadingAvailability.Transfer).state
        assertEquals(
            ReadingTransferState.Failed(ReadingFailureReason.SystemStopped),
            stoppedState,
        )
        stoppedDatabase.close()
    }

    @Test
    fun `shelf reconciliation does not interrupt a genuinely live process runner`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Live copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = first.nextRunnableTransfer()!!
        first.updateTransferState(
            transfer.id,
            transfer.stagingName,
            ReadingTransferState.Authorizing,
        )
        firstDatabase.close()

        OfflineReadingScheduler.runnerStarted()
        try {
            val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
            val reopened = store(reopenedDatabase)
            assertEquals(
                ReadingTransferState.Authorizing,
                (reopened.snapshot().items.single().availability as
                    OfflineReadingAvailability.Transfer).state,
            )
            reopenedDatabase.close()
        } finally {
            OfflineReadingScheduler.runnerStopped()
        }
    }

    @Test
    fun `locked reconciliation reports deferred and Task Manager stop fences queued work`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Locked copy", OfflineReadingMediaKind.WebArticle, 7)
        firstDatabase.close()

        val lockedDatabase = OfflineReadingDatabase(context, databaseName)
        val locked = store(lockedDatabase, sealPort = LockedBindingSeal)
        var outcome: OfflineReadingReconciliationOutcome? = null
        locked.reconcileForJob { outcome = it }
        assertTrue(outcome is OfflineReadingReconciliationOutcome.Deferred)
        assertTrue(locked.snapshot().items.isEmpty())
        assertTrue(locked.systemStopAllDurableTransferWork(null, null))
        assertFalse(locked.hasDurableTransferWork())
        lockedDatabase.close()
    }

    @Test
    fun `unlock foreground reconciliation restores same-account hosted shelf`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val first = store(database)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(first, first.nextRunnableTransfer()!!))
        database.close()

        val lockableSeal = LockableBindingSeal(seal, locked = true)
        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase, sealPort = lockableSeal)
        assertTrue(reopened.snapshot().binding is OfflineReadingBindingView.Absent)

        lockableSeal.locked = false
        var unlockedSnapshot: ReadingStoreSnapshot? = null
        reopened.reconcileAsync { outcome ->
            unlockedSnapshot = when (outcome) {
                is OfflineReadingReconciliationOutcome.Ready -> outcome.snapshot
                is OfflineReadingReconciliationOutcome.Deferred -> outcome.snapshot
                is OfflineReadingReconciliationOutcome.Failed -> throw AssertionError("unlock reconciliation failed", outcome.cause)
            }
        }
        assertTrue(unlockedSnapshot!!.binding is OfflineReadingBindingView.Present)
        assertTrue(
            unlockedSnapshot!!.items.single().availability is OfflineReadingAvailability.Ready
        )
        reopenedDatabase.close()
    }

    @Test
    fun `admitted job owns cold reconciliation without scheduling a second UIDT`() {
        OfflineReadingScheduler.runnerStopped()
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Owned run", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = first.nextRunnableTransfer()!!
        first.updateTransferState(
            transfer.id,
            transfer.stagingName,
            ReadingTransferState.Verifying,
        )
        val admissionsBeforeReopen = scheduler.admissions
        firstDatabase.close()

        OfflineReadingScheduler.claimJobReconciliation()
        try {
            val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
            val reopened = store(reopenedDatabase)
            assertEquals(admissionsBeforeReopen, scheduler.admissions)
            assertTrue(reopened.isReadyForJobDrain())
            assertEquals(
                ReadingTransferState.Restarting(1, ReadingRestartReason.Interrupted),
                (reopened.snapshot().items.single().availability as
                    OfflineReadingAvailability.Transfer).state,
            )
            reopenedDatabase.close()
        } finally {
            OfflineReadingScheduler.finishJobReconciliation()
        }
    }

    @Test
    fun `scheduler admission failure is durable and manual retry recovers`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        val secondMediaId = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        store.enqueue(mediaId, "Admission retry", OfflineReadingMediaKind.WebArticle, 7)
        store.enqueue(secondMediaId, "Second queued copy", OfflineReadingMediaKind.Pdf, 7)
        scheduler.failNextAdmission = true

        val failed = store.setNetworkPolicy(NetworkPolicy.UnmeteredOnly)
        assertEquals(2, failed.items.size)
        assertTrue(failed.items.all {
            (it.availability as OfflineReadingAvailability.Transfer).state ==
                ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired)
        })

        val retried = store.retry(mediaId)
        assertEquals(
            ReadingTransferState.Queued(ReadingQueueReason.WaitingForUnmetered),
            (retried.items.single { it.mediaId == mediaId }.availability as
                OfflineReadingAvailability.Transfer).state,
        )
        assertTrue(scheduler.admissions >= 2)

        val beforeSameValue = scheduler.admissions
        store.setNetworkPolicy(NetworkPolicy.UnmeteredOnly)
        assertEquals(beforeSameValue + 1, scheduler.admissions)
        database.close()
    }

    @Test
    fun `default policy durably reports waiting for unmetered after admission`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)

        val snapshot = store.enqueue(
            mediaId,
            "Waiting copy",
            OfflineReadingMediaKind.WebArticle,
            7,
        )

        assertEquals(NetworkPolicy.UnmeteredOnly, snapshot.networkPolicy)
        assertEquals(
            ReadingTransferState.Queued(ReadingQueueReason.WaitingForUnmetered),
            (snapshot.items.single().availability as OfflineReadingAvailability.Transfer).state,
        )
        assertEquals(1, scheduler.admissions)
        database.close()
    }

    @Test
    fun `Task Manager stop converts every queued item to manual retry instead of stranding a fixed queue`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        val secondMediaId = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "First copy", OfflineReadingMediaKind.WebArticle, 7)
        store.enqueue(secondMediaId, "Second copy", OfflineReadingMediaKind.Pdf, 7)

        assertTrue(store.systemStopAllDurableTransferWork(null, null))

        assertTrue(store.snapshot().items.all {
            (it.availability as OfflineReadingAvailability.Transfer).state ==
                ReadingTransferState.Failed(ReadingFailureReason.SystemStopped)
        })
        assertFalse(store.hasDurableTransferWork())
        database.close()
    }

    @Test
    fun `policy change relabels the passive queue and checkpoints only the live transfer`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        val secondMediaId = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        store.enqueue(mediaId, "First copy", OfflineReadingMediaKind.WebArticle, 7)
        store.enqueue(secondMediaId, "Second copy", OfflineReadingMediaKind.Pdf, 7)

        val connected = store.setNetworkPolicy(NetworkPolicy.AnyConnected)
        assertTrue(connected.items.all {
            (it.availability as OfflineReadingAvailability.Transfer).state ==
                ReadingTransferState.Queued(ReadingQueueReason.Capacity)
        })

        val active = store.nextRunnableTransfer()!!
        val archive = store.stagingArchiveFor(active).apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val verified = archive.parentFile!!.resolve("${active.stagingName}.verified").apply {
            mkdirs()
            resolve("partial").writeText("partial")
        }
        OfflineReadingTransferOperations.register(active.id).use {
            assertTrue(
                store.updateTransferState(
                    active.id,
                    active.stagingName,
                    ReadingTransferState.Authorizing,
                )
            )
            val unmetered = store.setNetworkPolicy(NetworkPolicy.UnmeteredOnly)
            assertEquals(
                ReadingTransferState.Restarting(1, ReadingRestartReason.PolicyChanged),
                (unmetered.items.single { it.mediaId == active.mediaId }.availability as
                    OfflineReadingAvailability.Transfer).state,
            )
            assertEquals(
                ReadingTransferState.Queued(ReadingQueueReason.WaitingForUnmetered),
                (unmetered.items.single { it.mediaId != active.mediaId }.availability as
                    OfflineReadingAvailability.Transfer).state,
            )
            assertFalse(archive.exists())
            assertFalse(verified.exists())
        }
        database.close()
    }

    @Test
    fun `foreign progress attestation preserves stored intent and lets the next writer commit`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val writer = store(database)
        writer.bindAccountAfterExternalPurge(accountId)
        val otherMedia = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142858")
        val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        for (id in listOf(mediaId, otherMedia)) {
            writer.enqueue(id, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
            assertTrue(publishRealPackage(writer, writer.nextRunnableTransfer()!!))
            val installed = writer.snapshot().items.single { it.mediaId == id } as OfflineReadingItemSnapshot.PackageItem
            writer.saveReaderProgress(id, installed.readerGeneration, installed.readerRevisionKey, locator)
        }
        // Choose the first actual queued writer for the external failure, so the
        // second commit establishes continuation after that failure.
        val candidates = writer.pendingSyncCandidates()
        assertEquals(2, candidates.size)
        val failed = candidates[0]
        val succeeding = candidates[1]
        val beforePending = storedRow(database, "offline_reader_progress_pending", failed.mediaId)
        val beforeBaseline = storedRow(database, "offline_reader_progress_baselines", failed.mediaId)
        val otherBaseline = storedRow(database, "offline_reader_progress_baselines", succeeding.mediaId)
        val packages = candidates.associate { it.mediaId to storedRow(database, "offline_reader_packages", it.mediaId) }
        val accepted = """{"state":"Positioned","revision":1,"source":{"kind":"Publication","reader_generation":7},"locator":$locator}"""
        val fetched = mutableListOf<UUID>()
        val synchronizer = OfflineReaderProgressSynchronizer(writer, object : OfflineReaderProgressOriginClient {
            override fun fetch(mediaId: UUID, expectedAccountId: UUID): AttestedRemoteReaderState {
                fetched += mediaId
                assertEquals(accountId, expectedAccountId)
                return AttestedRemoteReaderState(if (mediaId == failed.mediaId) nextAccountId else accountId,
                    7, """{"state":"Empty","revision":0}""")
            }
            override fun compareAndSwap(candidate: ReaderProgressSyncCandidate): RemoteReaderWriteResult {
                assertEquals(succeeding, candidate)
                return RemoteReaderWriteResult.Accepted(AttestedRemoteReaderState(accountId, 7, accepted))
            }
        })
        val escapedDefect = try { synchronizer.synchronize(); null }
            catch (error: IllegalArgumentException) { error }
        database.close()
        assertEquals("one media defect abandoned stored progress pass", null, escapedDefect)
        assertEquals(candidates.map { it.mediaId }, fetched)

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        try {
            val reopened = store(reopenedDatabase)
            assertEquals("foreign attestation changed stored pending bytes", beforePending,
                storedRow(reopenedDatabase, "offline_reader_progress_pending", failed.mediaId))
            assertEquals(beforeBaseline, storedRow(reopenedDatabase, "offline_reader_progress_baselines", failed.mediaId))
            assertEquals(listOf(failed), reopened.pendingSyncCandidates())
            assertFalse(reopenedDatabase.readableDatabase.queryOne(
                "SELECT id FROM offline_reader_progress_pending WHERE media_id = ?",
                arrayOf(succeeding.mediaId.toString()),
            ) {})
            assertEquals("later progress writer was abandoned", otherBaseline + ("server_snapshot_json" to accepted),
                storedRow(reopenedDatabase, "offline_reader_progress_baselines", succeeding.mediaId))
            for ((id, original) in packages) assertEquals(original, storedRow(reopenedDatabase, "offline_reader_packages", id))
            val failedView = (reopened.snapshot().items.single { it.mediaId == failed.mediaId }.availability as OfflineReadingAvailability.Ready).progress
            assertTrue(failedView is NativeReaderProgressView.Pending)
            failedView as NativeReaderProgressView.Pending
            assertEquals(locator, failedView.deviceLocatorJson)
            assertEquals("""{"kind":"Publication","reader_generation":7}""", failedView.sourceJson)
            val successfulView = (reopened.snapshot().items.single { it.mediaId == succeeding.mediaId }.availability as OfflineReadingAvailability.Ready).progress
            assertEquals(NativeReaderProgressView.Canonical(accepted), successfulView)
        } finally { reopenedDatabase.close() }
    }

    @Test
    fun `unrecognized accepted cursor preserves source and intent as a persisted conflict`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val writer = store(database)
        writer.bindAccountAfterExternalPurge(accountId)
        val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        val moved = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":3,"progression":0.5,"total_progression":0.5,"position":3},"text":{"quote":"der","quote_prefix":"rea","quote_suffix":null}}"""
        val mismatches = listOf(
            mediaId to """{"state":"Positioned","revision":1,"source":{"kind":"Publication","reader_generation":7},"locator":$moved}""",
            UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142858") to """{"state":"Positioned","revision":1,"source":{"kind":"Publication","reader_generation":8},"locator":$locator}""",
        )
        val pending = mutableMapOf<UUID, Map<String, String?>>()
        val baselines = mutableMapOf<UUID, Map<String, String?>>()
        val packages = mutableMapOf<UUID, Map<String, String?>>()
        for ((id, response) in mismatches) {
            writer.enqueue(id, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
            assertTrue(publishRealPackage(writer, writer.nextRunnableTransfer()!!))
            val installed = writer.snapshot().items.single { it.mediaId == id } as OfflineReadingItemSnapshot.PackageItem
            writer.saveReaderProgress(id, installed.readerGeneration, installed.readerRevisionKey, locator)
            val submitted = writer.pendingSyncCandidates(id).single()
            pending[id] = storedRow(database, "offline_reader_progress_pending", id)
            baselines[id] = storedRow(database, "offline_reader_progress_baselines", id)
            packages[id] = storedRow(database, "offline_reader_packages", id)
            OfflineReaderProgressSynchronizer(writer, object : OfflineReaderProgressOriginClient {
                override fun fetch(mediaId: UUID, expectedAccountId: UUID): AttestedRemoteReaderState {
                    assertEquals(id, mediaId)
                    assertEquals(accountId, expectedAccountId)
                    return AttestedRemoteReaderState(accountId, 7, """{"state":"Empty","revision":0}""")
                }
                override fun compareAndSwap(candidate: ReaderProgressSyncCandidate): RemoteReaderWriteResult {
                    assertEquals(submitted, candidate)
                    return RemoteReaderWriteResult.Accepted(AttestedRemoteReaderState(accountId, 7, response))
                }
            }).synchronize(id)
        }
        database.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        try {
            val reopened = store(reopenedDatabase)
            assertTrue(reopened.pendingSyncCandidates().isEmpty())
            for ((id, response) in mismatches) {
                val view = (reopened.snapshot().items.single { it.mediaId == id }.availability as OfflineReadingAvailability.Ready).progress
                assertTrue("unrecognized ack lost persisted conflict", view is NativeReaderProgressView.Conflict)
                view as NativeReaderProgressView.Conflict
                assertEquals("unrecognized ack discarded or rebased stored intent", pending.getValue(id) + ("sync_state" to "Conflict"),
                    storedRow(reopenedDatabase, "offline_reader_progress_pending", id))
                assertEquals(baselines.getValue(id) + ("server_snapshot_json" to response),
                    storedRow(reopenedDatabase, "offline_reader_progress_baselines", id))
                assertEquals(packages.getValue(id), storedRow(reopenedDatabase, "offline_reader_packages", id))
                assertEquals(response, view.canonicalJson)
                assertEquals(locator, view.deviceLocatorJson)
                assertEquals("""{"kind":"Publication","reader_generation":7}""", view.sourceJson)
            }
        } finally { reopenedDatabase.close() }
    }

    @Test
    fun `conflicted progress cannot silently rebase until explicit canonical or device choice`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val firstLocator =
            """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":0,"progression":0.1,"total_progression":0.1,"position":1},"text":{"quote":"reader","quote_prefix":null,"quote_suffix":null}}"""
        val movedLocator =
            """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        store.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            firstLocator,
        )
        var candidate = store.pendingSyncCandidates(mediaId).single()
        store.recordConflict(
            candidate,
            AttestedRemoteReaderState(
                accountId,
                7,
                "{\"state\":\"Positioned\",\"revision\":1,\"source\":{\"kind\":\"Publication\",\"reader_generation\":7},\"locator\":$movedLocator}",
            ),
        )

        val conflictAfterMovement = store.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            firstLocator,
        )
        assertTrue(conflictAfterMovement is NativeReaderProgressView.Conflict)
        conflictAfterMovement as NativeReaderProgressView.Conflict
        assertTrue(conflictAfterMovement.canonicalJson.contains("\"revision\":1"))
        assertEquals(firstLocator, conflictAfterMovement.deviceLocatorJson)
        assertTrue(store.pendingSyncCandidates(mediaId).isEmpty())

        assertTrue(resolveProgress(store, useCanonical = true) is
            NativeReaderProgressView.Canonical)
        store.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            firstLocator,
        )
        candidate = store.pendingSyncCandidates(mediaId).single()
        store.recordConflict(
            candidate,
            AttestedRemoteReaderState(
                accountId,
                7,
                "{\"state\":\"Positioned\",\"revision\":2,\"source\":{\"kind\":\"Publication\",\"reader_generation\":7},\"locator\":$movedLocator}",
            ),
        )
        assertTrue(resolveProgress(store, useCanonical = false) is
            NativeReaderProgressView.Pending)
        assertEquals(2, store.pendingSyncCandidates(mediaId).single().baseServerRevision)

        candidate = store.pendingSyncCandidates(mediaId).single()
        store.recordContentChanged(candidate)
        val changed = store.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            movedLocator,
        )
        assertTrue(changed is NativeReaderProgressView.ContentChanged)
        changed as NativeReaderProgressView.ContentChanged
        assertEquals(movedLocator, changed.deviceLocatorJson)
        assertTrue(store.pendingSyncCandidates(mediaId).isEmpty())
        assertTrue(resolveProgress(store, useCanonical = false) is NativeReaderProgressView.ContentChanged)
        assertTrue(resolveProgress(store, useCanonical = true) is NativeReaderProgressView.Canonical)
        database.close()
    }

    @Test
    fun `source unavailable progress remains local until remove`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val locator =
            """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":0,"progression":0.1,"total_progression":0.1,"position":1},"text":{"quote":"reader","quote_prefix":null,"quote_suffix":null}}"""
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        store.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            locator,
        )
        val candidate = store.pendingSyncCandidates(mediaId).single()
        store.recordSourceUnavailable(candidate)

        assertTrue(
            store.saveReaderProgress(
                mediaId,
                installed.readerGeneration,
                installed.readerRevisionKey,
                locator,
            ) is NativeReaderProgressView.SourceUnavailable
        )
        assertThrows(IllegalStateException::class.java) {
            resolveProgress(store, useCanonical = true)
        }
        assertThrows(IllegalStateException::class.java) {
            resolveProgress(store, useCanonical = false)
        }
        val lease = store.open(mediaId)
        assertTrue(lease.resolveEntry("descriptor.json").file.isFile)
        store.closeLease(lease.id)
        database.close()
    }

    @Test
    fun `stale authorization denial cannot fence a successor binding for the same account`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        store.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":0,"progression":0.1,"total_progression":0.1,"position":1},"text":{"quote":"reader","quote_prefix":null,"quote_suffix":null}}""",
        )
        val staleCandidate = store.pendingSyncCandidates(mediaId).single()

        store.logoutAndPurge()
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Fresh intent", OfflineReadingMediaKind.Pdf, 7)
        store.recordAuthorizationRequired(staleCandidate)

        val snapshot = store.snapshot()
        assertFalse((snapshot.binding as OfflineReadingBindingView.Present).authorizationRequired)
        val fresh = snapshot.items.single() as OfflineReadingItemSnapshot.TransferItem
        assertEquals(
            ReadingTransferState.Queued(ReadingQueueReason.WaitingForUnmetered),
            (fresh.availability as OfflineReadingAvailability.Transfer).state,
        )
        database.close()
    }

    @Test
    fun `latest acknowledged locator survives store recreation`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(first, first.nextRunnableTransfer()!!))
        val installed = first.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val firstLocator =
            """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":0,"progression":0.1,"total_progression":0.1,"position":1},"text":{"quote":"reader","quote_prefix":null,"quote_suffix":null}}"""
        val latestLocator =
            """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":3,"progression":0.5,"total_progression":0.5,"position":2},"text":{"quote":"der","quote_prefix":"rea","quote_suffix":null}}"""
        first.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            firstLocator,
        )
        first.saveReaderProgress(
            mediaId,
            installed.readerGeneration,
            installed.readerRevisionKey,
            latestLocator,
        )
        firstDatabase.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        val reopenedItem = reopened.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val progress = (reopenedItem.availability as OfflineReadingAvailability.Ready).progress
        assertTrue(progress is NativeReaderProgressView.Pending)
        assertEquals(latestLocator, (progress as NativeReaderProgressView.Pending).deviceLocatorJson)
        reopenedDatabase.close()
    }

    @Test
    fun `authorization denial fences every remote transfer but keeps installed shelf readable`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val second = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        val third = UUID.fromString("038f2e74-5efc-7d0d-8a3a-142857142857")
        store.enqueue(second, "Needs auth", OfflineReadingMediaKind.Pdf, 7)
        store.enqueue(third, "Also needs auth", OfflineReadingMediaKind.Epub, 7)

        store.remoteAuthorizationDenied()

        val denied = store.snapshot()
        assertTrue((denied.binding as OfflineReadingBindingView.Present).authorizationRequired)
        val deniedTransfers = denied.items.filterIsInstance<OfflineReadingItemSnapshot.TransferItem>()
        assertEquals(2, deniedTransfers.size)
        assertTrue(deniedTransfers.all {
            (it.availability as OfflineReadingAvailability.Transfer).state ==
                ReadingTransferState.Failed(ReadingFailureReason.AuthorizationRequired)
        })
        assertFalse(store.hasDurableTransferWork())
        val lease = store.open(mediaId)
        assertTrue(lease.resolveEntry("descriptor.json").file.isFile)
        store.closeLease(lease.id)

        store.completeAccountTransition(accountId)
        assertFalse(
            (store.snapshot().binding as OfflineReadingBindingView.Present).authorizationRequired
        )
        database.close()
    }

    @Test
    fun `crash after removal bytes delete converges without resurrection`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val packageRow = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val packageId = root.walkTopDown()
            .first { it.isDirectory && it.name.matches(Regex("[0-9a-f-]{36}")) && it.resolve("manifest.json").isFile }
        database.writableDatabase.execSQL(
            "INSERT INTO offline_reader_removals(id, package_id, requested_at) SELECT ?, id, ? FROM offline_reader_packages WHERE media_id = ?",
            arrayOf(UUID.randomUUID().toString(), Instant.now().toString(), packageRow.mediaId.toString()),
        )
        packageId.deleteRecursively()
        database.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        assertTrue(reopened.snapshot().items.isEmpty())
        val tables = listOf(
            "offline_reader_packages",
            "offline_reader_transfers",
            "offline_reader_progress_baselines",
            "offline_reader_progress_pending",
            "offline_reader_removals",
        )
        tables.forEach { table ->
            var count = -1L
            reopenedDatabase.readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use {
                assertTrue(it.moveToFirst())
                count = it.getLong(0)
            }
            assertEquals("expected empty $table", 0, count)
        }
        reopenedDatabase.close()
    }

    @Test
    fun `live-runner reconciliation defers orphan cleanup until no publisher can race`() {
        // A directory that is not in the reconciliation snapshot may be a package that a
        // live runner published AFTER the snapshot was taken. Deleting it from the stale
        // snapshot destroys freshly verified bytes behind a Ready row; cleanup must wait
        // for a reconciliation where bindingLocked fences every publish.
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val bindingDirectory = root.listFiles()!!.single { it.isDirectory }
        val concurrentlyPublished = bindingDirectory
            .resolve("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            .apply {
                check(mkdirs())
                resolve("manifest.json").writeText("published after the snapshot")
            }

        OfflineReadingScheduler.runnerStarted()
        try {
            store.reconcile()
            assertTrue(
                "live-runner reconciliation deleted a directory it did not snapshot",
                concurrentlyPublished.resolve("manifest.json").isFile,
            )
        } finally {
            OfflineReadingScheduler.runnerStopped()
        }

        // Without a live runner no publish can commit, so the same directory is now a
        // genuine orphan and reconciliation converges by deleting it.
        store.reconcile()
        assertFalse(concurrentlyPublished.exists())
        database.close()
    }

    @Test
    fun `stale-policy runner cannot claim queued work after a policy change`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.setNetworkPolicy(NetworkPolicy.AnyConnected)
        val secondMediaId = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        store.enqueue(mediaId, "Active copy", OfflineReadingMediaKind.WebArticle, 7)
        store.enqueue(secondMediaId, "Queued copy", OfflineReadingMediaKind.Pdf, 7)

        val active = (store.claimRunnableTransfer(NetworkPolicy.AnyConnected)
            as OfflineReadingRunnableClaim.Run).transfer
        OfflineReadingTransferOperations.register(active.id).use {
            assertTrue(
                store.updateTransferState(
                    active.id,
                    active.stagingName,
                    ReadingTransferState.Authorizing,
                )
            )
            // The user tightens to unmetered while the AnyConnected runner is mid-drain.
            store.setNetworkPolicy(NetworkPolicy.UnmeteredOnly)
        }

        // The stale runner's granted network belongs to the old constraint: it must not
        // begin the second queued item on that network.
        assertEquals(
            OfflineReadingRunnableClaim.PolicyChanged,
            store.claimRunnableTransfer(NetworkPolicy.AnyConnected),
        )
        // A runner admitted under the new constraint drains the same queue.
        val next = store.claimRunnableTransfer(NetworkPolicy.UnmeteredOnly)
        assertTrue(next is OfflineReadingRunnableClaim.Run)
        database.close()
    }

    @Test
    fun `crash after rename before row publication converges to recovery required`() {
        OfflineReadingScheduler.runnerStopped()
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Renamed copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = first.nextRunnableTransfer()!!
        first.stagingArchiveFor(transfer)
        assertTrue(
            first.updateTransferState(
                transfer.id,
                transfer.stagingName,
                ReadingTransferState.Verifying,
            )
        )
        // Simulate the crash window between the atomic rename (extracted bytes now live at
        // a package directory) and the SQLite publish transaction (no row yet).
        val bindingDirectory = root.listFiles()!!.single { it.isDirectory }
        val orphan = bindingDirectory.resolve("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").apply {
            check(mkdirs())
            resolve("manifest.json").writeText("renamed but never published")
        }
        firstDatabase.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        assertEquals(
            ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
            (reopened.snapshot().items.single().availability as
                OfflineReadingAvailability.Transfer).state,
        )
        assertFalse(orphan.exists())
        reopenedDatabase.close()
    }

    @Test
    fun `unsupported persisted package version converges to recovery instead of poisoning reads`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        database.writableDatabase.execSQL(
            "UPDATE offline_reader_packages SET package_schema_version = 3",
        )
        database.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase)
        // Every read path stays usable and the single unsupported row converges to a
        // typed Failed transfer, never a crash.
        assertEquals(
            ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
            (reopened.snapshot().items.single().availability as
                OfflineReadingAvailability.Transfer).state,
        )
        assertThrows(IllegalStateException::class.java) { reopened.open(mediaId) }
        var packageRows = -1L
        reopenedDatabase.readableDatabase
            .rawQuery("SELECT COUNT(*) FROM offline_reader_packages", null)
            .use {
                assertTrue(it.moveToFirst())
                packageRows = it.getLong(0)
            }
        assertEquals(0, packageRows)
        reopenedDatabase.close()
    }

    @Test
    fun `locked binding seal defers publication as typed deferral not failure`() {
        val lockableSeal = LockableBindingSeal(seal, locked = false)
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database, sealPort = lockableSeal)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Locked copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = store.nextRunnableTransfer()!!
        val artifact = buildWebArticleReadingPackage(mediaId, "Locked copy")
            .stageArtifact(store.stagingArchiveFor(transfer), accountId)
        val verified = store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)!!

        lockableSeal.locked = true
        assertThrows(OfflineReadingBindingSealLockedException::class.java) {
            store.publishVerifiedPackage(
                transfer.id,
                transfer.stagingName,
                verified,
                AttestedOfflineReaderBaseline(
                    accountId, 7, "{\"state\":\"Empty\",\"revision\":0}"
                ),
            )
        }
        assertThrows(OfflineReadingBindingSealLockedException::class.java) {
            store.boundAccountId(transfer.bindingId)
        }
        // The fully downloaded transfer is deferred, never converted to a Failed state.
        val state = (store.snapshot().items.single().availability as
            OfflineReadingAvailability.Transfer).state
        assertFalse(state is ReadingTransferState.Failed)

        lockableSeal.locked = false
        assertTrue(
            store.publishVerifiedPackage(
                transfer.id,
                transfer.stagingName,
                verified,
                AttestedOfflineReaderBaseline(
                    accountId, 7, "{\"state\":\"Empty\",\"revision\":0}"
                ),
            )
        )
        database.close()
    }

    @Test
    fun `keystore key-use failures classify as Locked deferral never destructive purge`() {
        // setUnlockedDeviceRequired keys used while locked surface as InvalidKeyException /
        // KeyStoreException / UnrecoverableKeyException / ProviderException depending on the
        // platform, not only UserNotAuthenticatedException. Every key-use failure must
        // defer (Locked), because Missing/Invalid trigger a destructive purge.
        listOf<Exception>(
            android.security.keystore.UserNotAuthenticatedException(),
            java.security.InvalidKeyException("Keystore operation failed: device locked"),
            java.security.KeyStoreException("ResponseCode.LOCKED"),
            java.security.UnrecoverableKeyException("Failed to obtain information about key"),
            java.security.ProviderException("Keystore operation failed"),
        ).forEach { error ->
            assertEquals(BindingSealStatus.Locked, bindingSealKeyUseStatus(error))
        }
        assertEquals(
            BindingReconciliationAction.DeferUntilUnlocked,
            bindingReconciliationAction(
                bindingSealKeyUseStatus(java.security.InvalidKeyException())
            ),
        )
    }

    @Test
    fun `package failing entry verification never publishes a row or directory`() {
        // Verification-before-publication sensitivity at the host state-machine seam: the
        // archive matches its transport digest but one extracted entry byte diverges from
        // the manifest digest, so the REAL verifier must reject before any publication.
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Tampered copy", OfflineReadingMediaKind.WebArticle, 7)
        val transfer = store.nextRunnableTransfer()!!
        val genuine = buildWebArticleReadingPackage(mediaId, "Tampered copy")
        // Keep valid unit JSON and byte length, while the declared digest stays original.
        val original = genuine.members.single { it.path == "units/intro.json" }
        val tampered = original.bytes.toString(Charsets.UTF_8)
            .replace("\"canonical_text\":\"reader\"", "\"canonical_text\":\"readeX\"").toByteArray()
        check(!tampered.contentEquals(original.bytes) && tampered.size == original.bytes.size)
        val tamperedArchive = encodeCanonicalOfflineReadingZip(genuine.members.map {
            if (it.path == original.path) it.copy(bytes = tampered) else it
        })
        val archiveFile = store.stagingArchiveFor(transfer).apply { writeBytes(tamperedArchive) }
        val artifact = OfflineReadingTransferArtifact(
            archive = archiveFile,
            accountId = accountId,
            readerGeneration = genuine.readerGeneration,
            compressedBytes = tamperedArchive.size.toLong(),
            expandedBytes = genuine.expandedBytes,
            packageSha256 = sha256Hex(tamperedArchive),
        )

        assertThrows(OfflineReadingPackageException::class.java) {
            store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
        }
        assertTrue(
            store.snapshot().items.single().availability is OfflineReadingAvailability.Transfer
        )
        var packageRows = -1L
        database.readableDatabase
            .rawQuery("SELECT COUNT(*) FROM offline_reader_packages", null)
            .use {
                assertTrue(it.moveToFirst())
                packageRows = it.getLong(0)
            }
        assertEquals(0, packageRows)
        val bindingDirectory = root.listFiles()!!.single { it.isDirectory }
        assertTrue(
            bindingDirectory.listFiles()!!.filter { it.isDirectory }
                .all { it.name == ".staging" }
        )
        assertTrue(
            bindingDirectory.resolve(".staging").listFiles()!!.none { it.isDirectory }
        )
        database.close()
    }

    @Test
    fun `conversion checks available disk space before staging`() {
        // The filesystem observation gates staging against the current admission estimate.
        // It neither reserves those bytes nor bounds the converted package's expansion.
        val fixture = InstalledLegacyReadingFixture(File(root, "legacy").apply { check(mkdirs()) })
        try {
            val migration = File(fixture.root, "${fixture.binding}/.staging/${fixture.packageId}.migration")
            val required = StorageAdmissionPolicy.RESERVE_BYTES +
                OFFLINE_READING_FILESYSTEM_OVERHEAD_BYTES + fixture.reader.size
            fun openStore(freeBytes: Long) = OfflineReadingStore(
                fixture.context,
                database = fixture.database,
                seal = fixture.seal,
                rootDirectory = fixture.root,
                freeSpaceBytes = { freeBytes },
                durability = NoOpDurability,
                integrityExecutor = Executor(Runnable::run),
            )

            val refused = openStore(required - 1)
            assertEquals(
                "conversion below the preflight estimate must stay locally retryable",
                OfflineReadingAvailability.UpgradeBlockedByStorage,
                refused.snapshot().items.single().availability,
            )
            assertFalse("refused conversion staged bytes anyway", migration.exists())
            assertTrue(File(fixture.installedDirectory, "reader.json").isFile)

            val admitted = openStore(required)
            assertTrue(
                "admitted conversion must still complete",
                admitted.snapshot().items.single().availability is OfflineReadingAvailability.Ready,
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `retained staging resumes a verified member and drops what the manifest omits`() {
        val directory = File(root, "retained-source")
        val members = OfflineReadingPackageVerifier().verifyAndExtract(
            buildWebArticleReadingPackage(mediaId, "Resumable copy", 7)
                .stageArtifact(File(root, "retained.zip"), accountId),
            accountId,
            mediaId,
            directory,
        )
        val staging = File(root, "retained-staging").apply { assertTrue(mkdirs()) }
        val publication = File(staging, "publication").apply { assertTrue(mkdirs()) }
        val entry = members.manifest.entries.maxByOrNull { it.sizeBytes }!!
        val staged = File(publication, entry.path)
        assertTrue(staged.parentFile!!.mkdirs() || staged.parentFile!!.isDirectory)
        staged.writeBytes(File(directory, entry.path).readBytes())
        // Only a stager that resumes can finish without this source member: a fresh
        // copy of the whole package has to read the file this line removes.
        assertTrue(File(directory, entry.path).delete())
        val abandonedMember = File(publication, "units/abandoned.json").apply {
            assertTrue(parentFile!!.mkdirs() || parentFile!!.isDirectory)
            writeText("{}")
        }
        val abandonedRoot = File(publication, "abandoned.json").apply { writeText("{}") }

        val prepared = stageRetainedReadingPackage(directory, staging)

        assertEquals(
            "resumed staging did not keep the member it had already verified",
            entry.sha256,
            File(prepared.source.extractedDirectory, entry.path).sha256Hex(),
        )
        assertFalse("undeclared nested staging file survived", abandonedMember.exists())
        assertFalse("undeclared staging file survived", abandonedRoot.exists())
    }

    /**
     * Downloads-then-publishes through the production install sequence: canonical archive
     * bytes staged, the REAL package verifier deciding acceptance, then durable publication.
     */
    private fun publishRealPackage(
        store: OfflineReadingStore,
        transfer: OfflineReadingTransfer,
        title: String = "Verified copy",
        readerGeneration: Long = 7,
    ): Boolean {
        val artifact = buildWebArticleReadingPackage(transfer.mediaId, title, readerGeneration)
            .stageArtifact(store.stagingArchiveFor(transfer), accountId)
        val verified = store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
            ?: return false
        return store.publishVerifiedPackage(
            transfer.id,
            transfer.stagingName,
            verified,
            AttestedOfflineReaderBaseline(
                accountId,
                readerGeneration,
                "{\"state\":\"Empty\",\"revision\":0}",
            ),
        )
    }

    private fun storedRow(database: OfflineReadingDatabase, table: String, media: UUID): Map<String, String?> =
        database.readableDatabase.rawQuery("SELECT * FROM $table WHERE media_id = ?", arrayOf(media.toString())).use { cursor ->
            assertTrue("stored $table row is missing for $media", cursor.moveToFirst())
            val row = cursor.columnNames.mapIndexed { index, name -> name to cursor.getString(index) }.toMap()
            assertFalse(cursor.moveToNext())
            row
        }

    private fun resolveProgress(store: OfflineReadingStore, useCanonical: Boolean): NativeReaderProgressView {
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        return store.resolveReaderProgress(mediaId, installed.readerGeneration, installed.readerRevisionKey,
            readerProgressViewJson((installed.availability as OfflineReadingAvailability.Ready).progress), useCanonical)
    }

    private fun store(
        database: OfflineReadingDatabase,
        verifier: OfflineReadingPackageVerifierPort = OfflineReadingPackageVerifier(),
        installedVerifier: OfflineReadingInstalledPackageVerifierPort =
            OfflineReadingInstalledPackageVerifier(),
        integrityExecutor: Executor = Executor(Runnable::run),
        sealPort: OfflineReadingBindingSealPort = seal,
        durabilityPort: OfflineReadingDurability = NoOpDurability,
    ) = OfflineReadingStore(
        context = context,
        database = database,
        seal = sealPort,
        ids = OfflineReadingIdSource { UUID.randomUUID() },
        clock = Clock.fixed(Instant.parse("2026-08-13T18:00:00Z"), ZoneOffset.UTC),
        packageVerifier = verifier,
        installedVerifier = installedVerifier,
        rootDirectory = root,
        durability = durabilityPort,
        schedulerFactory = { scheduler },
        progressOriginFactory = OfflineReaderProgressOriginFactory {
            error("progress sync must not run without an active network")
        },
        integrityExecutor = integrityExecutor,
    )
}

internal class MemoryBindingSeal : OfflineReadingBindingSealPort {
    private var seal: ByteArray? = null

    override fun create(bindingId: UUID, accountId: UUID): ByteArray =
        "${bindingId}:${accountId}".toByteArray().also { seal = it }

    override fun verify(
        bindingId: UUID,
        accountId: UUID,
        expectedSeal: ByteArray,
    ): BindingSealStatus = if (seal?.contentEquals(expectedSeal) == true) {
        BindingSealStatus.Verified
    } else {
        BindingSealStatus.Missing
    }

    override fun deleteKey() {
        seal = null
    }
}

internal data object LockedBindingSeal : OfflineReadingBindingSealPort {
    override fun create(bindingId: UUID, accountId: UUID): ByteArray = error("not used")
    override fun verify(
        bindingId: UUID,
        accountId: UUID,
        expectedSeal: ByteArray,
    ): BindingSealStatus = BindingSealStatus.Locked

    override fun deleteKey() = Unit
}

private class LockableBindingSeal(
    private val delegate: OfflineReadingBindingSealPort,
    var locked: Boolean,
) : OfflineReadingBindingSealPort by delegate {
    override fun verify(
        bindingId: UUID,
        accountId: UUID,
        expectedSeal: ByteArray,
    ): BindingSealStatus = if (locked) {
        BindingSealStatus.Locked
    } else {
        delegate.verify(bindingId, accountId, expectedSeal)
    }
}

private class RecordingScheduler : OfflineReadingSchedulerPort {
    var admissions = 0
    var failNextAdmission = false

    override fun ensureScheduled(): Boolean {
        admissions += 1
        return !failNextAdmission.also { failNextAdmission = false }
    }

    override fun rescheduleForPolicyChange(): Boolean {
        admissions += 1
        return !failNextAdmission.also { failNextAdmission = false }
    }

    override fun suspendForAccountTransition() = Unit
}

internal data object NoOpDurability : OfflineReadingDurability {
    override fun syncTree(directory: File) = Unit
    override fun syncDirectory(directory: File) = Unit
}
