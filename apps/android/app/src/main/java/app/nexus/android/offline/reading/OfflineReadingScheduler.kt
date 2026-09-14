package app.nexus.android.offline.reading

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.PersistableBundle
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineNetworkPolicyStore

internal const val OFFLINE_READING_JOB_ID = 0x4e58524f

internal interface OfflineReadingSchedulerPort {
    fun ensureScheduled(): Boolean
    fun rescheduleForPolicyChange(): Boolean
    fun suspendForAccountTransition()
}

internal class OfflineReadingScheduler(
    context: Context,
    private val store: OfflineReadingStore,
) : OfflineReadingSchedulerPort {
    private val appContext = context.applicationContext
    private val jobs = appContext.getSystemService(JobScheduler::class.java)

    override fun ensureScheduled(): Boolean {
        synchronized(QUEUE_LOCK) {
            val queuedWork = store.hasQueuedWork()
            if (!queuedWork) return true
            if (runnerActive) return true
            // JobScheduler still reports the fixed JobInfo while onStopJob is returning. It is
            // not an admitted successor: replace it for an enqueue that races that terminal path.
            if (runnerTerminalizing) {
                val admitted = jobs.schedule(buildJob()) == JobScheduler.RESULT_SUCCESS
                if (admitted) runnerTerminalizing = false
                return admitted
            }
            if (
                !shouldScheduleOfflineReadingJob(
                    queuedWork,
                    jobs.getPendingJob(OFFLINE_READING_JOB_ID) != null,
                )
            ) {
                return true
            }
            return jobs.schedule(buildJob()) == JobScheduler.RESULT_SUCCESS
        }
    }

    override fun rescheduleForPolicyChange(): Boolean {
        synchronized(QUEUE_LOCK) {
            jobs.cancel(OFFLINE_READING_JOB_ID)
            runnerActive = false
            runnerTerminalizing = false
            if (store.hasQueuedWork()) {
                return jobs.schedule(buildJob()) == JobScheduler.RESULT_SUCCESS
            }
            return true
        }
    }

    override fun suspendForAccountTransition() {
        synchronized(QUEUE_LOCK) {
            jobs.cancel(OFFLINE_READING_JOB_ID)
            runnerActive = false
            runnerTerminalizing = false
        }
    }

    private fun buildJob(): JobInfo {
        requireOfflineReadingSupported()
        val builder = JobInfo.Builder(
            OFFLINE_READING_JOB_ID,
            ComponentName(appContext, OfflineReadingTransferJobService::class.java),
        )
            .setPersisted(true)
            .setUserInitiated(true)
            // This backoff is the cadence of the whole runner, including the status
            // observation justified at OfflineReadingOriginClient.downloadPackage
            // (justify-polling): server-side archive preparation has no completion
            // channel, so each retry of this job reads status once.
            .setBackoffCriteria(JobInfo.DEFAULT_INITIAL_BACKOFF_MILLIS, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
        val policy = OfflineNetworkPolicyStore(appContext).get()
        builder.setExtras(
            PersistableBundle().apply { putString(OFFLINE_READING_POLICY_EXTRA, policy.name) }
        )
        builder.setRequiredNetworkType(offlineReadingRequiredNetworkType(policy))
        return builder.build()
    }

    companion object {
        private val QUEUE_LOCK = Any()
        private var runnerActive = false
        private var runnerTerminalizing = false
        private var jobReconciliationClaimed = false

        fun claimJobReconciliation() {
            synchronized(QUEUE_LOCK) { jobReconciliationClaimed = true }
        }

        fun finishJobReconciliation() {
            synchronized(QUEUE_LOCK) { jobReconciliationClaimed = false }
        }

        fun jobOwnsReconciliation(): Boolean =
            synchronized(QUEUE_LOCK) { jobReconciliationClaimed }

        fun runnerStarted() {
            synchronized(QUEUE_LOCK) {
                runnerActive = true
                runnerTerminalizing = false
            }
        }

        fun runnerIsActive(): Boolean = synchronized(QUEUE_LOCK) { runnerActive }

        /**
         * The empty decision and JobScheduler completion share the enqueue admission lock.
         * A concurrent enqueue either precedes this check and is drained by this run, or
         * schedules a replacement for the finishing job. `jobFinished` is asynchronous:
         * JobScheduler may keep reporting this fixed JobInfo after the lock is released, so
         * the checkpoint stays `runnerTerminalizing` — an enqueue in that settle window must
         * replace the finishing job, never trust the visible-but-doomed JobInfo. The next
         * `runnerStarted`/admission clears the state.
         */
        fun runnerCheckpoint(
            store: OfflineReadingStore,
            deferred: Set<Pair<java.util.UUID, String>> = emptySet(),
            finishJob: () -> Unit,
        ): Boolean {
            synchronized(QUEUE_LOCK) {
                if (store.hasQueuedWork(deferred)) return true
                runnerActive = false
                runnerTerminalizing = true
                finishJob()
                return false
            }
        }

        /**
         * Linearizes JobService.onStopJob before it returns its terminal decision. While this
         * state is set, the visible fixed JobInfo is the stopping runner, never a successor.
         */
        fun runnerTerminalizing() {
            synchronized(QUEUE_LOCK) {
                runnerActive = false
                runnerTerminalizing = true
            }
        }

        /** A destroyed runner may still have a visible fixed JobInfo until JobScheduler settles. */
        fun runnerDestroyed() = runnerTerminalizing()

        fun runnerStopped() {
            synchronized(QUEUE_LOCK) {
                runnerActive = false
                runnerTerminalizing = false
            }
        }
    }
}

internal fun offlineReadingRequiredNetworkType(policy: NetworkPolicy): Int = when (policy) {
    NetworkPolicy.UnmeteredOnly -> JobInfo.NETWORK_TYPE_UNMETERED
    NetworkPolicy.AnyConnected -> JobInfo.NETWORK_TYPE_ANY
}

internal const val OFFLINE_READING_POLICY_EXTRA = "offline_reading_network_policy"
