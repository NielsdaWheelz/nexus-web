package app.nexus.android.offline.reading

import android.content.Context
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineNetworkPolicyStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real JobScheduler/SQLite proofs for the one fixed-ID durable queue handoff. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingSchedulerStoreBoundaryTest {
    private lateinit var context: Context
    private lateinit var root: File
    private lateinit var databaseName: String
    private val seal = MemoryBindingSeal()
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(
            OfflineNetworkPolicyStore.PREFERENCE_FILE,
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
        databaseName = "offline-reading-scheduler-${UUID.randomUUID()}.db"
        root = kotlin.io.path.createTempDirectory("offline-reading-scheduler").toFile()
    }

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
        root.deleteRecursively()
    }

    @Test
    fun `enqueue during jobFinished settle window replaces the finished job instead of trusting it`() {
        // Production `jobFinished` is an asynchronous oneway binder call: JobScheduler keeps
        // reporting the finished fixed JobInfo for a while after the checkpoint releases the
        // admission lock. An enqueue landing in that settle window must schedule a
        // replacement; trusting the visible-but-finished JobInfo strands the item Queued
        // with neither a running nor pending job once JobScheduler settles.
        OfflineReadingScheduler.runnerStopped()
        val database = OfflineReadingDatabase(context, databaseName)
        val schedulerAdmissionAttempted = CountDownLatch(1)
        val schedulerAdmissions = AtomicInteger()
        val store = store(
            database,
            schedulerFactory = { owned ->
                SignalingScheduler(
                    OfflineReadingScheduler(context, owned),
                    schedulerAdmissions,
                    schedulerAdmissionAttempted,
                )
            },
        )
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Initial copy", OfflineReadingMediaKind.WebArticle, 7)
        val jobs = context.getSystemService(android.app.job.JobScheduler::class.java)
        assertEquals(
            NetworkPolicy.UnmeteredOnly.name,
            jobs.getPendingJob(OFFLINE_READING_JOB_ID)
                ?.extras
                ?.getString(OFFLINE_READING_POLICY_EXTRA),
        )
        store.cancel(mediaId)
        assertFalse(store.hasDurableTransferWork())
        val finalizationEntered = CountDownLatch(1)
        val permitJobFinish = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        val secondMediaId = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        try {
            OfflineReadingScheduler.runnerStarted()
            val checkpoint = executor.submit<Boolean> {
                OfflineReadingScheduler.runnerCheckpoint(store) {
                    finalizationEntered.countDown()
                    check(permitJobFinish.await(2, TimeUnit.SECONDS))
                    // Production semantics: jobFinished returns without removing the
                    // JobStatus; the old JobInfo stays visible through this whole window.
                }
            }
            assertTrue(finalizationEntered.await(2, TimeUnit.SECONDS))

            // Distinguish old JobInfo from a replacement through the persisted policy extra.
            OfflineNetworkPolicyStore(context).set(NetworkPolicy.AnyConnected)
            val enqueue = executor.submit {
                store.enqueue(secondMediaId, "Successor copy", OfflineReadingMediaKind.Pdf, 7)
            }
            assertTrue(schedulerAdmissionAttempted.await(2, TimeUnit.SECONDS))
            permitJobFinish.countDown()

            assertFalse(checkpoint.get(2, TimeUnit.SECONDS))
            enqueue.get(2, TimeUnit.SECONDS)
            assertTrue(store.hasDurableTransferWork())

            // JobScheduler settles the finished execution: only the old JobStatus is
            // removed; a replacement scheduled by the enqueue survives settling.
            val pendingBeforeSettle = jobs.getPendingJob(OFFLINE_READING_JOB_ID)
            if (
                pendingBeforeSettle?.extras?.getString(OFFLINE_READING_POLICY_EXTRA) ==
                NetworkPolicy.UnmeteredOnly.name
            ) {
                jobs.cancel(OFFLINE_READING_JOB_ID)
            }
            assertEquals(
                "queued work has neither a running nor pending JobInfo after settle",
                NetworkPolicy.AnyConnected.name,
                jobs.getPendingJob(OFFLINE_READING_JOB_ID)
                    ?.extras
                    ?.getString(OFFLINE_READING_POLICY_EXTRA),
            )
        } finally {
            permitJobFinish.countDown()
            OfflineReadingScheduler.runnerStopped()
            executor.shutdownNow()
            database.close()
        }
    }

    @Test
    fun `enqueue after Task Manager terminalizes old work replaces the stopping fixed job`() {
        OfflineReadingScheduler.runnerStopped()
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(
            database,
            schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) },
        )
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Stopping copy", OfflineReadingMediaKind.WebArticle, 7)
        val jobs = context.getSystemService(android.app.job.JobScheduler::class.java)
        assertEquals(
            NetworkPolicy.UnmeteredOnly.name,
            jobs.getPendingJob(OFFLINE_READING_JOB_ID)
                ?.extras
                ?.getString(OFFLINE_READING_POLICY_EXTRA),
        )
        OfflineReadingScheduler.runnerStarted()
        val stoppedOldWork = CountDownLatch(1)
        val allowStopReturn = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()

        try {
            val stop = executor.submit {
                // onStopJob enters this state before its store mutations. Keep the callback open
                // after it has terminalized old work, while JobScheduler still exposes its ID.
                OfflineReadingScheduler.runnerTerminalizing()
                store.systemStopAllDurableTransferWork(null, null)
                // Android may destroy the service before the old JobInfo disappears.
                OfflineReadingScheduler.runnerDestroyed()
                stoppedOldWork.countDown()
                check(allowStopReturn.await(2, TimeUnit.SECONDS))
            }
            assertTrue(stoppedOldWork.await(2, TimeUnit.SECONDS))

            OfflineNetworkPolicyStore(context).set(NetworkPolicy.AnyConnected)
            store.enqueue(
                UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857"),
                "Successor after Task Manager stop",
                OfflineReadingMediaKind.Pdf,
                7,
            )

            assertTrue(store.hasDurableTransferWork())
            assertEquals(
                NetworkPolicy.AnyConnected.name,
                jobs.getPendingJob(OFFLINE_READING_JOB_ID)
                    ?.extras
                    ?.getString(OFFLINE_READING_POLICY_EXTRA),
            )
            allowStopReturn.countDown()
            stop.get(2, TimeUnit.SECONDS)
        } finally {
            allowStopReturn.countDown()
            OfflineReadingScheduler.runnerStopped()
            executor.shutdownNow()
            database.close()
        }
    }

    @Test
    fun `stale policy job releases reconciliation ownership then replaces the fixed JobInfo`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(
            firstDatabase,
            schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) },
        )
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Stale policy copy", OfflineReadingMediaKind.WebArticle, 7)
        val jobs = context.getSystemService(android.app.job.JobScheduler::class.java)
        assertEquals(
            NetworkPolicy.UnmeteredOnly.name,
            jobs.getPendingJob(OFFLINE_READING_JOB_ID)
                ?.extras
                ?.getString(OFFLINE_READING_POLICY_EXTRA),
        )
        firstDatabase.close()

        OfflineNetworkPolicyStore(context).set(NetworkPolicy.AnyConnected)
        OfflineReadingScheduler.claimJobReconciliation()
        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        val reopened = store(
            reopenedDatabase,
            schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) },
        )
        var completed = false
        try {
            OfflineReadingScheduler.finishJobReconciliation()
            reopened.recoverStalePolicyJob { completed = true }

            assertTrue(completed)
            assertTrue(reopened.hasDurableTransferWork())
            assertEquals(
                NetworkPolicy.AnyConnected.name,
                jobs.getPendingJob(OFFLINE_READING_JOB_ID)
                    ?.extras
                    ?.getString(OFFLINE_READING_POLICY_EXTRA),
            )
        } finally {
            OfflineReadingScheduler.runnerStopped()
            reopenedDatabase.close()
        }
    }

    @Test
    fun `locked stale policy recovery retains fixed job ownership until unlock`() {
        val firstDatabase = OfflineReadingDatabase(context, databaseName)
        val first = store(
            firstDatabase,
            schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) },
        )
        first.bindAccountAfterExternalPurge(accountId)
        first.enqueue(mediaId, "Locked stale-policy copy", OfflineReadingMediaKind.WebArticle, 7)
        val jobs = context.getSystemService(android.app.job.JobScheduler::class.java)
        assertTrue(jobs.getPendingJob(OFFLINE_READING_JOB_ID) != null)
        firstDatabase.close()

        OfflineNetworkPolicyStore(context).set(NetworkPolicy.AnyConnected)
        OfflineReadingScheduler.claimJobReconciliation()
        val lockedDatabase = OfflineReadingDatabase(context, databaseName)
        val locked = store(
            lockedDatabase,
            sealPort = LockedBindingSeal,
            schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) },
        )
        var finish: OfflineReadingStalePolicyJobFinish? = null
        try {
            OfflineReadingScheduler.finishJobReconciliation()
            locked.recoverStalePolicyJob { finish = it }

            assertEquals(OfflineReadingStalePolicyJobFinish.Retry, finish)
            assertTrue(locked.hasDurableTransferWork())
            assertTrue(jobs.getPendingJob(OFFLINE_READING_JOB_ID) != null)
        } finally {
            OfflineReadingScheduler.runnerStopped()
            lockedDatabase.close()
        }
    }

    @Test
    fun `preparing publication defers only its attempt while ready work and explicit retry remain runnable`() {
        OfflineReadingScheduler.runnerStopped()
        val database = OfflineReadingDatabase(context, databaseName)
        var now = Instant.parse("2026-08-13T18:00:00Z")
        val clock = object : Clock() {
            override fun getZone() = ZoneOffset.UTC
            override fun withZone(zone: java.time.ZoneId): Clock = Clock.fixed(now, zone)
            override fun instant(): Instant = now
        }
        val store = store(database, clock = clock, schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) })
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Preparing copy", OfflineReadingMediaKind.WebArticle, 7)
        val first = store.nextRunnableTransfer()!!
        assertTrue(store.awaitPackagePreparation(first.id, first.stagingName))
        val deferred = setOf(first.id to first.stagingName)
        val secondMediaId = UUID.fromString("028f2e74-5efc-7d0d-8a3a-142857142857")
        now = now.plusSeconds(1)
        store.enqueue(secondMediaId, "Ready copy", OfflineReadingMediaKind.Pdf, 8)
        OfflineReadingScheduler.runnerStarted()
        var finished = false
        assertTrue(OfflineReadingScheduler.runnerCheckpoint(store, deferred) { finished = true })
        val next = store.claimRunnableTransfer(NetworkPolicy.UnmeteredOnly, deferred)
        assertTrue(next is OfflineReadingRunnableClaim.Run)
        assertEquals("preparing publication blocked another transfer", secondMediaId,
            (next as OfflineReadingRunnableClaim.Run).transfer.mediaId)
        store.cancel(secondMediaId)
        assertFalse(OfflineReadingScheduler.runnerCheckpoint(store, deferred) { finished = true })
        assertTrue(finished)
        assertTrue(store.hasDurableTransferWork())
        database.close()

        val reopenedDatabase = OfflineReadingDatabase(context, databaseName)
        try {
            val reopened = store(reopenedDatabase, schedulerFactory = { owned -> OfflineReadingScheduler(context, owned) })
            val resumed = reopened.nextRunnableTransfer()!!
            assertEquals(first.id, resumed.id)
            assertEquals(7L, resumed.readerGeneration)
            assertEquals(Instant.parse("2026-08-13T18:00:00Z"), resumed.preparationStartedAt)
            assertTrue(reopened.updateTransferState(resumed.id, resumed.stagingName,
                ReadingTransferState.Failed(ReadingFailureReason.Server)))
            reopened.retry(mediaId)
            val retried = reopened.nextRunnableTransfer(deferred)
            assertTrue("an explicit retry was hidden by the deferred earlier attempt", retried != null)
            assertEquals(first.id, retried!!.id)
            assertTrue(retried.stagingName != first.stagingName)
            assertEquals(7L, retried.readerGeneration)
            assertEquals(null, retried.preparationStartedAt)
        } finally {
            OfflineReadingScheduler.runnerStopped()
            reopenedDatabase.close()
        }
    }

    private fun store(
        database: OfflineReadingDatabase,
        integrityExecutor: Executor = Executor(Runnable::run),
        sealPort: OfflineReadingBindingSealPort = seal,
        clock: Clock = Clock.fixed(Instant.parse("2026-08-13T18:00:00Z"), ZoneOffset.UTC),
        schedulerFactory: (OfflineReadingStore) -> OfflineReadingSchedulerPort,
    ) = OfflineReadingStore(
        context = context,
        database = database,
        seal = sealPort,
        ids = OfflineReadingIdSource { UUID.randomUUID() },
        clock = clock,
        packageVerifier = OfflineReadingPackageVerifier(),
        installedVerifier = OfflineReadingInstalledPackageVerifier(),
        rootDirectory = root,
        durability = NoOpDurability,
        schedulerFactory = schedulerFactory,
        progressOriginFactory = OfflineReaderProgressOriginFactory {
            error("progress sync must not run without an active network")
        },
        integrityExecutor = integrityExecutor,
    )
}

private class SignalingScheduler(
    private val delegate: OfflineReadingSchedulerPort,
    private val admissions: AtomicInteger,
    private val successorAdmissionAttempted: CountDownLatch,
) : OfflineReadingSchedulerPort {
    override fun ensureScheduled(): Boolean {
        if (admissions.incrementAndGet() > 1) successorAdmissionAttempted.countDown()
        return delegate.ensureScheduled()
    }

    override fun rescheduleForPolicyChange(): Boolean = delegate.rescheduleForPolicyChange()

    override fun suspendForAccountTransition() = delegate.suspendForAccountTransition()
}
