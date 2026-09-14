package app.nexus.android.offline.reading

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class OfflineReadingTableHeadersTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `sparse selected-cell queries preserve normative opacity overlaps and first-seen order`() {
        val fixtureRoot = File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile, "offline-reading")
        val original = File(fixtureRoot, "table-headers.json").readBytes()
        val fixture = JSONObject(File(fixtureRoot, "table-header-geometry.json").readText())
        assertEquals(MessageDigest.getInstance("SHA-256").digest(original).joinToString("") { "%02x".format(it) },
            fixture.getString("source_sha256"))
        val cases = fixture.getJSONArray("cases")
        for (caseIndex in 0 until cases.length()) {
            val case = cases.getJSONObject(caseIndex)
            val rawCells = case.getJSONArray("cells")
            val names = mutableMapOf<Pair<Long, Long>, String>()
            var principal: Pair<Long, Long>? = null
            val cells = (0 until rawCells.length()).asSequence().map { position ->
                val raw = rawCells.getJSONObject(position)
                val point = raw.getLong("row") to raw.getLong("column")
                if (!raw.isNull("id")) {
                    names[point] = raw.getString("id")
                    if (raw.getString("id") == case.getString("principal_id")) principal = point
                }
                val targets = if (raw.isNull("explicit_targets")) null else raw.getJSONArray("explicit_targets")
                OfflineReadingTableHeaderCell(
                    OfflineReadingTableRectangle(0, point.first, point.second, raw.getLong("row_span"), raw.getLong("column_span")),
                    raw.getString("header_kind"), raw.getBoolean("empty"),
                    if (raw.isNull("row_group")) null else raw.getLong("row_group"),
                    targets?.let { array -> (0 until array.length()).asSequence().map {
                        array.getJSONArray(it).getLong(0) to array.getJSONArray(it).getLong(1)
                    } },
                )
            }
            val rawGroups = case.getJSONArray("column_groups")
            val groups = (0 until rawGroups.length()).asSequence().map {
                OfflineReadingTableColumnGroup(0, rawGroups.getJSONArray(it).getLong(0), rawGroups.getJSONArray(it).getLong(1))
            }
            val directory = temporary.newFolder()
            val index = File(directory, "index.sqlite")
            stageOfflineReadingTableHeaderIndex(index, REVISION, CACHE_KIB, cells, groups)
            val point = requireNotNull(principal)
            val scratch = File(directory, "query.sqlite")
            val actual = mutableListOf<String>()
            OfflineReadingTableHeaders(index, REVISION, scratch, CACHE_KIB, 1, 0, point.first, point.second).use { query ->
                var after: OfflineReadingTableHeaderPageKey? = null
                do {
                    var count = 0
                    query.page(after).use { page ->
                        assertTrue("header result escaped its page bound", page.count <= 1)
                        while (page.moveToNext()) {
                            after = OfflineReadingTableHeaderPageKey(page.getLong(0), page.getLong(1), page.getLong(2), page.getLong(3))
                            actual.add(requireNotNull(names[page.getLong(4) to page.getLong(5)]))
                            count++
                        }
                    }
                } while (count != 0)
            }
            val expected = case.getJSONArray("expected_header_ids")
            assertEquals("table header opacity or source order changed: ${case.getString("id")}",
                (0 until expected.length()).map { expected.getString(it) }, actual)
            assertFalse("closed header query retained its scratch database", scratch.exists())
            assertTrue("closing query deleted the package index", index.isFile)
        }
    }

    @Test
    fun `source coordinates do not expand implied rows and wrong revision cleans scratch`() {
        val index = File(temporary.newFolder(), "index.sqlite")
        val height = 65534L * 65536L
        stageOfflineReadingTableHeaderIndex(index, REVISION, CACHE_KIB, sequenceOf(
            OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, 0, 0, height, 1), "row", false, null, null),
            OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, 0, 1, height, 1), "data", false, null, null),
        ), emptySequence())
        val scratch = File(index.parentFile, "query.sqlite")
        OfflineReadingTableHeaders(index, REVISION, scratch, CACHE_KIB, 8, 0, 0, 1).use { query ->
            query.page(null).use { page ->
                assertTrue(page.moveToFirst())
                assertEquals(0L, page.getLong(4))
                assertEquals(0L, page.getLong(5))
                assertFalse(page.moveToNext())
            }
            assertEquals(1L, query.bands)
            assertEquals(1L, query.coverageNodesBuilt)
        }
        val failure = runCatching {
            OfflineReadingTableHeaders(index, "b".repeat(64), scratch, CACHE_KIB, 8, 0, 0, 1).close()
        }.exceptionOrNull()
        assertTrue("different revision read table context", failure is IllegalArgumentException)
        assertFalse(scratch.exists())
    }

    @Test
    fun `event reduction matches the literal slot oracle on small overlapping rectangles`() {
        val random = Random(20491)
        repeat(40) { example ->
            val principal = OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, 6, 6, 2, 2),
                listOf("data", "row", "column", "none")[random.nextInt(4)], random.nextBoolean(), null, null)
            val cells = mutableListOf(principal)
            val anchors = mutableSetOf(6L to 6L)
            repeat(24) {
                val row = random.nextInt(8).toLong()
                val column = random.nextInt(8).toLong()
                if (anchors.add(row to column)) cells.add(OfflineReadingTableHeaderCell(
                    OfflineReadingTableRectangle(0, row, column, random.nextInt(1, 4).toLong(), random.nextInt(1, 4).toLong()),
                    listOf("data", "row", "column", "none", "rowgroup", "colgroup")[random.nextInt(6)],
                    random.nextInt(4) == 0, null, null))
            }
            // Literal WHATWG slot walk: deliberately tiny and independent of
            // the product's reversed event sweep and disk interval reduction.
            val expected = linkedSetOf<Pair<Long, Long>>()
            for (axis in 0..1) {
                for (outer in 6L..7L) {
                    val opaque = mutableSetOf<Pair<Long, Long>>()
                    val block = mutableSetOf<Pair<Long, Long>>()
                    if (principal.kind != "data") block.add(6L to 8L)
                    for (inner in 5L downTo 0L) {
                        val row = if (axis == 0) outer else inner
                        val column = if (axis == 0) inner else outer
                        val covering = cells.filter { cell ->
                            val r = cell.rectangle
                            row >= r.row && row < r.rowEnd && column >= r.column && column < r.columnEnd
                        }
                        if (covering.size != 1) continue
                        val cell = covering.single()
                        val r = cell.rectangle
                        if (cell.kind == "data") {
                            opaque.addAll(block)
                            block.clear()
                        } else {
                            val group = if (axis == 0) r.row to r.rowEnd else r.column to r.columnEnd
                            block.add(group)
                            if (group !in opaque && cell.kind == (if (axis == 0) "row" else "column") && !cell.empty) {
                                expected.add(r.row to r.column)
                            }
                        }
                    }
                }
            }
            val index = File(temporary.newFolder(), "index.sqlite")
            stageOfflineReadingTableHeaderIndex(index, REVISION, CACHE_KIB, cells.asSequence(), emptySequence())
            val actual = mutableListOf<Pair<Long, Long>>()
            OfflineReadingTableHeaders(index, REVISION, File(index.parentFile, "query.sqlite"), CACHE_KIB, 3, 0, 6, 6).use { query ->
                var after: OfflineReadingTableHeaderPageKey? = null
                do {
                    var returned = 0
                    query.page(after).use { page ->
                        while (page.moveToNext()) {
                            after = OfflineReadingTableHeaderPageKey(page.getLong(0), page.getLong(1), page.getLong(2), page.getLong(3))
                            actual.add(page.getLong(4) to page.getLong(5))
                            returned++
                        }
                    }
                } while (returned == 3)
            }
            assertEquals("table header event reduction disagreed with literal slot oracle: $example", expected.toList(), actual)
        }
    }

    @Test
    fun `one bounded page can cross ray and group phases without dropping the remainder`() {
        val index = File(temporary.newFolder(), "index.sqlite")
        stageOfflineReadingTableHeaderIndex(index, REVISION, CACHE_KIB,
            listOf("row", "rowgroup", "colgroup", "data").asSequence().mapIndexed { column, kind ->
                OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, 0, column.toLong(), 1, 1),
                    kind, false, 0, null)
            }, sequenceOf(OfflineReadingTableColumnGroup(0, 0, 4)))
        OfflineReadingTableHeaders(index, REVISION, File(index.parentFile, "query.sqlite"), CACHE_KIB, 2, 0, 0, 3).use { query ->
            val after = query.page(null).use { page ->
                assertEquals(2, page.count)
                assertTrue(page.moveToFirst())
                assertEquals(0L, page.getLong(5))
                assertTrue(page.moveToNext())
                assertEquals(1L, page.getLong(5))
                OfflineReadingTableHeaderPageKey(page.getLong(0), page.getLong(1), page.getLong(2), page.getLong(3))
            }
            assertEquals(1L, query.groupRowsRead)
            query.page(after).use { page ->
                assertEquals(1, page.count)
                assertTrue(page.moveToFirst())
                assertEquals(2L, page.getLong(5))
            }
            assertEquals(2L, query.groupRowsRead)
        }
    }

    @Test
    fun `characterize selected-query work through dense rays and repeated overlapping windows`() {
        val observations = JSONArray()
        for ((shape, counts) in listOf(
            "dense-rays" to listOf(64, 256),
            "overlapping-windows" to listOf(64, 256, 1000, 2000, 8000),
            "irrelevant-table" to listOf(65536, 262144),
            "irrelevant-row-headers" to listOf(65536, 262144),
            "irrelevant-late-row-headers" to listOf(65536, 262144),
            "rowgroup-headers" to listOf(4096, 16384),
        )) {
            for (count in counts) {
                val index = File(temporary.newFolder(), "index.sqlite")
                val principalColumn = when (shape) {
                    "dense-rays", "irrelevant-row-headers", "irrelevant-late-row-headers" -> 1L
                    "overlapping-windows" -> 2000L
                    else -> 0L
                }
                val lastRow = shape == "rowgroup-headers" || shape == "irrelevant-late-row-headers"
                val principalRow = if (lastRow) count.toLong() else 0L
                val irrelevant = shape.startsWith("irrelevant-")
                val cells = sequence {
                    // One body cell grows to the end of this row group. Empty
                    // padding and overlapping headers below are source-formable
                    // within colspan<=1000, not an arbitrary dense slot matrix.
                    for (position in 0 until count) {
                        val row = position.toLong() + if (irrelevant && !lastRow) 1 else 0
                        if (irrelevant || shape == "rowgroup-headers") {
                            yield(OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, row, 0, 1, 1),
                                when (shape) { "irrelevant-table" -> "data"; "rowgroup-headers" -> "rowgroup"; else -> "row" },
                                false, 0, null))
                        } else if (shape == "dense-rays") {
                            yield(OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, row, 0, 1, 1),
                                "row", false, 0, null))
                        } else {
                            val inWindow = position % 1000
                            val windowEnd = minOf(count, position - inWindow + 1000)
                            val column = 1000L - inWindow
                            yield(OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, row, 0, 1, column),
                                "data", true, 0, null))
                            yield(OfflineReadingTableHeaderCell(OfflineReadingTableRectangle(0, row, column,
                                windowEnd - row, 1000), "row", false, 0, null))
                        }
                        if (position == 0 && !lastRow) yield(OfflineReadingTableHeaderCell(
                            OfflineReadingTableRectangle(0, principalRow, principalColumn,
                                if (irrelevant) 1 else count.toLong(), 1), "data", false, 0, null))
                    }
                    if (shape == "irrelevant-late-row-headers") yield(OfflineReadingTableHeaderCell(
                        OfflineReadingTableRectangle(0, principalRow, 0, 1, 1), "data", true, 0, null))
                    if (lastRow) yield(OfflineReadingTableHeaderCell(
                        OfflineReadingTableRectangle(0, principalRow, principalColumn, 1, 1), "data", false, 0, null))
                }
                // Files belong only to this profile. Sampling is evidence of
                // observed main+journal storage, not a hard peak or a claim
                // about SQLite temp files outside this owned directory.
                val indexPeak = AtomicLong()
                val scratchPeak = AtomicLong()
                val samples = AtomicLong()
                val sampler = Executors.newSingleThreadScheduledExecutor()
                val sample = Runnable {
                    val files = requireNotNull(index.parentFile.listFiles())
                    indexPeak.accumulateAndGet(files.filter { it.name.startsWith("index.sqlite") }.sumOf { it.length() }, ::maxOf)
                    scratchPeak.accumulateAndGet(files.filter { it.name.startsWith("query.sqlite") }.sumOf { it.length() }, ::maxOf)
                    samples.incrementAndGet()
                }
                val sampling = sampler.scheduleAtFixedRate(sample, 0, 10, TimeUnit.MILLISECONDS)
                try {
                    val start = System.nanoTime()
                    stageOfflineReadingTableHeaderIndex(index, REVISION, CACHE_KIB, cells, emptySequence())
                    val built = System.nanoTime()
                    val scratch = File(index.parentFile, "query.sqlite")
                    OfflineReadingTableHeaders(index, REVISION, scratch, CACHE_KIB, 128, 0, principalRow, principalColumn).use { query ->
                        val reduced = System.nanoTime()
                        var after: OfflineReadingTableHeaderPageKey? = null
                        var found = 0
                        var firstPageAt: Long? = null
                        do {
                            var returned = 0
                            query.page(after).use { page ->
                                assertTrue(page.count <= 128)
                                while (page.moveToNext()) {
                                    assertEquals("selected table header source order changed", found.toLong(), page.getLong(4))
                                    assertEquals(if (shape == "overlapping-windows") 1000L - found % 1000 else 0L, page.getLong(5))
                                    after = OfflineReadingTableHeaderPageKey(page.getLong(0), page.getLong(1), page.getLong(2), page.getLong(3))
                                    found++
                                    returned++
                                }
                            }
                            if (firstPageAt == null) firstPageAt = System.nanoTime()
                        } while (returned == 128)
                        assertEquals(if (irrelevant) 0 else count, found)
                        val completed = System.nanoTime()
                        sample.run()
                        observations.put(JSONObject()
                            .put("shape", shape).put("source_rows", count).put("returned_headers", found).put("cache_kib_per_connection", CACHE_KIB)
                            .put("page_rows", 128).put("source_cells_read", query.sourceCellsRead).put("group_rows_read", query.groupRowsRead)
                            .put("coverage_nodes_built", query.coverageNodesBuilt)
                            .put("coverage_nodes_read", query.coverageNodesRead)
                            .put("coverage_nodes_written", query.coverageNodesWritten)
                            .put("coverage_nodes_visited", query.coverageNodesVisited).put("bands", query.bands)
                            .put("coverage_read_ms", query.coverageReadNanos / 1_000_000.0)
                            .put("coverage_write_ms", query.coverageWriteNanos / 1_000_000.0)
                            .put("coverage_build_ms", query.coverageBuildNanos / 1_000_000.0)
                            .put("unique_reduction_ms", query.uniqueReductionNanos / 1_000_000.0)
                            .put("unique_spans", query.uniqueSpans).put("processed_cell_spans", query.processedCellSpans)
                            .put("max_completed_axis_state_rows", query.maxCompletedAxisStateRows)
                            .put("index_bytes", index.length()).put("scratch_bytes", query.scratchBytes)
                            .put("sample_interval_ms", 10).put("storage_samples", samples.get())
                            .put("sampled_index_main_journal_peak_bytes", indexPeak.get())
                            .put("sampled_scratch_main_journal_peak_bytes", scratchPeak.get())
                            .put("build_ms", (built - start) / 1_000_000.0)
                            .put("reduce_ms", (reduced - built) / 1_000_000.0)
                            .put("page_ms", (completed - reduced) / 1_000_000.0)
                            .put("first_page_ms", (requireNotNull(firstPageAt) - built) / 1_000_000.0)
                            .put("drain_complete_ms", (completed - built) / 1_000_000.0)
                            .put("jvm_heap_used", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory())
                            .put("process_memory", JSONArray(File("/proc/self/status").readLines().filter {
                                it.startsWith("VmRSS:") || it.startsWith("VmHWM:")
                            })))
                    }
                    assertFalse(scratch.exists())
                    check(!sampling.isDone)
                } finally {
                    sampler.shutdownNow()
                    check(sampler.awaitTermination(10, TimeUnit.SECONDS))
                }
            }
        }
        println("native_table_headers=" + JSONObject().put("version", 1)
            .put("scope", "unqualified-native-host-selected-header-query")
            .put("measurements", observations))
    }

    private companion object {
        const val CACHE_KIB = 1024 // Explicit native-host experiment, not a release profile.
        val REVISION = "a".repeat(64)
    }
}
