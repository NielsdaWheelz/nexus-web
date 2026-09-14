package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyTableUnitsTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `fitting table stays whole across a nearby unit boundary with caption and headers intact`() {
        val prefix = "p".repeat(65_530)
        val canonical = "$prefix\ncaption\nhead\nvalue"
        val prepared = convert("<p>$prefix</p><table><caption>caption</caption><tr><th id=\"h\">head</th><td headers=\"h\">value</td></tr></table>", canonical)
        val directory = prepared.source.extractedDirectory
        val descriptor = JSONObject(File(directory, "descriptor.json").readText())
        assertTrue(descriptor.getInt("unit_count") > 1)
        assertTrue(descriptor.isNull("table_metadata_ref"))
        assertEquals(null, prepared.tableIndexSha256)
        val pieces = units(prepared)
        val tableUnits = pieces.filter { body -> (0 until body.getJSONArray("render_nodes").length()).any {
            body.getJSONArray("render_nodes").getJSONObject(it).optString("name") == "table"
        } }
        assertEquals("fitting table was fragmented or changed operative semantics", 1, tableUnits.size)
        assertTrue(tableUnits.single().getString("canonical_text").endsWith("caption\nhead\nvalue"))
        val nodes = tableUnits.single().getJSONArray("render_nodes")
        val attributes = (0 until nodes.length()).flatMap { index ->
            val values = nodes.getJSONObject(index).optJSONArray("attributes") ?: JSONArray()
            (0 until values.length()).map(values::getJSONObject)
        }
        assertTrue(attributes.any { it.getString("name") == "headers" && it.getString("value") == "h" })
        assertTrue(attributes.none { it.getString("name") == "data-nexus-table" })
        assertEquals(canonical, pieces.joinToString("") { it.getString("canonical_text") })
    }

    @Test
    fun `opening after prior text retains its separator and exact first unit address`() {
        for (first in listOf("x".repeat(65_535), "🧠" + "x".repeat(65_534))) {
            val prepared = convert("<table><tr><td>$first</td></tr><tr><td id=\"next\">second</td></tr></table>", "$first\nsecond")
            val directory = prepared.source.extractedDirectory
            val descriptor = JSONObject(File(directory, "descriptor.json").readText())
            val firstKey = descriptor.getJSONObject("first_unit_ref").getString("key")
            val unit = JSONObject(File(directory, firstKey).readText())
            assertTrue("opening-only table range lost its metadata", !descriptor.isNull("table_metadata_ref"))
            val metadata = JSONObject(File(directory, descriptor.getJSONObject("table_metadata_ref").getString("key")).readText())
                .getJSONArray("table_metadata")
            val second = (0 until metadata.length()).map(metadata::getJSONObject)
                .single { it.getString("kind") == "Cell" && it.getLong("row") == 1L }.getJSONObject("range")
            assertEquals("opening-only table range lost its emitted separator", 65_536L, second.getLong("start_cp"))
            assertEquals(firstKey, second.getString("unit_key"))
            assertEquals(65_535L, unit.getLong("render_end_cp"))
            assertEquals(65_536L, unit.getLong("end_cp"))
            assertEquals("$first\n", unit.getString("canonical_text"))
        }
    }

    @Test
    fun `pending whitespace never splits its following combining grapheme`() {
        val first = "x".repeat(65_535)
        val canonical = "$first \u0301z"
        val pieces = units(convert("<p>$first <span id=\"mark\">&#x301;z</span></p>", canonical))
        assertEquals(canonical, pieces.joinToString("") { it.getString("canonical_text") })
        assertEquals("canonical suffix split a whitespace grapheme", first, pieces.first().getString("canonical_text"))
        assertEquals(" \u0301z", pieces.last().getString("canonical_text"))
    }

    @Test
    fun `large logical table retains exact source ranges later caption and explicit targets through preparation`() {
        val text = "v".repeat(70_000)
        val canonical = "café\n$text\nlate caption"
        val prepared = convert("<table><colgroup span=\"3\"></colgroup><tbody><tr><th id=\"h\" rowspan=\"65534\" colspan=\"3\">cafe&#x301;</th></tr><tr><td headers=\"h\">$text</td><td></td></tr></tbody><caption>late caption</caption></table>", canonical)
        assertTrue(prepared.tableIndexSha256 != null)
        val pieces = units(prepared)
        assertTrue(pieces.size > 1)
        assertEquals(canonical, pieces.joinToString("") { it.getString("canonical_text") })
        val directory = prepared.source.extractedDirectory
        val descriptor = JSONObject(File(directory, "descriptor.json").readText())
        var next: JSONObject? = descriptor.getJSONObject("table_metadata_ref")
        val records = mutableListOf<JSONObject>()
        while (next != null) {
            val file = File(directory, next.getString("key"))
            assertEquals(next.getString("sha256"), file.sha256Hex())
            val page = JSONObject(file.readText())
            val rows = page.getJSONArray("table_metadata")
            for (index in 0 until rows.length()) records += rows.getJSONObject(index)
            next = if (page.isNull("next_ref")) null else page.getJSONObject("next_ref")
        }
        val table = records.first()
        assertEquals(65_534L, table.getLong("row_count"))
        assertEquals(5L, table.getLong("column_count"))
        val caption = table.getJSONObject("caption")
        assertEquals(70_006L, caption.getLong("start_cp"))
        assertEquals(70_018L, caption.getLong("end_cp"))
        val captionUnit = JSONObject(File(directory, caption.getString("unit_key")).readText())
        assertTrue(captionUnit.getString("canonical_text").endsWith("late caption"))
        val cells = records.filter { it.getString("kind") == "Cell" }
        assertEquals(listOf(0L to 4L, 5L to 70_005L, 70_006L to 70_006L), cells.map {
            it.getJSONObject("range").let { range -> range.getLong("start_cp") to range.getLong("end_cp") }
        })
        val target = records.single { it.getString("kind") == "ExplicitHeader" }
        assertEquals(1L, target.getLong("row")); assertEquals(3L, target.getLong("column"))
        assertEquals(0L, target.getLong("target_row")); assertEquals(0L, target.getLong("target_column"))
        var continued = false
        for (body in pieces) {
            val contexts = body.getJSONArray("table_contexts")
            for (index in 0 until contexts.length()) {
                val context = contexts.getJSONObject(index)
                assertEquals(caption.toString(), context.getJSONObject("caption").toString())
                val excerpts = context.getJSONArray("cells")
                for (cell in 0 until excerpts.length()) continued = continued || excerpts.getJSONObject(cell).getBoolean("continued_before")
            }
            val nodes = body.getJSONArray("render_nodes")
            for (index in 0 until nodes.length()) {
                val node = nodes.getJSONObject(index)
                if (node.optString("name") !in setOf("table", "colgroup", "tbody", "tr", "th", "td", "caption")) continue
                val attrs = node.getJSONArray("attributes")
                val names = (0 until attrs.length()).map { attrs.getJSONObject(it).getString("name") }
                assertTrue("excerpt retained operative table layout", names.none { it in setOf("rowspan", "colspan", "span", "headers") })
                assertTrue(names.contains("data-nexus-table"))
            }
        }
        assertTrue("cross-unit source cell lost its continuation", continued)
    }

    private fun units(prepared: PreparedOfflineReadingPackage): List<JSONObject> = prepared.source.manifest.entries
        .filter { it.path.startsWith("units/") }.map { JSONObject(File(prepared.source.extractedDirectory, it.path).readText()) }
        .sortedBy { it.getLong("start_cp") }

    private fun convert(html: String, canonical: String): PreparedOfflineReadingPackage {
        val source = temporary.newFolder()
        val staging = temporary.newFolder()
        val media = UUID.fromString("00000000-0000-4000-8000-000000000007")
        val bytes = JSONObject().put("readerContractVersion", 1).put("mediaId", media.toString()).put("mediaKind", "WebArticle")
            .put("title", "Legacy table").put("navigation", JSONArray())
            .put("fragments", JSONArray().put(JSONObject().put("fragmentId", "original-table").put("ordinal", 0)
                .put("htmlSanitized", html).put("canonicalText", canonical))).toString().toByteArray()
        File(source, "reader.json").writeBytes(bytes)
        val entries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", bytes.size.toLong(), sha256Hex(bytes)))
        File(source, "manifest.json").writeText(JSONObject().put("packageSchemaVersion", 1).put("readerContractVersion", 1)
            .put("minimumReaderBundleVersion", 1).put("mediaId", media.toString()).put("mediaKind", "WebArticle").put("title", "Legacy table")
            .put("readerGeneration", 7).put("readerRevisionKey", OfflineReadingRevision.compute(7, entries))
            .put("entries", JSONArray().put(JSONObject().put("path", "reader.json").put("mediaType", "application/json")
                .put("sizeBytes", bytes.size).put("sha256", sha256Hex(bytes)))).toString())
        val result = prepareOfflineReadingPackage(stageLegacyReaderPackage(source, staging, HostReadingFilesystemDurability))
        assertTrue(bytes.contentEquals(File(source, "reader.json").readBytes()))
        return result
    }
}
