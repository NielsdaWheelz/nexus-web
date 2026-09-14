package app.nexus.android.offline.reading

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class OfflineReadingTableGeometryTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `paged sparse geometry retains overlaps and implied rows beyond int32`() {
        val file = File(temporary.newFolder(), "geometry.sqlite")
        val highRow = 65534L * 65536L
        val cells = sequenceOf(
            OfflineReadingTableRectangle(0, 0, 1, 2, 1),
            OfflineReadingTableRectangle(0, 1, 0, 1, 2),
            OfflineReadingTableRectangle(0, highRow, 0, 65534, 1000),
            OfflineReadingTableRectangle(1, 0, 0, 1, 1),
        )
        stageOfflineReadingTableGeometry(file, REVISION, CACHE_KIB, cells)
        OfflineReadingTableGeometry(file, REVISION, CACHE_KIB).use { index ->
            val overlaps = mutableListOf<Pair<Long, Long>>()
            var after: Pair<Long, Long>? = null
            do {
                var count = 0
                index.intersecting(0, 1, 2, 1, 2, after, 1).use { rows ->
                    assertTrue("sparse table query escaped its page bound", rows.count <= 1)
                    while (rows.moveToNext()) {
                        after = rows.getLong(0) to rows.getLong(1)
                        overlaps.add(after!!)
                        count++
                    }
                }
            } while (count != 0)
            assertEquals(listOf(0L to 1L, 1L to 0L), overlaps)
            index.intersecting(0, highRow + 65533, highRow + 65534, 999, 1000, null, 1).use { rows ->
                assertTrue("table geometry truncated an implied row beyond int32", rows.moveToFirst())
                assertEquals(highRow, rows.getLong(0))
                assertEquals(highRow + 65534, rows.getLong(2))
                assertEquals(1000L, rows.getLong(3))
                assertTrue(!rows.moveToNext())
            }
            index.intersecting(0, highRow + 65534, highRow + 65535, 0, 1, null, 1).use { rows ->
                assertEquals(0, rows.count)
            }
        }
        val mismatch = runCatching { OfflineReadingTableGeometry(file, "b".repeat(64), CACHE_KIB).close() }.exceptionOrNull()
        assertTrue("another package revision opened the derived table index", mismatch is IllegalArgumentException)
    }

    @Test
    fun `characterize sparse source shapes with fixed page and sqlite cache experiments`() {
        // Geometry-only input, after source parsing; this is not source-worker,
        // complete header association, maximum package or device qualification.
        val observations = JSONArray()
        for (count in listOf(65536, 262144)) {
            for (shape in listOf("dense", "rowspan-zero", "staggered-expiry", "implied-rows")) {
                val file = File(temporary.newFolder(), "geometry.sqlite")
                val started = System.nanoTime()
                val cells = (0 until count).asSequence().map { ordinal ->
                    val n = ordinal.toLong()
                    when (shape) {
                        "dense" -> OfflineReadingTableRectangle(0, n / 4, n % 4, 1, 1)
                        "rowspan-zero" -> OfflineReadingTableRectangle(0, n, n, count - n, 1)
                        "staggered-expiry" -> OfflineReadingTableRectangle(0, n, n, 65534 - n % 65534, 1)
                        else -> OfflineReadingTableRectangle(0, n * 65534, 0, 65534, 1)
                    }
                }
                stageOfflineReadingTableGeometry(file, REVISION, CACHE_KIB, cells)
                val built = System.nanoTime()
                var selected = 0
                var pages = 0
                OfflineReadingTableGeometry(file, REVISION, CACHE_KIB).use { index ->
                    var after: Pair<Long, Long>? = null
                    do {
                        var pageCount = 0
                        index.intersecting(0, 0, Long.MAX_VALUE, 0, Long.MAX_VALUE, after, PAGE_ROWS).use { rows ->
                            assertTrue("sparse table query escaped its page bound", rows.count <= PAGE_ROWS)
                            while (rows.moveToNext()) {
                                val ordinal = selected.toLong()
                                val expectedRow = when (shape) {
                                    "dense" -> ordinal / 4
                                    "implied-rows" -> ordinal * 65534
                                    else -> ordinal
                                }
                                val expectedColumn = when (shape) {
                                    "dense" -> ordinal % 4
                                    "implied-rows" -> 0L
                                    else -> ordinal
                                }
                                assertEquals(expectedRow, rows.getLong(0))
                                assertEquals(expectedColumn, rows.getLong(1))
                                after = rows.getLong(0) to rows.getLong(1)
                                selected++
                                pageCount++
                            }
                        }
                        pages++
                    } while (pageCount == PAGE_ROWS)
                    assertEquals(count, selected)
                    val fullRead = System.nanoTime()
                    // A tiny late slot distinguishes bounded returned rows from
                    // an ordinary btree's potentially source-sized prefix scan.
                    val row = if (shape == "dense") (count - 1L) / 4 else
                        if (shape == "implied-rows") (count - 1L) * 65534 else count - 1L
                    val column = if (shape == "dense") 3L else if (shape == "implied-rows") 0L else count - 1L
                    repeat(16) {
                        index.intersecting(0, row, row + 1, column, column + 1, null, PAGE_ROWS).use { rows ->
                            assertEquals(1, rows.count)
                        }
                    }
                    val tinyRead = System.nanoTime()
                    val proc = File("/proc/self/status").readLines().filter {
                        it.startsWith("VmRSS:") || it.startsWith("VmHWM:")
                    }
                    observations.put(JSONObject()
                        .put("shape", shape).put("cells", count)
                        .put("cache_kib", CACHE_KIB).put("page_rows", PAGE_ROWS)
                        .put("build_ms", (built - started) / 1_000_000.0)
                        .put("all_rows_ms", (fullRead - built) / 1_000_000.0)
                        .put("tiny_slot_16_ms", (tinyRead - fullRead) / 1_000_000.0)
                        .put("returned_cells", selected).put("pages", pages)
                        .put("file_bytes", file.length())
                        .put("jvm_heap_used", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory())
                        .put("process_memory", JSONArray(proc)))
                }
            }
        }
        println("native_table_geometry=" + JSONObject()
            .put("version", 1).put("scope", "unqualified-native-host-geometry-only")
            .put("revision", REVISION).put("measurements", observations))
    }

    private companion object {
        const val CACHE_KIB = 1024 // Explicit experiment, not a release profile.
        const val PAGE_ROWS = 128
        val REVISION = "a".repeat(64)
    }
}
