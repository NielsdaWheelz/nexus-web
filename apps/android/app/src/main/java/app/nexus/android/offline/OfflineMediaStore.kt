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
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal const val OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON = 10_001
internal const val OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON = 10_002
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
                else -> error("unknown offline media stop reason $stopReason")
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
        else -> error("unknown Media3 download state $state")
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
        val callback: (List<OfflineMediaItem>, NetworkPolicy) -> Unit,
    )

    private data class QueuedConnect(
        val accountId: UUID,
        val generation: Long,
        val callback: (List<OfflineMediaItem>, NetworkPolicy) -> Unit,
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
    private val pendingEnqueues = mutableMapOf<String, PendingEnqueue>()
    private val connectQueue = ArrayDeque<QueuedConnect>()
    private val sessionGeneration = AtomicLong(0)

    @Volatile
    private var activeAccountId: UUID? = null
    private var pendingConnect: PendingConnect? = null
    private var initialized = false
    private var reconciled = false
    private var foregroundRequested = false
    @Volatile
    private var foregroundAuthorized = false
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
                                return@execute
                            }
                            pending.durableObserved = true
                            if (!pending.mayAdmit(activeAccountId, sessionGeneration.get())) {
                                pendingEnqueues.remove(download.request.id, pending)
                                requestRemoval(download.request.id)
                                completePending(
                                    pending,
                                    if (pending.canceled.get()) {
                                        Result.success(Unit)
                                    } else {
                                        Result.failure(AccountMismatchException())
                                    },
                                )
                                return@execute
                            }
                            logDownload(download, finalException)
                            publish(download)
                            mainHandler.post {
                                val shouldStart = foregroundAuthorized &&
                                    pending.mayAdmit(activeAccountId, sessionGeneration.get())
                                if (shouldStart) {
                                    OfflineMediaDownloadService.admit(
                                        appContext,
                                        download.request.id,
                                    )
                                }
                                worker.execute {
                                    pendingEnqueues.remove(download.request.id, pending)
                                    if (!pending.mayAdmit(activeAccountId, sessionGeneration.get())) {
                                        requestRemoval(download.request.id)
                                    }
                                    completePending(
                                        pending,
                                        if (pending.canceled.get()) {
                                            Result.success(Unit)
                                        } else if (
                                            activeAccountId != pending.accountId ||
                                            sessionGeneration.get() != pending.generation
                                        ) {
                                            Result.failure(AccountMismatchException())
                                        } else {
                                            Result.success(Unit)
                                        },
                                    )
                                }
                            }
                            return@execute
                        }
                        logDownload(download, finalException)
                        publish(download)
                    }
                }

                override fun onDownloadRemoved(
                    downloadManager: DownloadManager,
                    download: Download,
                ) {
                    worker.execute {
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
                        synchronized(readLeases) {
                            pendingRemovals.remove(download.request.id)
                        }
                        cache.removeResource(download.request.id)
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
    }

    fun connect(
        accountId: UUID,
        callback: (List<OfflineMediaItem>, NetworkPolicy) -> Unit,
    ) {
        if (activeAccountId != accountId) {
            activeAccountId = null
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
                callback(Result.success(itemsForActiveAccount() to networkPolicy))
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
            if (downloadIndex.getDownload(id) != null) {
                return@execute callback(Result.success(Unit))
            }
            startPreflightAttempt(accountId, spec, callback)
        }
    }

    fun cancel(mediaId: UUID, callback: (Result<Unit>) -> Unit) {
        withDownload(mediaId, callback) { download ->
            val accountId = activeAccountId
                ?: throw AccountMismatchException()
            val id = stableDownloadId(accountId, mediaId)
            pendingEnqueues[id]?.let { pending ->
                pending.canceled.set(true)
                pending.cancellation.cancel()
                requestRemoval(id)
            }
            if (
                download != null &&
                download.state in setOf(
                    Download.STATE_QUEUED,
                    Download.STATE_STOPPED,
                    Download.STATE_DOWNLOADING,
                    Download.STATE_RESTARTING,
                )
            ) {
                requestRemoval(id)
            }
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
            val download = downloadIndex.getDownload(id)
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
            cache.removeResource(id)
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
        withDownload(mediaId, callback) { download ->
            if (download != null) {
                val id = download.request.id
                pendingEnqueues[id]?.let { pending ->
                    pending.canceled.set(true)
                    pending.cancellation.cancel()
                }
                val (added, removeNow) = synchronized(readLeases) {
                    pendingRemovals.add(id) to ((readLeases[id] ?: 0) == 0)
                }
                if (added) {
                    emitState(mediaId, Presence.Present(NativeLocalAvailability.Removing))
                }
                if (removeNow) {
                    requestRemoval(id)
                }
            }
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
            check(preferences.edit().putString(NETWORK_POLICY_KEY, policy.name).commit())
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
        foregroundAuthorized = true
        worker.execute {
            foregroundRequested = true
            maybeResumeInForeground()
        }
    }

    fun onAppBackground() {
        foregroundAuthorized = false
        worker.execute { foregroundRequested = false }
    }

    fun pauseForSystemLimit() {
        check(Looper.myLooper() == downloadManager.applicationLooper)
        downloadManager.currentDownloads.filter {
            it.state in setOf(
                Download.STATE_QUEUED,
                Download.STATE_DOWNLOADING,
                Download.STATE_RESTARTING,
            )
        }.forEach { download ->
            downloadManager.setStopReason(
                download.request.id,
                OFFLINE_MEDIA_SYSTEM_LIMIT_STOP_REASON,
            )
        }
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
            val download = downloadIndex.getDownload(id)
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
        val queued = connectQueue.removeFirst()
        if (queued.generation != sessionGeneration.get()) {
            startNextConnect()
            return
        }
        if (activeAccountId == queued.accountId) {
            queued.callback(itemsForActiveAccount(), networkPolicy)
            startNextConnect()
            return
        }
        activeAccountId = null
        val foreign = downloads()
            .filter { metadata(it).accountId != queued.accountId }
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
        foreign.forEach { id ->
            val removeNow = synchronized(readLeases) {
                if ((readLeases[id] ?: 0) == 0) {
                    true
                } else {
                    pendingRemovals.add(id)
                    false
                }
            }
            if (removeNow) {
                requestRemoval(id)
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
        connect.callback(itemsForActiveAccount(), networkPolicy)
        maybeResumeInForeground()
        startNextConnect()
    }

    private fun withDownload(
        mediaId: UUID,
        callback: (Result<Unit>) -> Unit,
        action: (Download?) -> Unit,
    ) {
        worker.execute {
            val accountId = activeAccountId
                ?: return@execute callback(Result.failure(AccountMismatchException()))
            action(downloadIndex.getDownload(stableDownloadId(accountId, mediaId)))
            callback(Result.success(Unit))
        }
    }

    private fun requestRemoval(id: String) {
        mainHandler.post { downloadManager.removeDownload(id) }
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

    private fun reconcile() {
        if (reconciled) {
            return
        }
        val indexedDownloads = downloads()
        val indexedIds = indexedDownloads.mapTo(mutableSetOf()) { it.request.id }
        cache.keys.filterNot(indexedIds::contains).forEach(cache::removeResource)
        indexedDownloads.forEach { download ->
            val metadata = metadata(download)
            check(download.request.id == stableDownloadId(metadata.accountId, metadata.mediaId))
            check(download.request.customCacheKey == download.request.id)
            if (download.state == Download.STATE_COMPLETED) {
                val size = completedSize(download, metadata)
                if (
                    size == null ||
                    !isComplete(download.request.id, size) ||
                    !hasExpectedContainer(download.request.id, metadata.contentType, size)
                ) {
                    markRepairRequired(download)
                }
            } else {
                cache.removeResource(download.request.id)
            }
        }
        reconciled = true
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
        val resumable = downloads().any {
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
        downloads().forEach(::publish)
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
            error("unknown offline media stop reason ${download.stopReason}")
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
                markRepairRequired(download)
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
        markRepairRequired(download)
        return Result.failure(LocalMediaMissingException())
    }

    private fun markRepairRequired(download: Download) {
        if (download.stopReason == OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON) {
            return
        }
        mainHandler.post {
            downloadManager.setStopReason(
                download.request.id,
                OFFLINE_MEDIA_REPAIR_REQUIRED_STOP_REASON,
            )
        }
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

internal class LocalMediaMissingException : IOException("offline media is unavailable")

internal class UnsatisfiableRangeException(val size: Long) : IOException("unsatisfiable byte range")
