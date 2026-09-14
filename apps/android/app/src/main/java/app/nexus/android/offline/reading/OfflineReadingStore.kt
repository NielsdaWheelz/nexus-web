package app.nexus.android.offline.reading

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteFullException
import android.database.sqlite.SQLiteDiskIOException
import android.net.ConnectivityManager
import android.system.Os
import android.system.ErrnoException
import android.system.OsConstants
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.OfflineNetworkPolicyStore
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.StandardCopyOption
import java.time.Clock
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executor
import java.util.concurrent.Executors

internal data class AttestedOfflineReaderBaseline(
    val accountId: UUID,
    val readerGeneration: Long,
    val snapshotJson: String,
)

internal data class OfflineReadingAccountTransition(
    val targetAccountId: UUID?,
)

internal sealed interface OfflineReadingAccountTransitionView {
    data object None : OfflineReadingAccountTransitionView
    data object Logout : OfflineReadingAccountTransitionView
    data class AccountSwitch(val targetAccountId: UUID) : OfflineReadingAccountTransitionView
}

internal sealed interface OfflineReadingReconciliationOutcome {
    data class Ready(val snapshot: ReadingStoreSnapshot) :
        OfflineReadingReconciliationOutcome

    data class Deferred(val snapshot: ReadingStoreSnapshot) :
        OfflineReadingReconciliationOutcome

    data class Failed(val cause: Exception) :
        OfflineReadingReconciliationOutcome
}

internal enum class OfflineReadingStalePolicyJobFinish {
    Complete,
    Retry,
}

/**
 * A runner admitted under one network policy must not claim new work after the policy
 * changed: its `JobParameters.network` was granted for the old constraint. The claim is
 * atomic with the policy read under the store monitor, so a transfer returned as [Run]
 * is guaranteed to have been claimed while the runner's admitted policy was current.
 */
internal sealed interface OfflineReadingRunnableClaim {
    data class Run(val transfer: OfflineReadingTransfer) : OfflineReadingRunnableClaim
    data object Idle : OfflineReadingRunnableClaim
    data object PolicyChanged : OfflineReadingRunnableClaim
}

internal interface OfflineReadingDurability {
    fun syncTree(directory: File)
    fun syncDirectory(directory: File)
}

internal data object AndroidOfflineReadingDurability : OfflineReadingDurability {
    override fun syncTree(directory: File) {
        directory.walkBottomUp().forEach { file ->
            if (file.isFile) {
                file.inputStream().use { input -> input.fd.sync() }
            } else if (file.isDirectory) {
                syncDirectory(file)
            }
        }
    }

    override fun syncDirectory(directory: File) {
        try {
            val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
            try {
                Os.fsync(descriptor)
            } finally {
                Os.close(descriptor)
            }
        } catch (error: ErrnoException) {
            // Kernel resource failures are retryable. Invalid descriptors,
            // arguments and other programming failures keep their exact cause.
            when (error.errno) {
                OsConstants.ENOENT -> throw NoSuchFileException(directory.path).apply { initCause(error) }
                OsConstants.EIO, OsConstants.ENOSPC, OsConstants.EDQUOT,
                OsConstants.EACCES, OsConstants.EPERM, OsConstants.EROFS,
                OsConstants.ENOMEM, OsConstants.EMFILE, OsConstants.ENFILE ->
                    throw IOException("directory durability unavailable: ${directory.path}", error)
                else -> throw error
            }
        }
    }
}

internal class OfflineReadingStore internal constructor(
    context: Context,
    private val database: OfflineReadingDatabase = OfflineReadingDatabase(context.applicationContext),
    private val seal: OfflineReadingBindingSealPort = OfflineReadingBindingSeal(),
    private val ids: OfflineReadingIdSource = Uuid7Source(),
    /** The one time source for this store and for the origin client its runner drives. */
    internal val clock: Clock = Clock.systemUTC(),
    private val packageVerifier: OfflineReadingPackageVerifierPort = OfflineReadingPackageVerifier(),
    private val installedVerifier: OfflineReadingInstalledPackageVerifierPort =
        OfflineReadingInstalledPackageVerifier(),
    private val rootDirectory: File = File(context.applicationContext.filesDir, "offline-reading"),
    /** Current filesystem availability, measured like `StatFs`; this reserves no bytes. */
    private val freeSpaceBytes: (File) -> Long = { directory -> directory.usableSpace },
    private val durability: OfflineReadingDurability = AndroidOfflineReadingDurability,
    private val schedulerFactory: (OfflineReadingStore) -> OfflineReadingSchedulerPort = { store ->
        OfflineReadingScheduler(context.applicationContext, store)
    },
    private val progressOriginFactory: OfflineReaderProgressOriginFactory =
        OfflineReaderProgressOriginFactory { network ->
            HttpOfflineReaderProgressOriginClient(network)
        },
    private val integrityExecutor: Executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "NexusOfflineReadingIntegrity").apply { isDaemon = true }
    },
    reconcileOnInit: Boolean = true,
) : OfflineReaderProgressRepository {
    private val appContext = context.applicationContext
    private val listeners = CopyOnWriteArraySet<(ReadingStoreSnapshot) -> Unit>()
    private val leases = ConcurrentHashMap<UUID, OfflineReadingLease>()
    private sealed interface PackageReadiness {
        data object Prepared : PackageReadiness
        data object ConversionRequired : PackageReadiness
        data object StorageBlocked : PackageReadiness
        data class Limited(val refusal: OfflineReadingConversionRefusal) : PackageReadiness
    }
    private data class ReconciledPackage(val installed: OfflineReadingPackage, val readiness: PackageReadiness)
    private val verifiedPackages = ConcurrentHashMap<UUID, ReconciledPackage>()
    private val scheduler by lazy { schedulerFactory(this) }
    private val progressSyncExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "NexusOfflineReaderProgressSync").apply { isDaemon = true }
    }
    @Volatile private var bindingLocked = reconcileOnInit
    @Volatile private var reconciliationComplete = !reconcileOnInit
    private var reconciliationRunning = false
    private var reconciliationEpoch = 0L
    private var reconciliationClaimedByJob = false
    private var reconciliationAllowsLiveRunner = false
    private val reconciliationCallbacks =
        mutableListOf<(OfflineReadingReconciliationOutcome) -> Unit>()
    // One callback in the existing completion list coalesces explicit retries
    // that overlap a run whose snapshot still contains the previous refusal.
    private val retryReconciliation: (OfflineReadingReconciliationOutcome) -> Unit = { requestReconciliation() }

    init {
        rootDirectory.mkdirs()
        if (reconcileOnInit) requestReconciliation()
    }

    fun bindAccountAfterExternalPurge(accountId: UUID): ReadingStoreSnapshot {
        beginAccountTransition(accountId)
        return completeAccountTransition(accountId)
    }

    fun beginAccountTransition(targetAccountId: UUID?): ReadingStoreSnapshot {
        OfflineReadingTransferOperations.cancelAll()
        val started = synchronized(this) {
            val current = readAccountTransition()
            check(current == null || current.targetAccountId == targetAccountId)
            if (
                current == null &&
                targetAccountId != null &&
                readBinding()?.accountId == targetAccountId
            ) {
                return@synchronized false
            }
            if (current == null) {
                database.writableDatabase.execSQL(
                    """
                    INSERT INTO offline_reader_account_transitions(
                        id, singleton_id, kind, target_account_id, requested_at
                    ) VALUES(?, 1, ?, ?, ?)
                    """.trimIndent(),
                    arrayOf(
                        ids.next().toString(),
                        if (targetAccountId == null) "Logout" else "AccountSwitch",
                        targetAccountId?.toString(),
                        clock.instant().toString(),
                    ),
                )
            }
            reconciliationEpoch += 1
            reconciliationComplete = false
            verifiedPackages.clear()
            bindingLocked = true
            true
        }
        if (!started) return snapshot()
        scheduler.suspendForAccountTransition()
        notifySnapshotChanged()
        return snapshot()
    }

    fun completeAccountTransition(targetAccountId: UUID?): ReadingStoreSnapshot {
        synchronized(this) {
            val transition = readAccountTransition() ?: run {
                val current = readBinding()
                require(targetAccountId != null && current?.accountId == targetAccountId)
                clearRemoteAuthorizationFence(current)
                return snapshot()
            }
            require(transition.targetAccountId == targetAccountId)
            readBinding()?.let { binding ->
                purgeReadingState(binding, transitionReason(targetAccountId), deleteSeal = true)
            }
            if (targetAccountId != null) createBinding(targetAccountId)
            database.writableDatabase.execSQL("DELETE FROM offline_reader_account_transitions")
            reconciliationEpoch += 1
            reconciliationComplete = true
            bindingLocked = false
        }
        notifySnapshotChanged()
        if (targetAccountId != null) synchronizeReaderProgress()
        return snapshot()
    }

    private fun createBinding(accountId: UUID) {
        val current = readBinding()
        if (current != null) {
            require(current.accountId == accountId)
            requireBindingSeal(current)
            return
        }
        val bindingId = ids.next()
        val now = clock.instant()
        val bindingSeal = seal.create(bindingId, accountId)
        database.writableDatabase.execSQL(
            """
            INSERT INTO offline_reader_binding(
                id, singleton_id, binding_id, account_id, binding_seal,
                remote_authorization_required, bound_at
            ) VALUES(?, 1, ?, ?, ?, 0, ?)
            """.trimIndent(),
            arrayOf(
                ids.next().toString(),
                bindingId.toString(),
                accountId.toString(),
                bindingSeal,
                now.toString(),
            ),
        )
    }

    @Synchronized
    fun snapshot(): ReadingStoreSnapshot {
        if (!reconciliationComplete || bindingLocked || readAccountTransition() != null) {
            return ReadingStoreSnapshot(
                OfflineReadingBindingView.Absent,
                OfflineNetworkPolicyStore(appContext).get(),
                emptyList(),
            )
        }
        val binding = readBinding()
            ?.let {
                OfflineReadingBindingView.Present(it.accountId, it.authorizationRequired)
            }
            ?: OfflineReadingBindingView.Absent
        return ReadingStoreSnapshot(
            binding = binding,
            networkPolicy = OfflineNetworkPolicyStore(appContext).get(),
            items = readPackageItems() + readTransferItems(),
        )
    }

    fun addListener(listener: (ReadingStoreSnapshot) -> Unit): AutoCloseable {
        listeners.add(listener)
        listener(snapshot())
        return AutoCloseable { listeners.remove(listener) }
    }

    @Synchronized
    fun pendingAccountTransition(): OfflineReadingAccountTransitionView {
        val transition = readAccountTransition()
            ?: return OfflineReadingAccountTransitionView.None
        return transition.targetAccountId?.let {
            OfflineReadingAccountTransitionView.AccountSwitch(it)
        } ?: OfflineReadingAccountTransitionView.Logout
    }

    fun enqueue(
        mediaId: UUID,
        requestedTitle: String,
        requestedMediaKind: OfflineReadingMediaKind,
        readerGeneration: Long,
    ): ReadingStoreSnapshot {
        requireOfflineReadingSupported()
        synchronized(this) {
            requireTitle(requestedTitle)
            require(readerGeneration > 0)
            val binding = requireBinding()
            check(!binding.authorizationRequired) { "offline reading reauthorization required" }
            require(readPackage(binding.bindingId, mediaId) == null)
            val existing = readTransfer(binding.bindingId, mediaId)
            if (existing == null) {
                val transfer = OfflineReadingTransfer(
                    id = ids.next(),
                    bindingId = binding.bindingId,
                    mediaId = mediaId,
                    requestedTitle = requestedTitle,
                    requestedMediaKind = requestedMediaKind,
                    state = ReadingTransferState.Preparing,
                    automaticRestartCount = 0,
                    stagingName = ids.next().toString(),
                    requestedAt = clock.instant(),
                    readerGeneration = readerGeneration,
                    preparationStartedAt = null,
                )
                insertTransfer(transfer)
            }
        }
        if (scheduler.ensureScheduled()) {
            markPreparingTransfersAdmitted()
        } else {
            markSchedulerAdmissionFailed()
        }
        notifySnapshotChanged()
        return snapshot()
    }

    @Synchronized
    fun cancel(mediaId: UUID): ReadingStoreSnapshot {
        val binding = requireBinding()
        val transfer = readTransfer(binding.bindingId, mediaId) ?: return snapshot()
        deleteStaging(transfer)
        database.writableDatabase.execSQL(
            "DELETE FROM offline_reader_transfers WHERE id = ? AND binding_id = ?",
            arrayOf(transfer.id.toString(), binding.bindingId.toString()),
        )
        notifySnapshotChanged()
        return snapshot()
    }

    fun retry(mediaId: UUID): ReadingStoreSnapshot {
        val needsUpgrade = synchronized(this) {
            val binding = requireBinding()
            val installed = readPackage(binding.bindingId, mediaId)
            if (installed != null && verifiedPackages[installed.id]?.readiness != PackageReadiness.Prepared) {
                if (installed.conversionRefusal != null) {
                    val values = ContentValues().apply { putNull("conversion_refusal") }
                    check(database.writableDatabase.update("offline_reader_packages", values, "id = ?", arrayOf(installed.id.toString())) == 1)
                }
                if (reconciliationRunning && retryReconciliation !in reconciliationCallbacks) {
                    reconciliationCallbacks += retryReconciliation
                }
                true
            } else false
        }
        if (needsUpgrade) {
            requestReconciliation()
            return snapshot()
        }
        synchronized(this) {
            val binding = requireBinding()
            check(!binding.authorizationRequired) { "offline reading reauthorization required" }
            val transfer = readTransfer(binding.bindingId, mediaId)
                ?: error("offline reading transfer not found")
            require(transfer.state is ReadingTransferState.Failed)
            deleteStaging(transfer)
            val next = transfer.copy(
                state = ReadingTransferState.Preparing,
                automaticRestartCount = 0,
                stagingName = ids.next().toString(),
                preparationStartedAt = null,
            )
            replaceTransfer(next)
        }
        if (scheduler.ensureScheduled()) {
            markPreparingTransfersAdmitted()
        } else {
            markSchedulerAdmissionFailed()
        }
        notifySnapshotChanged()
        return snapshot()
    }

    @Synchronized
    fun remove(mediaId: UUID): ReadingStoreSnapshot {
        val binding = requireBinding()
        val installed = readPackage(binding.bindingId, mediaId)
            ?: return cancel(mediaId)
        val existing = readRemoval(installed.id)
        if (!existing) {
            database.writableDatabase.execSQL(
                "INSERT INTO offline_reader_removals(id, package_id, requested_at) VALUES(?, ?, ?)",
                arrayOf(ids.next().toString(), installed.id.toString(), clock.instant().toString()),
            )
        }
        if (leases.values.none { it.mediaId == mediaId }) {
            finishRemoval(installed)
        }
        notifySnapshotChanged()
        return snapshot()
    }

    @Synchronized
    fun open(mediaId: UUID): OfflineReadingLease {
        val binding = requireBinding()
        val installed = readPackage(binding.bindingId, mediaId)
            ?: error("offline reading package not found")
        check(!readRemoval(installed.id)) { "offline reading package is removing" }
        check(installed.packageSchemaVersion == OFFLINE_READING_PACKAGE_SCHEMA_VERSION) {
            "offline reading package requires local conversion"
        }
        val directory = packageDirectory(binding.bindingId, installed.id)
        check(verifiedPackages[installed.id] == ReconciledPackage(installed, PackageReadiness.Prepared) && directory.isDirectory) {
            "offline reading package has not passed this process integrity reconciliation"
        }
        val manifestFile = File(directory, "manifest.json")
        require(manifestFile.length() <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
        val manifest = OfflineReadingManifestParser.parse(manifestFile.readBytes())
        require(manifest.mediaId == mediaId && manifest.readerGeneration == installed.readerGeneration &&
            manifest.readerRevisionKey == installed.readerRevisionKey)
        val lease = OfflineReadingLease(
            id = ids.next(),
            mediaId = mediaId,
            readerGeneration = installed.readerGeneration,
            readerRevisionKey = installed.readerRevisionKey,
            installedAt = installed.installedAt,
            progress = readProgress(binding.bindingId, mediaId, installed.readerGeneration),
            packageDirectory = directory,
            memberMediaTypes = manifest.entries.associate { it.path to it.mediaType },
        )
        leases[lease.id] = lease
        return lease
    }

    fun openAsync(mediaId: UUID, callback: (Result<OfflineReadingLease>) -> Unit) {
        integrityExecutor.execute { callback(runCatching { open(mediaId) }) }
    }

    @Synchronized
    fun closeLease(leaseId: UUID) {
        val lease = leases.remove(leaseId) ?: return
        val binding = readBinding() ?: return
        val installed = readPackage(binding.bindingId, lease.mediaId) ?: return
        if (readRemoval(installed.id) && leases.values.none { it.mediaId == lease.mediaId }) {
            finishRemoval(installed)
            notifySnapshotChanged()
        }
    }

    @Synchronized
    fun saveReaderProgress(
        mediaId: UUID,
        readerGeneration: Long,
        readerRevisionKey: String,
        locatorJson: String,
    ): NativeReaderProgressView {
        OfflineReaderStateValidator.requireLocator(locatorJson)
        val binding = requireBinding()
        val installed = readPackage(binding.bindingId, mediaId)
            ?: error("offline reading package not found")
        require(installed.readerGeneration == readerGeneration)
        require(installed.readerRevisionKey == readerRevisionKey)
        val baseline = readBaseline(binding.bindingId, mediaId)
            ?: error("offline reading baseline is missing")
        val existingPending = readPending(binding.bindingId, mediaId)
        if (existingPending != null && existingPending.readerGeneration != readerGeneration) {
            return readProgress(binding.bindingId, mediaId, installed.readerGeneration)
        }
        val baseRevision = existingPending?.baseServerRevision ?: readerSnapshotRevision(baseline.serverSnapshotJson)
        val syncState = if (baseline.readerGeneration != readerGeneration) {
            OfflineReaderSyncState.ContentChanged
        } else existingPending?.syncState ?: OfflineReaderSyncState.Pending
        val now = clock.instant()
        val db = database.writableDatabase
        db.transaction {
            val present = queryOne(
                "SELECT id FROM offline_reader_progress_pending WHERE binding_id = ? AND media_id = ?",
                arrayOf(binding.bindingId.toString(), mediaId.toString()),
            ) {}
            if (present) {
                execSQL(
                    """
                    UPDATE offline_reader_progress_pending
                    SET reader_generation = ?, reader_revision_key = ?, base_server_revision = ?,
                        locator_json = ?, sync_state = ?, updated_at = ?
                    WHERE binding_id = ? AND media_id = ?
                    """.trimIndent(),
                    arrayOf(
                        readerGeneration,
                        readerRevisionKey,
                        baseRevision,
                        locatorJson,
                        syncState.name,
                        now.toString(),
                        binding.bindingId.toString(),
                        mediaId.toString(),
                    ),
                )
            } else {
                execSQL(
                    """
                    INSERT INTO offline_reader_progress_pending(
                        id, binding_id, media_id, reader_generation, reader_revision_key,
                        base_server_revision, locator_json, sync_state, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """.trimIndent(),
                    arrayOf(
                        ids.next().toString(),
                        binding.bindingId.toString(),
                        mediaId.toString(),
                        readerGeneration,
                        readerRevisionKey,
                        baseRevision,
                        locatorJson,
                        syncState.name,
                        now.toString(),
                    ),
                )
            }
        }
        notifySnapshotChanged()
        if (syncState == OfflineReaderSyncState.Pending) {
            synchronizeReaderProgress(mediaId)
        }
        return readProgress(binding.bindingId, mediaId, installed.readerGeneration)
    }

    fun resolveReaderProgress(
        mediaId: UUID,
        readerGeneration: Long,
        readerRevisionKey: String,
        expected: StrictJson.ObjectValue,
        useCanonical: Boolean,
    ): NativeReaderProgressView {
        var shouldSynchronize = false
        val result = synchronized(this) {
            val binding = requireBinding()
            val installed = readPackage(binding.bindingId, mediaId)
                ?: error("offline reading package is missing")
            require(installed.readerGeneration == readerGeneration && installed.readerRevisionKey == readerRevisionKey) {
                "downloaded copy changed; reopen it before resolving progress"
            }
            val observed = readProgress(binding.bindingId, mediaId, installed.readerGeneration)
            if (!strictJsonSemanticallyEqual(expected, readerProgressViewJson(observed))) return@synchronized observed
            val baseline = readBaseline(binding.bindingId, mediaId)
                ?: error("offline reading baseline is missing")
            val pending = readPending(binding.bindingId, mediaId)
                ?: return@synchronized observed
            check(observed is NativeReaderProgressView.Conflict || observed is NativeReaderProgressView.ContentChanged) {
                "only conflicted or content-changed progress can be resolved"
            }
            if (useCanonical) {
                database.writableDatabase.execSQL(
                    "DELETE FROM offline_reader_progress_pending WHERE binding_id = ? AND media_id = ?",
                    arrayOf(binding.bindingId.toString(), mediaId.toString()),
                )
            } else {
                if (observed is NativeReaderProgressView.ContentChanged) return@synchronized observed
                check(pending.readerGeneration == baseline.readerGeneration)
                database.writableDatabase.execSQL(
                    """
                    UPDATE offline_reader_progress_pending
                    SET base_server_revision = ?, sync_state = ?, updated_at = ?
                    WHERE binding_id = ? AND media_id = ?
                    """.trimIndent(),
                    arrayOf(
                        readerSnapshotRevision(baseline.serverSnapshotJson),
                        OfflineReaderSyncState.Pending.name,
                        clock.instant().toString(),
                        binding.bindingId.toString(),
                        mediaId.toString(),
                    ),
                )
                shouldSynchronize = true
            }
            notifySnapshotChanged()
            readProgress(binding.bindingId, mediaId, installed.readerGeneration)
        }
        if (shouldSynchronize) synchronizeReaderProgress(mediaId)
        return result
    }

    fun synchronizeReaderProgress(mediaId: UUID? = null) {
        if (synchronized(this) { readBinding()?.authorizationRequired != false }) return
        val network = appContext.getSystemService(ConnectivityManager::class.java).activeNetwork
            ?: return
        progressSyncExecutor.execute {
            try {
                OfflineReaderProgressSynchronizer(
                    this,
                    progressOriginFactory.create(network),
                ).synchronize(mediaId)
            } catch (defect: Exception) {
                // justify-ignore-error: this background pass owns no caller to raise to, and
                // crashing the process would destroy nothing but the app. Every pending row
                // keeps its exact intent and the next pass retries; the defect stays loud.
                android.util.Log.e("OfflineReading", "reader progress synchronization failed", defect)
            }
        }
    }

    fun logoutAndPurge(): ReadingStoreSnapshot {
        beginAccountTransition(null)
        return completeAccountTransition(null)
    }

    fun setNetworkPolicy(policy: NetworkPolicy): ReadingStoreSnapshot {
        val changed = synchronized(this) {
            val policyStore = OfflineNetworkPolicyStore(appContext)
            if (policyStore.get() == policy) {
                false
            } else {
                policyStore.set(policy)
                reclassifyTransfersForPolicyChange(policy)
                true
            }
        }
        val admitted = if (changed) {
            scheduler.rescheduleForPolicyChange()
        } else {
            scheduler.ensureScheduled()
        }
        if (!admitted) {
            markSchedulerAdmissionFailed()
        } else if (!changed) {
            markPreparingTransfersAdmitted()
        }
        notifySnapshotChanged()
        return snapshot()
    }

    @Synchronized
    private fun reclassifyTransfersForPolicyChange(policy: NetworkPolicy) {
        val binding = readBinding() ?: return
        val transfers = readTransfers(binding.bindingId).filter {
            it.state !is ReadingTransferState.Failed
        }
        val active = transfers.filter { transfer ->
            transfer.state.isActiveTransferPhase() &&
                OfflineReadingTransferOperations.isActive(transfer.id)
        }
        check(active.size <= 1) { "offline reading queue has more than one active transfer" }
        val activeTransfer = active.singleOrNull()
        activeTransfer?.let(::deleteStaging)
        val queueReason = queueReasonForPolicy(policy)
        database.writableDatabase.transaction {
            transfers.forEach { transfer ->
                val isActive = activeTransfer?.id == transfer.id
                val state = if (isActive) {
                    checkpointForPolicyChange(transfer.automaticRestartCount).state
                } else {
                    ReadingTransferState.Queued(queueReason)
                }
                execSQL(
                    """
                    UPDATE offline_reader_transfers
                    SET state_json = ?, staging_name = ?
                    WHERE id = ? AND binding_id = ?
                    """.trimIndent(),
                    arrayOf(
                        OfflineReadingStateCodec.encode(state),
                        if (isActive) ids.next().toString() else transfer.stagingName,
                        transfer.id.toString(),
                        binding.bindingId.toString(),
                    ),
                )
            }
        }
    }

    @Synchronized
    private fun markPreparingTransfersAdmitted() {
        val binding = readBinding() ?: return
        val queueReason = queueReasonForPolicy(OfflineNetworkPolicyStore(appContext).get())
        readTransfers(binding.bindingId)
            .filter { it.state is ReadingTransferState.Preparing }
            .forEach { transfer ->
                replaceTransfer(
                    transfer.copy(state = ReadingTransferState.Queued(queueReason))
                )
            }
    }

    private fun queueReasonForPolicy(policy: NetworkPolicy): ReadingQueueReason =
        if (policy == NetworkPolicy.UnmeteredOnly) {
            ReadingQueueReason.WaitingForUnmetered
        } else {
            ReadingQueueReason.Capacity
        }

    private fun ReadingTransferState.isActiveTransferPhase(): Boolean =
        this is ReadingTransferState.Authorizing ||
            this is ReadingTransferState.Downloading ||
            this is ReadingTransferState.Verifying

    @Synchronized
    private fun markSchedulerAdmissionFailed() {
        val binding = readBinding() ?: return
        val transfers = readTransfers(binding.bindingId).filter {
            it.state !is ReadingTransferState.Failed
        }
        transfers.forEach(::deleteStaging)
        database.writableDatabase.transaction {
            transfers.forEach { transfer ->
                execSQL(
                    """
                    UPDATE offline_reader_transfers
                    SET state_json = ?, staging_name = ?
                    WHERE id = ? AND binding_id = ?
                    """.trimIndent(),
                    arrayOf(
                        OfflineReadingStateCodec.encode(
                            ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired)
                        ),
                        ids.next().toString(),
                        transfer.id.toString(),
                        binding.bindingId.toString(),
                    ),
                )
            }
        }
    }

    @Synchronized
    fun hasPendingProgress(mediaId: UUID): Boolean {
        val binding = requireBinding()
        return readPending(binding.bindingId, mediaId) != null
    }

    fun reconcile(): ReadingStoreSnapshot {
        requestReconciliation()
        return snapshot()
    }

    fun reconcileAsync(callback: (OfflineReadingReconciliationOutcome) -> Unit) {
        requestReconciliation(callback)
    }

    internal fun reconcileForJob(
        callback: (OfflineReadingReconciliationOutcome) -> Unit,
    ) {
        synchronized(this) {
            if (reconciliationRunning) {
                reconciliationClaimedByJob = true
                reconciliationCallbacks += callback
                return
            }
        }
        integrityExecutor.execute {
            val outcome = synchronized(this) {
                // A run may have been claimed after this inspection was queued.
                if (reconciliationRunning) {
                    reconciliationClaimedByJob = true
                    reconciliationCallbacks += callback
                    return@execute
                }
                try {
                    if (reconciliationComplete && !bindingLocked && readAccountTransition() == null) {
                        OfflineReadingReconciliationOutcome.Ready(snapshot())
                    } else {
                        reconciliationClaimedByJob = true
                        null
                    }
                } catch (error: Exception) {
                    // Fail this inspection before another caller can claim a new run.
                    bindingLocked = true
                    reconciliationComplete = false
                    verifiedPackages.clear()
                    android.util.Log.e("OfflineReading", "job reconciliation inspection failed", error)
                    OfflineReadingReconciliationOutcome.Failed(error)
                }
            }
            if (outcome == null) {
                requestReconciliation(callback)
                return@execute
            }
            try {
                callback(outcome)
            } catch (error: Exception) {
                android.util.Log.e("OfflineReading", "reconciliation callback failed", error)
            }
        }
    }

    /**
     * A JobInfo with stale policy constraints must not retain reconciliation ownership. Once
     * reconciliation exposes durable work, replace that fixed ID with the current constraint.
     */
    internal fun recoverStalePolicyJob(callback: (OfflineReadingStalePolicyJobFinish) -> Unit) {
        synchronized(this) { reconciliationClaimedByJob = false }
        requestReconciliation { outcome ->
            if (outcome is OfflineReadingReconciliationOutcome.Ready) {
                if (!scheduler.rescheduleForPolicyChange()) {
                    markSchedulerAdmissionFailed()
                }
                callback(OfflineReadingStalePolicyJobFinish.Complete)
            } else if (outcome is OfflineReadingReconciliationOutcome.Deferred) {
                // The old fixed-ID job must ask JobScheduler to retain ownership until unlock.
                callback(OfflineReadingStalePolicyJobFinish.Retry)
            } else {
                // The cause has been reported; a defect must not spin the job.
                callback(OfflineReadingStalePolicyJobFinish.Complete)
            }
        }
    }

    private fun requestReconciliation(
        callback: ((OfflineReadingReconciliationOutcome) -> Unit)? = null,
    ) {
        val claimedByJobAtRequest = OfflineReadingScheduler.jobOwnsReconciliation()
        val liveRunnerAtRequest = OfflineReadingScheduler.runnerIsActive()
        val epoch = synchronized(this) {
            if (callback != null) reconciliationCallbacks += callback
            if (claimedByJobAtRequest) reconciliationClaimedByJob = true
            if (reconciliationRunning) return
            reconciliationRunning = true
            reconciliationComplete = false
            reconciliationAllowsLiveRunner = liveRunnerAtRequest
            bindingLocked = !liveRunnerAtRequest
            verifiedPackages.clear()
            reconciliationEpoch += 1
            reconciliationEpoch
        }
        integrityExecutor.execute { runReconciliation(epoch, liveRunnerAtRequest) }
    }

    private fun runReconciliation(epoch: Long, liveRunnerAtRequest: Boolean) {
        var shouldSchedule = false
        var suspendedForTransition = false
        var failure: Exception? = null
        try {
            notifySnapshotChanged()
            val preparation = synchronized(this) {
                if (epoch != reconciliationEpoch) return@synchronized null
                if (readAccountTransition() != null) {
                    suspendedForTransition = true
                    return@synchronized null
                }
                val binding = readBinding()
                if (binding == null) {
                    purgeUnboundState()
                    bindingLocked = false
                    reconciliationComplete = true
                    return@synchronized null
                }
                if (hasPurge(binding.bindingId)) {
                    purgeReadingState(binding, "Logout", deleteSeal = true)
                    bindingLocked = false
                    reconciliationComplete = true
                    return@synchronized null
                }
                var storedSeal = byteArrayOf()
                check(
                    database.readableDatabase.queryOne(
                        "SELECT binding_seal FROM offline_reader_binding WHERE singleton_id = 1",
                    ) { cursor ->
                        storedSeal = cursor.getBlob(cursor.getColumnIndexOrThrow("binding_seal"))
                    }
                )
                when (
                    bindingReconciliationAction(
                        seal.verify(binding.bindingId, binding.accountId, storedSeal)
                    )
                ) {
                    BindingReconciliationAction.Continue -> Unit
                    BindingReconciliationAction.DeferUntilUnlocked -> return@synchronized null
                    BindingReconciliationAction.Purge -> {
                        purgeReadingState(binding, "Logout", deleteSeal = true)
                        bindingLocked = false
                        reconciliationComplete = true
                        return@synchronized null
                    }
                }
                val orphanDirectoryPresent = !liveRunnerAtRequest &&
                    orphanPackageDirectories(binding, readPackages(binding.bindingId))
                        .isNotEmpty()
                reconcileInterruptedTransfers(
                    binding.bindingId,
                    liveRunnerAtRequest,
                    orphanDirectoryPresent,
                )
                if (!liveRunnerAtRequest) cleanupStaging(binding.bindingId)
                readPackages(binding.bindingId)
                    .filter { readRemoval(it.id) }
                    .forEach(::finishRemoval)
                ReconciliationPreparation(
                    binding,
                    readPackages(binding.bindingId),
                    readUnsupportedPackageIds(binding.bindingId),
                )
            }
            if (preparation != null) {
                // Orphan cleanup is licensed only against truly orphaned directories. A live
                // runner may commit `publishVerifiedPackage` (rename + row insert) after the
                // preparation snapshot was taken, which would make a freshly published
                // package look like an orphan of that stale snapshot. Mirror the
                // cleanupStaging guard: defer orphan cleanup to the next reconciliation
                // without a live runner, where `bindingLocked` fences every publish.
                if (!liveRunnerAtRequest) {
                    cleanupOrphanPackageDirectories(preparation.binding, preparation.packages)
                }
                val checks = preparation.packages.associateWith { installed ->
                    installed.id !in preparation.unsupportedPackageIds &&
                        installed.readerGeneration > 0 &&
                        installed.readerRevisionKey.matches(Regex("[0-9a-f]{64}")) &&
                        installedVerifier.membersAreValid(
                            installed,
                            packageDirectory(preparation.binding.bindingId, installed.id),
                        )
                }
                val converted = mutableMapOf<UUID, PreparedOfflineReadingPackage>()
                val readiness = mutableMapOf<UUID, PackageReadiness>()
                for ((installed, valid) in checks) {
                    if (!valid) continue
                    if (installed.conversionRefusal != null) {
                        readiness[installed.id] = PackageReadiness.Limited(installed.conversionRefusal)
                        continue
                    }
                    try {
                        if (installedTableIndexIsReady(installed, packageDirectory(installed.bindingId, installed.id))) {
                            readiness[installed.id] = PackageReadiness.Prepared
                            continue
                        }
                    } catch (error: Exception) {
                        android.util.Log.e("OfflineReading", "local table index verification failed", error)
                    }
                    val staging = synchronized(this) {
                        if (epoch != reconciliationEpoch || readAccountTransition() != null ||
                            readBinding() != preparation.binding ||
                            readPackage(installed.bindingId, installed.mediaId) != installed ||
                            readRemoval(installed.id) || leases.values.any { it.mediaId == installed.mediaId }
                        ) {
                            null
                        } else if (
                            !OfflineReadingStorageAdmission.canAdmit(
                                freeSpaceBytes(stagingDirectory(installed.bindingId)),
                                compressedBytes = 0,
                                expandedBytes = installed.sizeBytes,
                            )
                        ) {
                            // Check the existing admission estimate before staging. Conversion
                            // can expand beyond it; this observation reserves no disk space.
                            // Write failures still preserve the attested original for retry.
                            readiness[installed.id] = PackageReadiness.StorageBlocked
                            android.util.Log.e(
                                "OfflineReading",
                                "insufficient storage to stage local package conversion for ${installed.id}",
                            )
                            null
                        } else {
                            migrationDirectory(installed.bindingId, installed.id).apply {
                                check(mkdirs() || isDirectory)
                            }
                        }
                    } ?: continue
                    try {
                        val directory = packageDirectory(installed.bindingId, installed.id)
                        val prepared = if (installed.packageSchemaVersion == 1) {
                            prepareOfflineReadingPackage(stageLegacyReaderPackage(directory, staging, durability))
                        } else stageRetainedReadingPackage(directory, staging)
                        durability.syncTree(prepared.source.extractedDirectory)
                        converted[installed.id] = prepared
                    } catch (_: OfflineReadingGraphemeCapacityException) {
                        readiness[installed.id] = PackageReadiness.Limited(OfflineReadingConversionRefusal.GraphemeExceedsUnitCapacity)
                    } catch (error: Exception) {
                        if (error !is IOException && error !is SQLiteFullException && error !is SQLiteDiskIOException) throw error
                        // Resource failures preserve source and progress; the next
                        // reconciliation may retry. Invariant/parser failures propagate.
                        android.util.Log.e("OfflineReading", "local package conversion could not access its storage", error)
                    }
                }
                synchronized(this) {
                    if (
                        epoch != reconciliationEpoch ||
                        readAccountTransition() != null ||
                        readBinding() != preparation.binding
                    ) {
                        return@synchronized
                    }
                    checks.forEach { (installed, directoryValid) ->
                        val current = readPackage(installed.bindingId, installed.mediaId)
                        if (current != installed) return@forEach
                        val valid = directoryValid &&
                            readBaseline(installed.bindingId, installed.mediaId) != null
                        if (valid) {
                            val candidate = converted[installed.id]
                            if (candidate != null && !readRemoval(installed.id) && leases.values.none { it.mediaId == installed.mediaId }) {
                                try {
                                    activatePreparedReaderPackage(preparation.binding, installed, candidate)
                                } catch (error: Exception) {
                                    // SQLite determines whether activation committed. A
                                    // failed rename/fsync/commit never destroys the original.
                                    val retained = readPackage(installed.bindingId, installed.mediaId)
                                        ?: error("local conversion lost the installed row")
                                    // Re-readiness belongs to the row SQLite actually
                                    // committed, including a post-commit cleanup failure.
                                    val prepared =
                                        retained.packageSchemaVersion == OFFLINE_READING_PACKAGE_SCHEMA_VERSION &&
                                            try {
                                                installedTableIndexIsReady(
                                                    retained,
                                                    packageDirectory(retained.bindingId, retained.id),
                                                )
                                            } catch (_: Exception) { false }
                                    verifiedPackages.remove(installed.id)
                                    verifiedPackages[retained.id] = ReconciledPackage(retained, if (prepared) PackageReadiness.Prepared else PackageReadiness.ConversionRequired)
                                    android.util.Log.e("OfflineReading", "local package activation failed", error)
                                }
                            } else {
                                val result = readiness[installed.id] ?: PackageReadiness.ConversionRequired
                                val retained = if (result is PackageReadiness.Limited && installed.conversionRefusal != result.refusal) {
                                    val values = ContentValues().apply { put("conversion_refusal", result.refusal.name) }
                                    check(database.writableDatabase.update("offline_reader_packages", values, "id = ?", arrayOf(installed.id.toString())) == 1)
                                    installed.copy(conversionRefusal = result.refusal)
                                } else installed
                                verifiedPackages[installed.id] = ReconciledPackage(retained, result)
                            }
                        } else {
                            recoverCorruptPackage(installed)
                        }
                    }
                    bindingLocked = false
                    reconciliationComplete = true
                    shouldSchedule = hasQueuedWork()
                }
            }
        } catch (error: Exception) {
            if (error is IOException || error is SQLiteFullException || error is SQLiteDiskIOException ||
                error is OfflineReadingBindingSealLockedException) {
                android.util.Log.e("OfflineReading", "reconciliation could not access its storage", error)
            } else {
                failure = error
                android.util.Log.e("OfflineReading", "package reconciliation defect", error)
            }
        } finally {
            var claimedByJob = false
            val callbacks = synchronized(this) {
                reconciliationRunning = false
                reconciliationAllowsLiveRunner = false
                if (epoch != reconciliationEpoch) {
                    // A durable account transition owns exposure now; stale verification is ignored.
                    verifiedPackages.clear()
                } else if (failure != null) {
                    bindingLocked = true
                    reconciliationComplete = false
                    verifiedPackages.clear()
                }
                claimedByJob = reconciliationClaimedByJob
                reconciliationClaimedByJob = false
                reconciliationCallbacks.toList().also { reconciliationCallbacks.clear() }
            }
            val outcome = if (failure != null) {
                // Reporting a failed store must not require another successful
                // SQLite read merely to manufacture a snapshot.
                OfflineReadingReconciliationOutcome.Failed(failure)
            } else try {
                if (suspendedForTransition) scheduler.suspendForAccountTransition()
                if (shouldSchedule && !claimedByJob) {
                    if (scheduler.ensureScheduled()) markPreparingTransfersAdmitted()
                    else markSchedulerAdmissionFailed()
                }
                notifySnapshotChanged()
                val snapshot = snapshot()
                if (synchronized(this) {
                        reconciliationComplete && !bindingLocked && readAccountTransition() == null
                    }
                ) OfflineReadingReconciliationOutcome.Ready(snapshot)
                else OfflineReadingReconciliationOutcome.Deferred(snapshot)
            } catch (error: Exception) {
                synchronized(this) {
                    if (epoch == reconciliationEpoch) {
                        bindingLocked = true
                        reconciliationComplete = false
                        verifiedPackages.clear()
                    }
                }
                android.util.Log.e("OfflineReading", "reconciliation completion failed", error)
                OfflineReadingReconciliationOutcome.Failed(error)
            }
            callbacks.forEach { callback ->
                try {
                    callback(outcome)
                } catch (error: Exception) {
                    // One failed scheduler/bridge consumer must not strand the
                    // remaining completions or a queued explicit retry.
                    android.util.Log.e("OfflineReading", "reconciliation callback failed", error)
                }
            }
        }
    }

    @Synchronized
    internal fun hasQueuedWork(deferred: Set<Pair<UUID, String>> = emptySet()): Boolean {
        if (
            (!reconciliationComplete && !reconciliationAllowsLiveRunner) ||
            bindingLocked ||
            readAccountTransition() != null
        ) return false
        val binding = readBinding() ?: return false
        return readTransfers(binding.bindingId).any {
            (it.id to it.stagingName) !in deferred && it.state !is ReadingTransferState.Failed
        }
    }

    @Synchronized
    internal fun hasDurableTransferWork(): Boolean {
        val binding = readBinding() ?: return false
        return readTransfers(binding.bindingId).any {
            it.state !is ReadingTransferState.Failed
        }
    }

    @Synchronized
    internal fun reconciliationIsPending(): Boolean =
        reconciliationRunning || !reconciliationComplete || bindingLocked

    @Synchronized
    internal fun isReadyForJobDrain(): Boolean =
        reconciliationComplete && !bindingLocked && readAccountTransition() == null

    @Synchronized
    internal fun nextRunnableTransfer(deferred: Set<Pair<UUID, String>> = emptySet()): OfflineReadingTransfer? {
        if (
            (!reconciliationComplete && !reconciliationAllowsLiveRunner) ||
            bindingLocked ||
            readAccountTransition() != null
        ) return null
        val binding = requireBinding()
        return readTransfers(binding.bindingId).firstOrNull {
            (it.id to it.stagingName) !in deferred && it.state !is ReadingTransferState.Failed
        }
    }

    @Synchronized
    internal fun claimRunnableTransfer(
        admittedPolicy: NetworkPolicy,
        deferred: Set<Pair<UUID, String>> = emptySet(),
    ): OfflineReadingRunnableClaim {
        if (OfflineNetworkPolicyStore(appContext).get() != admittedPolicy) {
            // setNetworkPolicy persisted a different constraint after this runner was
            // admitted; the policy owner already scheduled the replacement JobInfo.
            return OfflineReadingRunnableClaim.PolicyChanged
        }
        val transfer = nextRunnableTransfer(deferred) ?: return OfflineReadingRunnableClaim.Idle
        return OfflineReadingRunnableClaim.Run(transfer)
    }

    @Synchronized
    internal fun selectLegacyTransferGeneration(
        transferId: UUID,
        expectedStagingName: String,
        readerGeneration: Long,
    ): OfflineReadingTransfer? {
        require(readerGeneration > 0)
        val current = readTransferById(transferId) ?: return null
        if (current.stagingName != expectedStagingName) return null
        require(current.readerGeneration == null || current.readerGeneration == readerGeneration)
        val selected = current.copy(readerGeneration = readerGeneration)
        replaceTransfer(selected)
        return selected
    }

    @Synchronized
    internal fun awaitPackagePreparation(transferId: UUID, expectedStagingName: String): Boolean {
        val current = readTransferById(transferId) ?: return false
        if (current.stagingName != expectedStagingName) return false
        replaceTransfer(current.copy(
            state = ReadingTransferState.Queued(ReadingQueueReason.Preparation),
            preparationStartedAt = current.preparationStartedAt ?: clock.instant(),
        ))
        notifySnapshotChanged()
        return true
    }

    @Synchronized
    internal fun updateTransferState(
        transferId: UUID,
        expectedStagingName: String,
        state: ReadingTransferState,
    ): Boolean {
        val transfer = readTransferById(transferId) ?: return false
        if (transfer.stagingName != expectedStagingName) return false
        val next = if (state is ReadingTransferState.Failed) {
            deleteStaging(transfer)
            transfer.copy(state = state, stagingName = ids.next().toString())
        } else {
            transfer.copy(state = state)
        }
        replaceTransfer(next)
        notifySnapshotChanged()
        return true
    }

    @Synchronized
    internal fun interrupted(transferId: UUID, expectedStagingName: String): InterruptionResult? {
        val transfer = readTransferById(transferId) ?: return null
        if (transfer.stagingName != expectedStagingName) return null
        if (
            transfer.state !is ReadingTransferState.Authorizing &&
            transfer.state !is ReadingTransferState.Downloading &&
            transfer.state !is ReadingTransferState.Verifying &&
            transfer.state !is ReadingTransferState.Restarting
        ) {
            return null
        }
        val result = interruptTransfer(transfer.state, transfer.automaticRestartCount)
        deleteStaging(transfer)
        replaceTransfer(
            transfer.copy(
                state = result.state,
                automaticRestartCount = result.automaticRestartCount,
                stagingName = ids.next().toString(),
            )
        )
        notifySnapshotChanged()
        return result
    }

    @Synchronized
    internal fun systemStopped(transferId: UUID, expectedStagingName: String) {
        val transfer = readTransferById(transferId) ?: return
        if (transfer.stagingName != expectedStagingName) return
        deleteStaging(transfer)
        replaceTransfer(
            transfer.copy(
                state = convergeSystemStopped(),
                stagingName = ids.next().toString(),
            )
        )
        notifySnapshotChanged()
    }

    @Synchronized
    internal fun systemStopAllDurableTransferWork(
        preferredTransferId: UUID?,
        expectedStagingName: String?,
    ): Boolean {
        val binding = readBinding() ?: return false
        val preferred = preferredTransferId?.let(::readTransferById)
            ?.takeIf {
                expectedStagingName != null &&
                    it.stagingName == expectedStagingName &&
                    it.state !is ReadingTransferState.Failed
            }
        val transfers = readTransfers(binding.bindingId).filter {
            it.state !is ReadingTransferState.Failed
        }
        if (transfers.isEmpty()) return false
        val ordered = listOfNotNull(preferred) + transfers.filter { it.id != preferred?.id }
        ordered.forEach(::deleteStaging)
        database.writableDatabase.transaction {
            ordered.forEach { transfer ->
                execSQL(
                    """
                    UPDATE offline_reader_transfers
                    SET state_json = ?, staging_name = ?
                    WHERE id = ? AND binding_id = ?
                    """.trimIndent(),
                    arrayOf(
                        OfflineReadingStateCodec.encode(convergeSystemStopped()),
                        ids.next().toString(),
                        transfer.id.toString(),
                        binding.bindingId.toString(),
                    ),
                )
            }
        }
        notifySnapshotChanged()
        return true
    }

    /**
     * Install step 5: verify the downloaded artifact and extract it into staging. This
     * MUST fully precede the reader-state baseline fetch (install step 6); the job owns
     * that ordering and the type system enforces it — publication accepts only the
     * [PreparedOfflineReadingPackage] this step produces. Returns null when the transfer
     * was fenced (cancelled, restarted, or superseded) before preparation completed.
     */
    internal fun verifyDownloadedPackage(
        transferId: UUID,
        expectedStagingName: String,
        artifact: OfflineReadingTransferArtifact,
    ): PreparedOfflineReadingPackage? {
        val preparation = synchronized(this) {
            val transfer = readTransferById(transferId) ?: return null
            if (transfer.stagingName != expectedStagingName) return null
            val binding = requireBinding()
            require(transfer.bindingId == binding.bindingId)
            require(artifact.accountId == binding.accountId)
            require(artifact.readerGeneration == transfer.readerGeneration)
            Triple(transfer, binding, stagingVerified(binding.bindingId, transfer.stagingName))
        }
        val (transfer, preparedBinding, destination) = preparation
        fun isCurrent(): Boolean = synchronized(this) {
            val current = readTransferById(transferId)
            !bindingLocked && readAccountTransition() == null && readBinding() == preparedBinding &&
                current != null && current.bindingId == transfer.bindingId &&
                current.stagingName == expectedStagingName
        }
        return try {
            val verified = packageVerifier.verifyAndExtract(
                artifact, preparedBinding.accountId, transfer.mediaId, destination,
            )
            require(verified.manifest.mediaKind == transfer.requestedMediaKind)
            require(verified.manifest.readerGeneration == artifact.readerGeneration)
            if (!isCurrent()) return null
            val prepared = prepareOfflineReadingPackage(verified)
            durability.syncTree(destination)
            if (isCurrent()) prepared else null
        } catch (error: IOException) {
            // justify-ignore-error: only missing files on this retired identity explain
            // cancellation. Completed JSON parsing can also throw IOException.
            if ((error !is FileNotFoundException && error !is NoSuchFileException) || isCurrent()) throw error
            null
        } catch (error: OfflineReadingPackageException) {
            // justify-ignore-error: the verifier wraps the same retired missing-file I/O.
            // Preserve every other verdict, including completed-byte parse failure.
            if ((error.cause !is FileNotFoundException && error.cause !is NoSuchFileException) || isCurrent()) throw error
            null
        } finally {
            if (!isCurrent()) destination.deleteRecursively()
        }
    }

    /** Install steps 7-8: recheck the seal, atomically rename, and publish in one transaction. */
    internal fun publishVerifiedPackage(
        transferId: UUID,
        expectedStagingName: String,
        prepared: PreparedOfflineReadingPackage,
        baseline: AttestedOfflineReaderBaseline,
    ): Boolean {
        val verified = prepared.source
        OfflineReaderStateValidator.requireCursorSnapshot(baseline.snapshotJson)
        val published = synchronized(this) {
            val current = readTransferById(transferId) ?: return@synchronized false
            if (current.stagingName != expectedStagingName) return@synchronized false
            val binding = requireBinding()
            require(current.bindingId == binding.bindingId)
            require(baseline.accountId == binding.accountId)
            require(current.readerGeneration == verified.manifest.readerGeneration)
            require(
                verified.extractedDirectory ==
                    stagingVerified(binding.bindingId, current.stagingName)
            )
            val transfer = current
            requireBindingSeal(binding)
            val packageId = ids.next()
            val finalDirectory = packageDirectory(binding.bindingId, packageId)
            Files.move(
                verified.extractedDirectory.toPath(),
                finalDirectory.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
            )
            durability.syncDirectory(bindingDirectory(binding.bindingId))
            val installedAt = clock.instant()
            val previousBaseline = readBaseline(binding.bindingId, transfer.mediaId)
            val observedGeneration = maxOf(baseline.readerGeneration, previousBaseline?.readerGeneration ?: 0)
            val observedSnapshot = if (previousBaseline != null &&
                readerSnapshotRevision(previousBaseline.serverSnapshotJson) > readerSnapshotRevision(baseline.snapshotJson)
            ) previousBaseline.serverSnapshotJson else baseline.snapshotJson
            try {
                database.writableDatabase.transaction {
                execSQL(
                    """
                    INSERT INTO offline_reader_packages(
                        id, binding_id, media_id, media_kind, title, reader_generation,
                        reader_revision_key, package_schema_version, reader_contract_version,
                        minimum_bundle_version, size_bytes, installed_at, table_index_sha256
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """.trimIndent(),
                    arrayOf(
                        packageId.toString(),
                        binding.bindingId.toString(),
                        transfer.mediaId.toString(),
                        verified.manifest.mediaKind.name,
                        verified.manifest.title,
                        verified.manifest.readerGeneration,
                        verified.manifest.readerRevisionKey,
                        verified.manifest.packageSchemaVersion,
                        OFFLINE_READING_READER_CONTRACT_VERSION,
                        // The manifest parser requires minimum bundle == package schema.
                        verified.manifest.packageSchemaVersion,
                        prepared.installedBytes,
                        installedAt.toString(),
                        prepared.tableIndexSha256,
                    ),
                )
                execSQL(
                    """
                    INSERT INTO offline_reader_progress_baselines(
                        id, binding_id, media_id, reader_generation, server_snapshot_json, observed_at
                    ) VALUES(?, ?, ?, ?, ?, ?)
                    ON CONFLICT(binding_id, media_id) DO UPDATE SET
                        reader_generation = excluded.reader_generation,
                        server_snapshot_json = excluded.server_snapshot_json,
                        observed_at = excluded.observed_at
                    """.trimIndent(),
                    arrayOf(
                        ids.next().toString(),
                        binding.bindingId.toString(),
                        transfer.mediaId.toString(),
                        observedGeneration,
                        observedSnapshot,
                        installedAt.toString(),
                    ),
                )
                execSQL(
                    "DELETE FROM offline_reader_transfers WHERE id = ? AND binding_id = ?",
                    arrayOf(transfer.id.toString(), binding.bindingId.toString()),
                )
                }
            } catch (error: RuntimeException) {
                // The invisible orphan is deliberately left for reconciliation after a failed publish commit.
                throw error
            }
            val installed = readPackage(binding.bindingId, transfer.mediaId)
                ?: error("published offline reading package row is missing")
            verifiedPackages[packageId] = ReconciledPackage(installed, PackageReadiness.Prepared)
            true
        }
        if (!published) verified.extractedDirectory.deleteRecursively()
        if (published) notifySnapshotChanged()
        return published
    }

    @Synchronized
    internal fun stagingArchiveFor(transfer: OfflineReadingTransfer): File {
        val current = readTransferById(transfer.id)
            ?: error("offline reading transfer no longer exists")
        require(current.bindingId == transfer.bindingId && current.stagingName == transfer.stagingName)
        deleteStagingFiles(transfer)
        return stagingArchive(transfer.bindingId, transfer.stagingName)
    }

    @Synchronized
    internal fun boundAccountId(bindingId: UUID): UUID {
        val binding = requireBinding()
        require(binding.bindingId == bindingId)
        requireBindingSeal(binding)
        return binding.accountId
    }

    @Synchronized
    override fun pendingSyncCandidates(mediaId: UUID?): List<ReaderProgressSyncCandidate> {
        val binding = requireBinding()
        if (binding.authorizationRequired) return emptyList()
        val candidates = mutableListOf<ReaderProgressSyncCandidate>()
        val arguments = mutableListOf(binding.bindingId.toString())
        val mediaPredicate = if (mediaId == null) "" else {
            arguments += mediaId.toString()
            " AND pending.media_id = ?"
        }
        database.readableDatabase.rawQuery(
            """
            SELECT pending.media_id, pending.reader_generation,
                   pending.base_server_revision, pending.locator_json
            FROM offline_reader_progress_pending AS pending
            JOIN offline_reader_progress_baselines AS baseline
              ON baseline.binding_id = pending.binding_id AND baseline.media_id = pending.media_id
              AND baseline.reader_generation = pending.reader_generation
            WHERE pending.binding_id = ? AND pending.sync_state = ?$mediaPredicate
            ORDER BY pending.updated_at, pending.id
            """.trimIndent(),
            (arguments.take(1) + OfflineReaderSyncState.Pending.name + arguments.drop(1))
                .toTypedArray(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                candidates += ReaderProgressSyncCandidate(
                    binding.bindingId,
                    binding.accountId,
                    cursor.uuid("media_id"),
                    cursor.long("reader_generation"),
                    cursor.long("base_server_revision"),
                    cursor.text("locator_json"),
                )
            }
        }
        return candidates
    }

    @Synchronized
    override fun acceptCanonical(
        candidate: ReaderProgressSyncCandidate,
        state: AttestedRemoteReaderState,
    ) {
        if (!candidateIsCurrent(candidate) || !stateAttests(candidate, state)) return
        replaceBaselineAndPending(candidate, state.snapshotJson, deletePending = true)
        notifySnapshotChanged()
    }

    @Synchronized
    override fun recordConflict(
        candidate: ReaderProgressSyncCandidate,
        state: AttestedRemoteReaderState,
    ) {
        if (!candidateIsCurrent(candidate) || !stateAttests(candidate, state)) return
        replaceBaselineAndPending(candidate, state.snapshotJson, deletePending = false)
        notifySnapshotChanged()
    }

    @Synchronized
    override fun recordContentChanged(candidate: ReaderProgressSyncCandidate) {
        if (!candidateIsCurrent(candidate)) return
        updateCandidateSyncState(candidate, OfflineReaderSyncState.ContentChanged)
        notifySnapshotChanged()
    }

    @Synchronized
    override fun recordSourceUnavailable(candidate: ReaderProgressSyncCandidate) {
        if (!candidateIsCurrent(candidate)) return
        updateCandidateSyncState(candidate, OfflineReaderSyncState.SourceUnavailable)
        notifySnapshotChanged()
    }

    @Synchronized
    override fun recordAuthorizationRequired(candidate: ReaderProgressSyncCandidate) {
        if (!candidateBindingIsCurrent(candidate)) return
        remoteAuthorizationDenied()
    }

    override fun reportDefect(mediaId: UUID, defect: Throwable) {
        // Identity and failure only: a cursor locator is private content.
        android.util.Log.e("OfflineReading", "reader progress sync defect for media $mediaId", defect)
    }

    @Synchronized
    internal fun remoteAuthorizationDenied() {
        val binding = readBinding() ?: return
        OfflineReadingTransferOperations.cancelAll()
        val transfers = readTransfers(binding.bindingId).filter {
            it.state !is ReadingTransferState.Failed
        }
        transfers.forEach(::deleteStaging)
        database.writableDatabase.transaction {
            execSQL(
                "UPDATE offline_reader_binding SET remote_authorization_required = 1 WHERE binding_id = ?",
                arrayOf(binding.bindingId.toString()),
            )
            transfers.forEach { transfer ->
                execSQL(
                    """
                    UPDATE offline_reader_transfers
                    SET state_json = ?, staging_name = ?
                    WHERE id = ? AND binding_id = ?
                    """.trimIndent(),
                    arrayOf(
                        OfflineReadingStateCodec.encode(
                            ReadingTransferState.Failed(
                                ReadingFailureReason.AuthorizationRequired
                            )
                        ),
                        ids.next().toString(),
                        transfer.id.toString(),
                        binding.bindingId.toString(),
                    ),
                )
            }
        }
        notifySnapshotChanged()
    }

    private fun candidateIsCurrent(candidate: ReaderProgressSyncCandidate): Boolean {
        if (!candidateBindingIsCurrent(candidate)) return false
        val binding = readBinding() ?: return false
        val pending = readPending(binding.bindingId, candidate.mediaId) ?: return false
        if (readBaseline(binding.bindingId, candidate.mediaId)?.readerGeneration != candidate.readerGeneration) return false
        return pending.readerGeneration == candidate.readerGeneration &&
            pending.baseServerRevision == candidate.baseServerRevision &&
            pending.locatorJson == candidate.locatorJson &&
            pending.syncState == OfflineReaderSyncState.Pending
    }

    private fun candidateBindingIsCurrent(candidate: ReaderProgressSyncCandidate): Boolean {
        val binding = readBinding() ?: return false
        return binding.bindingId == candidate.bindingId && binding.accountId == candidate.accountId
    }

    private fun stateAttests(
        candidate: ReaderProgressSyncCandidate,
        state: AttestedRemoteReaderState,
    ): Boolean = state.accountId == candidate.accountId &&
        state.readerGeneration == candidate.readerGeneration &&
        readBaseline(candidate.bindingId, candidate.mediaId)?.let {
            readerSnapshotRevision(it.serverSnapshotJson) <= state.revision
        } == true

    private fun replaceBaselineAndPending(
        candidate: ReaderProgressSyncCandidate,
        canonicalSnapshotJson: String,
        deletePending: Boolean,
    ) {
        val binding = requireBinding()
        database.writableDatabase.transaction {
            execSQL(
                """
                UPDATE offline_reader_progress_baselines
                SET server_snapshot_json = ?, observed_at = ?
                WHERE binding_id = ? AND media_id = ? AND reader_generation = ?
                """.trimIndent(),
                arrayOf(
                    canonicalSnapshotJson,
                    clock.instant().toString(),
                    binding.bindingId.toString(),
                    candidate.mediaId.toString(),
                    candidate.readerGeneration,
                ),
            )
            if (deletePending) {
                execSQL(
                    "DELETE FROM offline_reader_progress_pending WHERE binding_id = ? AND media_id = ?",
                    arrayOf(binding.bindingId.toString(), candidate.mediaId.toString()),
                )
            } else {
                execSQL(
                    """
                    UPDATE offline_reader_progress_pending
                    SET sync_state = ?, updated_at = ?
                    WHERE binding_id = ? AND media_id = ?
                    """.trimIndent(),
                    arrayOf(
                        OfflineReaderSyncState.Conflict.name,
                        clock.instant().toString(),
                        binding.bindingId.toString(),
                        candidate.mediaId.toString(),
                    ),
                )
            }
        }
    }

    private fun updateCandidateSyncState(
        candidate: ReaderProgressSyncCandidate,
        syncState: OfflineReaderSyncState,
    ) {
        val binding = requireBinding()
        database.writableDatabase.execSQL(
            """
            UPDATE offline_reader_progress_pending SET sync_state = ?, updated_at = ?
            WHERE binding_id = ? AND media_id = ?
            """.trimIndent(),
            arrayOf(
                syncState.name,
                clock.instant().toString(),
                binding.bindingId.toString(),
                candidate.mediaId.toString(),
            ),
        )
    }

    /** The installed row is the only commit point; original files survive every earlier failure. */
    private fun activatePreparedReaderPackage(
        binding: OfflineReadingBinding,
        installed: OfflineReadingPackage,
        prepared: PreparedOfflineReadingPackage,
    ) {
        val candidate = prepared.source
        check(Thread.holdsLock(this))
        requireBindingSeal(binding)
        require(
            installed.packageSchemaVersion in 1..OFFLINE_READING_PACKAGE_SCHEMA_VERSION &&
                candidate.manifest.packageSchemaVersion == OFFLINE_READING_PACKAGE_SCHEMA_VERSION
        )
        require(candidate.manifest.mediaId == installed.mediaId &&
            candidate.manifest.readerGeneration == installed.readerGeneration)
        val packageId = ids.next()
        val finalDirectory = packageDirectory(binding.bindingId, packageId)
        Files.move(candidate.extractedDirectory.toPath(), finalDirectory.toPath(), StandardCopyOption.ATOMIC_MOVE)
        durability.syncDirectory(bindingDirectory(binding.bindingId))
        database.writableDatabase.transaction {
            val values = ContentValues().apply {
                put("id", packageId.toString())
                put("reader_revision_key", candidate.manifest.readerRevisionKey)
                put("package_schema_version", 2)
                put("minimum_bundle_version", 2)
                put("size_bytes", prepared.installedBytes)
                put("table_index_sha256", prepared.tableIndexSha256)
                putNull("conversion_refusal")
            }
            check(update("offline_reader_packages", values, "id = ?", arrayOf(installed.id.toString())) == 1)
        }
        // Neither baseline nor pending rows participate in a byte-layout migration.
        verifiedPackages.remove(installed.id)
        val activated = readPackage(binding.bindingId, installed.mediaId)
            ?: error("converted offline reading package row is missing")
        verifiedPackages[packageId] = ReconciledPackage(activated, PackageReadiness.Prepared)
        check(packageDirectory(binding.bindingId, installed.id).deleteRecursively())
        check(migrationDirectory(binding.bindingId, installed.id).deleteRecursively())
    }

    private data class ReconciliationPreparation(
        val binding: OfflineReadingBinding,
        val packages: List<OfflineReadingPackage>,
        val unsupportedPackageIds: Set<UUID>,
    )

    private fun orphanPackageDirectories(
        binding: OfflineReadingBinding,
        packages: List<OfflineReadingPackage>,
    ): List<File> {
        val packageIds = packages.map { it.id.toString() }.toSet()
        return bindingDirectory(binding.bindingId).listFiles().orEmpty()
            .filter { it.isDirectory && it.name != ".staging" && it.name !in packageIds }
    }

    private fun cleanupOrphanPackageDirectories(
        binding: OfflineReadingBinding,
        packages: List<OfflineReadingPackage>,
    ) {
        orphanPackageDirectories(binding, packages).forEach { orphan ->
            check(orphan.deleteRecursively())
        }
    }

    private fun recoverCorruptPackage(installed: OfflineReadingPackage) {
        verifiedPackages.remove(installed.id)
        packageDirectory(installed.bindingId, installed.id).deleteRecursively()
        database.writableDatabase.transaction {
            execSQL(
                "DELETE FROM offline_reader_removals WHERE package_id = ?",
                arrayOf(installed.id.toString()),
            )
            execSQL(
                "DELETE FROM offline_reader_packages WHERE id = ?",
                arrayOf(installed.id.toString()),
            )
            if (readTransfer(installed.bindingId, installed.mediaId) == null) {
                insertTransferInTransaction(
                    this,
                    OfflineReadingTransfer(
                        ids.next(),
                        installed.bindingId,
                        installed.mediaId,
                        installed.title,
                        installed.mediaKind,
                        ReadingTransferState.Failed(ReadingFailureReason.RecoveryRequired),
                        0,
                        ids.next().toString(),
                        clock.instant(),
                        installed.readerGeneration,
                        null,
                    ),
                )
            }
        }
    }
    private fun reconcileInterruptedTransfers(
        bindingId: UUID,
        liveRunnerInProcess: Boolean,
        orphanPackageDirectoryPresent: Boolean,
    ) {
        readTransfers(bindingId).forEach { transfer ->
            if (
                transfer.state is ReadingTransferState.Authorizing ||
                transfer.state is ReadingTransferState.Downloading ||
                transfer.state is ReadingTransferState.Verifying ||
                transfer.state is ReadingTransferState.Restarting
            ) {
                if (orphanPackageDirectoryPresent && transfer.state is ReadingTransferState.Verifying) {
                    // A crash between the atomic rename and row publication leaves the
                    // extracted bytes as an invisible orphan directory with the transfer
                    // still in Verifying. Reconciliation deletes the orphan and records
                    // RecoveryRequired; it never guesses Ready and never spends the
                    // automatic-restart budget on this case.
                    deleteStaging(transfer)
                    replaceTransfer(
                        transfer.copy(
                            state = ReadingTransferState.Failed(
                                ReadingFailureReason.RecoveryRequired
                            ),
                            stagingName = ids.next().toString(),
                        )
                    )
                    return@forEach
                }
                val result = reconcileStaleActiveTransfer(
                    liveRunnerInProcess,
                    transfer.state,
                    transfer.automaticRestartCount,
                ) ?: return@forEach
                deleteStaging(transfer)
                replaceTransfer(
                    transfer.copy(
                        state = result.state,
                        automaticRestartCount = result.automaticRestartCount,
                        stagingName = ids.next().toString(),
                    )
                )
            }
        }
    }

    private fun finishRemoval(installed: OfflineReadingPackage) {
        check(leases.values.none { it.mediaId == installed.mediaId })
        verifiedPackages.remove(installed.id)
        val migration = migrationDirectory(installed.bindingId, installed.id)
        if (migration.exists()) check(migration.deleteRecursively())
        val directory = packageDirectory(installed.bindingId, installed.id)
        if (directory.exists()) {
            check(directory.deleteRecursively())
        }
        check(!directory.exists())
        database.writableDatabase.transaction {
            execSQL(
                "DELETE FROM offline_reader_removals WHERE package_id = ?",
                arrayOf(installed.id.toString()),
            )
            execSQL(
                "DELETE FROM offline_reader_transfers WHERE binding_id = ? AND media_id = ?",
                arrayOf(installed.bindingId.toString(), installed.mediaId.toString()),
            )
            execSQL(
                "DELETE FROM offline_reader_progress_pending WHERE binding_id = ? AND media_id = ?",
                arrayOf(installed.bindingId.toString(), installed.mediaId.toString()),
            )
            execSQL(
                "DELETE FROM offline_reader_progress_baselines WHERE binding_id = ? AND media_id = ?",
                arrayOf(installed.bindingId.toString(), installed.mediaId.toString()),
            )
            execSQL(
                "DELETE FROM offline_reader_packages WHERE id = ?",
                arrayOf(installed.id.toString()),
            )
        }
    }

    private fun purgeReadingState(
        binding: OfflineReadingBinding,
        reason: String,
        deleteSeal: Boolean,
    ) {
        leases.clear()
        verifiedPackages.clear()
        if (!hasPurge(binding.bindingId)) {
            database.writableDatabase.execSQL(
                "INSERT INTO offline_reader_purges(id, binding_id, reason, requested_at) VALUES(?, ?, ?, ?)",
                arrayOf(
                    ids.next().toString(),
                    binding.bindingId.toString(),
                    reason,
                    clock.instant().toString(),
                ),
            )
        }
        bindingDirectory(binding.bindingId).deleteRecursively()
        check(!bindingDirectory(binding.bindingId).exists())
        database.writableDatabase.transaction {
            execSQL("DELETE FROM offline_reader_removals")
            execSQL("DELETE FROM offline_reader_progress_pending")
            execSQL("DELETE FROM offline_reader_progress_baselines")
            execSQL("DELETE FROM offline_reader_packages")
            execSQL("DELETE FROM offline_reader_transfers")
            execSQL("DELETE FROM offline_reader_purges WHERE binding_id = ?", arrayOf(binding.bindingId.toString()))
            execSQL("DELETE FROM offline_reader_binding WHERE binding_id = ?", arrayOf(binding.bindingId.toString()))
        }
        if (deleteSeal) seal.deleteKey()
    }

    private fun purgeUnboundState() {
        leases.clear()
        verifiedPackages.clear()
        rootDirectory.listFiles().orEmpty().forEach { child ->
            check(child.deleteRecursively())
        }
        database.writableDatabase.transaction {
            execSQL("DELETE FROM offline_reader_removals")
            execSQL("DELETE FROM offline_reader_progress_pending")
            execSQL("DELETE FROM offline_reader_progress_baselines")
            execSQL("DELETE FROM offline_reader_packages")
            execSQL("DELETE FROM offline_reader_transfers")
            execSQL("DELETE FROM offline_reader_purges")
            execSQL("DELETE FROM offline_reader_account_transitions")
        }
        seal.deleteKey()
    }

    private fun requireBindingSeal(binding: OfflineReadingBinding) {
        var storedSeal = byteArrayOf()
        check(
            database.readableDatabase.queryOne(
                "SELECT binding_seal FROM offline_reader_binding WHERE singleton_id = 1",
            ) { cursor -> storedSeal = cursor.getBlob(cursor.getColumnIndexOrThrow("binding_seal")) }
        )
        when (seal.verify(binding.bindingId, binding.accountId, storedSeal)) {
            BindingSealStatus.Verified -> Unit
            BindingSealStatus.Locked ->
                // The device locked mid-work. This is a deferral, never a failure: the
                // caller keeps the durable intent and retries after unlock.
                throw OfflineReadingBindingSealLockedException()
            BindingSealStatus.Missing, BindingSealStatus.Invalid ->
                error("offline reading device-binding seal is unavailable or invalid")
        }
    }

    private fun readBinding(): OfflineReadingBinding? {
        var binding: OfflineReadingBinding? = null
        database.readableDatabase.queryOne(
            """
            SELECT binding_id, account_id, remote_authorization_required, bound_at
            FROM offline_reader_binding WHERE singleton_id = 1
            """.trimIndent(),
        ) { cursor ->
            binding = OfflineReadingBinding(
                cursor.uuid("binding_id"),
                cursor.uuid("account_id"),
                cursor.int("remote_authorization_required") == 1,
                cursor.instant("bound_at"),
            )
        }
        return binding
    }

    private fun clearRemoteAuthorizationFence(binding: OfflineReadingBinding) {
        if (!binding.authorizationRequired) return
        database.writableDatabase.execSQL(
            "UPDATE offline_reader_binding SET remote_authorization_required = 0 WHERE binding_id = ?",
            arrayOf(binding.bindingId.toString()),
        )
    }

    private fun requireBinding(): OfflineReadingBinding =
        readBinding()?.also {
            check(!bindingLocked && readAccountTransition() == null) {
                "offline reading binding is locked"
            }
        }
            ?: error("offline reading account is not bound")

    private fun readAccountTransition(): OfflineReadingAccountTransition? {
        var result: OfflineReadingAccountTransition? = null
        database.readableDatabase.queryOne(
            """
            SELECT kind, target_account_id
            FROM offline_reader_account_transitions WHERE singleton_id = 1
            """.trimIndent(),
        ) { cursor ->
            val kind = cursor.text("kind")
            val targetIndex = cursor.getColumnIndexOrThrow("target_account_id")
            val target = if (cursor.isNull(targetIndex)) null else UUID.fromString(cursor.getString(targetIndex))
            check((kind == "Logout" && target == null) || (kind == "AccountSwitch" && target != null))
            result = OfflineReadingAccountTransition(target)
        }
        return result
    }

    private fun transitionReason(targetAccountId: UUID?): String =
        if (targetAccountId == null) "Logout" else "AccountSwitch"

    private fun readPackage(bindingId: UUID, mediaId: UUID): OfflineReadingPackage? =
        readPackages(bindingId).singleOrNull { it.mediaId == mediaId }

    private fun readPackages(bindingId: UUID): List<OfflineReadingPackage> {
        val result = mutableListOf<OfflineReadingPackage>()
        database.readableDatabase.rawQuery(
            """
            SELECT id, binding_id, media_id, media_kind, title, reader_generation,
                   reader_revision_key, size_bytes, installed_at,
                   package_schema_version, reader_contract_version, minimum_bundle_version, table_index_sha256, conversion_refusal
            FROM offline_reader_packages
            WHERE binding_id = ?
            ORDER BY installed_at, id
            """.trimIndent(),
            arrayOf(bindingId.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                // Version support is validated per package during reconciliation
                // (readUnsupportedPackageIds -> recoverCorruptPackage) so one unsupported
                // persisted row converges to Failed(RecoveryRequired) instead of poisoning
                // every read path of the whole store.
                result += OfflineReadingPackage(
                    cursor.uuid("id"),
                    cursor.uuid("binding_id"),
                    cursor.uuid("media_id"),
                    enumValues<OfflineReadingMediaKind>().single { it.name == cursor.text("media_kind") },
                    cursor.text("title"),
                    cursor.long("reader_generation"),
                    cursor.text("reader_revision_key"),
                    cursor.int("package_schema_version"),
                    cursor.long("size_bytes"),
                    cursor.instant("installed_at"),
                    cursor.getString(cursor.getColumnIndexOrThrow("table_index_sha256")),
                    cursor.getString(cursor.getColumnIndexOrThrow("conversion_refusal"))?.let { OfflineReadingConversionRefusal.valueOf(it) },
                )
            }
        }
        return result
    }

    private fun readUnsupportedPackageIds(bindingId: UUID): Set<UUID> {
        val result = mutableSetOf<UUID>()
        database.readableDatabase.rawQuery(
            """
            SELECT id FROM offline_reader_packages
            WHERE binding_id = ?
              AND (package_schema_version NOT IN (1, 2)
                   OR reader_contract_version != 1
                   OR minimum_bundle_version != package_schema_version)
            """.trimIndent(),
            arrayOf(bindingId.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) result += cursor.uuid("id")
        }
        return result
    }

    private fun readTransfer(bindingId: UUID, mediaId: UUID): OfflineReadingTransfer? =
        readTransfers(bindingId).singleOrNull { it.mediaId == mediaId }

    private fun readTransferById(id: UUID): OfflineReadingTransfer? {
        val binding = readBinding() ?: return null
        return readTransfers(binding.bindingId).singleOrNull { it.id == id }
    }

    private fun readTransfers(bindingId: UUID): List<OfflineReadingTransfer> {
        val result = mutableListOf<OfflineReadingTransfer>()
        database.readableDatabase.rawQuery(
            """
            SELECT id, binding_id, media_id, requested_title, requested_media_kind, state_json,
                   automatic_restart_count, staging_name, requested_at, reader_generation, preparation_started_at
            FROM offline_reader_transfers
            WHERE binding_id = ?
            ORDER BY requested_at, id
            """.trimIndent(),
            arrayOf(bindingId.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result += OfflineReadingTransfer(
                    cursor.uuid("id"),
                    cursor.uuid("binding_id"),
                    cursor.uuid("media_id"),
                    cursor.text("requested_title"),
                    enumValues<OfflineReadingMediaKind>().single {
                        it.name == cursor.text("requested_media_kind")
                    },
                    OfflineReadingStateCodec.decode(cursor.text("state_json")),
                    cursor.int("automatic_restart_count"),
                    cursor.text("staging_name"),
                    cursor.instant("requested_at"),
                    if (cursor.isNull(cursor.getColumnIndexOrThrow("reader_generation"))) null else cursor.long("reader_generation"),
                    if (cursor.isNull(cursor.getColumnIndexOrThrow("preparation_started_at"))) null else cursor.instant("preparation_started_at"),
                )
            }
        }
        return result
    }

    private fun insertTransfer(transfer: OfflineReadingTransfer) {
        insertTransferInTransaction(database.writableDatabase, transfer)
    }

    private fun insertTransferInTransaction(db: SQLiteDatabase, transfer: OfflineReadingTransfer) {
        db.execSQL(
            """
            INSERT INTO offline_reader_transfers(
                id, binding_id, media_id, requested_title, requested_media_kind, state_json,
                automatic_restart_count, staging_name, requested_at, reader_generation, preparation_started_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
            arrayOf(
                transfer.id.toString(),
                transfer.bindingId.toString(),
                transfer.mediaId.toString(),
                transfer.requestedTitle,
                transfer.requestedMediaKind.name,
                OfflineReadingStateCodec.encode(transfer.state),
                transfer.automaticRestartCount,
                transfer.stagingName,
                transfer.requestedAt.toString(),
                transfer.readerGeneration,
                transfer.preparationStartedAt?.toString(),
            ),
        )
    }

    private fun replaceTransfer(transfer: OfflineReadingTransfer) {
        val values = ContentValues().apply {
            put("state_json", OfflineReadingStateCodec.encode(transfer.state))
            put("automatic_restart_count", transfer.automaticRestartCount)
            put("staging_name", transfer.stagingName)
            put("reader_generation", transfer.readerGeneration)
            put("preparation_started_at", transfer.preparationStartedAt?.toString())
        }
        check(
            database.writableDatabase.update(
                "offline_reader_transfers",
                values,
                "id = ? AND binding_id = ?",
                arrayOf(transfer.id.toString(), transfer.bindingId.toString()),
            ) == 1
        )
    }

    private fun readBaseline(bindingId: UUID, mediaId: UUID): OfflineReaderBaseline? {
        var result: OfflineReaderBaseline? = null
        database.readableDatabase.queryOne(
            """
            SELECT binding_id, media_id, reader_generation, server_snapshot_json, observed_at
            FROM offline_reader_progress_baselines WHERE binding_id = ? AND media_id = ?
            """.trimIndent(),
            arrayOf(bindingId.toString(), mediaId.toString()),
        ) { cursor ->
            result = OfflineReaderBaseline(
                cursor.uuid("binding_id"),
                cursor.uuid("media_id"),
                cursor.long("reader_generation"),
                cursor.text("server_snapshot_json"),
                cursor.instant("observed_at"),
            )
        }
        return result
    }

    private fun readPending(bindingId: UUID, mediaId: UUID): OfflineReaderPendingProgress? {
        var result: OfflineReaderPendingProgress? = null
        database.readableDatabase.queryOne(
            """
            SELECT binding_id, media_id, reader_generation, reader_revision_key,
                   base_server_revision, locator_json, sync_state, updated_at
            FROM offline_reader_progress_pending WHERE binding_id = ? AND media_id = ?
            """.trimIndent(),
            arrayOf(bindingId.toString(), mediaId.toString()),
        ) { cursor ->
            result = OfflineReaderPendingProgress(
                cursor.uuid("binding_id"),
                cursor.uuid("media_id"),
                cursor.long("reader_generation"),
                cursor.text("reader_revision_key"),
                cursor.long("base_server_revision"),
                cursor.text("locator_json"),
                enumValues<OfflineReaderSyncState>().single {
                    it.name == cursor.text("sync_state")
                },
                cursor.instant("updated_at"),
            )
        }
        return result
    }

    private fun readProgress(bindingId: UUID, mediaId: UUID, selectedGeneration: Long): NativeReaderProgressView {
        val baseline = readBaseline(bindingId, mediaId)
            ?: error("offline reading baseline is missing")
        val pending = readPending(bindingId, mediaId)
        if (pending == null) {
            val snapshot = StrictJson.parse(baseline.serverSnapshotJson.toByteArray()) as StrictJson.ObjectValue
            if (snapshot.fields.getValue("state").requireString() == "Positioned") {
                val source = snapshot.fields.getValue("source") as StrictJson.ObjectValue
                if (source.fields.getValue("kind").requireString() != "Publication" ||
                    source.fields.getValue("reader_generation").requireLong() != selectedGeneration
                ) {
                    return NativeReaderProgressView.ContentChanged(
                        baseline.serverSnapshotJson,
                        snapshot.fields.getValue("locator").toJson(),
                        source.toJson(),
                    )
                }
            }
            return NativeReaderProgressView.Canonical(baseline.serverSnapshotJson)
        }
        val source = "{\"kind\":\"Publication\",\"reader_generation\":${pending.readerGeneration}}"
        if (pending.readerGeneration != selectedGeneration || pending.readerGeneration != baseline.readerGeneration) {
            return NativeReaderProgressView.ContentChanged(baseline.serverSnapshotJson, pending.locatorJson, source)
        }
        return when (pending.syncState) {
            OfflineReaderSyncState.Pending ->
                NativeReaderProgressView.Pending(baseline.serverSnapshotJson, pending.locatorJson, source)
            OfflineReaderSyncState.Conflict ->
                NativeReaderProgressView.Conflict(baseline.serverSnapshotJson, pending.locatorJson, source)
            OfflineReaderSyncState.ContentChanged ->
                NativeReaderProgressView.ContentChanged(baseline.serverSnapshotJson, pending.locatorJson, source)
            OfflineReaderSyncState.SourceUnavailable ->
                NativeReaderProgressView.SourceUnavailable(baseline.serverSnapshotJson, pending.locatorJson, source)
        }
    }

    private fun readPackageItems(): List<OfflineReadingItemSnapshot> {
        val binding = readBinding() ?: return emptyList()
        return readPackages(binding.bindingId).filter { installed ->
            verifiedPackages[installed.id]?.installed == installed
        }.map { installed ->
            OfflineReadingItemSnapshot.PackageItem(
                mediaId = installed.mediaId,
                title = installed.title,
                mediaKind = installed.mediaKind,
                readerGeneration = installed.readerGeneration,
                readerRevisionKey = installed.readerRevisionKey,
                availability = if (readRemoval(installed.id)) {
                    OfflineReadingAvailability.Removing
                } else if (installed.conversionRefusal != null) {
                    OfflineReadingAvailability.UpgradeFailed
                } else if (verifiedPackages[installed.id]?.readiness == PackageReadiness.StorageBlocked) {
                    OfflineReadingAvailability.UpgradeBlockedByStorage
                } else if (verifiedPackages[installed.id]?.readiness != PackageReadiness.Prepared) {
                    OfflineReadingAvailability.UpgradeRequired
                } else {
                    OfflineReadingAvailability.Ready(
                        installed.sizeBytes,
                        installed.installedAt,
                        readProgress(binding.bindingId, installed.mediaId, installed.readerGeneration),
                    )
                },
            )
        }
    }

    private fun readTransferItems(): List<OfflineReadingItemSnapshot> {
        val binding = readBinding() ?: return emptyList()
        return readTransfers(binding.bindingId).filter { transfer ->
            readPackage(binding.bindingId, transfer.mediaId) == null
        }.map { transfer ->
            OfflineReadingItemSnapshot.TransferItem(
                transfer.mediaId,
                transfer.requestedTitle,
                transfer.requestedMediaKind,
                OfflineReadingAvailability.Transfer(transfer.state),
            )
        }
    }

    private fun readRemoval(packageId: UUID): Boolean =
        database.readableDatabase.queryOne(
            "SELECT id FROM offline_reader_removals WHERE package_id = ?",
            arrayOf(packageId.toString()),
        ) {}

    private fun hasPurge(bindingId: UUID): Boolean =
        database.readableDatabase.queryOne(
            "SELECT id FROM offline_reader_purges WHERE binding_id = ?",
            arrayOf(bindingId.toString()),
        ) {}

    private fun cleanupStaging(bindingId: UUID) {
        val retained = readPackages(bindingId).filter { it.packageSchemaVersion == 1 }
            .map { migrationDirectory(bindingId, it.id).name }.toSet()
        stagingDirectory(bindingId).listFiles().orEmpty().forEach { file ->
            if (file.name !in retained) check(file.deleteRecursively())
        }
    }

    private fun deleteStaging(transfer: OfflineReadingTransfer) {
        OfflineReadingTransferOperations.cancel(transfer.id)
        deleteStagingFiles(transfer)
    }

    private fun deleteStagingFiles(transfer: OfflineReadingTransfer) {
        stagingArchive(transfer.bindingId, transfer.stagingName).delete()
        stagingVerified(transfer.bindingId, transfer.stagingName).deleteRecursively()
    }

    private fun bindingDirectory(bindingId: UUID): File = File(rootDirectory, bindingId.toString())
    private fun stagingDirectory(bindingId: UUID): File =
        File(bindingDirectory(bindingId), ".staging").apply { mkdirs() }
    private fun stagingArchive(bindingId: UUID, name: String): File =
        File(stagingDirectory(bindingId), "$name.zip")
    private fun stagingVerified(bindingId: UUID, name: String): File =
        File(stagingDirectory(bindingId), "$name.verified")
    private fun migrationDirectory(bindingId: UUID, packageId: UUID): File =
        File(bindingDirectory(bindingId), ".staging/$packageId.migration")
    private fun packageDirectory(bindingId: UUID, packageId: UUID): File =
        File(bindingDirectory(bindingId), packageId.toString())

    private fun notifySnapshotChanged() {
        val value = snapshot()
        listeners.forEach { listener -> listener(value) }
    }

    companion object {
        @Volatile
        private var instance: OfflineReadingStore? = null

        fun get(context: Context): OfflineReadingStore =
            instance ?: synchronized(this) {
                instance ?: OfflineReadingStore(context).also { instance = it }
            }
    }
}
