package app.nexus.android.offline.reading

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class OfflineReadingTransferOperationTest {
    @Test
    fun `package lane outlives proxy header bound while BFF JSON remains short`() {
        val bff = OkHttpClient.Builder()
            .readTimeout(OFFLINE_READING_READ_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
            .build()
        val packageClient = offlineReadingPackageClient(bff)

        assertEquals(60_000, bff.readTimeoutMillis)
        assertEquals(3_600_000, packageClient.readTimeoutMillis)
        assertTrue(packageClient.readTimeoutMillis > TimeUnit.SECONDS.toMillis(660))
        assertEquals(0, packageClient.callTimeoutMillis)
    }

    @Test
    fun `store cancellation closes active response body before another byte is read`() {
        val transferId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")
        val source = CancelAwareSource()
        val call = BodyCall(source)
        val executor = Executors.newSingleThreadExecutor()
        val operation = OfflineReadingTransferOperations.register(transferId)
        try {
            val result = executor.submit<Long> {
                operation.execute(call) { response ->
                    response.body!!.source().read(Buffer(), 1)
                }
            }
            assertTrue(source.readEntered.await(2, TimeUnit.SECONDS))

            // This is the same registry seam invoked synchronously by Store.cancel/deleteStaging.
            OfflineReadingTransferOperations.cancel(transferId)

            assertEquals(-1L, result.get(2, TimeUnit.SECONDS))
            assertTrue(call.isCanceled())
            assertTrue(source.closed)
            assertEquals(0, source.bytesRead)
        } finally {
            operation.close()
            executor.shutdownNow()
        }
    }
}

private class CancelAwareSource : Source {
    val readEntered = CountDownLatch(1)
    val canceled = CountDownLatch(1)
    var bytesRead = 0
    var closed = false

    override fun read(sink: Buffer, byteCount: Long): Long {
        readEntered.countDown()
        check(canceled.await(2, TimeUnit.SECONDS))
        return -1
    }

    override fun timeout(): Timeout = Timeout.NONE

    override fun close() {
        closed = true
    }
}

private class BodyCall(private val trackingSource: CancelAwareSource) : Call {
    private val request = Request.Builder().url("https://api.example/package").build()
    private var canceled = false

    override fun request(): Request = request

    override fun execute(): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .body(object : ResponseBody() {
            private val buffered: BufferedSource = trackingSource.buffer()
            override fun contentType(): MediaType? = null
            override fun contentLength(): Long = 1
            override fun source(): BufferedSource = buffered
        })
        .build()

    override fun enqueue(responseCallback: Callback) = error("not used")

    override fun cancel() {
        canceled = true
        trackingSource.canceled.countDown()
    }

    override fun isExecuted(): Boolean = true
    override fun isCanceled(): Boolean = canceled
    override fun timeout(): Timeout = Timeout.NONE
    override fun clone(): Call = error("not used")
}
