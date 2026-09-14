package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class OfflineReadingLegacyTableHeadersTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `actual legacy html supplies independently expected sparse header associations`() {
        val fixtures = File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile, "offline-reading")
        val cases = JSONObject(File(fixtures, "table-headers.json").readText()).getJSONArray("cases")
        for (position in 0 until cases.length()) {
            val case = cases.getJSONObject(position)
            val staging = temporary.newFolder()
            // Installed legacy source was serialized after comment removal.
            // Preserve the shared case's surrounding whitespace and header oracle.
            val html = File(staging, "0.html").apply { writeText(case.getString("html").replace("<!--comment-->", "")) }
            val revision = html.sha256Hex()
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
                db.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
                db.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(revision))
            }
            stageLegacyReaderHtml(staging, 0)
            stageLegacyReaderTables(staging, 0)
            val index = File(staging, "index.sqlite")
            val names = mutableMapOf<Pair<Long, Long>, String>()
            var principal: Pair<Long, Long>? = null
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
                val table = db.rawQuery("SELECT node FROM legacy_tables WHERE ordinal=0", null).use { check(it.moveToFirst()); it.getLong(0) }
                val cells = sequence<OfflineReadingTableHeaderCell> {
                    db.rawQuery("""SELECT c.node, c.row_start, c.column_start, c.row_end, c.column_end, c.row_group,
                        h.kind, h.empty, h.explicit_headers, n.attributes_json FROM legacy_table_cells c
                        JOIN legacy_table_headers h ON h.fragment=c.fragment AND h.node=c.node
                        JOIN html_nodes n ON n.fragment_ordinal=c.fragment AND n.ordinal=c.node
                        WHERE c.table_node=? ORDER BY c.node""", arrayOf("$table")).use { rows ->
                        while (rows.moveToNext()) {
                            val node = rows.getLong(0)
                            val point = rows.getLong(1) to rows.getLong(2)
                            val attributes = JSONArray(rows.getString(9))
                            for (attribute in 0 until attributes.length()) {
                                val value = attributes.getJSONObject(attribute)
                                if (!value.isNull("namespace") || value.getString("name") != "id") continue
                                names[point] = value.getString("value")
                                if (value.getString("value") == case.getString("principal_id")) principal = point
                            }
                            val targets: Sequence<Pair<Long, Long>>? = if (rows.getInt(8) == 0) null else sequence<Pair<Long, Long>> {
                                db.rawQuery("""SELECT c.row_start, c.column_start FROM legacy_table_explicit e JOIN legacy_table_cells c
                                    ON c.fragment=e.fragment AND c.node=e.target_node WHERE e.node=? ORDER BY e.ordinal""", arrayOf("$node")).use {
                                    while (it.moveToNext()) yield(it.getLong(0) to it.getLong(1))
                                }
                            }
                            yield(OfflineReadingTableHeaderCell(
                                OfflineReadingTableRectangle(0, point.first, point.second, rows.getLong(3) - point.first, rows.getLong(4) - point.second),
                                rows.getString(6), rows.getInt(7) != 0, if (rows.isNull(5)) null else rows.getLong(5), targets))
                        }
                    }
                }
                val columns = sequence<OfflineReadingTableColumnGroup> {
                    db.rawQuery("SELECT start, end FROM legacy_table_columns WHERE table_node=? ORDER BY start", arrayOf("$table")).use {
                        while (it.moveToNext()) yield(OfflineReadingTableColumnGroup(0, it.getLong(0), it.getLong(1)))
                    }
                }
                stageOfflineReadingTableHeaderIndex(index, revision, OFFLINE_READING_TABLE_PREPARATION_CACHE_KIB, cells, columns)
            }
            val point = requireNotNull(principal)
            val scratch = File(staging, "query.sqlite")
            val actual = mutableListOf<String>()
            OfflineReadingTableHeaders(index, revision, scratch, OFFLINE_READING_TABLE_PREPARATION_CACHE_KIB, 1, 0, point.first, point.second).use { query ->
                var after: OfflineReadingTableHeaderPageKey? = null
                do {
                    var count = 0
                    query.page(after).use { page ->
                        assertTrue(page.count <= 1)
                        while (page.moveToNext()) {
                            after = OfflineReadingTableHeaderPageKey(page.getLong(0), page.getLong(1), page.getLong(2), page.getLong(3))
                            actual += requireNotNull(names[page.getLong(4) to page.getLong(5)])
                            count++
                        }
                    }
                } while (count != 0)
            }
            val expected = case.getJSONArray("expected_header_ids")
            assertEquals("legacy source changed header associations: ${case.getString("id")}",
                (0 until expected.length()).map(expected::getString), actual)
            assertFalse(scratch.exists())
            assertEquals(revision, html.sha256Hex())
        }
    }
}
