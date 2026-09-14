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
class OfflineReadingLegacyIndexTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `converted first index keeps source order while paged contents keeps authored order`() {
        val source = temporary.newFolder()
        val staging = temporary.newFolder()
        val mediaId = UUID.fromString("00000000-0000-4000-8000-000000000007")
        val fragments = JSONArray()
        val navigation = JSONArray()
        val count = 140
        for (ordinal in 0 until count) fragments.put(JSONObject().put("fragmentId", "source-$ordinal")
            .put("ordinal", ordinal).put("htmlSanitized", "<p>source $ordinal</p>").put("canonicalText", "source $ordinal"))
        // Maximum supported labels exercise actual page encoding; authored order
        // deliberately differs from source order and is the independent oracle.
        val label = "🧠".repeat(512)
        for (ordinal in count - 1 downTo 0) navigation.put(JSONObject().put("fragmentId", "source-$ordinal").put("label", label))
        val bytes = JSONObject().put("readerContractVersion", 1).put("mediaId", mediaId.toString())
            .put("mediaKind", "WebArticle").put("title", "Retained index").put("fragments", fragments)
            .put("navigation", navigation).toString().toByteArray()
        File(source, "reader.json").writeBytes(bytes)
        val originalEntries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", bytes.size.toLong(), sha256Hex(bytes)))
        val original = OfflineReadingManifest(mediaId, OfflineReadingMediaKind.WebArticle, "Retained index", 7,
            OfflineReadingRevision.compute(7, originalEntries), originalEntries, 1)
        stageLegacyReaderSource(source, original, staging, NoOpDurability)
        stageLegacyReaderUnits(staging, original, NoOpDurability)
        val entries = stageLegacyReaderIndex(source, staging, original, NoOpDurability)
        val publication = File(staging, "publication")
        val descriptor = JSONObject(File(publication, "descriptor.json").readText())
        assertEquals(7, descriptor.getInt("reader_generation"))
        assertEquals(count, descriptor.getInt("unit_count"))
        fun read(reference: JSONObject): JSONObject {
            val file = File(publication, reference.getString("key"))
            assertTrue(file.length() <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
            assertEquals(reference.getLong("bytes"), file.length())
            assertEquals(reference.getString("sha256"), file.sha256Hex())
            return JSONObject(file.readText())
        }
        val first = read(descriptor.getJSONObject("index_ref"))
        assertTrue("converted first reader index lost source units", first.getJSONArray("units").length() > 0)
        assertEquals("source-0", first.getJSONArray("units").getJSONObject(0).getString("fragment_id"))
        assertEquals("source-0", read(descriptor.getJSONObject("first_unit_ref")).getString("fragment_id"))
        var next: JSONObject? = descriptor.getJSONObject("contents_ref")
        val visited = mutableSetOf<String>()
        var expected = count - 1
        while (next != null) {
            assertTrue(visited.add(next.getString("key")))
            val page = read(next)
            assertEquals(0, page.getJSONArray("units").length())
            assertEquals(0, page.getJSONArray("sections").length())
            val rows = page.getJSONArray("toc")
            for (index in 0 until rows.length()) {
                val row = rows.getJSONObject(index)
                assertEquals("source-${expected--}", row.getString("section_id"))
                assertEquals(label, row.getString("label"))
            }
            next = if (page.isNull("next_ref")) null else page.getJSONObject("next_ref")
        }
        assertEquals(-1, expected)
        assertTrue("fixture did not cross a contents page", visited.size > 1)
        val converted = original.copy(entries = entries, packageSchemaVersion = 2,
            readerRevisionKey = OfflineReadingRevision.compute(7, entries))
        OfflineReaderPublicationVerifier.verify(publication, converted, PublicationOrigin.Retained)
        assertTrue(bytes.contentEquals(File(source, "reader.json").readBytes()))
        assertEquals(entries, stageLegacyReaderIndex(source, staging, original, NoOpDurability))
    }
}
