package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyCanonicalTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `bounded source projection preserves canonical unicode visibility and separator policy`() {
        val cases = listOf(
            "<p>e<span>&#x301;</span>&nbsp;🧠</p><div hidden>secret</div><p>one<br><br><br>two</p>" to "é 🧠\none\n\ntwo",
            "<div>A<span> </span> <b>B</b></div>" to "A  B",
            "<p> A\u0085 B&nbsp;C\u202fD </p><p aria-hidden=\"true\">secret</p>" to "A B C D",
            "<table><caption>caption</caption><tr><td>first</td><td>second</td></tr></table>" to "caption\nfirst\nsecond",
        )
        for ((html, expected) in cases) {
            val staging = temporary.newFolder()
            File(staging, "0.html").writeText(html)
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
                database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(File(staging, "0.html").sha256Hex()))
            }
            stageLegacyReaderHtml(staging, 0)
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                val end = database.rawQuery("SELECT max(end_cp) FROM html_nodes", null).use { require(it.moveToFirst()); it.getLong(0) }
                val crop = cropLegacyReaderHtml(database, 0, 0, end)!!
                LegacyReaderText(File(staging, "canonical.utf16").apply { writeText(expected, Charsets.UTF_16BE) }).use { text ->
                    assertEquals("canonical source meaning changed", expected, canonicalizeLegacyReaderCrop(crop, text, 0).text)
                }
            }
        }
    }
}
