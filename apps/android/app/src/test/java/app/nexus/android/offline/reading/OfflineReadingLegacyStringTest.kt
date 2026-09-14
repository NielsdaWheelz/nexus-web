package app.nexus.android.offline.reading

import com.squareup.moshi.JsonReader
import java.io.File
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReadingLegacyStringTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `legacy strings preserve Unicode escapes and leave the enclosing reader usable`() {
        val reader = JsonReader.of(Buffer().writeUtf8("""["café \ud83e\udde0\n\"\\\/\b\f\r\t",7]"""))
        reader.beginArray()
        val file = File(temporary.root, "text")
        assertEquals(14L, spoolLegacyReaderString(reader, file))
        assertEquals("café 🧠\n\"\\/\b\u000c\r\t", file.readText())
        assertEquals(7, reader.nextInt())
        reader.endArray()
        assertEquals(JsonReader.Token.END_DOCUMENT, reader.peek())
    }

    @Test
    fun `largest installed member writes incrementally rather than retaining its decoded value`() {
        val file = File(temporary.root, "large-text")
        val bytes = OFFLINE_READING_MAX_READER_JSON_BYTES - 2
        var emitted = 0L
        val chunk = ByteArray(8192) { 'a'.code.toByte() }
        val source = object : Source {
            override fun read(sink: Buffer, byteCount: Long): Long {
                if (emitted == bytes + 2) return -1
                if (emitted > 65_536) assertTrue("legacy string must reach disk before the complete value is read", file.length() > 0)
                if (emitted == 0L || emitted == bytes + 1) {
                    sink.writeByte('"'.code)
                    emitted += 1
                    return 1
                }
                val count = minOf(chunk.size.toLong(), byteCount, bytes + 1 - emitted).toInt()
                sink.write(chunk, 0, count)
                emitted += count
                return count.toLong()
            }
            override fun timeout() = Timeout.NONE
            override fun close() = Unit
        }
        JsonReader.of(source.buffer()).use { reader ->
            assertEquals(bytes, spoolLegacyReaderString(reader, file))
            assertEquals(JsonReader.Token.END_DOCUMENT, reader.peek())
        }
        assertEquals(bytes, file.length())
    }

    @Test
    fun `raw nextSource values still require valid JSON strings`() {
        for (wire in listOf("\"\\x\"", "\"\\ud800\"", "\"\\udc00\"", "\"line\nfeed\"", "\"\\u１２３４\"")) {
            val reader = JsonReader.of(Buffer().writeUtf8(wire))
            assertThrows(Exception::class.java) { spoolLegacyReaderString(reader, File(temporary.root, "invalid")) }
        }
    }
}
