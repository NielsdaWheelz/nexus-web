@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.nexus.android.offline

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadNotificationHelper
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Scheduler
import app.nexus.android.MainActivity
import app.nexus.android.R

private const val OFFLINE_MEDIA_NOTIFICATION_ID = 71
private const val OFFLINE_MEDIA_NOTIFICATION_CHANNEL = "offline_downloads"

class OfflineMediaDownloadService : DownloadService(
    OFFLINE_MEDIA_NOTIFICATION_ID,
    DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL,
    OFFLINE_MEDIA_NOTIFICATION_CHANNEL,
    R.string.offline_download_channel_name,
    R.string.offline_download_channel_description,
) {
    private val store by lazy { OfflineMediaStore.get(this) }
    private val notificationHelper by lazy {
        DownloadNotificationHelper(this, OFFLINE_MEDIA_NOTIFICATION_CHANNEL)
    }

    override fun getDownloadManager(): DownloadManager = store.downloadManager

    override fun getScheduler(): Scheduler? = null

    override fun getForegroundNotification(
        downloads: List<Download>,
        notMetRequirements: Int,
    ): Notification {
        store.publishForegroundProgress(downloads)
        val message = if (notMetRequirements == 0) {
            getString(R.string.offline_download_notification_title)
        } else {
            getString(R.string.offline_download_notification_waiting)
        }
        return notificationHelper.buildProgressNotification(
            this,
            R.drawable.ic_stat_nexus,
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
            message,
            downloads,
            notMetRequirements,
        )
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        store.pauseForSystemLimit()
        super.onTimeout(startId, fgsType)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val result = super.onStartCommand(intent, flags, startId)
        intent?.getStringExtra(EXTRA_ADMIT_DOWNLOAD_ID)?.let { id ->
            downloadManager.setStopReason(id, Download.STOP_REASON_NONE)
        }
        if (intent?.getBooleanExtra(EXTRA_CLEAR_SYSTEM_LIMIT, false) == true) {
            downloadManager.currentDownloads
                .filter { it.stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON }
                .forEach {
                    downloadManager.setStopReason(it.request.id, Download.STOP_REASON_NONE)
                }
        }
        return result
    }

    companion object {
        private const val EXTRA_ADMIT_DOWNLOAD_ID =
            "app.nexus.android.offline.ADMIT_DOWNLOAD_ID"
        private const val EXTRA_CLEAR_SYSTEM_LIMIT =
            "app.nexus.android.offline.CLEAR_SYSTEM_LIMIT"

        fun admit(context: Context, id: String) {
            val intent = buildResumeDownloadsIntent(
                context,
                OfflineMediaDownloadService::class.java,
                true,
            ).putExtra(EXTRA_ADMIT_DOWNLOAD_ID, id)
            ContextCompat.startForegroundService(context, intent)
        }

        fun resume(context: Context) {
            val intent = buildResumeDownloadsIntent(
                context,
                OfflineMediaDownloadService::class.java,
                true,
            ).putExtra(EXTRA_CLEAR_SYSTEM_LIMIT, true)
            ContextCompat.startForegroundService(context, intent)
        }

    }
}
