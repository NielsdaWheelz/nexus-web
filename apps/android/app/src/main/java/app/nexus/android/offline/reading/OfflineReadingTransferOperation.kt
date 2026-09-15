package app.nexus.android.offline.reading

import okhttp3.Call
import okhttp3.Response
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class OfflineReadingTransferOperation internal constructor(
    private val transferId: UUID,
) : Closeable {
    private val canceled = AtomicBoolean(false)
    private val activeCall = AtomicReference<Call?>(null)

    fun <T> execute(call: Call, consume: (Response) -> T): T {
        check(activeCall.compareAndSet(null, call))
        if (canceled.get()) call.cancel()
        return try {
            call.execute().use(consume)
        } finally {
            activeCall.compareAndSet(call, null)
        }
    }

    fun cancel() {
        canceled.set(true)
        activeCall.get()?.cancel()
    }

    override fun close() {
        activeCall.getAndSet(null)?.cancel()
        OfflineReadingTransferOperations.release(transferId, this)
    }
}

internal object OfflineReadingTransferOperations {
    private val operations = ConcurrentHashMap<UUID, OfflineReadingTransferOperation>()

    fun register(transferId: UUID): OfflineReadingTransferOperation {
        val operation = OfflineReadingTransferOperation(transferId)
        check(operations.putIfAbsent(transferId, operation) == null)
        return operation
    }

    fun cancel(transferId: UUID) {
        operations[transferId]?.cancel()
    }

    fun cancelAll() {
        operations.values.forEach(OfflineReadingTransferOperation::cancel)
    }

    fun isActive(transferId: UUID): Boolean = operations.containsKey(transferId)

    internal fun release(
        transferId: UUID,
        operation: OfflineReadingTransferOperation,
    ) {
        operations.remove(transferId, operation)
    }
}
