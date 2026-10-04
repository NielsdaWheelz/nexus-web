package app.nexus.android.offline

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.text.format.Formatter
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import app.nexus.android.MainActivity
import app.nexus.android.NexusOriginClient
import app.nexus.android.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Dns
import okhttp3.OkHttpClient
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal const val TRANSFER_JOB_ID = 0x4e58444c
internal const val SYNC_JOB_ID = 0x4e585359
private const val NOTIFICATION_ID = 71
private const val CHANNEL_ID = "downloads"

/**
 * The two platform jobs. `transferRun` and `syncRun` name the live runs; the
 * drain's empty check and `schedule` share this lock, so an enqueue is either
 * drained by the live run or schedules the next one.
 */
internal object OfflineJobs {
    private var transferRun: JobParameters? = null
    private var syncRun: JobParameters? = null
    private var syncAgain = false

    /**
     * The user-initiated transfer job, persisted, on the policy's network.
     * Leaves a live drain alone unless `replace` (a policy change), which
     * stops it so its item requeues under the new constraint.
     */
    fun schedule(context: Context, replace: Boolean = false) {
        if (Build.VERSION.SDK_INT < 34) return
        synchronized(this) {
            val store = OfflineStore.get(context)
            val running = transferRun != null
            val idle = if (replace) !running && !store.hasQueued() else running || !store.hasQueued()
            if (idle) return
            val network = if (store.policy == Policy.AnyConnected) JobInfo.NETWORK_TYPE_ANY else JobInfo.NETWORK_TYPE_UNMETERED
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(TRANSFER_JOB_ID, ComponentName(context, OfflineJobService::class.java))
                    .setUserInitiated(true)
                    .setPersisted(true)
                    .setRequiredNetworkType(network)
                    .build(),
            )
        }
    }

    /** The position sync job; scheduling replaces a pending one, a live one runs again after. */
    fun scheduleSync(context: Context, delayMs: Long) {
        synchronized(this) {
            if (syncRun != null) {
                syncAgain = true
                return
            }
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(SYNC_JOB_ID, ComponentName(context, OfflineJobService::class.java))
                    .setMinimumLatency(delayMs)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    fun started(run: JobParameters) {
        synchronized(this) {
            if (run.jobId == TRANSFER_JOB_ID) {
                transferRun = run
            } else {
                syncRun = run
                syncAgain = false
            }
        }
    }

    /** Ends a run; true when a sync was asked for while it ran. */
    fun ended(run: JobParameters): Boolean {
        synchronized(this) {
            if (transferRun === run) transferRun = null
            if (syncRun !== run) return false
            syncRun = null
            return syncAgain.also { syncAgain = false }
        }
    }

    /** The drain's next transfer, past the items this run already requeued; null ends the run. */
    fun next(run: JobParameters, store: OfflineStore, skip: Set<UUID>): Transfer? {
        synchronized(this) {
            if (transferRun !== run) return null
            val transfer = store.startNext(skip)
            if (transfer == null) transferRun = null
            return transfer
        }
    }
}

/** Only ever scheduled on android 14+ (UIDT). */
class OfflineJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val runs = ConcurrentHashMap<Int, Pair<Job, OkHttpClient>>()
    private val store by lazy { OfflineStore.get(this) }

    override fun onStartJob(params: JobParameters): Boolean {
        if (Build.VERSION.SDK_INT < 34) return false
        val http = params.network?.let { network ->
            OkHttpClient.Builder()
                .socketFactory(network.socketFactory)
                .dns(object : Dns {
                    override fun lookup(hostname: String) = network.getAllByName(hostname).toList()
                })
                .build()
        } ?: OkHttpClient()
        val origin = NexusOriginClient(http = http)
        val transfer = params.jobId == TRANSFER_JOB_ID
        OfflineJobs.started(params)
        if (transfer) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.downloads_channel_name), NotificationManager.IMPORTANCE_LOW),
            )
            setNotification(params, NOTIFICATION_ID, notification(), JOB_END_NOTIFICATION_POLICY_REMOVE)
        }
        val job = scope.launch {
            val reschedule = if (transfer) {
                drain(params, http, origin)
            } else {
                val retry = syncPositions(store, origin)
                OfflineJobs.ended(params) || retry
            }
            if (isActive) jobFinished(params, reschedule)
        }
        runs[params.jobId] = job to http
        return true
    }

    @RequiresApi(34)
    override fun onStopJob(params: JobParameters): Boolean {
        val byUser = params.stopReason == JobParameters.STOP_REASON_USER
        OfflineJobs.ended(params)
        if (params.jobId == TRANSFER_JOB_ID) store.stopActive(byUser)
        runs.remove(params.jobId)?.let { (job, http) ->
            job.cancel()
            http.dispatcher.cancelAll()
        }
        return !byUser
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /**
     * startNext → fetch → publish | fail, until nothing is startable. An item
     * requeued by a retryable failure waits out the job's backoff without
     * holding back the items queued behind it.
     */
    @RequiresApi(34)
    private suspend fun drain(params: JobParameters, http: OkHttpClient, origin: NexusOriginClient): Boolean {
        val unsubscribe = store.addListener {
            setNotification(params, NOTIFICATION_ID, notification(), JOB_END_NOTIFICATION_POLICY_REMOVE)
        }
        val requeued = HashSet<UUID>()
        try {
            while (true) {
                currentCoroutineContext().ensureActive()
                val transfer = OfflineJobs.next(params, store, requeued) ?: return requeued.isNotEmpty()
                val onProgress = { received: Long, total: Long? ->
                    if (!store.progress(transfer, received, total)) throw IOException("transfer superseded")
                }
                val retry = try {
                    if (transfer.kind == AUDIO) {
                        fetchAudio(transfer.url!!, transfer.staging, http, onProgress)
                        store.publish(transfer, 0, null)
                    } else {
                        val copy = fetchCopy(transfer.mediaId, store.account, transfer.staging, http, origin, onProgress)
                        store.publish(transfer, copy.generation, copy.baseline)
                    }
                    false
                } catch (failure: TransferFailure) {
                    store.fail(transfer, failure.reason, failure.retryable)
                } catch (_: IOException) {
                    // justify-ignore-error: an interrupted body is a retryable Network failure.
                    store.fail(transfer, "Network", true)
                }
                if (retry) requeued += transfer.mediaId
            }
        } finally {
            unsubscribe()
        }
    }

    private fun notification(): Notification {
        val items = store.snapshot().getJSONArray("items")
        val item = (0 until items.length()).map(items::getJSONObject).firstOrNull { it.getString("state") == "Downloading" }
        val received = item?.getLong("received") ?: 0
        val total = item?.optLong("total") ?: 0
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_nexus)
            .setContentTitle(getString(R.string.downloads_notification_title))
            .setContentText(item?.getString("title"))
            .setSubText(
                if (total > 0) {
                    "${Formatter.formatShortFileSize(this, received)} of ${Formatter.formatShortFileSize(this, total)}"
                } else {
                    null
                },
            )
            .setProgress(100, if (total > 0) (received * 100 / total).toInt() else 0, item != null && total <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(
                PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE),
            )
            .build()
    }
}
