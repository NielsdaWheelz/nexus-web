package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyBoundaryTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `canonical graphemes retain exact source cuts across markup and astral text`() {
        val staging = temporary.newFolder()
        val source = File(staging, "0.html")
        source.writeText("<p>A<span>e</span><b>&#x301;</b>🧠</p><p>Z</p>")
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(source.sha256Hex()))
        }
        stageLegacyReaderHtml(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            LegacyReaderText(File(staging, "canonical.utf16").apply { writeText("Aé🧠\nZ", Charsets.UTF_16BE) }).use { text ->
                val whole = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(database, 0, 0, 9)), text, 0)
                assertEquals("Aé🧠\nZ", whole.text)
                assertArrayEquals("canonical boundary lost its original source coordinate", longArrayOf(1, 3, 6, 6, 7, 8), whole.sourceStarts)
                val cut = whole.sourceStarts[2]
                val first = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(database, 0, 0, cut)), text, 0)
                val second = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(database, 0, cut, 9)), text, first.end)
                assertEquals("Aé", first.text)
                assertEquals("🧠\nZ", second.text)
                assertEquals(whole.text, first.text + second.text)
            }
        }
    }

    @Test
    fun `authored anchors preserve positions inside graphemes and after block separators`() {
        val cases = listOf(
            Triple("<p>👩<span id=\"join\">‍💻</span></p>", "👩‍💻", mapOf("join" to 1L)),
            Triple("<p>A<span>e</span><b id=\"mark\">&#x301;</b>🧠</p><p id=\"next\">Z</p>", "Aé🧠\nZ", mapOf("mark" to 2L, "next" to 4L)),
            Triple("<p id=\"block\"> A <span id=\"space\"> </span><b id=\"word\">B</b></p>", "A  B", mapOf("block" to 0L, "space" to 2L, "word" to 3L)),
        )
        for ((html, canonical, expected) in cases) {
            val staging = temporary.newFolder()
            val source = File(staging, "0.html").apply { writeText(html) }
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
                database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(source.sha256Hex()))
            }
            stageLegacyReaderHtml(staging, 0)
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                val end = database.rawQuery("SELECT max(end_cp) FROM html_nodes", null).use { it.moveToFirst(); it.getLong(0) }
                LegacyReaderText(File(staging, "canonical.utf16").apply { writeText(canonical, Charsets.UTF_16BE) }).use { text ->
                    val actual = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(database, 0, 0, end)), text, 0)
                    assertEquals("authored anchor changed its original canonical point", expected, actual.anchors)
                }
            }
        }
    }

    @Test
    fun `retained opening markers use original canonical pending whitespace`() {
        val cases = listOf(
            Triple("<table><tr><td>first</td></tr><tr><td id=\"mark\">second</td></tr></table>", "first\nsecond", 6L to 6),
            Triple("<p>A<br><span id=\"mark\"></span><br>B</p>", "A\n\nB", 3L to 3),
            Triple("<p>A <span id=\"mark\"></span></p><p>B</p>", "A\nB", 1L to 2),
            Triple("<p>A</p><span id=\"mark\"></span><p>B</p>", "A\nB", 2L to 2),
            Triple("<span>A</span><span id=\"mark\"></span><p>B</p>", "A\nB", 1L to 1),
        )
        for ((html, canonical, expected) in cases) {
            val staging = temporary.newFolder()
            val file = File(staging, "0.html").apply { writeText(html) }
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
                db.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
                db.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(file.sha256Hex()))
            }
            stageLegacyReaderHtml(staging, 0)
            LegacyReaderText(File(staging, "canonical.utf16").apply { writeText(canonical, Charsets.UTF_16BE) }).use { text ->
                SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
                    val opening = db.rawQuery("SELECT start_cp FROM html_nodes WHERE attributes_json LIKE '%mark%'", null).use {
                        check(it.moveToFirst()); it.getLong(0)
                    }
                    val crop = requireNotNull(cropLegacyReaderHtml(db, 0, 0, opening + 1))
                    val mapped = canonicalizeLegacyReaderCrop(crop, text, 0)
                    assertEquals("source opening lost its original pending whitespace", expected.first, mapped.anchors.getValue("mark"))
                    assertEquals("crop lost its independently owned closing separator", expected.second, mapped.end)
                    val preceding = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(db, 0, 0, opening)), text, 0)
                    val following = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(db, 0, opening, opening + 1)), text, preceding.end)
                    assertEquals("", following.text)
                    assertEquals(expected.first, preceding.end + following.anchors.getValue("mark"))
                    if (html.startsWith("<table>")) {
                        val empty = canonicalizeLegacyReaderCrop(requireNotNull(cropLegacyReaderHtml(db, 0, opening, opening + 1)), text, 5)
                        assertEquals("", empty.text)
                        assertEquals(6, empty.end)
                        assertEquals(1L, empty.anchors.getValue("mark"))
                    }
                }
            }
        }
    }
}
