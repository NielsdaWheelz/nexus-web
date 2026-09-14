package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyTableContinuationTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `opening only excerpt owns structural continuation before any canonical text`() {
        val staging = temporary.newFolder()
        val html = File(staging, "0.html").apply { writeText("<table><tr><td rowspan=\"65534\">x</td></tr></table>") }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
            db.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            db.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(html.sha256Hex()))
        }
        stageLegacyReaderHtml(staging, 0)
        stageLegacyReaderTables(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
            LegacyReaderText(File(staging, "canonical.utf16").apply { writeText("x", Charsets.UTF_16BE) }).use { text ->
                beginLegacyTablePublication(db, 0)
                val opening = db.rawQuery("SELECT start_cp FROM html_nodes WHERE name='td'", null).use { check(it.moveToFirst()); it.getLong(0) }
                val end = db.rawQuery("SELECT max(end_cp) FROM html_nodes", null).use { check(it.moveToFirst()); it.getLong(0) }
                val first = requireNotNull(cropLegacyTableUnit(db, 0, 0, opening + 1))
                val firstCell = requireNotNull(projectLegacyTableUnit(db, 0, "source", 1, 0, first))
                    .getJSONObject(0).getJSONArray("cells").getJSONObject(0)
                assertEquals("", canonicalizeLegacyReaderCrop(first, text, 0).text)
                assertFalse(firstCell.getBoolean("continued_before")); assertTrue(firstCell.getBoolean("continued_after"))
                val second = requireNotNull(cropLegacyTableUnit(db, 0, opening + 1, end))
                val secondCell = requireNotNull(projectLegacyTableUnit(db, 0, "source", 1, opening + 1, second))
                    .getJSONObject(0).getJSONArray("cells").getJSONObject(0)
                assertEquals("x", canonicalizeLegacyReaderCrop(second, text, 0).text)
                assertTrue("opening-only table excerpt lost continuation", secondCell.getBoolean("continued_before"))
                assertFalse(secondCell.getBoolean("continued_after"))
            }
        }
    }
}
