package app.nexus.android.offline.reading

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.Intent
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import app.nexus.android.MainActivity
import app.nexus.android.R
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineNetworkPolicyStore
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

internal const val OFFLINE_READING_NOTIFICATION_ID = 73
private const val OFFLINE_READING_NOTIFICATION_CHANNEL = "offline_reading"

internal fun readingJobCallbackOwnsFinish(
    stopped: Boolean,
    currentRunGeneration: Long,
    callbackGeneration: Long,
): Boolean = !stopped && currentRunGeneration == callbackGeneration

// Only user-initiated data transfer jobs (API 34) reach this service: OfflineReadingScheduler
// schedules it behind requireOfflineReadingSupported(), so the platform never instantiates it
// on an older release.
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class OfflineReadingTransferJobService : JobService() {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "NexusOfflineReadingTransfer").apply { isDaemon = true }
    }
    private val store by lazy { OfflineReadingStore.get(this) }
    private val originClient: OfflineReadingOriginClient by lazy { HttpOfflineReadingOriginClient() }
    @Volatile private var stopped = false
    @Volatile private var activeTransfer: OfflineReadingTransfer? = null
    private val runGeneration = AtomicLong(0)
    private val callbackLock = Any()

    override fun onStartJob(params: JobParameters): Boolean {
        // Construction starts fail-closed reconciliation before this process is advertised as live.
        OfflineReadingScheduler.claimJobReconciliation()
        val generation = synchronized(callbackLock) {
            stopped = false
            runGeneration.incrementAndGet()
        }
        createNotificationChannel()
        setNotification(
            params,
            OFFLINE_READING_NOTIFICATION_ID,
            notification("Preparing downloaded copy"),
            JOB_END_NOTIFICATION_POLICY_REMOVE,
        )
        val initializedStore = store
        if (
            params.extras.getString(OFFLINE_READING_POLICY_EXTRA) !=
            OfflineNetworkPolicyStore(this).get().name
        ) {
            OfflineReadingScheduler.finishJobReconciliation()
            initializedStore.recoverStalePolicyJob { finish ->
                val ownsFinish = synchronized(callbackLock) {
                    readingJobCallbackOwnsFinish(stopped, runGeneration.get(), generation)
                }
                if (ownsFinish) {
                    OfflineReadingScheduler.runnerStopped()
                    jobFinished(params, finish == OfflineReadingStalePolicyJobFinish.Retry)
                }
            }
            return true
        }
        val network = params.network
        if (network == null) {
            executor.execute { finishAwaitingReconciliation(params, generation, reschedule = true) }
            return true
        }
        initializedStore.reconcileForJob { outcome ->
            when (outcome) {
                is OfflineReadingReconciliationOutcome.Ready -> {
                    OfflineReadingScheduler.finishJobReconciliation()
                    if (!initializedStore.isReadyForJobDrain()) {
                        finishAwaitingReconciliation(params, generation, reschedule = true)
                        return@reconcileForJob
                    }
                    val start = synchronized(callbackLock) {
                        if (stopped || runGeneration.get() != generation) {
                            false
                        } else {
                            OfflineReadingScheduler.runnerStarted()
                            true
                        }
                    }
                    if (start) executor.execute { drain(params, network, generation) }
                }
                is OfflineReadingReconciliationOutcome.Deferred -> {
                    OfflineReadingScheduler.finishJobReconciliation()
                    finishAwaitingReconciliation(params, generation, reschedule = true)
                }
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        val shouldReschedule = synchronized(callbackLock) {
            stopped = true
            runGeneration.incrementAndGet()
            // Linearize before mutating the durable queue: an enqueue that overlaps any
            // remaining stop work must replace this fixed JobInfo, not trust the stopping one.
            OfflineReadingScheduler.runnerTerminalizing()
            val transfer = activeTransfer
            val userStop = params.stopReason == JobParameters.STOP_REASON_USER
            if (userStop) {
                store.systemStopAllDurableTransferWork(transfer?.id, transfer?.stagingName)
            }
            val interrupted = if (userStop) null else transfer?.let {
                store.interrupted(it.id, it.stagingName)
            }
            shouldRescheduleStoppedReadingJob(
                userInitiatedStop = userStop,
                interruption = interrupted,
                hasDurableTransferWork = store.hasDurableTransferWork(),
                reconciliationPending = store.reconciliationIsPending(),
            )
        }
        OfflineReadingScheduler.finishJobReconciliation()
        return shouldReschedule
    }

    override fun onDestroy() {
        synchronized(callbackLock) {
            stopped = true
            runGeneration.incrementAndGet()
        }
        OfflineReadingScheduler.runnerDestroyed()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun finishAwaitingReconciliation(
        params: JobParameters,
        generation: Long,
        reschedule: Boolean,
    ) {
        val finish = synchronized(callbackLock) {
            readingJobCallbackOwnsFinish(stopped, runGeneration.get(), generation)
        }
        if (!finish) return
        OfflineReadingScheduler.finishJobReconciliation()
        OfflineReadingScheduler.runnerStopped()
        jobFinished(params, reschedule)
    }

    private fun drain(
        params: JobParameters,
        network: android.net.Network,
        generation: Long,
    ) {
        val admittedPolicy = NetworkPolicy.valueOf(
            params.extras.getString(OFFLINE_READING_POLICY_EXTRA)
                ?: error("offline reading job is missing its admitted network policy"),
        )
        try {
            while (!stopped && runGeneration.get() == generation) {
                val transfer = when (val claim = store.claimRunnableTransfer(admittedPolicy)) {
                    is OfflineReadingRunnableClaim.PolicyChanged -> {
                        // The persisted policy no longer matches this runner's admitted
                        // constraint: JobParameters.network was granted for the old policy.
                        // setNetworkPolicy already cancelled this job and scheduled the
                        // replacement JobInfo; finish without claiming any further work.
                        synchronized(callbackLock) {
                            if (
                                readingJobCallbackOwnsFinish(
                                    stopped,
                                    runGeneration.get(),
                                    generation,
                                )
                            ) {
                                OfflineReadingScheduler.runnerStopped()
                                jobFinished(params, false)
                            }
                        }
                        return
                    }
                    is OfflineReadingRunnableClaim.Idle -> {
                        if (!OfflineReadingScheduler.runnerCheckpoint(store) {
                                jobFinished(params, false)
                            }
                        ) {
                            return
                        }
                        continue
                    }
                    is OfflineReadingRunnableClaim.Run -> claim.transfer
                }
                synchronized(callbackLock) {
                    if (stopped || runGeneration.get() != generation) return
                    activeTransfer = transfer
                }
                val step = process(
                    params,
                    network,
                    transfer,
                    TransferRunFence(generation, transfer.id, transfer.stagingName),
                )
                synchronized(callbackLock) { activeTransfer = null }
                if (step == TransferStep.DeferUntilUnlocked) {
                    // The Keystore binding key is unusable until the device unlocks. The
                    // durable intent stays queued; ask JobScheduler for a later retry
                    // instead of failing a fully downloaded transfer.
                    synchronized(callbackLock) {
                        if (
                            readingJobCallbackOwnsFinish(stopped, runGeneration.get(), generation)
                        ) {
                            OfflineReadingScheduler.runnerStopped()
                            jobFinished(params, true)
                        }
                    }
                    return
                }
            }
        } catch (_: Exception) {
            synchronized(callbackLock) {
                activeTransfer?.let { transfer ->
                    if (runGeneration.get() == generation && !stopped) {
                        store.updateTransferState(
                            transfer.id,
                            transfer.stagingName,
                            ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
                        )
                    }
                }
                if (runGeneration.get() == generation && !stopped) {
                    activeTransfer = null
                    OfflineReadingScheduler.runnerStopped()
                    // A terminal runner fault may have left later intent rows untouched.
                    // Ask JobScheduler for one fresh drain rather than stranding that durable queue.
                    jobFinished(params, true)
                }
            }
        } finally {
            synchronized(callbackLock) { activeTransfer = null }
        }
    }

    private enum class TransferStep { Continue, DeferUntilUnlocked }

    private fun process(
        params: JobParameters,
        network: android.net.Network,
        transfer: OfflineReadingTransfer,
        fence: TransferRunFence,
    ): TransferStep {
        OfflineReadingTransferOperations.register(transfer.id).use { operation ->
            return processWithOperation(params, network, transfer, fence, operation)
        }
    }

    private fun processWithOperation(
        params: JobParameters,
        network: android.net.Network,
        transfer: OfflineReadingTransfer,
        fence: TransferRunFence,
        operation: OfflineReadingTransferOperation,
    ): TransferStep {
        try {
            mutateIfCurrent(fence) {
                store.updateTransferState(
                transfer.id,
                transfer.stagingName,
                ReadingTransferState.Authorizing,
                )
            }
            mutateIfCurrent(fence) {
                setNotification(
                    params,
                    OFFLINE_READING_NOTIFICATION_ID,
                    notification("Authorizing downloaded copy"),
                    JOB_END_NOTIFICATION_POLICY_REMOVE,
                )
            }
            val accountId = store.boundAccountId(transfer.bindingId)
            var lastPersistedBytes = -1L
            // Install steps 2-4: mint the token and download to a unique staging file.
            val artifact = originClient.downloadPackage(
                transfer,
                accountId,
                network,
                store.stagingArchiveFor(transfer),
                operation,
            ) { received, total ->
                if (received == total || received - lastPersistedBytes >= PROGRESS_CHECKPOINT_BYTES) {
                    lastPersistedBytes = received
                    mutateIfCurrent(fence) {
                        store.updateTransferState(
                            transfer.id,
                            transfer.stagingName,
                            ReadingTransferState.Downloading(received, total),
                        )
                        setNotification(
                            params,
                            OFFLINE_READING_NOTIFICATION_ID,
                            notification("Downloading copy · $received of $total bytes"),
                            JOB_END_NOTIFICATION_POLICY_REMOVE,
                        )
                        }
                }
            }
            if (!callbackIsCurrent(fence)) return TransferStep.Continue
            mutateIfCurrent(fence) {
                store.updateTransferState(
                    transfer.id,
                    transfer.stagingName,
                    ReadingTransferState.Verifying,
                )
            }
            mutateIfCurrent(fence) {
                setNotification(
                    params,
                    OFFLINE_READING_NOTIFICATION_ID,
                    notification("Verifying downloaded copy"),
                    JOB_END_NOTIFICATION_POLICY_REMOVE,
                )
            }
            // Install step 5 fully precedes step 6: a package that fails verification
            // never triggers the authenticated reader-state baseline round-trip.
            val verified = if (callbackIsCurrent(fence)) {
                store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
            } else {
                null
            }
            if (verified != null) {
                val baseline = originClient.fetchBaseline(
                    transfer,
                    accountId,
                    network,
                    artifact.readerGeneration,
                    operation,
                )
                if (callbackIsCurrent(fence)) {
                    store.publishVerifiedPackage(
                        transfer.id,
                        transfer.stagingName,
                        verified,
                        baseline,
                    )
                }
            }
            artifact.archive.delete()
        } catch (_: OfflineReadingBindingSealLockedException) {
            mutateIfCurrent(fence) {
                store.updateTransferState(
                    transfer.id,
                    transfer.stagingName,
                    ReadingTransferState.Queued(ReadingQueueReason.Scheduler),
                )
            }
            return TransferStep.DeferUntilUnlocked
        } catch (error: OfflineReadingOriginException) {
            mutateIfCurrent(fence) {
                if (error.reason == ReadingFailureReason.AuthorizationRequired) {
                    store.remoteAuthorizationDenied()
                } else {
                    store.updateTransferState(
                        transfer.id,
                        transfer.stagingName,
                        ReadingTransferState.Failed(error.reason),
                    )
                }
            }
        } catch (error: OfflineReadingPackageException) {
            mutateIfCurrent(fence) { store.updateTransferState(
                transfer.id,
                transfer.stagingName,
                ReadingTransferState.Failed(error.reason),
            ) }
        } catch (_: IllegalArgumentException) {
            mutateIfCurrent(fence) { store.updateTransferState(
                transfer.id,
                transfer.stagingName,
                ReadingTransferState.Failed(ReadingFailureReason.Integrity),
            ) }
        } catch (_: Exception) {
            mutateIfCurrent(fence) {
                store.updateTransferState(
                    transfer.id,
                    transfer.stagingName,
                    ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
                )
            }
        }
        return TransferStep.Continue
    }

    private fun callbackIsCurrent(fence: TransferRunFence): Boolean =
        transferCallbackIsCurrent(fence, runGeneration.get(), stopped)

    private inline fun mutateIfCurrent(fence: TransferRunFence, action: () -> Unit) {
        synchronized(callbackLock) {
            if (callbackIsCurrent(fence)) action()
        }
    }

    private fun notification(message: String) = NotificationCompat.Builder(
        this,
        OFFLINE_READING_NOTIFICATION_CHANNEL,
    )
        .setSmallIcon(R.drawable.ic_stat_nexus)
        .setContentTitle("Offline reading")
        .setContentText(message)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        )
        .build()

    private fun createNotificationChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                OFFLINE_READING_NOTIFICATION_CHANNEL,
                "Offline reading",
                NotificationManager.IMPORTANCE_LOW,
            )
        )
    }

    private companion object {
        const val PROGRESS_CHECKPOINT_BYTES = 1024L * 1024L
    }
}
