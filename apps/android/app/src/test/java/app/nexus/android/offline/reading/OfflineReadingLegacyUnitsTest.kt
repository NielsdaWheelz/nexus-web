package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.IOException
import java.util.UUID
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
class OfflineReadingLegacyUnitsTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `committed fragment retires a surviving spool and rebuilds lost table files from original source`() {
        val source = temporary.newFolder()
        val staging = temporary.newFolder()
        val media = UUID.fromString("00000000-0000-4000-8000-000000000007")
        val canonical = "head\nvalue\ncaption"
        val html = "<table><tr><th id=\"h\" rowspan=\"65534\">head</th><td headers=\"h\">value</td></tr><caption>caption</caption></table>"
        val bytes = JSONObject().put("readerContractVersion", 1).put("mediaId", media.toString())
            .put("mediaKind", "WebArticle").put("title", "Resume table").put("navigation", JSONArray())
            .put("fragments", JSONArray().put(JSONObject().put("fragmentId", "original-table").put("ordinal", 0)
                .put("htmlSanitized", html).put("canonicalText", canonical))).toString().toByteArray()
        File(source, "reader.json").writeBytes(bytes)
        val digest = sha256Hex(bytes)
        val entries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", bytes.size.toLong(), digest))
        val manifestBytes = JSONObject().put("packageSchemaVersion", 1).put("readerContractVersion", 1)
            .put("minimumReaderBundleVersion", 1).put("mediaId", media.toString()).put("mediaKind", "WebArticle")
            .put("title", "Resume table").put("readerGeneration", 7)
            .put("readerRevisionKey", OfflineReadingRevision.compute(7, entries))
            .put("entries", JSONArray().put(JSONObject().put("path", "reader.json").put("mediaType", "application/json")
                .put("sizeBytes", bytes.size).put("sha256", digest))).toString().toByteArray()
        File(source, "manifest.json").writeBytes(manifestBytes)
        val manifest = OfflineReadingManifestParser.parse(manifestBytes)
        stageLegacyReaderSource(source, manifest, staging, HostReadingFilesystemDurability)
        val spool = stageLegacyReaderText(staging, 0, HostReadingFilesystemDurability)
        val survivingSpool = temporary.newFile().apply { writeBytes(spool.readBytes()) }
        val first = stageLegacyReaderPackage(source, staging, HostReadingFilesystemDurability)
        assertFalse("completed fragment retained its conversion spool", spool.exists())
        // Restore the exact previously staged file at an actual committed checkpoint:
        // the filesystem state left by a crash before unlink, without a product hook.
        survivingSpool.copyTo(spool)
        stageLegacyReaderUnits(staging, manifest, HostReadingFilesystemDurability)
        assertFalse("resumed checkpoint retained its conversion spool", spool.exists())
        val orphan = File(temporary.newFolder(), "orphan")
        assertTrue(first.extractedDirectory.renameTo(orphan))
        assertTrue(orphan.deleteRecursively())
        val rebuilt = prepareOfflineReadingPackage(stageLegacyReaderPackage(source, staging, HostReadingFilesystemDurability))
        assertEquals("rebuilt publication changed source identities", first.manifest.entries, rebuilt.source.manifest.entries)
        assertEquals(digest, File(source, "reader.json").sha256Hex())
        val directory = rebuilt.source.extractedDirectory
        val descriptor = JSONObject(File(directory, "descriptor.json").readText())
        val published = rebuilt.source.manifest.entries.filter { it.path.startsWith("units/") }
            .map { JSONObject(File(directory, it.path).readText()) }.sortedBy { it.getLong("start_cp") }
            .joinToString("") { it.getString("canonical_text") }
        assertEquals(canonical, published)
        assertEquals(sha256Hex(canonical.toByteArray()), sha256Hex(published.toByteArray()))
        assertTrue(rebuilt.tableIndexSha256 != null)
        val metadata = JSONObject(File(directory, descriptor.getJSONObject("table_metadata_ref").getString("key")).readText())
            .getJSONArray("table_metadata")
        val records = (0 until metadata.length()).map(metadata::getJSONObject)
        val caption = records.single { it.getString("kind") == "Table" }.getJSONObject("caption")
        assertEquals("original-table", caption.getString("fragment_id"))
        assertEquals(11L, caption.getLong("start_cp")); assertEquals(18L, caption.getLong("end_cp"))
        val captionUnit = JSONObject(File(directory, caption.getString("unit_key")).readText())
        assertEquals("caption", captionUnit.getString("canonical_text").substring(
            (caption.getLong("start_cp") - captionUnit.getLong("start_cp")).toInt(),
            (caption.getLong("end_cp") - captionUnit.getLong("start_cp")).toInt()))
        val target = records.single { it.getString("kind") == "ExplicitHeader" }
        assertEquals(0L, target.getLong("row")); assertEquals(1L, target.getLong("column"))
        assertEquals(0L, target.getLong("target_row")); assertEquals(0L, target.getLong("target_column"))
    }

    @Test
    fun `interrupted conversion resumes exact original text within unit limits`() {
        val source = temporary.newFolder()
        val staging = temporary.newFolder()
        val mediaId = UUID.fromString("00000000-0000-4000-8000-000000000007")
        val fragmentId = "retained-opaque-fragment"
        val prefix = "<p>A<span>e</span><b>&#x301;</b>🧠</p>".repeat(48)
        val middle = "x".repeat(65534 - 48 * 4)
        val html = "$prefix<p>${middle}e<span>&#x301;</span>🧠${" tail".repeat(300)}</p>"
        val canonical = "Aé🧠\n".repeat(48) + middle + "é🧠" + " tail".repeat(300)
        val bytes = JSONObject().put("readerContractVersion", 1).put("mediaId", mediaId.toString())
            .put("mediaKind", "WebArticle").put("title", "Retained source")
            .put("navigation", JSONArray().put(JSONObject().put("fragmentId", fragmentId).put("label", "Source")))
            .put("fragments", JSONArray().put(JSONObject().put("fragmentId", fragmentId).put("ordinal", 0)
                .put("htmlSanitized", html).put("canonicalText", canonical)))
            .toString().toByteArray()
        File(source, "reader.json").writeBytes(bytes)
        val entries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", bytes.size.toLong(), sha256Hex(bytes)))
        val manifest = OfflineReadingManifest(mediaId, OfflineReadingMediaKind.WebArticle, "Retained source", 7,
            OfflineReadingRevision.compute(7, entries), entries, 1)
        stageLegacyReaderSource(source, manifest, staging, NoOpDurability)
        assertThrows(IOException::class.java) {
            stageLegacyReaderUnits(staging, manifest, object : OfflineReadingDurability {
                override fun syncTree(directory: File) = Unit
                override fun syncDirectory(directory: File) {
                    if (directory.name == "units") throw IOException("interrupted before fragment checkpoint")
                }
            })
        }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.rawQuery("SELECT count(*) FROM units_complete", null).use { it.moveToFirst(); assertEquals(0, it.getInt(0)) }
        }
        repeat(2) { stageLegacyReaderUnits(staging, manifest, NoOpDurability) }
        val retained = StringBuilder()
        var extent = 0L
        var count = 0
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.rawQuery("SELECT member_key, bytes, sha256 FROM publication_units ORDER BY ordinal", null).use { rows ->
                while (rows.moveToNext()) {
                    val file = File(staging, "publication/${rows.getString(0)}")
                    assertEquals(rows.getLong(1), file.length())
                    assertEquals(rows.getString(2), file.sha256Hex())
                    assertTrue(file.length() <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
                    val unit = JSONObject(file.readText())
                    assertEquals(fragmentId, unit.getString("fragment_id"))
                    assertEquals(extent, unit.getLong("start_cp"))
                    val text = unit.getString("canonical_text")
                    val length = text.codePointCount(0, text.length)
                    assertTrue(length <= OFFLINE_READING_MAX_UNIT_CODEPOINTS)
                    assertTrue(unit.getJSONArray("render_nodes").length() <= OFFLINE_READING_MAX_UNIT_DOM_NODES - 2)
                    assertTrue(unit.isNull("word_boundaries"))
                    extent += length
                    assertEquals(extent, unit.getLong("end_cp"))
                    retained.append(text)
                    count++
                }
            }
        }
        assertTrue("fixture did not cross a publication unit", count > 1)
        assertEquals("converted units changed original canonical text", canonical, retained.toString())
        assertTrue("conversion changed the only installed source", bytes.contentEquals(File(source, "reader.json").readBytes()))
    }
}
