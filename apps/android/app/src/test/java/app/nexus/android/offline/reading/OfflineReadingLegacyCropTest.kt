package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyCropTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `a continued source list retains exact text and numbering without duplicating anchors`() {
        val staging = temporary.newFolder()
        File(staging, "0.html").writeText("""<ol start="7"><li id="a">alpha😀</li><li id="b" value="4">beta</li><li>gamma</li></ol>""")
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(File(staging, "0.html").sha256Hex()))
        }
        stageLegacyReaderHtml(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            // Element positions: ol 0, first li 1, second li 8, third li 13.
            // Text positions count code points, so the emoji occupies one.
            val first = cropLegacyReaderHtml(database, 0, 0, 10)!!
            val second = cropLegacyReaderHtml(database, 0, 10, 19)!!
            val text = StringBuilder()
            val anchors = mutableListOf<String>()
            for (crop in listOf(first, second)) for (index in 0 until crop.nodes.length()) {
                val node = crop.nodes.getJSONObject(index)
                if (node.getString("kind") == "Text") text.append(node.getString("text")) else {
                    val attributes = node.getJSONArray("attributes")
                    for (item in 0 until attributes.length()) if (attributes.getJSONObject(item).getString("name") == "id") anchors += attributes.getJSONObject(item).getString("value")
                }
            }
            assertEquals("alpha😀betagamma", text.toString())
            assertEquals("source anchors must occur exactly once across cuts", listOf("a", "b"), anchors)
            val listAttributes = second.nodes.getJSONObject(0).getJSONArray("attributes")
            assertEquals("7", (0 until listAttributes.length()).map { listAttributes.getJSONObject(it) }.single { it.getString("name") == "start" }.getString("value"))
            val continued = second.nodes.getJSONObject(1).getJSONArray("attributes")
            assertEquals("4", (0 until continued.length()).map { continued.getJSONObject(it) }.single { it.getString("name") == "value" }.getString("value"))
            assertTrue((0 until continued.length()).any { continued.getJSONObject(it).getString("name") == "data-nexus-continuation" })
            assertFalse((0 until continued.length()).any { continued.getJSONObject(it).getString("name") == "id" })
        }
    }

    @Test
    fun `distant text crops never hydrate a whole source run`() {
        val staging = temporary.newFolder()
        val content = "a".repeat(512 * 1024)
        File(staging, "0.html").writeText("<table><tr><td>cell</td></tr></table><p>$content</p>")
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(File(staging, "0.html").sha256Hex()))
        }
        stageLegacyReaderHtml(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            val distant = cropLegacyReaderHtml(database, 0, 400_000, 400_128)
            assertNotNull(distant)
            assertEquals(2, distant!!.nodes.length())
            assertEquals("a".repeat(128), distant.nodes.getJSONObject(1).getString("text"))
            assertTrue(distant.nodes.toString().toByteArray().size < 1024)
        }
    }

}
