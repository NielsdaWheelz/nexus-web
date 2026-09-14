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
class OfflineReadingLegacySourceTest {
    @get:Rule val temporary = TemporaryFolder()
    private val mediaId = UUID.fromString("00000000-0000-4000-8000-000000000007")
    private val fragmentId = "00000000-0000-4000-8000-000000000008"

    @Test
    fun `duplicated legacy epub sections stage one exact source and restart before durability`() {
        val (source, manifest) = source()
        val original = File(source, "reader.json").readBytes()
        val staging = temporary.newFolder("staging")
        assertThrows(IOException::class.java) {
            stageLegacyReaderSource(source, manifest, staging, object : OfflineReadingDurability {
                override fun syncTree(directory: File) { throw IOException("interrupted before durable source checkpoint") }
                override fun syncDirectory(directory: File) = Unit
            })
        }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.rawQuery("SELECT 1 FROM complete", null).use { assertFalse(it.moveToFirst()) }
        }
        repeat(2) { stageLegacyReaderSource(source, manifest, staging, NoOpDurability) }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.rawQuery("SELECT fragment_id, fragment_idx, canonical_length, html_path, canonical_path FROM fragments", null).use {
                assertTrue(it.moveToFirst())
                assertEquals(fragmentId, it.getString(0))
                assertEquals(0L, it.getLong(1))
                assertEquals(10L, it.getLong(2))
                assertEquals("<p>café 🧠</p><p>cat</p>", File(staging, it.getString(3)).readText())
                assertEquals("café 🧠\ncat", File(staging, it.getString(4)).readText())
                assertFalse("navigation duplicated complete source text", it.moveToNext())
            }
            database.rawQuery("SELECT section_id, start_cp, end_cp FROM sections ORDER BY ordinal", null).use {
                assertTrue(it.moveToFirst())
                assertEquals("first", it.getString(0)); assertEquals(0L, it.getLong(1)); assertEquals(7L, it.getLong(2))
                assertTrue(it.moveToNext())
                assertEquals("second", it.getString(0)); assertEquals(7L, it.getLong(1)); assertEquals(10L, it.getLong(2))
                assertFalse(it.moveToNext())
            }
        }
        assertTrue("source staging changed the only installed copy", original.contentEquals(File(source, "reader.json").readBytes()))
    }

    @Test
    fun `different text under the same legacy fragment identity cannot select an arbitrary winner`() {
        val (source, manifest) = source(conflictingDuplicate = true)
        val staging = temporary.newFolder("conflicting")
        assertThrows("conflicting source duplicate must retain the original package", IllegalArgumentException::class.java) {
            stageLegacyReaderSource(source, manifest, staging, NoOpDurability)
        }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.rawQuery("SELECT 1 FROM complete", null).use { assertFalse(it.moveToFirst()) }
        }
    }

    private fun source(conflictingDuplicate: Boolean = false): Pair<File, OfflineReadingManifest> {
        val directory = temporary.newFolder()
        val sections = JSONArray()
        for (ordinal in 0..1) {
            sections.put(JSONObject().put("sectionId", if (ordinal == 0) "first" else "second")
                .put("ordinal", ordinal).put("fragmentId", fragmentId).put("fragmentIdx", 0)
                .put("hrefPath", "chapter.xhtml").put("anchorId", JSONObject.NULL)
                .put("startOffset", if (ordinal == 0) 0 else 7).put("endOffset", if (ordinal == 0) 7 else 10)
                .put("htmlSanitized", "<p>café 🧠</p><p>cat</p>")
                .put("canonicalText", if (conflictingDuplicate && ordinal == 1) "café 🧠\ndog" else "café 🧠\ncat")
                .put("assetPaths", JSONArray()))
        }
        val bytes = JSONObject().put("readerContractVersion", 1).put("mediaId", mediaId.toString())
            .put("mediaKind", "Epub").put("title", "Retained copy").put("sections", sections)
            .put("navigation", JSONArray().put(JSONObject().put("sectionId", "second").put("label", "Last")))
            .toString().toByteArray()
        File(directory, "reader.json").writeBytes(bytes)
        val entries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", bytes.size.toLong(), sha256Hex(bytes)))
        return directory to OfflineReadingManifest(mediaId, OfflineReadingMediaKind.Epub, "Retained copy", 7,
            OfflineReadingRevision.compute(7, entries), entries, 1)
    }
}
