package app.nexus.android.offline.reading

import android.net.Network
import java.util.UUID

internal data class ReaderProgressSyncCandidate(
    val bindingId: UUID,
    val accountId: UUID,
    val mediaId: UUID,
    val readerGeneration: Long,
    val baseServerRevision: Long,
    val locatorJson: String,
)

internal data class AttestedRemoteReaderState(
    val accountId: UUID,
    val readerGeneration: Long,
    val snapshotJson: String,
) {
    val revision: Long = readerSnapshotRevision(snapshotJson)
}

internal sealed interface RemoteReaderWriteResult {
    data class Accepted(val state: AttestedRemoteReaderState) : RemoteReaderWriteResult
    data object Conflict : RemoteReaderWriteResult
    data object ContentChanged : RemoteReaderWriteResult
    data object SourceUnavailable : RemoteReaderWriteResult
}

internal interface OfflineReaderProgressOriginClient {
    fun fetch(
        mediaId: UUID,
        expectedAccountId: UUID,
    ): AttestedRemoteReaderState

    fun compareAndSwap(
        candidate: ReaderProgressSyncCandidate,
    ): RemoteReaderWriteResult
}

internal interface OfflineReaderProgressRepository {
    fun pendingSyncCandidates(mediaId: UUID? = null): List<ReaderProgressSyncCandidate>
    fun acceptCanonical(candidate: ReaderProgressSyncCandidate, state: AttestedRemoteReaderState)
    fun recordConflict(candidate: ReaderProgressSyncCandidate, state: AttestedRemoteReaderState)
    fun recordContentChanged(candidate: ReaderProgressSyncCandidate)
    fun recordSourceUnavailable(candidate: ReaderProgressSyncCandidate)
    fun recordAuthorizationRequired(candidate: ReaderProgressSyncCandidate)

    /** Record a broken protocol invariant for one media; never cursor content. */
    fun reportDefect(mediaId: UUID, defect: Throwable)
}

internal class OfflineReaderProgressSynchronizer(
    private val repository: OfflineReaderProgressRepository,
    private val origin: OfflineReaderProgressOriginClient,
) {
    fun synchronize(mediaId: UUID? = null) {
        try {
            repository.pendingSyncCandidates(mediaId).forEach { candidate ->
                try {
                    synchronizeCandidate(candidate)
                } catch (denial: StopProgressSyncAfterAuthorizationDenial) {
                    throw denial
                } catch (defect: Exception) {
                    // justify-ignore-error: one media's broken invariant may not abandon the
                    // other pending writes of this pass. Its row keeps its exact pending
                    // intent, the next pass retries it, and the defect stays loud.
                    repository.reportDefect(candidate.mediaId, defect)
                }
            }
        } catch (_: StopProgressSyncAfterAuthorizationDenial) {
            // One denial fences the account; no later candidate may issue remote work.
        }
    }

    private fun synchronizeCandidate(candidate: ReaderProgressSyncCandidate) {
        val canonical = try {
            origin.fetch(candidate.mediaId, candidate.accountId)
        } catch (error: OfflineReaderProgressOriginException) {
            when (error.reason) {
                ReaderProgressOriginFailure.SourceUnavailable ->
                    repository.recordSourceUnavailable(candidate)
                ReaderProgressOriginFailure.AuthorizationRequired ->
                    stopAfterAuthorizationDenial(candidate)
                ReaderProgressOriginFailure.Network,
                ReaderProgressOriginFailure.Server -> Unit
            }
            return
        }
        require(canonical.accountId == candidate.accountId)
        if (canonical.readerGeneration != candidate.readerGeneration) {
            repository.recordContentChanged(candidate)
            return
        }
        if (canonical.matches(candidate)) {
            repository.acceptCanonical(candidate, canonical)
            return
        }
        if (canonical.revision != candidate.baseServerRevision) {
            repository.recordConflict(candidate, canonical)
            return
        }
        val writeResult = try {
            origin.compareAndSwap(candidate)
        } catch (error: OfflineReaderProgressOriginException) {
            when (error.reason) {
                ReaderProgressOriginFailure.SourceUnavailable ->
                    repository.recordSourceUnavailable(candidate)
                ReaderProgressOriginFailure.AuthorizationRequired ->
                    stopAfterAuthorizationDenial(candidate)
                ReaderProgressOriginFailure.Network, ReaderProgressOriginFailure.Server -> Unit
            }
            return
        }
        when (val result = writeResult) {
            is RemoteReaderWriteResult.Accepted -> {
                require(result.state.accountId == candidate.accountId)
                if (result.state.readerGeneration != candidate.readerGeneration) {
                    repository.recordContentChanged(candidate)
                } else if (result.state.matches(candidate)) {
                    repository.acceptCanonical(candidate, result.state)
                } else {
                    // The write was accepted but the attested cursor is not the one we
                    // submitted. Never acknowledge it: install the attested state as the
                    // baseline and expose the existing conflict choice, and keep the
                    // protocol defect visible.
                    repository.reportDefect(
                        candidate.mediaId,
                        UnrecognizedReaderAcknowledgment(candidate.mediaId),
                    )
                    repository.recordConflict(candidate, result.state)
                }
            }
            RemoteReaderWriteResult.Conflict -> {
                val racedCanonical = try {
                    origin.fetch(candidate.mediaId, candidate.accountId)
                } catch (error: OfflineReaderProgressOriginException) {
                    when (error.reason) {
                        ReaderProgressOriginFailure.SourceUnavailable ->
                            repository.recordSourceUnavailable(candidate)
                        ReaderProgressOriginFailure.AuthorizationRequired ->
                            stopAfterAuthorizationDenial(candidate)
                        ReaderProgressOriginFailure.Network, ReaderProgressOriginFailure.Server -> Unit
                    }
                    return
                }
                require(racedCanonical.accountId == candidate.accountId)
                if (racedCanonical.readerGeneration != candidate.readerGeneration) {
                    repository.recordContentChanged(candidate)
                } else if (racedCanonical.matches(candidate)) {
                    repository.acceptCanonical(candidate, racedCanonical)
                } else {
                    repository.recordConflict(candidate, racedCanonical)
                }
            }
            RemoteReaderWriteResult.ContentChanged -> repository.recordContentChanged(candidate)
            RemoteReaderWriteResult.SourceUnavailable -> repository.recordSourceUnavailable(candidate)
        }
    }

    private fun stopAfterAuthorizationDenial(candidate: ReaderProgressSyncCandidate): Nothing {
        repository.recordAuthorizationRequired(candidate)
        throw StopProgressSyncAfterAuthorizationDenial()
    }
}

private class StopProgressSyncAfterAuthorizationDenial : RuntimeException()

/** The origin accepted a write and attested a cursor that is not the submitted one. */
internal class UnrecognizedReaderAcknowledgment(mediaId: UUID) : IllegalStateException(
    "reader acknowledgment does not match the submitted source and locator for media $mediaId"
)

private fun AttestedRemoteReaderState.matches(candidate: ReaderProgressSyncCandidate): Boolean {
    val root = StrictJson.parse(snapshotJson.toByteArray()) as StrictJson.ObjectValue
    if (root.fields["state"]?.requireString() != "Positioned") return false
    val source = root.fields.getValue("source") as StrictJson.ObjectValue
    if (source.fields.getValue("kind").requireString() != "Publication") return false
    if (source.fields.getValue("reader_generation").requireLong() != candidate.readerGeneration) return false
    return strictJsonSemanticallyEqual(
        root.fields.getValue("locator"),
        StrictJson.parse(candidate.locatorJson.toByteArray()),
    )
}

internal fun strictJsonSemanticallyEqual(left: StrictJson, right: StrictJson): Boolean =
    when {
        left is StrictJson.NumberValue && right is StrictJson.NumberValue ->
            left.value.toBigDecimal().compareTo(right.value.toBigDecimal()) == 0
        left is StrictJson.ObjectValue && right is StrictJson.ObjectValue ->
            left.fields.keys == right.fields.keys && left.fields.all { (key, value) ->
                strictJsonSemanticallyEqual(value, right.fields.getValue(key))
            }
        left is StrictJson.ArrayValue && right is StrictJson.ArrayValue ->
            left.values.size == right.values.size && left.values.zip(right.values).all { (a, b) ->
                strictJsonSemanticallyEqual(a, b)
            }
        else -> left == right
    }

internal fun interface OfflineReaderProgressOriginFactory {
    fun create(network: Network): OfflineReaderProgressOriginClient
}

internal enum class ReaderProgressOriginFailure {
    AuthorizationRequired,
    SourceUnavailable,
    Network,
    Server,
}

internal class OfflineReaderProgressOriginException(
    val reason: ReaderProgressOriginFailure,
    cause: Throwable? = null,
) : Exception(reason.name, cause)

internal fun readerSnapshotRevision(snapshotJson: String): Long {
    return OfflineReaderStateValidator.requireCursorSnapshot(snapshotJson)
}
