package app.nexus.android.offline.reading

import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineReadingJsonBoundTest {
    @Test
    fun `unknown length response is rejected without reading the oversized body`() {
        var consumed = 0L
        val wireBytes = 16L * OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES
        val chunk = ByteArray(8192) { ' '.code.toByte() }
        val source = object : Source {
            override fun read(sink: Buffer, byteCount: Long): Long {
                if (consumed == wireBytes) return -1
                val count = minOf(byteCount, chunk.size.toLong(), wireBytes - consumed).toInt()
                sink.write(chunk, 0, count)
                consumed += count
                return count.toLong()
            }
            override fun timeout() = Timeout.NONE
            override fun close() = Unit
        }
        source.buffer().asResponseBody().use { body ->
            assertThrows(IllegalArgumentException::class.java) { body.readBoundedJson() }
        }
        assertTrue("the limit must stop wire consumption before whole-body allocation", consumed < wireBytes)
        assertTrue(consumed <= OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES + chunk.size)
        val bounded = Buffer().writeUtf8("{\"data\":null}")
        bounded.asResponseBody().use { body ->
            assertEquals("{\"data\":null}", body.readBoundedJson().toString(Charsets.UTF_8))
        }
    }
}
