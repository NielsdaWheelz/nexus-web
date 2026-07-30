@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package app.nexus.android.offline

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.C
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSourceInputStream
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.offline.DefaultDownloadIndex
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.scheduler.Requirements
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal const val OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON = 10_001
internal const val OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON = 10_002
private const val DURABLE_INDEX_MUTATION_ATTEMPTS = 3
private const val SYSTEM_LIMIT_FENCE_TIMEOUT_MS = 1_500L
private const val OFFLINE_MEDIA_CACHE_DIRECTORY = "offline-media"
private const val OFFLINE_MEDIA_DOWNLOAD_INDEX_NAME = "offline_media"
private const val OFFLINE_MEDIA_PREFERENCES = "offline_media_policy"
private const val NETWORK_POLICY_KEY = "network_policy"
private const val LOG_TAG = "NexusOfflineMedia"

internal data class OfflineMediaRead(
    val statusCode: Int,
    val reasonPhrase: String,
    val contentType: String,
    val contentLength: Long,
    val contentRange: String?,
    val body: InputStream,
)

internal sealed interface RequestedByteRange {
    data class Satisfiable(
        val start: Long,
        val length: Long,
        val contentRange: String?,
    ) : RequestedByteRange

    data object Unsatisfiable : RequestedByteRange

    companion object {
        fun parse(header: String?, size: Long): RequestedByteRange {
            require(size > 0)
            if (header == null) {
                return Satisfiable(0, size, null)
            }
            if (!header.startsWith("bytes=") || header.indexOf(',') >= 0) {
                return Unsatisfiable
            }
            val value = header.removePrefix("bytes=")
            val separator = value.indexOf('-')
            if (separator < 0 || separator != value.lastIndexOf('-')) {
                return Unsatisfiable
            }
            val startText = value.substring(0, separator)
            val endText = value.substring(separator + 1)
            if (startText.isEmpty()) {
                val suffixLength = endText.toLongOrNull()
                    ?.takeIf { it > 0 }
                    ?: return Unsatisfiable
                val length = minOf(suffixLength, size)
                val start = size - length
                return Satisfiable(
                    start,
                    length,
                    "bytes $start-${size - 1}/$size",
                )
            }
            val start = startText.toLongOrNull()
                ?.takeIf { it >= 0 && it < size }
                ?: return Unsatisfiable
            val end = if (endText.isEmpty()) {
                size - 1
            } else {
                endText.toLongOrNull()
                    ?.takeIf { it >= start }
                    ?.let { minOf(it, size - 1) }
                    ?: return Unsatisfiable
            }
            return Satisfiable(
                start,
                end - start + 1,
                "bytes $start-$end/$size",
            )
        }
    }
}

internal object ProgressiveContainerVerifier {
    fun accepts(contentType: String, header: ByteArray): Boolean {
        return when (contentType) {
            "audio/mpeg", "audio/mp3" -> isMp3(header)
            "audio/mp4", "audio/x-m4a" -> isM4a(header)
            else -> false
        }
    }

    private fun isMp3(header: ByteArray): Boolean {
        if (header.size >= 3 && header.copyOfRange(0, 3).contentEquals("ID3".toByteArray())) {
            return true
        }
        if (header.size < 3) {
            return false
        }
        val first = header[0].toInt() and 0xff
        val second = header[1].toInt() and 0xff
        val third = header[2].toInt() and 0xff
        val version = second shr 3 and 0x3
        val layer = second shr 1 and 0x3
        val bitrate = third shr 4 and 0xf
        val sampleRate = third shr 2 and 0x3
        return first == 0xff &&
            second and 0xe0 == 0xe0 &&
            version != 1 &&
            layer != 0 &&
            bitrate !in setOf(0, 15) &&
            sampleRate != 3
    }

    private fun isM4a(header: ByteArray): Boolean {
        if (header.size < 12 || !header.copyOfRange(4, 8).contentEquals("ftyp".toByteArray())) {
            return false
        }
        val brands = buildList {
            add(header.copyOfRange(8, 12).toString(Charsets.US_ASCII))
            var offset = 16
            while (offset + 4 <= header.size) {
                add(header.copyOfRange(offset, offset + 4).toString(Charsets.US_ASCII))
                offset += 4
            }
        }
        return brands.any { it in AUDIO_MP4_BRANDS }
    }

    private val AUDIO_MP4_BRANDS = setOf("M4A ", "M4B ", "mp41", "mp42", "isom", "iso2")
}

internal fun projectMedia3State(
    state: Int,
    stopReason: Int,
    bytesDownloaded: Long,
    contentLength: Long,
    metadataContentLength: Presence<Long>,
    queueReason: QueueReason,
    ready: NativeLocalAvailability.Ready?,
): NativeLocalAvailability {
    return when (state) {
        Download.STATE_QUEUED ->
            NativeLocalAvailability.Queued(queueReason)
        Download.STATE_STOPPED ->
            when (stopReason) {
                OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON ->
                    NativeLocalAvailability.Queued(QueueReason.SystemLimit)
                OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON ->
                    NativeLocalAvailability.Failed
                else -> throw OfflineMediaCorruptionException(
                    "unknown offline media stop reason $stopReason"
                )
            }
        Download.STATE_DOWNLOADING ->
            NativeLocalAvailability.Downloading(
                bytesDownloaded,
                contentLength
                    .takeIf { it != C.LENGTH_UNSET.toLong() }
                    ?.let(Presence<Long>::Present)
                    ?: metadataContentLength,
            )
        Download.STATE_COMPLETED -> ready ?: NativeLocalAvailability.Failed
        Download.STATE_FAILED -> NativeLocalAvailability.Failed
        Download.STATE_REMOVING -> NativeLocalAvailability.Removing
        Download.STATE_RESTARTING -> NativeLocalAvailability.Restarting
        else -> throw OfflineMediaCorruptionException(
            "unknown Media3 download state $state"
        )
    }
}

internal fun admissionIsCurrent(
    canceled: Boolean,
    expectedAccountId: UUID,
    expectedGeneration: Long,
    currentAccountId: UUID?,
    currentGeneration: Long,
): Boolean {
    return !canceled &&
        currentAccountId == expectedAccountId &&
        currentGeneration == expectedGeneration
}

internal fun durableDownloadMatches(
    expected: Download,
    actual: Download?,
): Boolean {
    return actual != null &&
        actual.request == expected.request &&
        actual.state == expected.state &&
        actual.startTimeMs == expected.startTimeMs &&
        actual.updateTimeMs == expected.updateTimeMs &&
        actual.contentLength == expected.contentLength &&
        actual.stopReason == expected.stopReason &&
        actual.failureReason == expected.failureReason &&
        actual.bytesDownloaded == expected.bytesDownloaded &&
        actual.percentDownloaded.toBits() == expected.percentDownloaded.toBits()
}

internal fun <T> ensureDurableMutation(
    expected: T,
    read: () -> T?,
    write: (T) -> Unit,
    matches: (T, T?) -> Boolean = { left, right -> left == right },
): Boolean {
    repeat(DURABLE_INDEX_MUTATION_ATTEMPTS) {
        val current = try {
            read()
        } catch (_: IOException) {
            null
        }
        if (matches(expected, current)) {
            return true
        }
        try {
            write(expected)
        } catch (_: IOException) {
            // The bounded retry below owns transient index I/O failure.
        }
    }
    return try {
        matches(expected, read())
    } catch (_: IOException) {
        false
    }
}

internal fun <T> ensureDurableRemoval(
    read: () -> T?,
    remove: () -> Unit,
): Boolean {
    repeat(DURABLE_INDEX_MUTATION_ATTEMPTS) {
        val current = try {
            read()
        } catch (_: IOException) {
            return@repeat
        }
        if (current == null) {
            return true
        }
        try {
            remove()
        } catch (_: IOException) {
            // The bounded retry below owns transient index I/O failure.
        }
    }
    return try {
        read() == null
    } catch (_: IOException) {
        false
    }
}

internal fun ensureDurableDownload(
    expected: Download,
    read: () -> Download?,
    write: (Download) -> Unit,
): Boolean {
    return ensureDurableMutation(
        expected,
        read,
        write,
        ::durableDownloadMatches,
    )
}

internal fun observeDurableDownloadNotification(
    notification: Download,
    read: () -> Download?,
    write: (Download) -> Unit,
): Download? {
    return observeDurableNotification(
        notification,
        read,
        write,
        ::durableDownloadMatches,
        ::durableDownloadSupersedes,
    )
}

internal fun <T> observeDurableNotification(
    notification: T,
    read: () -> T?,
    write: (T) -> Unit,
    matches: (T, T?) -> Boolean,
    supersedes: (T, T) -> Boolean,
): T? {
    repeat(DURABLE_INDEX_MUTATION_ATTEMPTS) {
        val current = try {
            read()
        } catch (_: IOException) {
            return@repeat
        }
        if (matches(notification, current)) {
            return current
        }
        if (current != null && supersedes(current, notification)) {
            return current
        }
        try {
            write(notification)
        } catch (_: IOException) {
            // The bounded retry below owns transient index I/O failure.
        }
    }
    return try {
        read()?.takeIf {
            matches(notification, it) || supersedes(it, notification)
        }
    } catch (_: IOException) {
        null
    }
}

private fun durableDownloadSupersedes(
    durable: Download,
    notification: Download,
): Boolean {
    return durableStateSupersedes(
        durable.state,
        durable.stopReason,
        durable.updateTimeMs,
        notification.state,
        notification.stopReason,
        notification.updateTimeMs,
    )
}

internal fun durableStateSupersedes(
    durableState: Int,
    durableStopReason: Int,
    durableUpdateTimeMs: Long,
    notificationState: Int,
    notificationStopReason: Int,
    notificationUpdateTimeMs: Long,
): Boolean {
    if (durableUpdateTimeMs != notificationUpdateTimeMs) {
        return durableUpdateTimeMs > notificationUpdateTimeMs
    }
    return durableStateRank(durableState, durableStopReason) >=
        durableStateRank(notificationState, notificationStopReason)
}

private fun durableStateRank(
    state: Int,
    stopReason: Int,
): Int {
    return when {
        state == Download.STATE_REMOVING -> 6
        state in setOf(Download.STATE_COMPLETED, Download.STATE_FAILED) -> 5
        stopReason != Download.STOP_REASON_NONE -> 4
        state == Download.STATE_RESTARTING -> 3
        state == Download.STATE_DOWNLOADING -> 2
        else -> 1
    }
}

internal fun systemLimited(download: Download): Download {
    require(requiresSystemLimitFence(download))
    if (
        download.state == Download.STATE_STOPPED &&
        download.stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON
    ) {
        return download
    }
    return Download(
        download.request,
        Download.STATE_STOPPED,
        download.startTimeMs,
        maxOf(System.currentTimeMillis(), download.updateTimeMs + 1),
        download.contentLength,
        OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
        Download.FAILURE_REASON_NONE,
    )
}

internal fun requiresSystemLimitFence(download: Download): Boolean {
    return requiresSystemLimitFence(download.state, download.stopReason)
}

internal fun requiresSystemLimitFence(
    state: Int,
    stopReason: Int,
): Boolean {
    return state in setOf(
        Download.STATE_QUEUED,
        Download.STATE_DOWNLOADING,
        Download.STATE_RESTARTING,
    ) || (
        state == Download.STATE_STOPPED &&
            stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON
        )
}

internal fun removalRequiresManagerObservation(state: Int): Boolean {
    return state !in setOf(
        Download.STATE_COMPLETED,
        Download.STATE_FAILED,
        Download.STATE_REMOVING,
    )
}

private inline fun <T> indexResult(block: () -> T): Result<T> {
    return try {
        Result.success(block())
    } catch (error: IOException) {
        Result.failure(OfflineMediaPersistenceException(error))
    } catch (error: IllegalArgumentException) {
        Result.failure(OfflineMediaPersistenceException(error))
    } catch (error: OfflineMediaCorruptionException) {
        Result.failure(OfflineMediaPersistenceException(error))
    }
}

internal class OfflineMediaStore private constructor(
    context: Context,
) {
    interface Listener {
        fun onStateChanged(mediaId: UUID, state: Presence<NativeLocalAvailability>)

        fun onNetworkPolicyChanged(policy: NetworkPolicy)
    }

    private data class PendingConnect(
        val accountId: UUID,
        val generation: Long,
        val waitingForRemoval: MutableSet<String>,
        val callback: (Result<Pair<List<OfflineMediaItem>, NetworkPolicy>>) -> Unit,
    )

    private data class QueuedConnect(
        val accountId: UUID,
        val generation: Long,
        val callback: (Result<Pair<List<OfflineMediaItem>, NetworkPolicy>>) -> Unit,
    )

    private class PendingEnqueue(
        val accountId: UUID,
        val generation: Long,
        val cancellation: PreflightCancellation,
        callback: (Result<Unit>) -> Unit,
    ) {
        val canceled = AtomicBoolean(false)
        val callbacks = mutableListOf(callback)
        var durableObserved = false

        fun mayAdmit(currentAccountId: UUID?, currentGeneration: Long): Boolean {
            return admissionIsCurrent(
                canceled.get(),
                accountId,
                generation,
                currentAccountId,
                currentGeneration,
            )
        }
    }

    private class SystemLimitFence(
        val snapshots: List<Download>,
        val callback: (Result<Unit>) -> Unit,
    ) {
        val remaining = ConcurrentHashMap.newKeySet<String>().apply {
            addAll(snapshots.map { it.request.id })
        }
        val completed = AtomicBoolean(false)
        val retryCount = AtomicLong(0)
    }

    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker: ExecutorService =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "nexus-offline-media").apply { isDaemon = true }
        }
    private val networkWorker: ExecutorService =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "nexus-offline-preflight").apply { isDaemon = true }
        }
    private val listeners = CopyOnWriteArraySet<Listener>()
    private val databaseProvider = StandaloneDatabaseProvider(appContext)
    private val downloadIndex = DefaultDownloadIndex(
        databaseProvider,
        OFFLINE_MEDIA_DOWNLOAD_INDEX_NAME,
    )
    private val cache: Cache = SimpleCache(
        appContext.filesDir.resolve(OFFLINE_MEDIA_CACHE_DIRECTORY),
        NoOpCacheEvictor(),
        databaseProvider,
    )
    private val safeHttpClient = SafeHttpClient()
    private val upstreamFactory = OkHttpDataSource.Factory(safeHttpClient.client)
        .setUserAgent("NexusAndroidOfflineMedia/1")
    private val cacheDataSourceFactory = CacheDataSource.Factory()
        .setCache(cache)
        .setUpstreamDataSourceFactory(upstreamFactory)
        .setCacheWriteDataSinkFactory(
            ReserveGuardDataSinkFactory(cache, appContext.filesDir)
        )
    val downloadManager = DownloadManager(
        appContext,
        downloadIndex,
        SafeProgressiveDownloaderFactory(
            cache,
            cacheDataSourceFactory,
            Runnable::run,
            safeHttpClient,
        ),
    )
    private val preferences = appContext.getSharedPreferences(
        OFFLINE_MEDIA_PREFERENCES,
        Context.MODE_PRIVATE,
    )
    private val connectivityManager =
        appContext.getSystemService(ConnectivityManager::class.java)
    private val readLeases = mutableMapOf<String, Int>()
    private val pendingRemovals = mutableSetOf<String>()
    private val pendingRemovalCallbacks =
        mutableMapOf<String, MutableList<(Result<Unit>) -> Unit>>()
    private val pendingEnqueues = mutableMapOf<String, PendingEnqueue>()
    private val systemLimitFences = CopyOnWriteArraySet<SystemLimitFence>()
    private data class AdmissionToken(
        val accountId: UUID,
        val generation: Long,
    )
    private val admissionTokens = ConcurrentHashMap<String, AdmissionToken>()
    private val connectQueue = ArrayDeque<QueuedConnect>()
    private val sessionGeneration = AtomicLong(0)
    private val foregroundGeneration = AtomicLong(0)

    @Volatile
    private var activeAccountId: UUID? = null
    private var pendingConnect: PendingConnect? = null
    private var initialized = false
    private var reconciled = false
    private var foregroundRequested = false
    private var foregroundWhileStopping = false
    @Volatile
    private var foregroundAuthorized = false
    @Volatile
    private var serviceStopInProgress = false
    @Volatile
    private var admittedForegroundGeneration = 0L
    private var networkPolicy = loadNetworkPolicy()

    init {
        downloadManager.setMaxParallelDownloads(1)
        downloadManager.setRequirements(requirementsFor(networkPolicy))
        downloadManager.pauseDownloads()
        downloadManager.addListener(
            object : DownloadManager.Listener {
                override fun onInitialized(downloadManager: DownloadManager) {
                    worker.execute {
                        initialized = true
                        reconcile()
                        startNextConnect()
                        maybeResumeInForeground()
                    }
                }

                override fun onDownloadChanged(
                    downloadManager: DownloadManager,
                    download: Download,
                    finalException: Exception?,
                ) {
                    worker.execute {
                        val pending = pendingEnqueues[download.request.id]
                        if (pending != null) {
                            if (pending.durableObserved) {
                                val durable = observeDownloadNotification(download)
                                if (durable != null) {
                                    observeSystemLimitSettlement(durable)
                                    publish(durable)
                                }
                                return@execute
                            }
                            if (!pending.mayAdmit(activeAccountId, sessionGeneration.get())) {
                                pending.durableObserved = true
                                pendingEnqueues.remove(download.request.id, pending)
                                val current = observeDownloadNotification(download)
                                if (current == null) {
                                    completePending(
                                        pending,
                                        Result.failure(OfflineMediaPersistenceException()),
                                    )
                                    return@execute
                                }
                                beginRemoval(
                                    current,
                                    metadata(current).mediaId,
                                ) { removal ->
                                    completePending(
                                        pending,
                                        removal.fold(
                                            onSuccess = {
                                                if (pending.canceled.get()) {
                                                    Result.success(Unit)
                                                } else {
                                                    Result.failure(
                                                        AccountMismatchException()
                                                    )
                                                }
                                            },
                                            onFailure = { Result.failure(it) },
                                        ),
                                    )
                                }
                                return@execute
                            }
                            val durable = observeDownloadNotification(download)
                            if (durable == null) {
                                pending.durableObserved = true
                                pendingEnqueues.remove(download.request.id, pending)
                                requestRemoval(download.request.id)
                                completePending(
                                    pending,
                                    Result.failure(OfflineMediaPersistenceException()),
                                )
                                return@execute
                            }
                            pending.durableObserved = true
                            logDownload(durable, finalException)
                            publish(durable)
                            observeSystemLimitSettlement(durable)
                            mainHandler.post {
                                val shouldStart = foregroundAuthorized &&
                                    pending.mayAdmit(
                                        activeAccountId,
                                        sessionGeneration.get(),
                                    ) &&
                                    systemLimitFences.isEmpty()
                                if (shouldStart) {
                                    admissionTokens[durable.request.id] = AdmissionToken(
                                        pending.accountId,
                                        pending.generation,
                                    )
                                    OfflineMediaDownloadService.admit(
                                        appContext,
                                        durable.request.id,
                                    )
                                }
                                worker.execute {
                                    pendingEnqueues.remove(download.request.id, pending)
                                    if (!pending.mayAdmit(activeAccountId, sessionGeneration.get())) {
                                        beginRemoval(
                                            durable,
                                            metadata(durable).mediaId,
                                        ) { removal ->
                                            completePending(
                                                pending,
                                                removal.fold(
                                                    onSuccess = {
                                                        if (pending.canceled.get()) {
                                                            Result.success(Unit)
                                                        } else {
                                                            Result.failure(
                                                                AccountMismatchException()
                                                            )
                                                        }
                                                    },
                                                    onFailure = { Result.failure(it) },
                                                ),
                                            )
                                        }
                                    } else {
                                        completePending(pending, Result.success(Unit))
                                    }
                                }
                            }
                            return@execute
                        }
                        val durable = observeDownloadNotification(download)
                        if (durable == null) {
                            Log.e(
                                LOG_TAG,
                                "downloadId=${download.request.id} failed durable index verification",
                            )
                            failRemoval(download.request.id)
                            failConnectRemoval(download.request.id)
                            return@execute
                        }
                        logDownload(durable, finalException)
                        if (durable.state == Download.STATE_REMOVING) {
                            synchronized(readLeases) {
                                pendingRemovals.add(durable.request.id)
                            }
                        }
                        publish(durable)
                        observeSystemLimitSettlement(durable)
                        if (durable.state == Download.STATE_REMOVING) {
                            completeRemoval(durable.request.id, Result.success(Unit))
                        }
                    }
                }

                override fun onDownloadRemoved(
                    downloadManager: DownloadManager,
                    download: Download,
                ) {
                    worker.execute {
                        observeSystemLimit(download.request.id)
                        if (!ensureObservedRemoval(download.request.id)) {
                            Log.e(
                                LOG_TAG,
                                "downloadId=${download.request.id} failed durable removal verification",
                            )
                            synchronized(readLeases) {
                                pendingRemovals.remove(download.request.id)
                            }
                            completeRemoval(
                                download.request.id,
                                Result.failure(OfflineMediaPersistenceException()),
                            )
                            failConnectRemoval(download.request.id)
                            markRepairRequired(download)
                            return@execute
                        }
                        pendingEnqueues.remove(download.request.id)?.let { pending ->
                            completePending(
                                pending,
                                if (pending.canceled.get()) {
                                    Result.success(Unit)
                                } else {
                                    Result.failure(AccountMismatchException())
                                },
                            )
                        }
                        if (!removeCachedResourceVerified(download.request.id)) {
                            synchronized(readLeases) {
                                pendingRemovals.remove(download.request.id)
                            }
                            completeRemoval(
                                download.request.id,
                                Result.failure(OfflineMediaPersistenceException()),
                            )
                            failConnectRemoval(download.request.id)
                            persistRepairRequired(download)?.let(::publish)
                            return@execute
                        }
                        synchronized(readLeases) {
                            pendingRemovals.remove(download.request.id)
                        }
                        completeRemoval(download.request.id, Result.success(Unit))
                        val connect = pendingConnect
                        if (connect != null && connect.waitingForRemoval.remove(download.request.id)) {
                            finishConnectIfReady(connect)
                        } else {
                            metadata(download).takeIf { it.accountId == activeAccountId }?.let {
                                emitState(it.mediaId, Presence.Absent)
                            }
                        }
                    }
                }

                override fun onRequirementsStateChanged(
                    downloadManager: DownloadManager,
                    requirements: Requirements,
                    notMetRequirements: Int,
                ) {
                    worker.execute { publishAll() }
                }
            }
        )
        if (downloadManager.isInitialized) {
            worker.execute {
                initialized = true
                reconcile()
                startNextConnect()
            }
        }
    }

    fun addListener(listener: Listener) {
        listeners.add(listener)
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    fun disconnect() {
        activeAccountId = null
        sessionGeneration.incrementAndGet()
        admissionTokens.clear()
    }

    fun connect(
        accountId: UUID,
        callback: (Result<Pair<List<OfflineMediaItem>, NetworkPolicy>>) -> Unit,
    ) {
        if (activeAccountId != accountId) {
            activeAccountId = null
            admissionTokens.clear()
        }
        val generation = sessionGeneration.get()
        worker.execute {
            connectQueue.addLast(QueuedConnect(accountId, generation, callback))
            startNextConnect()
        }
    }

    fun snapshot(callback: (Result<Pair<List<OfflineMediaItem>, NetworkPolicy>>) -> Unit) {
        worker.execute {
            if (activeAccountId == null) {
                callback(Result.failure(AccountMismatchException()))
            } else {
                callback(indexResult { itemsForActiveAccount() to networkPolicy })
            }
        }
    }

    fun enqueue(
        spec: OfflineDownloadSpec,
        callback: (Result<Unit>) -> Unit,
    ) {
        worker.execute {
            val accountId = activeAccountId
                ?: return@execute callback(Result.failure(AccountMismatchException()))
            val id = stableDownloadId(accountId, spec.mediaId)
            pendingEnqueues[id]?.let {
                it.callbacks.add(callback)
                return@execute
            }
            val existing = try {
                downloadIndex.getDownload(id)
            } catch (error: IOException) {
                return@execute callback(
                    Result.failure(OfflineMediaPersistenceException(error))
                )
            }
            if (existing != null) {
                return@execute callback(Result.success(Unit))
            }
            startPreflightAttempt(accountId, spec, callback)
        }
    }

    fun cancel(mediaId: UUID, callback: (Result<Unit>) -> Unit) {
        worker.execute {
            val accountId = activeAccountId
                ?: return@execute callback(Result.failure(AccountMismatchException()))
            val id = stableDownloadId(accountId, mediaId)
            if (cancelPendingEnqueue(id, callback)) {
                return@execute
            }
            val download = try {
                downloadIndex.getDownload(id)
            } catch (error: IOException) {
                return@execute callback(
                    Result.failure(OfflineMediaPersistenceException(error))
                )
            }
            beginRemoval(download, mediaId, callback)
        }
    }

    fun retry(mediaId: UUID, callback: (Result<Unit>) -> Unit) {
        worker.execute {
            val accountId = activeAccountId
                ?: return@execute callback(Result.failure(AccountMismatchException()))
            val id = stableDownloadId(accountId, mediaId)
            pendingEnqueues[id]?.let {
                it.callbacks.add(callback)
                return@execute
            }
            val download = try {
                downloadIndex.getDownload(id)
            } catch (error: IOException) {
                return@execute callback(
                    Result.failure(OfflineMediaPersistenceException(error))
                )
            }
                ?: return@execute callback(Result.success(Unit))
            if (
                download.state != Download.STATE_FAILED &&
                download.stopReason != OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON
            ) {
                return@execute callback(Result.success(Unit))
            }
            val oldMetadata = metadata(download)
            val spec = OfflineDownloadSpec(
                mediaId,
                oldMetadata.title,
                download.request.uri.toString(),
            )
            if (!removeCachedResourceVerified(id)) {
                return@execute callback(
                    Result.failure(OfflineMediaPersistenceException())
                )
            }
            startPreflightAttempt(accountId, spec, callback)
        }
    }

    private fun startPreflightAttempt(
        accountId: UUID,
        spec: OfflineDownloadSpec,
        callback: (Result<Unit>) -> Unit,
    ) {
        val id = stableDownloadId(accountId, spec.mediaId)
        val pending = PendingEnqueue(
            accountId,
            sessionGeneration.get(),
            PreflightCancellation(),
            callback,
        )
        pendingEnqueues[id] = pending
        networkWorker.execute network@{
            val result = runCatching {
                safeHttpClient.preflight(
                    UUID.fromString(id),
                    spec.mediaId,
                    spec.sourceUrl,
                    appContext.filesDir,
                    pending.cancellation,
                )
            }
            worker.execute completion@{
                if (pendingEnqueues[id] !== pending || pending.canceled.get()) {
                    pendingEnqueues.remove(id, pending)
                    completePending(pending, Result.success(Unit))
                    return@completion
                }
                val error = result.exceptionOrNull()
                if (error != null) {
                    pendingEnqueues.remove(id, pending)
                    when (error) {
                        is PreflightCanceledException ->
                            completePending(pending, Result.success(Unit))
                        is OfflineMediaSourceException -> {
                            logPreflightFailure(id, spec, error)
                            completePending(pending, Result.failure(error))
                        }
                        else -> throw error
                    }
                    return@completion
                }
                if (activeAccountId != accountId) {
                    pendingEnqueues.remove(id, pending)
                    completePending(pending, Result.failure(AccountMismatchException()))
                    return@completion
                }
                val request = request(accountId, spec, result.getOrThrow())
                mainHandler.post {
                    if (!pending.mayAdmit(activeAccountId, sessionGeneration.get())) {
                        worker.execute {
                            pendingEnqueues.remove(id, pending)
                            completePending(
                                pending,
                                if (pending.canceled.get()) {
                                    Result.success(Unit)
                                } else {
                                    Result.failure(AccountMismatchException())
                                },
                            )
                        }
                    } else {
                        persistDownload(request)
                    }
                }
            }
        }
    }

    fun remove(mediaId: UUID, callback: (Result<Unit>) -> Unit) {
        worker.execute {
            val accountId = activeAccountId
                ?: return@execute callback(Result.failure(AccountMismatchException()))
            val id = stableDownloadId(accountId, mediaId)
            if (cancelPendingEnqueue(id, callback)) {
                return@execute
            }
            val download = try {
                downloadIndex.getDownload(id)
            } catch (error: IOException) {
                return@execute callback(
                    Result.failure(OfflineMediaPersistenceException(error))
                )
            }
            beginRemoval(download, mediaId, callback)
        }
    }

    fun setNetworkPolicy(
        policy: NetworkPolicy,
        callback: (Result<Unit>) -> Unit,
    ) {
        worker.execute {
            if (activeAccountId == null) {
                return@execute callback(Result.failure(AccountMismatchException()))
            }
            if (networkPolicy == policy) {
                return@execute callback(Result.success(Unit))
            }
            if (!preferences.edit().putString(NETWORK_POLICY_KEY, policy.name).commit()) {
                return@execute callback(
                    Result.failure(OfflineMediaPersistenceException())
                )
            }
            networkPolicy = policy
            val requirements = requirementsFor(policy)
            mainHandler.post {
                downloadManager.setRequirements(requirements)
                if (foregroundAuthorized && activeAccountId != null) {
                    OfflineMediaDownloadService.resume(appContext)
                }
                listeners.forEach { it.onNetworkPolicyChanged(policy) }
                callback(Result.success(Unit))
            }
        }
    }

    fun onAppForeground() {
        foregroundGeneration.incrementAndGet()
        foregroundAuthorized = true
        systemLimitFences.forEach(::forceSystemLimitFence)
        worker.execute {
            if (serviceStopInProgress || systemLimitFences.isNotEmpty()) {
                foregroundRequested = false
                foregroundWhileStopping = true
            } else {
                foregroundRequested = true
            }
            maybeResumeInForeground()
        }
    }

    fun onAppBackground() {
        foregroundAuthorized = false
        worker.execute {
            foregroundRequested = false
            foregroundWhileStopping = false
        }
    }

    fun pauseForSystemLimit(
        callback: (Result<Unit>) -> Unit = {},
    ) {
        check(Looper.myLooper() == downloadManager.applicationLooper)
        val unfinished = downloadManager.currentDownloads
            .filter(::requiresSystemLimitFence)
        if (unfinished.isEmpty()) {
            callback(Result.success(Unit))
            return
        }
        val replayForeground =
            foregroundGeneration.get() > admittedForegroundGeneration
        serviceStopInProgress = true
        worker.execute {
            foregroundRequested = false
            foregroundWhileStopping =
                foregroundWhileStopping || replayForeground
        }
        val fence = SystemLimitFence(
            unfinished,
            callback,
        )
        systemLimitFences.add(fence)
        downloadManager.pauseDownloads()
        unfinished.forEach { download ->
            downloadManager.setStopReason(
                download.request.id,
                OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
            )
        }
        worker.execute {
            unfinished
                .filter { it.stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON }
                .forEach { download ->
                    if (ensureObservedDownload(download)) {
                        observeSystemLimit(download.request.id)
                    }
                }
        }
        mainHandler.postDelayed(
            {
                if (!fence.completed.get()) {
                    forceSystemLimitFence(fence)
                }
            },
            SYSTEM_LIMIT_FENCE_TIMEOUT_MS,
        )
    }

    fun releaseSystemLimit(admissionId: String? = null) {
        check(Looper.myLooper() == downloadManager.applicationLooper)
        val accountId = activeAccountId ?: return
        val generation = sessionGeneration.get()
        if (
            !foregroundAuthorized ||
            serviceStopInProgress ||
            systemLimitFences.isNotEmpty()
        ) {
            return
        }
        if (admissionId != null) {
            val token = admissionTokens.remove(admissionId) ?: return
            if (token.accountId != accountId || token.generation != generation) {
                return
            }
        }
        admittedForegroundGeneration = foregroundGeneration.get()
        downloadManager.currentDownloads
            .asSequence()
            .filter {
                it.stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON &&
                    (admissionId == null || it.request.id == admissionId)
            }
            .filter {
                runCatching { metadata(it).accountId == accountId }
                    .getOrDefault(false)
            }
            .forEach {
                downloadManager.setStopReason(
                    it.request.id,
                    Download.STOP_REASON_NONE,
                )
            }
    }

    private fun observeSystemLimit(id: String) {
        systemLimitFences.forEach { fence ->
            if (fence.remaining.remove(id) && fence.remaining.isEmpty()) {
                finishSystemLimitFence(fence, Result.success(Unit))
            }
        }
    }

    private fun observeSystemLimitSettlement(download: Download) {
        if (
            download.stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON ||
            !requiresSystemLimitFence(download)
        ) {
            observeSystemLimit(download.request.id)
        }
    }

    private fun forceSystemLimitFence(
        fence: SystemLimitFence,
    ) {
        worker.execute {
            val persisted = fence.snapshots
                .filter { it.request.id in fence.remaining }
                .map { snapshot ->
                    val current = try {
                        downloadIndex.getDownload(snapshot.request.id)
                    } catch (error: IOException) {
                        Log.e(
                            LOG_TAG,
                            "downloadId=${snapshot.request.id} failed SystemLimit read",
                            error,
                        )
                        return@map false
                    }
                    when {
                        current == null || !requiresSystemLimitFence(current) -> {
                            fence.remaining.remove(snapshot.request.id)
                            true
                        }
                        current.stopReason ==
                            OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON -> {
                            ensureObservedDownload(current).also { success ->
                                if (success) {
                                    fence.remaining.remove(snapshot.request.id)
                                }
                            }
                        }
                        else -> {
                            ensureObservedDownload(systemLimited(current)).also { success ->
                                if (success) {
                                    fence.remaining.remove(snapshot.request.id)
                                }
                            }
                        }
                    }
                }
                .all { it }
            if (!persisted) {
                Log.e(LOG_TAG, "failed durable SystemLimit service-stop fence")
                if (fence.retryCount.getAndIncrement() < 2) {
                    mainHandler.postDelayed(
                        { forceSystemLimitFence(fence) },
                        SYSTEM_LIMIT_FENCE_TIMEOUT_MS,
                    )
                }
            }
            if (persisted && fence.completed.get()) {
                systemLimitFences.remove(fence)
                maybeRearmAfterServiceStop()
            } else {
                finishSystemLimitFence(
                    fence,
                    if (persisted) {
                        Result.success(Unit)
                    } else {
                        Result.failure(OfflineMediaPersistenceException())
                    },
                )
            }
        }
    }

    private fun finishSystemLimitFence(
        fence: SystemLimitFence,
        result: Result<Unit>,
    ) {
        if (!fence.completed.compareAndSet(false, true)) {
            return
        }
        if (result.isSuccess) {
            systemLimitFences.remove(fence)
        }
        mainHandler.post { fence.callback(result) }
        maybeRearmAfterServiceStop()
    }

    fun completeServiceStop() {
        check(Looper.myLooper() == downloadManager.applicationLooper)
        serviceStopInProgress = false
        worker.execute(::maybeRearmAfterServiceStop)
    }

    private fun maybeRearmAfterServiceStop() {
        if (
            serviceStopInProgress ||
            systemLimitFences.isNotEmpty() ||
            !foregroundAuthorized ||
            !foregroundWhileStopping
        ) {
            return
        }
        foregroundWhileStopping = false
        foregroundRequested = true
        maybeResumeInForeground()
    }

    fun publishForegroundProgress(downloads: List<Download>) {
        worker.execute {
            downloads.forEach(::publish)
        }
    }

    fun open(mediaId: UUID, rangeHeader: String?): Result<OfflineMediaRead> {
        val accountId = activeAccountId
            ?: return Result.failure(AccountMismatchException())
        val id = stableDownloadId(accountId, mediaId)
        val prepared = synchronized(readLeases) {
            if (activeAccountId != accountId) {
                return Result.failure(AccountMismatchException())
            }
            val download = try {
                downloadIndex.getDownload(id)
            } catch (error: IOException) {
                return Result.failure(OfflineMediaPersistenceException(error))
            }
                ?: return Result.failure(LocalMediaMissingException())
            val metadata = metadata(download)
            if (
                metadata.accountId != accountId ||
                download.state != Download.STATE_COMPLETED ||
                download.stopReason == OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON ||
                id in pendingRemovals
            ) {
                return Result.failure(LocalMediaMissingException())
            }
            val size = completedSize(download, metadata)
                ?: return brokenCompleted(download)
            if (!isComplete(id, size) || !hasExpectedContainer(id, metadata.contentType, size)) {
                return brokenCompleted(download)
            }
            val requestedRange = RequestedByteRange.parse(rangeHeader, size)
            if (requestedRange is RequestedByteRange.Unsatisfiable) {
                return Result.failure(UnsatisfiableRangeException(size))
            }
            requestedRange as RequestedByteRange.Satisfiable
            readLeases[id] = (readLeases[id] ?: 0) + 1
            Triple(download, metadata, requestedRange)
        }
        val (download, metadata, requestedRange) = prepared
        return try {
            val stream = cacheInputStream(
                download.request.uri,
                id,
                requestedRange.start,
                requestedRange.length,
            )
            Result.success(
                OfflineMediaRead(
                    statusCode = if (requestedRange.contentRange == null) 200 else 206,
                    reasonPhrase = if (requestedRange.contentRange == null) "OK" else "Partial Content",
                    contentType = metadata.contentType,
                    contentLength = requestedRange.length,
                    contentRange = requestedRange.contentRange,
                    body = LeaseInputStream(
                        stream,
                        release = { releaseReadLease(id) },
                        onReadFailure = { markRepairRequired(download) },
                    ),
                )
            )
        } catch (error: IOException) {
            releaseReadLease(id)
            markRepairRequired(download)
            Result.failure(LocalMediaMissingException())
        }
    }

    private fun startNextConnect() {
        if (pendingConnect != null || connectQueue.isEmpty() || !initialized) {
            return
        }
        if (!reconciled && !reconcile()) {
            connectQueue.removeFirst().callback(
                Result.failure(OfflineMediaPersistenceException())
            )
            startNextConnect()
            return
        }
        val queued = connectQueue.removeFirst()
        if (queued.generation != sessionGeneration.get()) {
            startNextConnect()
            return
        }
        if (activeAccountId == queued.accountId) {
            val snapshot = indexResult {
                itemsForActiveAccount() to networkPolicy
            }
            if (snapshot.isFailure) {
                activeAccountId = null
            }
            queued.callback(snapshot)
            startNextConnect()
            return
        }
        activeAccountId = null
        val foreignDownloads = try {
            downloads()
        } catch (error: IOException) {
            queued.callback(Result.failure(OfflineMediaPersistenceException(error)))
            startNextConnect()
            return
        }
            .filter { metadata(it).accountId != queued.accountId }
        val foreign = foreignDownloads
            .mapTo(mutableSetOf()) { it.request.id }
        val pending = PendingConnect(
            queued.accountId,
            queued.generation,
            foreign,
            queued.callback,
        )
        pendingConnect = pending
        if (foreign.isEmpty()) {
            finishConnectIfReady(pending)
            return
        }
        for (download in foreignDownloads) {
            if (!beginAccountRemoval(download)) {
                Log.e(
                    LOG_TAG,
                    "downloadId=${download.request.id} failed durable account-purge marker",
                )
                failConnect(pending, OfflineMediaPersistenceException())
                return
            }
        }
    }

    private fun finishConnectIfReady(connect: PendingConnect) {
        if (connect.waitingForRemoval.isNotEmpty()) {
            return
        }
        if (connect.generation != sessionGeneration.get()) {
            pendingConnect = null
            startNextConnect()
            return
        }
        activeAccountId = connect.accountId
        pendingConnect = null
        val snapshot = indexResult {
            itemsForActiveAccount() to networkPolicy
        }
        if (snapshot.isFailure) {
            activeAccountId = null
        }
        connect.callback(snapshot)
        try {
            maybeResumeInForeground()
        } finally {
            startNextConnect()
        }
    }

    private fun failConnect(
        connect: PendingConnect,
        error: OfflineMediaPersistenceException,
    ) {
        if (pendingConnect !== connect) {
            return
        }
        pendingConnect = null
        activeAccountId = null
        connect.callback(Result.failure(error))
        startNextConnect()
    }

    private fun failConnectRemoval(id: String) {
        val connect = pendingConnect ?: return
        if (connect.waitingForRemoval.remove(id)) {
            failConnect(connect, OfflineMediaPersistenceException())
        }
    }

    private fun beginRemoval(
        download: Download?,
        mediaId: UUID,
        callback: (Result<Unit>) -> Unit,
    ) {
        if (download == null) {
            callback(Result.success(Unit))
            return
        }
        val id = download.request.id
        pendingRemovalCallbacks[id]?.let {
            it.add(callback)
            return
        }
        val managerOwned = removalRequiresManagerObservation(download.state)
        if (managerOwned) {
            pendingRemovalCallbacks[id] = mutableListOf(callback)
            requestRemoval(id)
            return
        }
        val (added, removeNow) = synchronized(readLeases) {
            pendingRemovals.add(id) to ((readLeases[id] ?: 0) == 0)
        }
        if (!markRemovalPending(download)) {
            synchronized(readLeases) {
                pendingRemovals.remove(id)
            }
            callback(Result.failure(OfflineMediaPersistenceException()))
            return
        }
        if (added) {
            emitState(mediaId, Presence.Present(NativeLocalAvailability.Removing))
        }
        callback(Result.success(Unit))
        if (removeNow) {
            requestRemoval(id)
        }
    }

    private fun beginAccountRemoval(download: Download): Boolean {
        val id = download.request.id
        val managerOwned = removalRequiresManagerObservation(download.state)
        val removeNow = synchronized(readLeases) {
            pendingRemovals.add(id)
            (readLeases[id] ?: 0) == 0
        }
        if (!managerOwned && !markRemovalPending(download)) {
            synchronized(readLeases) {
                pendingRemovals.remove(id)
            }
            return false
        }
        if (removeNow) {
            requestRemoval(id)
        }
        return true
    }

    private fun cancelPendingEnqueue(
        id: String,
        callback: (Result<Unit>) -> Unit,
    ): Boolean {
        val pending = pendingEnqueues[id] ?: return false
        pending.canceled.set(true)
        pending.cancellation.cancel()
        pending.callbacks.add(callback)
        val observed = try {
            downloadIndex.getDownload(id)
        } catch (error: IOException) {
            pendingEnqueues.remove(id, pending)
            completePending(
                pending,
                Result.failure(OfflineMediaPersistenceException(error)),
            )
            return true
        } ?: return true
        pendingEnqueues.remove(id, pending)
        beginRemoval(
            observed,
            metadata(observed).mediaId,
        ) { result ->
            completePending(pending, result)
        }
        return true
    }

    private fun completeRemoval(id: String, result: Result<Unit>) {
        pendingRemovalCallbacks.remove(id)?.forEach { it(result) }
    }

    private fun failRemoval(id: String) {
        completeRemoval(
            id,
            Result.failure(OfflineMediaPersistenceException()),
        )
        synchronized(readLeases) {
            pendingRemovals.remove(id)
        }
    }

    private fun markRemovalPending(download: Download): Boolean {
        val removing = if (download.state == Download.STATE_REMOVING) {
            download
        } else {
            Download(
                download.request,
                Download.STATE_REMOVING,
                download.startTimeMs,
                maxOf(System.currentTimeMillis(), download.updateTimeMs + 1),
                download.contentLength,
                Download.STOP_REASON_NONE,
                Download.FAILURE_REASON_NONE,
            )
        }
        return ensureDurableDownload(
            removing,
            read = { downloadIndex.getDownload(removing.request.id) },
            write = downloadIndex::putDownload,
        )
    }

    private fun ensureObservedDownload(download: Download): Boolean {
        return ensureDurableDownload(
            download,
            read = { downloadIndex.getDownload(download.request.id) },
            write = downloadIndex::putDownload,
        )
    }

    private fun observeDownloadNotification(download: Download): Download? {
        return observeDurableDownloadNotification(
            download,
            read = { downloadIndex.getDownload(download.request.id) },
            write = downloadIndex::putDownload,
        )
    }

    private fun readDurableDownload(id: String): Download? {
        return try {
            downloadIndex.getDownload(id)
        } catch (error: IOException) {
            Log.e(LOG_TAG, "downloadId=$id failed durable index read", error)
            null
        }
    }

    private fun ensureObservedRemoval(id: String): Boolean {
        return ensureDurableRemoval(
            read = { downloadIndex.getDownload(id) },
            remove = { downloadIndex.removeDownload(id) },
        )
    }

    private fun requestRemoval(id: String) {
        mainHandler.post { downloadManager.removeDownload(id) }
    }

    private fun removeCachedResourceVerified(id: String): Boolean {
        return try {
            removeCachedResource(cache, id)
            id !in cache.keys
        } catch (error: IOException) {
            Log.e(LOG_TAG, "downloadId=$id failed cache cleanup", error)
            false
        }
    }

    private fun persistDownload(request: DownloadRequest) {
        check(Looper.myLooper() == downloadManager.applicationLooper)
        downloadManager.addDownload(
            request,
            OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
        )
    }

    private fun completePending(
        pending: PendingEnqueue,
        result: Result<Unit>,
    ) {
        pending.callbacks.forEach { it(result) }
        pending.callbacks.clear()
    }

    private fun releaseReadLease(id: String) {
        worker.execute {
            synchronized(readLeases) {
                val count = readLeases[id] ?: error("missing offline media read lease")
                if (count == 1) {
                    readLeases.remove(id)
                } else {
                    readLeases[id] = count - 1
                }
            }
            val removeNow = synchronized(readLeases) {
                id in pendingRemovals && (readLeases[id] ?: 0) == 0
            }
            if (removeNow) {
                requestRemoval(id)
            }
        }
    }

    private fun reconcile(): Boolean {
        if (reconciled) {
            return true
        }
        val indexedDownloads = try {
            downloads()
        } catch (error: IOException) {
            Log.e(LOG_TAG, "failed offline media index reconciliation", error)
            return false
        }
        try {
            val indexedIds = indexedDownloads.mapTo(mutableSetOf()) { it.request.id }
            for (id in cache.keys.filterNot(indexedIds::contains)) {
                if (!removeCachedResourceVerified(id)) {
                    return false
                }
            }
            for (download in indexedDownloads) {
                val metadata = metadata(download)
                if (
                    download.request.id !=
                    stableDownloadId(metadata.accountId, metadata.mediaId) ||
                    download.request.customCacheKey != download.request.id
                ) {
                    Log.e(
                        LOG_TAG,
                        "downloadId=${download.request.id} has corrupt durable identity",
                    )
                    return false
                }
                if (download.state == Download.STATE_COMPLETED) {
                    val size = completedSize(download, metadata)
                    if (
                        size == null ||
                        !isComplete(download.request.id, size) ||
                        !hasExpectedContainer(
                            download.request.id,
                            metadata.contentType,
                            size,
                        )
                    ) {
                        if (persistRepairRequired(download) == null) {
                            return false
                        }
                    }
                } else if (!removeCachedResourceVerified(download.request.id)) {
                    return false
                }
            }
        } catch (error: IllegalArgumentException) {
            Log.e(LOG_TAG, "failed offline media metadata reconciliation", error)
            return false
        }
        reconciled = true
        return true
    }

    private fun maybeResumeInForeground() {
        if (
            !initialized ||
            !reconciled ||
            !foregroundRequested ||
            activeAccountId == null ||
            pendingConnect != null ||
            connectQueue.isNotEmpty()
        ) {
            return
        }
        val indexedDownloads = try {
            downloads()
        } catch (error: IOException) {
            Log.e(LOG_TAG, "failed foreground resume index read", error)
            return
        }
        val resumable = indexedDownloads.any {
            it.state !in setOf(Download.STATE_COMPLETED, Download.STATE_FAILED) &&
                it.stopReason != OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON
        }
        if (resumable) {
            mainHandler.post {
                if (foregroundAuthorized && activeAccountId != null) {
                    OfflineMediaDownloadService.resume(appContext)
                }
            }
        }
    }

    private fun publishAll() {
        try {
            downloads().forEach(::publish)
        } catch (error: IOException) {
            Log.e(LOG_TAG, "failed offline media snapshot publication", error)
        }
    }

    private fun publish(download: Download) {
        val metadata = metadata(download)
        if (metadata.accountId != activeAccountId) {
            return
        }
        emitState(
            metadata.mediaId,
            Presence.Present(project(download, metadata)),
        )
    }

    private fun project(
        download: Download,
        metadata: OfflineMediaMetadata,
    ): NativeLocalAvailability {
        if (synchronized(readLeases) { download.request.id in pendingRemovals }) {
            return NativeLocalAvailability.Removing
        }
        if (
            download.stopReason !in setOf(
                Download.STOP_REASON_NONE,
                OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON,
                OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
            )
        ) {
            throw OfflineMediaCorruptionException(
                "unknown offline media stop reason ${download.stopReason}"
            )
        }
        if (download.stopReason == OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON) {
            return NativeLocalAvailability.Failed
        }
        if (download.stopReason == OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON) {
            return NativeLocalAvailability.Queued(QueueReason.SystemLimit)
        }
        val ready = if (download.state == Download.STATE_COMPLETED) {
            val size = completedSize(download, metadata)
            if (
                size == null ||
                !isComplete(download.request.id, size) ||
                !hasExpectedContainer(download.request.id, metadata.contentType, size)
            ) {
                if (persistRepairRequired(download) == null) {
                    throw OfflineMediaPersistenceException()
                }
                null
            } else {
                NativeLocalAvailability.Ready(
                    size,
                    metadata.contentType,
                    Instant.ofEpochMilli(download.updateTimeMs),
                )
            }
        } else {
            null
        }
        return projectMedia3State(
            download.state,
            download.stopReason,
            download.bytesDownloaded,
            download.contentLength,
            metadata.contentLength,
            queueReason(),
            ready,
        )
    }

    private fun queueReason(): QueueReason {
        val network = connectivityManager.activeNetwork
        val capabilities = network?.let(connectivityManager::getNetworkCapabilities)
        if (
            capabilities == null ||
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        ) {
            return QueueReason.WaitingForNetwork
        }
        if (
            networkPolicy == NetworkPolicy.UnmeteredOnly &&
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        ) {
            return QueueReason.WaitingForUnmetered
        }
        return QueueReason.Capacity
    }

    private fun itemsForActiveAccount(): List<OfflineMediaItem> {
        val accountId = activeAccountId ?: return emptyList()
        return downloads()
            .filter { metadata(it).accountId == accountId }
            .sortedWith(
                compareBy<Download> { if (it.state in ACTIVE_STATES) 0 else 1 }
                    .thenByDescending { it.updateTimeMs }
            )
            .map { download ->
                val metadata = metadata(download)
                OfflineMediaItem(
                    metadata.mediaId,
                    metadata.title,
                    project(download, metadata),
                )
            }
    }

    private fun downloads(): List<Download> {
        return buildList {
            downloadIndex.getDownloads().use { cursor ->
                while (cursor.moveToNext()) {
                    add(cursor.download)
                }
            }
        }
    }

    private fun metadata(download: Download): OfflineMediaMetadata {
        return OfflineMediaMetadata.decode(download.request.data)
    }

    private fun completedSize(
        download: Download,
        metadata: OfflineMediaMetadata,
    ): Long? {
        val downloadLength = download.contentLength.takeIf { it > 0 }
        val cacheLength = ContentMetadata.getContentLength(
            cache.getContentMetadata(download.request.id)
        ).takeIf { it > 0 }
        val metadataLength = (metadata.contentLength as? Presence.Present)?.value
            ?.takeIf { it > 0 }
        val size = downloadLength ?: cacheLength ?: metadataLength ?: return null
        if (
            listOfNotNull(downloadLength, cacheLength, metadataLength)
                .any { it != size }
        ) {
            return null
        }
        return size
    }

    private fun isComplete(id: String, size: Long): Boolean {
        return size > 0 && cache.getCachedBytes(id, 0, size) == size
    }

    private fun hasExpectedContainer(id: String, contentType: String, size: Long): Boolean {
        val headerLength = minOf(size, 64).toInt()
        if (headerLength < 3) {
            return false
        }
        return try {
            val stream = cacheInputStream(Uri.EMPTY, id, 0, headerLength.toLong())
            stream.use {
                val header = ByteArray(headerLength)
                var offset = 0
                while (offset < header.size) {
                    val read = it.read(header, offset, header.size - offset)
                    if (read < 0) {
                        return false
                    }
                    offset += read
                }
                ProgressiveContainerVerifier.accepts(contentType, header)
            }
        } catch (_: IOException) {
            false
        }
    }

    private fun cacheInputStream(
        uri: Uri,
        id: String,
        position: Long,
        length: Long,
    ): DataSourceInputStream {
        val dataSource = CacheDataSource(
            cache,
            null,
            FileDataSource(),
            null,
            CacheDataSource.FLAG_BLOCK_ON_CACHE,
            null,
        )
        return DataSourceInputStream(
            dataSource,
            DataSpec.Builder()
                .setUri(uri)
                .setKey(id)
                .setPosition(position)
                .setLength(length)
                .build(),
        ).also { it.open() }
    }

    private fun brokenCompleted(download: Download): Result<OfflineMediaRead> {
        return if (persistRepairRequired(download) == null) {
            Result.failure(OfflineMediaPersistenceException())
        } else {
            Result.failure(LocalMediaMissingException())
        }
    }

    private fun markRepairRequired(download: Download) {
        if (download.stopReason == OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON) {
            return
        }
        worker.execute {
            persistRepairRequired(download)?.let(::publish)
        }
    }

    private fun persistRepairRequired(download: Download): Download? {
        val current = readDurableDownload(download.request.id) ?: download
        if (current.stopReason == OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON) {
            return current
        }
        val repairRequired = Download(
            current.request,
            Download.STATE_STOPPED,
            current.startTimeMs,
            maxOf(System.currentTimeMillis(), current.updateTimeMs + 1),
            current.contentLength,
            OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON,
            Download.FAILURE_REASON_NONE,
        )
        if (!ensureObservedDownload(repairRequired)) {
            Log.e(
                LOG_TAG,
                "downloadId=${download.request.id} failed repair marker persistence",
            )
            return null
        }
        return repairRequired
    }

    private fun emitState(
        mediaId: UUID,
        state: Presence<NativeLocalAvailability>,
    ) {
        listeners.forEach { it.onStateChanged(mediaId, state) }
    }

    private fun loadNetworkPolicy(): NetworkPolicy {
        val value = preferences.getString(
            NETWORK_POLICY_KEY,
            NetworkPolicy.UnmeteredOnly.name,
        )
        return NetworkPolicy.valueOf(value ?: error("network policy preference was null"))
    }

    private fun requirementsFor(policy: NetworkPolicy): Requirements {
        return Requirements(
            when (policy) {
                NetworkPolicy.UnmeteredOnly -> Requirements.NETWORK_UNMETERED
                NetworkPolicy.AnyConnected -> Requirements.NETWORK
            }
        )
    }

    private fun request(
        accountId: UUID,
        spec: OfflineDownloadSpec,
        source: VettedProgressiveSource,
    ): DownloadRequest {
        val id = stableDownloadId(accountId, spec.mediaId)
        return DownloadRequest.Builder(id, source.sourceUri)
            .setMimeType(source.contentType)
            .setCustomCacheKey(id)
            .setData(
                OfflineMediaMetadata(
                    accountId,
                    spec.mediaId,
                    spec.title,
                    source.contentType,
                    source.contentLength,
                ).encode()
            )
            .build()
    }

    private fun stableDownloadId(accountId: UUID, mediaId: UUID): String {
        val input = "${BuildOrigin.value}\u0000$accountId\u0000$mediaId"
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest(input.toByteArray(Charsets.UTF_8))
            .copyOfRange(0, 16)
        bytes[6] = (bytes[6].toInt() and 0x0f or 0x50).toByte()
        bytes[8] = (bytes[8].toInt() and 0x3f or 0x80).toByte()
        val high = bytes.copyOfRange(0, 8).fold(0L) { value, byte ->
            value shl 8 or (byte.toLong() and 0xff)
        }
        val low = bytes.copyOfRange(8, 16).fold(0L) { value, byte ->
            value shl 8 or (byte.toLong() and 0xff)
        }
        return UUID(high, low).toString()
    }

    private fun logPreflightFailure(
        id: String,
        spec: OfflineDownloadSpec,
        error: OfflineMediaSourceException,
    ) {
        val host = Uri.parse(spec.sourceUrl).host ?: "invalid"
        Log.w(
            LOG_TAG,
            "requestId=$id mediaId=${spec.mediaId} host=$host status=none redirects=0 " +
                "bytes=0 error=${error.cause?.javaClass?.simpleName ?: error.javaClass.simpleName}",
        )
    }

    private fun logDownload(download: Download, error: Exception?) {
        val metadata = metadata(download)
        Log.i(
            LOG_TAG,
            "requestId=${download.request.id} mediaId=${metadata.mediaId} " +
                "host=${download.request.uri.host ?: "invalid"} status=media3 redirects=owned " +
                "bytes=${download.bytesDownloaded} error=${error?.javaClass?.simpleName ?: "none"}",
        )
    }

    private object BuildOrigin {
        val value: String = canonicalOriginRule(app.nexus.android.BuildConfig.NEXUS_BASE_URL)
    }

    private inner class LeaseInputStream(
        input: InputStream,
        private val release: () -> Unit,
        private val onReadFailure: () -> Unit,
    ) : FilterInputStream(input) {
        private var closed = false

        override fun read(): Int = readGuarded { super.read() }

        override fun read(buffer: ByteArray): Int = readGuarded { super.read(buffer) }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            return readGuarded { super.read(buffer, offset, length) }
        }

        override fun close() {
            if (closed) {
                return
            }
            closed = true
            try {
                super.close()
            } finally {
                release()
            }
        }

        private fun readGuarded(read: () -> Int): Int {
            return try {
                read()
            } catch (error: IOException) {
                onReadFailure()
                throw error
            }
        }
    }

    companion object {
        private val ACTIVE_STATES = setOf(
            Download.STATE_QUEUED,
            Download.STATE_STOPPED,
            Download.STATE_DOWNLOADING,
            Download.STATE_REMOVING,
            Download.STATE_RESTARTING,
        )

        @Volatile
        private var instance: OfflineMediaStore? = null

        fun get(context: Context): OfflineMediaStore {
            return instance ?: synchronized(this) {
                instance ?: OfflineMediaStore(context).also { instance = it }
            }
        }
    }
}

internal class AccountMismatchException : IllegalStateException("offline media account is not connected")

internal class OfflineMediaPersistenceException(
    cause: Throwable? = null,
) : IOException("offline media index mutation could not be persisted", cause)

internal class OfflineMediaCorruptionException(
    message: String,
) : IllegalStateException(message)

internal class LocalMediaMissingException : IOException("offline media is unavailable")

internal class UnsatisfiableRangeException(val size: Long) : IOException("unsatisfiable byte range")
