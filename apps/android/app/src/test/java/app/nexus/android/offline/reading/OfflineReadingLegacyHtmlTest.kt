package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyHtmlTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `serialized source preserves tails entities and foreign namespaces without browser tree recovery`() {
        val staging = source("""<p id="intro">café &amp; 🧠<br>tail</p><svg viewBox="0 0 1 1"><linearGradient id="ink"></linearGradient><title>svg &amp; title</title><foreignObject><p>html</p></foreignObject></svg><math><mi>x</mi></math>""")
        repeat(2) { stageLegacyReaderHtml(staging, 0) }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            val elements = mutableListOf<String>()
            database.rawQuery("SELECT namespace, name FROM html_nodes WHERE kind = 'Element' ORDER BY ordinal", null).use {
                while (it.moveToNext()) elements += "${it.getString(0)}:${it.getString(1)}"
            }
            assertEquals(listOf("html:p", "html:br", "svg:svg", "svg:linearGradient", "svg:title", "svg:foreignObject", "html:p", "mathml:math", "mathml:mi"), elements)
            val text = StringBuilder()
            database.rawQuery("SELECT text FROM html_text ORDER BY node, part", null).use {
                while (it.moveToNext()) text.append(it.getString(0))
            }
            assertEquals("source text changed", "café & 🧠tailsvg & titlehtmlx", text.toString())
            database.rawQuery("SELECT attributes_json FROM html_nodes WHERE name = 'svg'", null).use {
                assertTrue(it.moveToFirst())
                assertTrue(it.getString(0).contains("viewBox"))
            }
            database.rawQuery("SELECT count(*) FROM html_complete", null).use {
                assertTrue(it.moveToFirst()); assertEquals(1, it.getInt(0))
            }
        }
    }

    @Test
    fun `largest legacy text run stays one source node with bounded disk parts`() {
        val directory = temporary.newFolder("installed")
        val staging = temporary.newFolder("staging")
        val media = UUID.fromString("00000000-0000-4000-8000-000000000007")
        val prefix = """{"readerContractVersion":1,"mediaId":"$media","mediaKind":"WebArticle","title":"Maximum source","navigation":[],"fragments":[{"fragmentId":"original","ordinal":0,"htmlSanitized":"<p>"""
        val middle = """</p>","canonicalText":""""
        val suffix = """"}]}"""
        val overhead = (prefix + middle + suffix).toByteArray().size
        val textLength = (OFFLINE_READING_MAX_READER_JSON_BYTES - overhead) / 2
        val padding = (OFFLINE_READING_MAX_READER_JSON_BYTES - overhead) % 2
        val readerFile = File(directory, "reader.json")
        readerFile.bufferedWriter().use { output ->
            val chunk = "a".repeat(8192)
            output.write(prefix)
            repeat(2) { part ->
                var remaining = textLength
                while (remaining > 0) {
                    val count = minOf(remaining, chunk.length.toLong()).toInt()
                    output.write(chunk, 0, count)
                    remaining -= count
                }
                output.write(if (part == 0) middle else suffix)
            }
            if (padding != 0L) output.write(" ")
        }
        assertEquals(OFFLINE_READING_MAX_READER_JSON_BYTES, readerFile.length())
        val sourceDigest = readerFile.sha256Hex()
        val entries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", readerFile.length(), sourceDigest))
        File(directory, "manifest.json").writeText(JSONObject().put("packageSchemaVersion", 1).put("readerContractVersion", 1)
            .put("minimumReaderBundleVersion", 1).put("mediaId", media.toString()).put("mediaKind", "WebArticle")
            .put("title", "Maximum source").put("readerGeneration", 7)
            .put("readerRevisionKey", OfflineReadingRevision.compute(7, entries))
            .put("entries", JSONArray().put(JSONObject().put("path", "reader.json").put("mediaType", "application/json")
                .put("sizeBytes", readerFile.length()).put("sha256", sourceDigest))).toString())
        println("native_legacy_maximum_input=" + JSONObject().put("encoded_reader_bytes", readerFile.length())
            .put("encoded_reader_sha256", sourceDigest).put("source_text_codepoints", textLength)
            .put("recipe", "one-ascii-paragraph-with-two-encoded-source-copies")
            .put("java_version", System.getProperty("java.version")).put("jvm_max_heap_bytes", Runtime.getRuntime().maxMemory()))
        val heapPeak = AtomicLong()
        val ownedStoragePeak = AtomicLong()
        val samples = AtomicLong()
        val sampler = Executors.newSingleThreadScheduledExecutor()
        val sample = Runnable {
            heapPeak.accumulateAndGet(Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory(), ::maxOf)
            ownedStoragePeak.accumulateAndGet(temporary.root.walkTopDown().filter(File::isFile).sumOf(File::length), ::maxOf)
            samples.incrementAndGet()
        }
        sample.run()
        val heapBefore = heapPeak.get()
        val linux = System.getProperty("os.name") == "Linux"
        val processBefore = if (linux) File("/proc/self/status").readLines().filter {
            it.startsWith("VmRSS:") || it.startsWith("VmHWM:")
        } else emptyList()
        // Sampled observations include owned journals when present; they are
        // neither a hard peak nor an android device memory qualification.
        val sampling = sampler.scheduleAtFixedRate(sample, 0, 100, TimeUnit.MILLISECONDS)
        try {
            val start = System.nanoTime()
            // Inspect the actual source projection before completed-fragment cleanup.
            // Final publication still has independent original-byte/text hash oracles.
            val manifest = OfflineReadingManifestParser.parse(File(directory, "manifest.json").readBytes())
            stageLegacyReaderSource(directory, manifest, staging, HostReadingFilesystemDurability)
            stageLegacyReaderHtml(staging, 0)
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                database.rawQuery("SELECT count(*), sum(length(text)), max(length(CAST(text AS BLOB))) FROM html_text", null).use {
                    assertTrue(it.moveToFirst())
                    assertTrue(it.getInt(0) > 1)
                    assertEquals(textLength, it.getLong(1))
                    assertTrue("a source run was materialized into an unbounded row", it.getLong(2) <= 8192)
                }
                database.rawQuery("SELECT count(*) FROM html_nodes WHERE kind = 'Text'", null).use {
                    assertTrue(it.moveToFirst()); assertEquals("input chunking changed source text-node identity", 1, it.getInt(0))
                }
                database.rawQuery("SELECT start_cp, end_cp FROM html_nodes WHERE kind = 'Text'", null).use {
                    assertTrue(it.moveToFirst()); assertEquals(1L, it.getLong(0)); assertEquals(textLength + 1, it.getLong(1))
                }
                database.rawQuery("SELECT end_cp FROM html_nodes WHERE name = 'p'", null).use {
                    assertTrue(it.moveToFirst()); assertEquals(textLength + 1, it.getLong(0))
                }
            }
            val source = stageLegacyReaderPackage(directory, staging, HostReadingFilesystemDurability)
            val converted = System.nanoTime()
            val prepared = prepareOfflineReadingPackage(source)
            val completed = System.nanoTime()
            sample.run()
            check(!sampling.isDone)
            sampler.shutdown()
            check(sampler.awaitTermination(10, TimeUnit.SECONDS))
            val processAfter = if (linux) File("/proc/self/status").readLines().filter {
                it.startsWith("VmRSS:") || it.startsWith("VmHWM:")
            } else emptyList()
            val unitEntries = source.manifest.entries.filter { it.path.startsWith("units/") }
            val canonicalHash = MessageDigest.getInstance("SHA-256")
            var canonicalLength = 0L
            var next: JSONObject? = JSONObject(File(source.extractedDirectory, "descriptor.json").readText()).getJSONObject("index_ref")
            var readUnits = 0
            while (next != null) {
                val page = JSONObject(File(source.extractedDirectory, next.getString("key")).readText())
                val positions = page.getJSONArray("units")
                for (index in 0 until positions.length()) {
                    val position = positions.getJSONObject(index)
                    assertEquals(readUnits++, position.getInt("ordinal"))
                    val file = File(source.extractedDirectory, position.getJSONObject("member").getString("key"))
                    val unit = JSONObject(file.readText())
                    assertEquals(canonicalLength, unit.getLong("start_cp"))
                    val text = unit.getString("canonical_text")
                    canonicalLength += text.length
                    assertEquals(canonicalLength, unit.getLong("end_cp"))
                    assertTrue(file.length() <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
                    assertTrue(text.length <= OFFLINE_READING_MAX_UNIT_CODEPOINTS)
                    canonicalHash.update(text.toByteArray())
                }
                next = if (page.isNull("next_ref")) null else page.getJSONObject("next_ref")
            }
            assertEquals(unitEntries.size, readUnits)
            assertEquals(textLength, canonicalLength)
            assertEquals(File(staging, "0.txt").sha256Hex(), canonicalHash.digest().toHex())
            assertEquals(sourceDigest, readerFile.sha256Hex())
            assertEquals(null, prepared.tableIndexSha256)
            assertEquals(source.extractedDirectory.walkTopDown().filter(File::isFile).sumOf(File::length), prepared.installedBytes)
            println("native_legacy_maximum=" + JSONObject().put("scope", "unqualified-host-exact-encoded-source")
                .put("memory_observer", if (linux) "sampled-jvm-heap-and-linux-status" else "sampled-jvm-heap-only")
                .put("encoded_reader_bytes", readerFile.length()).put("encoded_reader_sha256", sourceDigest)
                .put("source_text_codepoints", textLength).put("member_count", source.manifest.entries.size)
                .put("unit_count", unitEntries.size).put("installed_bytes", prepared.installedBytes)
                .put("source_index_bytes", File(staging, "source.sqlite").length())
                .put("conversion_ms", (converted - start) / 1_000_000.0).put("preparation_ms", (completed - converted) / 1_000_000.0)
                .put("sample_interval_ms", 100).put("samples", samples.get())
                .put("heap_used_before_bytes", heapBefore).put("sampled_heap_used_peak_bytes", heapPeak.get())
                .put("sampled_owned_files_peak_bytes", ownedStoragePeak.get())
                .put("process_before", JSONArray(processBefore)).put("process_after", JSONArray(processAfter)))
        } finally {
            sampler.shutdownNow()
            check(sampler.awaitTermination(10, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `unbalanced or commented source leaves no conversion checkpoint`() {
        for (html in listOf("<p>not closed", "<p>before<!--comment-->after</p>")) {
            val staging = source(html)
            assertThrows(Exception::class.java) { stageLegacyReaderHtml(staging, 0) }
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                database.rawQuery("SELECT 1 FROM html_complete", null).use { assertFalse(it.moveToFirst()) }
                database.rawQuery("SELECT 1 FROM html_nodes", null).use { assertFalse(it.moveToFirst()) }
            }
        }
    }

    @Test
    fun `table row groups and qualified attributes retain their DOM meanings`() {
        val staging = source("""<table><tr><td>one</td></tr> tail<tr><td>two</td></tr><tbody><tr><td>three</td></tr></tbody><tr><td>four</td></tr></table><svg><text xml:lang="el" xlink:title="title">x</text></svg>""")
        stageLegacyReaderHtml(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.rawQuery("SELECT count(*) FROM html_nodes WHERE name = 'tbody'", null).use {
                assertTrue(it.moveToFirst()); assertEquals(3, it.getInt(0))
            }
            database.rawQuery("SELECT p.name FROM html_nodes n JOIN html_nodes p ON n.fragment_ordinal = p.fragment_ordinal AND n.parent = p.ordinal WHERE n.name = 'tr' ORDER BY n.ordinal", null).use {
                var rows = 0
                while (it.moveToNext()) { assertEquals("tbody", it.getString(0)); rows += 1 }
                assertEquals(4, rows)
            }
            database.rawQuery("SELECT attributes_json FROM html_nodes WHERE name = 'text'", null).use {
                assertTrue(it.moveToFirst())
                val attributes = JSONArray(it.getString(0))
                assertEquals("xml", attributes.getJSONObject(0).getString("namespace"))
                assertEquals("lang", attributes.getJSONObject(0).getString("name"))
                assertEquals("xlink", attributes.getJSONObject(1).getString("namespace"))
                assertEquals("title", attributes.getJSONObject(1).getString("name"))
            }
        }
    }

    private fun source(html: String): File = temporary.newFolder().also {
        File(it, "0.html").writeText(html)
        sourceIndex(it)
    }

    private fun sourceIndex(staging: File) {
        // Immutable output baseline of the independently proved JSON/source phase.
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(File(staging, "0.html").sha256Hex()))
        }
    }
}
