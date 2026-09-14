package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.json.JSONArray
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
class OfflineReadingLegacyTableGeometryTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `actual legacy source keeps deferred footer geometry and source ordered cells`() {
        val staging = source("""<table><colgroup span="3"></colgroup><tfoot><tr><th rowspan="2">footer</th></tr></tfoot><tbody><tr><td rowspan="0">a</td><td colspan="2">b</td></tr><tr><td>c</td></tr></tbody></table>""")
        repeat(2) { stageLegacyReaderTables(staging, 0) }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
            db.rawQuery("SELECT rows, columns FROM legacy_tables", null).use {
                assertTrue(it.moveToFirst()); assertEquals(4L, it.getLong(0)); assertEquals(3L, it.getLong(1))
            }
            val expected = listOf(listOf(2L, 0L, 4L, 1L, 1L), listOf(0L, 0L, 2L, 1L, 0L),
                listOf(0L, 1L, 1L, 3L, 0L), listOf(1L, 1L, 2L, 2L, 0L))
            val actual = mutableListOf<List<Long>>()
            db.rawQuery("SELECT row_start, column_start, row_end, column_end, row_group FROM legacy_table_cells ORDER BY node", null).use {
                while (it.moveToNext()) actual += (0..4).map(it::getLong)
            }
            assertEquals("legacy table source changed logical rectangles", expected, actual)
            db.rawQuery("SELECT start, end FROM legacy_table_columns", null).use {
                assertTrue(it.moveToFirst()); assertEquals(0L, it.getLong(0)); assertEquals(3L, it.getLong(1))
            }
        }
    }

    @Test
    fun `overlaps remain independent and implied row spans never create logical slots`() {
        val staging = source("""<table><tr><td>a</td><td rowspan="65535trailing">b</td></tr><tr><td colspan="3">c</td></tr></table><table><caption>caption only</caption></table>""")
        stageLegacyReaderTables(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
            db.rawQuery("SELECT rows, columns, caption_node FROM legacy_tables ORDER BY ordinal", null).use {
                assertTrue(it.moveToFirst()); assertEquals(65534L, it.getLong(0)); assertEquals(3L, it.getLong(1))
                assertTrue(it.moveToNext()); assertEquals(0L, it.getLong(0)); assertEquals(0L, it.getLong(1)); assertTrue(!it.isNull(2))
            }
            val actual = mutableListOf<List<Long>>()
            db.rawQuery("SELECT row_start, column_start, row_end, column_end FROM legacy_table_cells ORDER BY node", null).use {
                while (it.moveToNext()) actual += (0..3).map(it::getLong)
            }
            assertEquals(listOf(listOf(0L, 0L, 1L, 1L), listOf(0L, 1L, 65534L, 2L), listOf(1L, 0L, 2L, 3L)), actual)
            db.rawQuery("SELECT COUNT(*) FROM table_occupancy", null).use { assertTrue(it.moveToFirst()); assertEquals(1L, it.getLong(0)) }
        }
    }

    @Test
    fun `source classification preserves explicit data targets first ids and non ascii whitespace`() {
        val staging = source("""<div id="shadow"></div><table><tr><th id="h">head</th><td id="d">data</td><th id="shadow">shadow</th></tr><tr><td headers="d h d shadow missing">principal</td><th scope="colgroup"> </th><th scope="ROW">&nbsp;</th></tr></table>""")
        stageLegacyReaderTables(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
            val kinds = mutableListOf<String>()
            val empty = mutableListOf<Boolean>()
            val explicit = mutableListOf<Boolean>()
            db.rawQuery("SELECT kind, empty, explicit_headers FROM legacy_table_headers ORDER BY node", null).use {
                while (it.moveToNext()) { kinds += it.getString(0); empty += it.getInt(1) != 0; explicit += it.getInt(2) != 0 }
            }
            assertEquals(listOf("none", "data", "row", "data", "colgroup", "row"), kinds)
            assertEquals(listOf(false, false, false, false, true, false), empty)
            assertEquals(listOf(false, false, false, true, false, false), explicit)
            val targets = mutableListOf<String>()
            db.rawQuery("SELECT n.attributes_json FROM legacy_table_explicit e JOIN html_nodes n ON n.fragment_ordinal=e.fragment AND n.ordinal=e.target_node ORDER BY e.ordinal", null).use {
                while (it.moveToNext()) targets += JSONArray(it.getString(0)).getJSONObject(0).getString("value")
            }
            assertEquals(listOf("d", "h"), targets)
        }
    }

    private fun source(html: String): File {
        val staging = temporary.newFolder()
        val file = File(staging, "0.html").apply { writeText(html) }
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
            db.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            db.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(file.sha256Hex()))
        }
        stageLegacyReaderHtml(staging, 0)
        return staging
    }
}
