package app.nexus.android.offline.reading

import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.StorageAdmissionPolicy
import android.os.Build
import java.time.Instant
import java.util.UUID

internal const val OFFLINE_READING_PACKAGE_SCHEMA_VERSION = 1
internal const val OFFLINE_READING_READER_CONTRACT_VERSION = 2
internal const val OFFLINE_READING_READER_BUNDLE_VERSION = 2
internal const val OFFLINE_READING_FILESYSTEM_OVERHEAD_BYTES = 16L * 1024L * 1024L
internal const val OFFLINE_READING_MINIMUM_SDK = 34

internal class OfflineReadingUnsupportedPlatformException : IllegalStateException()

internal fun requireOfflineReadingSupported(sdkInt: Int = Build.VERSION.SDK_INT) {
    if (sdkInt < OFFLINE_READING_MINIMUM_SDK) {
        throw OfflineReadingUnsupportedPlatformException()
    }
}

internal enum class OfflineReadingMediaKind {
    Pdf,
    Epub,
    WebArticle,
}

internal enum class ReadingQueueReason {
    WaitingForUnmetered,
    Capacity,
    Scheduler,
}

internal enum class ReadingRestartReason {
    Interrupted,
    PolicyChanged,
}

internal enum class ReadingFailureReason {
    AuthorizationRequired,
    SourceUnavailable,
    ContentChanged,
    TooLarge,
    LowSpace,
    Network,
    SystemStopped,
    Integrity,
    UnsupportedPackage,
    RecoveryRequired,
    Server,
}

internal sealed interface ReadingTransferState {
    data object Preparing : ReadingTransferState

    data class Queued(val reason: ReadingQueueReason) : ReadingTransferState

    data object Authorizing : ReadingTransferState

    data class Downloading(
        val receivedBytes: Long,
        val totalBytes: Long,
    ) : ReadingTransferState {
        init {
            require(receivedBytes >= 0 && totalBytes >= 0 && receivedBytes <= totalBytes)
        }
    }

    data object Verifying : ReadingTransferState

    data class Restarting(
        val attempt: Int,
        val reason: ReadingRestartReason,
    ) : ReadingTransferState {
        init {
            require(attempt > 0)
        }
    }

    data class Failed(val reason: ReadingFailureReason) : ReadingTransferState
}

internal data class InterruptionResult(
    val state: ReadingTransferState,
    val automaticRestartCount: Int,
    val shouldReschedule: Boolean,
)

internal fun interruptTransfer(
    state: ReadingTransferState,
    automaticRestartCount: Int,
): InterruptionResult {
    require(automaticRestartCount >= 0)
    check(
        state is ReadingTransferState.Authorizing ||
            state is ReadingTransferState.Downloading ||
            state is ReadingTransferState.Verifying ||
            state is ReadingTransferState.Restarting
    )
    return if (automaticRestartCount == 0) {
        InterruptionResult(
            ReadingTransferState.Restarting(1, ReadingRestartReason.Interrupted),
            automaticRestartCount = 1,
            shouldReschedule = true,
        )
    } else {
        InterruptionResult(
            ReadingTransferState.Failed(ReadingFailureReason.SystemStopped),
            automaticRestartCount,
            shouldReschedule = false,
        )
    }
}

internal fun checkpointForPolicyChange(automaticRestartCount: Int): InterruptionResult {
    require(automaticRestartCount >= 0)
    return InterruptionResult(
        ReadingTransferState.Restarting(
            attempt = automaticRestartCount + 1,
            reason = ReadingRestartReason.PolicyChanged,
        ),
        automaticRestartCount,
        shouldReschedule = true,
    )
}

internal fun convergeSystemStopped(): ReadingTransferState =
    ReadingTransferState.Failed(ReadingFailureReason.SystemStopped)

internal fun reconcileStaleActiveTransfer(
    liveRunnerInProcess: Boolean,
    state: ReadingTransferState,
    automaticRestartCount: Int,
): InterruptionResult? = if (liveRunnerInProcess) {
    null
} else {
    interruptTransfer(state, automaticRestartCount)
}

internal data class TransferRunFence(
    val runGeneration: Long,
    val transferId: UUID,
    val stagingName: String,
)

internal fun transferCallbackIsCurrent(
    fence: TransferRunFence,
    currentRunGeneration: Long,
    stopped: Boolean,
): Boolean = !stopped && fence.runGeneration == currentRunGeneration

internal fun shouldRescheduleStoppedReadingJob(
    userInitiatedStop: Boolean,
    interruption: InterruptionResult?,
    hasDurableTransferWork: Boolean,
    reconciliationPending: Boolean,
): Boolean = !userInitiatedStop && (
    interruption?.shouldReschedule == true ||
        hasDurableTransferWork ||
        reconciliationPending
    )

internal fun shouldScheduleOfflineReadingJob(
    hasQueuedWork: Boolean,
    jobIsPendingOrRunning: Boolean,
): Boolean = hasQueuedWork && !jobIsPendingOrRunning

internal object OfflineReadingStorageAdmission {
    fun canAdmit(
        availableBytes: Long,
        compressedBytes: Long,
        expandedBytes: Long,
    ): Boolean {
        if (
            compressedBytes < 0 ||
            expandedBytes < 0 ||
            compressedBytes > Long.MAX_VALUE - expandedBytes
        ) {
            return false
        }
        val packageBytes = compressedBytes + expandedBytes
        if (packageBytes > Long.MAX_VALUE - OFFLINE_READING_FILESYSTEM_OVERHEAD_BYTES) {
            return false
        }
        return StorageAdmissionPolicy.preservesReserve(
            availableBytes,
            packageBytes + OFFLINE_READING_FILESYSTEM_OVERHEAD_BYTES,
        )
    }
}

internal data class OfflineReadingBinding(
    val bindingId: UUID,
    val accountId: UUID,
    val authorizationRequired: Boolean,
    val boundAt: Instant,
)

internal data class OfflineReadingTransfer(
    val id: UUID,
    val bindingId: UUID,
    val mediaId: UUID,
    val requestedTitle: String,
    val requestedMediaKind: OfflineReadingMediaKind,
    val state: ReadingTransferState,
    val automaticRestartCount: Int,
    val stagingName: String,
    val requestedAt: Instant,
)

internal data class OfflineReadingPackage(
    val id: UUID,
    val bindingId: UUID,
    val mediaId: UUID,
    val mediaKind: OfflineReadingMediaKind,
    val title: String,
    val readerGeneration: Long,
    val readerRevisionKey: String,
    val packageSha256: String,
    val sizeBytes: Long,
    val installedAt: Instant,
)

internal data class OfflineReaderBaseline(
    val bindingId: UUID,
    val mediaId: UUID,
    val readerGeneration: Long,
    val serverSnapshotJson: String,
    val observedAt: Instant,
)

internal data class OfflineReaderPendingProgress(
    val bindingId: UUID,
    val mediaId: UUID,
    val readerGeneration: Long,
    val readerRevisionKey: String,
    val baseServerRevision: Long,
    val locatorJson: String,
    val syncState: OfflineReaderSyncState,
    val updatedAt: Instant,
)

internal enum class OfflineReaderSyncState {
    Pending,
    Conflict,
    ContentChanged,
    SourceUnavailable,
}

internal sealed interface NativeReaderProgressView {
    data class Canonical(val baselineJson: String) : NativeReaderProgressView

    data class Pending(
        val baselineJson: String,
        val deviceLocatorJson: String,
    ) : NativeReaderProgressView

    data class Conflict(
        val canonicalJson: String,
        val deviceLocatorJson: String,
    ) : NativeReaderProgressView

    data class ContentChanged(
        val baselineJson: String,
        val deviceLocatorJson: String,
    ) : NativeReaderProgressView

    data class SourceUnavailable(
        val baselineJson: String,
        val deviceLocatorJson: String,
    ) : NativeReaderProgressView
}

internal sealed interface OfflineReadingBindingView {
    data object Absent : OfflineReadingBindingView
    data class Present(
        val accountId: UUID,
        val authorizationRequired: Boolean,
    ) : OfflineReadingBindingView
}

internal sealed interface OfflineReadingAvailability {
    data class Transfer(val state: ReadingTransferState) : OfflineReadingAvailability

    data class Ready(
        val sizeBytes: Long,
        val installedAt: Instant,
        val progress: NativeReaderProgressView,
    ) : OfflineReadingAvailability

    data object Removing : OfflineReadingAvailability
}

internal sealed interface OfflineReadingItemSnapshot {
    val mediaId: UUID
    val title: String
    val mediaKind: OfflineReadingMediaKind
    val availability: OfflineReadingAvailability

    data class TransferItem(
        override val mediaId: UUID,
        override val title: String,
        override val mediaKind: OfflineReadingMediaKind,
        override val availability: OfflineReadingAvailability.Transfer,
    ) : OfflineReadingItemSnapshot

    data class PackageItem(
        override val mediaId: UUID,
        override val title: String,
        override val mediaKind: OfflineReadingMediaKind,
        val readerGeneration: Long,
        val readerRevisionKey: String,
        override val availability: OfflineReadingAvailability,
    ) : OfflineReadingItemSnapshot {
        init {
            require(
                availability is OfflineReadingAvailability.Ready ||
                    availability is OfflineReadingAvailability.Removing
            )
        }
    }
}

internal data class ReadingStoreSnapshot(
    val binding: OfflineReadingBindingView,
    val networkPolicy: NetworkPolicy,
    val items: List<OfflineReadingItemSnapshot>,
)

internal data class OfflineReadingLease(
    val id: UUID,
    val mediaId: UUID,
    val readerGeneration: Long,
    val readerRevisionKey: String,
    val installedAt: Instant,
    val progress: NativeReaderProgressView,
    private val packageDirectory: java.io.File,
) {
    fun resolveEntry(path: String): java.io.File {
        requireSafePackagePath(path)
        val entry = java.io.File(packageDirectory, path).canonicalFile
        require(entry.toPath().startsWith(packageDirectory.canonicalFile.toPath()))
        require(entry.isFile)
        return entry
    }
}
