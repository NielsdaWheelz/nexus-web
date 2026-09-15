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
}

internal class OfflineReaderProgressSynchronizer(
    private val repository: OfflineReaderProgressRepository,
    private val origin: OfflineReaderProgressOriginClient,
) {
    fun synchronize(mediaId: UUID? = null) {
        try {
            repository.pendingSyncCandidates(mediaId).forEach(::synchronizeCandidate)
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
        if (canonical.locatorEquals(candidate.locatorJson)) {
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
                if (result.state.readerGeneration == candidate.readerGeneration) {
                    repository.acceptCanonical(candidate, result.state)
                } else {
                    repository.recordContentChanged(candidate)
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
                if (racedCanonical.readerGeneration == candidate.readerGeneration) {
                    repository.recordConflict(candidate, racedCanonical)
                } else {
                    repository.recordContentChanged(candidate)
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

private fun AttestedRemoteReaderState.locatorEquals(locatorJson: String): Boolean {
    val root = StrictJson.parse(snapshotJson.toByteArray()) as StrictJson.ObjectValue
    if (root.fields["state"]?.requireString() != "Positioned") return false
    return strictJsonSemanticallyEqual(
        root.fields.getValue("locator"),
        StrictJson.parse(locatorJson.toByteArray()),
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
