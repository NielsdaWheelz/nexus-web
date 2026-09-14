package app.nexus.android.offline.reading

import java.io.File
import java.time.Duration
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReaderPublicationRangeReadTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `many sparse ranges share bounded actual source unit reads`() {
        val directory = File(temporary.root, "verified")
        val artifact = readerPublicationArtifact(temporary.root, "many-table-ranges")
        val trace = File(temporary.root, "source-reads.jfr")
        // Android's compile classpath omits jdk.jfr. These are public host
        // JDK APIs, reached reflectively without a production dependency.
        val recordingType = Class.forName("jdk.jfr.Recording")
        val settingsType = Class.forName("jdk.jfr.EventSettings")
        (recordingType.getConstructor().newInstance() as AutoCloseable).use { recording ->
            val settings = recordingType.getMethod("enable", String::class.java).invoke(recording, "jdk.FileRead")
            settingsType.getMethod("withThreshold", Duration::class.java).invoke(settings, Duration.ZERO)
            settingsType.getMethod("withoutStackTrace").invoke(settings)
            recordingType.getMethod("enable", String::class.java).invoke(recording, "jdk.DataLoss")
            recordingType.getMethod("start").invoke(recording)
            val verified = OfflineReadingPackageVerifier().verifyAndExtract(artifact,
                UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                UUID.fromString("11111111-1111-4111-8111-111111111111"), directory)
            assertEquals(2, verified.manifest.packageSchemaVersion)
            recordingType.getMethod("stop").invoke(recording)
            recordingType.getMethod("dump", java.nio.file.Path::class.java).invoke(recording, trace.toPath())
        }
        val unit = File(directory, "units/first.json")
        var readBytes = 0L
        var events = 0L
        var lostBytes = 0L
        val fileType = Class.forName("jdk.jfr.consumer.RecordingFile")
        val eventType = Class.forName("jdk.jfr.consumer.RecordedEvent")
        val objectType = Class.forName("jdk.jfr.consumer.RecordedObject")
        val typeType = Class.forName("jdk.jfr.EventType")
        val hasMore = fileType.getMethod("hasMoreEvents")
        val readEvent = fileType.getMethod("readEvent")
        val getType = eventType.getMethod("getEventType")
        val getName = typeType.getMethod("getName")
        val getLong = objectType.getMethod("getLong", String::class.java)
        val getString = objectType.getMethod("getString", String::class.java)
        (fileType.getConstructor(java.nio.file.Path::class.java).newInstance(trace.toPath()) as AutoCloseable).use { recording ->
            while (hasMore.invoke(recording) as Boolean) {
                val event = readEvent.invoke(recording)
                when (getName.invoke(getType.invoke(event))) {
                    "jdk.DataLoss" -> lostBytes += getLong.invoke(event, "amount") as Long
                    "jdk.FileRead" -> if (getString.invoke(event, "path") == unit.path) {
                        readBytes += getLong.invoke(event, "bytesRead") as Long
                        events++
                    }
                }
            }
        }
        println("native_publication_range_reads=" + JSONObject().put("scope", "host-jdk-file-reads")
            .put("source_unit_bytes", unit.length()).put("range_count", 256).put("observed_bytes", readBytes)
            .put("file_read_events", events).put("lost_bytes", lostBytes))
        assertEquals("source read instrumentation lost events", 0L, lostBytes)
        assertTrue("source read instrumentation did not observe the owned unit", events > 0 && readBytes >= unit.length())
        assertTrue("table ranges reread complete source units", readBytes <= 2 * unit.length())
        assertTrue(unit.length() <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
        val ranges = JSONObject(File(directory, "index/table-metadata-0.json").readText()).getJSONArray("table_metadata")
        assertEquals(257, ranges.length())
        // A decode memoised on the range tuple would satisfy the byte oracle if
        // the cells shared one window, so the corpus must keep them distinct.
        val windows = (1 until ranges.length()).map {
            val range = ranges.getJSONObject(it).getJSONObject("range")
            range.getLong("start_cp") to range.getLong("end_cp")
        }
        assertEquals("sparse cells share a single source window", 256, windows.toSet().size)
        assertTrue("sparse cell windows are empty", windows.all { (start, end) -> end > start })

    }
}
