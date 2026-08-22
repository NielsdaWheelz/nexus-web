package app.nexus.android.offline.reading

import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineNetworkPolicyStore
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
    fun `SQLite and files survive recreate then lease gates removal and account switch purges`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(firstDatabase)
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
        assertEquals(1, scheduler.admissions)
        assertTrue(publishRealPackage(first, first.nextRunnableTransfer()!!))
        val firstLease = first.open(mediaId)
        assertTrue(firstLease.resolveEntry("reader.json").readText().contains("readerContractVersion"))
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

        reopened.enqueue(mediaId, "Second copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        root.walkTopDown().single { it.name == "reader.json" }.writeText("corrupt")

        store.reconcile()
        assertThrows(IllegalStateException::class.java) { store.open(mediaId) }
        val recovery = store.snapshot().items.single().availability as OfflineReadingAvailability.Transfer
        assertEquals(
            ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
            recovery.state,
        )
        database.close()
    }

    @Test
    fun `every enumerated failure deletes and fences staging bytes`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Failed copy", OfflineReadingMediaKind.WebArticle)
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
        val queued = store.enqueue(mediaId, "Wrong kind", OfflineReadingMediaKind.Pdf)

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
        initial.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
        assertTrue(publishRealPackage(initial, initial.nextRunnableTransfer()!!))
        initialDatabase.close()

        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val blockedVerifier = OfflineReadingInstalledPackageVerifierPort { installed, directory ->
            entered.countDown()
            try {
                check(release.await(5, TimeUnit.SECONDS))
                OfflineReadingInstalledPackageVerifier().isValid(installed, directory)
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
        first.enqueue(mediaId, "Interrupted copy", OfflineReadingMediaKind.WebArticle)
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
        first.enqueue(mediaId, "Live copy", OfflineReadingMediaKind.WebArticle)
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
        first.enqueue(mediaId, "Locked copy", OfflineReadingMediaKind.WebArticle)
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
        first.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
        assertTrue(publishRealPackage(first, first.nextRunnableTransfer()!!))
        database.close()

        val lockableSeal = LockableBindingSeal(seal, locked = true)
        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(reopenedDatabase, sealPort = lockableSeal)
        assertTrue(reopened.snapshot().binding is OfflineReadingBindingView.Absent)

        lockableSeal.locked = false
        var unlockedSnapshot: ReadingStoreSnapshot? = null
        reopened.reconcileAsync { unlockedSnapshot = it }
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
        first.enqueue(mediaId, "Owned run", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Admission retry", OfflineReadingMediaKind.WebArticle)
        store.enqueue(secondMediaId, "Second queued copy", OfflineReadingMediaKind.Pdf)
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
        store.enqueue(mediaId, "First copy", OfflineReadingMediaKind.WebArticle)
        store.enqueue(secondMediaId, "Second copy", OfflineReadingMediaKind.Pdf)

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
        store.enqueue(mediaId, "First copy", OfflineReadingMediaKind.WebArticle)
        store.enqueue(secondMediaId, "Second copy", OfflineReadingMediaKind.Pdf)

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
    fun `conflicted progress cannot silently rebase until explicit canonical or device choice`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
                "{\"state\":\"Positioned\",\"revision\":1,\"locator\":$movedLocator}",
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

        assertTrue(store.resolveReaderProgress(mediaId, useCanonical = true) is
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
                "{\"state\":\"Positioned\",\"revision\":2,\"locator\":$movedLocator}",
            ),
        )
        assertTrue(store.resolveReaderProgress(mediaId, useCanonical = false) is
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
        assertThrows(IllegalStateException::class.java) {
            store.resolveReaderProgress(mediaId, useCanonical = true)
        }
        assertThrows(IllegalStateException::class.java) {
            store.resolveReaderProgress(mediaId, useCanonical = false)
        }
        database.close()
    }

    @Test
    fun `source unavailable progress remains local until remove`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
            store.resolveReaderProgress(mediaId, useCanonical = true)
        }
        assertThrows(IllegalStateException::class.java) {
            store.resolveReaderProgress(mediaId, useCanonical = false)
        }
        val lease = store.open(mediaId)
        assertTrue(lease.resolveEntry("reader.json").isFile)
        store.closeLease(lease.id)
        database.close()
    }

    @Test
    fun `stale authorization denial cannot fence a successor binding for the same account`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Fresh intent", OfflineReadingMediaKind.Pdf)
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
        first.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val second = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        val third = UUID.fromString("038f2e74-5efc-7d0d-8a3a-142857142857")
        store.enqueue(second, "Needs auth", OfflineReadingMediaKind.Pdf)
        store.enqueue(third, "Also needs auth", OfflineReadingMediaKind.Epub)

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
        assertTrue(lease.resolveEntry("reader.json").isFile)
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
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Active copy", OfflineReadingMediaKind.WebArticle)
        store.enqueue(secondMediaId, "Queued copy", OfflineReadingMediaKind.Pdf)

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
        first.enqueue(mediaId, "Renamed copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Verified copy", OfflineReadingMediaKind.WebArticle)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        database.writableDatabase.execSQL(
            "UPDATE offline_reader_packages SET package_schema_version = 2",
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
        store.enqueue(mediaId, "Locked copy", OfflineReadingMediaKind.WebArticle)
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
        store.enqueue(mediaId, "Tampered copy", OfflineReadingMediaKind.WebArticle)
        val transfer = store.nextRunnableTransfer()!!
        val genuine = buildWebArticleReadingPackage(mediaId, "Tampered copy")
        // The tampered byte keeps reader.json structurally valid: only the manifest's
        // per-entry digest check can observe the divergence.
        val tamperedReader = genuine.readerJson.toString(Charsets.UTF_8)
            .replace("\"canonicalText\":\"reader\"", "\"canonicalText\":\"readeX\"")
            .toByteArray()
        check(!tamperedReader.contentEquals(genuine.readerJson))
        check(tamperedReader.size == genuine.readerJson.size)
        val tamperedArchive = encodeCanonicalOfflineReadingZip(
            listOf(
                CanonicalZipMember("manifest.json", genuine.manifestJson),
                CanonicalZipMember("reader.json", tamperedReader),
            )
        )
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

    private fun store(
        database: OfflineReadingDatabase,
        verifier: OfflineReadingPackageVerifierPort = OfflineReadingPackageVerifier(),
        installedVerifier: OfflineReadingInstalledPackageVerifierPort =
            OfflineReadingInstalledPackageVerifier(),
        integrityExecutor: Executor = Executor(Runnable::run),
        sealPort: OfflineReadingBindingSealPort = seal,
    ) = OfflineReadingStore(
        context = context,
        database = database,
        seal = sealPort,
        ids = OfflineReadingIdSource { UUID.randomUUID() },
        clock = Clock.fixed(Instant.parse("2026-08-13T18:00:00Z"), ZoneOffset.UTC),
        packageVerifier = verifier,
        installedVerifier = installedVerifier,
        rootDirectory = root,
        durability = NoOpDurability,
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
