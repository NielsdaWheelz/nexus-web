package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.json.JSONObject

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyListTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `continued reversed list uses staged scalar numbering without reading earlier attributes`() {
        val staging = temporary.newFolder()
        val priorAttribute = "x".repeat(3 * 1024 * 1024)
        File(staging, "0.html").writeText("<ol reversed><li title=\"$priorAttribute\">one</li><li value=\"7\">two</li><li>three</li></ol>")
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
            database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(File(staging, "0.html").sha256Hex()))
        }
        stageLegacyReaderHtml(staging, 0)
        SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
            for ((start, end, expectedNumber) in listOf(Triple(5L, 9L, "7"), Triple(9L, 15L, "6"))) {
                val crop = cropLegacyReaderHtml(database, 0, start, end)!!
                val item = (0 until crop.nodes.length()).map { crop.nodes.getJSONObject(it) }.single { it.optString("name") == "li" }
                val attributes = item.getJSONArray("attributes")
                val number = (0 until attributes.length()).map { attributes.getJSONObject(it) }.single { it.getString("name") == "value" }.getString("value")
                assertEquals("continued list number changed", expectedNumber, number)
                assertTrue(crop.nodes.toString().toByteArray().size < 1024)
            }
        }
    }

    @Test
    fun `shared list ordinals survive both whole and continued render trees`() {
        val cases = JSONObject(File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile,
            "offline-reading/list-ordinals.json").readText()).getJSONArray("cases")
        for (caseIndex in 0 until cases.length()) {
            val case = cases.getJSONObject(caseIndex)
            val staging = temporary.newFolder()
            File(staging, "0.html").writeText(case.getString("html"))
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                database.execSQL("CREATE TABLE fragments (ordinal INTEGER PRIMARY KEY, html_path TEXT NOT NULL, html_sha256 TEXT NOT NULL)")
                database.execSQL("INSERT INTO fragments VALUES(0, '0.html', ?)", arrayOf(File(staging, "0.html").sha256Hex()))
            }
            stageLegacyReaderHtml(staging, 0)
            SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
                val expected = case.getJSONArray("numbers")
                database.rawQuery("SELECT n.start_cp, n.end_cp, l.number FROM html_nodes n LEFT JOIN html_list_numbers l ON l.fragment_ordinal = n.fragment_ordinal AND l.node = n.ordinal WHERE n.fragment_ordinal = 0 AND n.namespace = 'html' AND n.name = 'li' ORDER BY n.ordinal", null).use { items ->
                    var itemIndex = 0
                    while (items.moveToNext()) {
                        val number = if (expected.isNull(itemIndex)) null else expected.getString(itemIndex)
                        assertEquals("continued list number changed: ${case.getString("name")}/$itemIndex", number, if (items.isNull(2)) null else items.getString(2))
                        if (number != null) {
                            for (start in items.getLong(0)..items.getLong(0) + 1) {
                                val crop = requireNotNull(cropLegacyReaderHtml(database, 0, start, start + 2))
                                val item = (0 until crop.nodes.length()).map { crop.nodes.getJSONObject(it) }.last { it.optString("name") == "li" }
                                val attributes = item.getJSONArray("attributes")
                                val value = (0 until attributes.length()).map { attributes.getJSONObject(it) }.single { it.getString("name") == "value" }.getString("value")
                                assertEquals("continued list number changed: ${case.getString("name")}/$itemIndex", number, value)
                            }
                        }
                        itemIndex += 1
                    }
                    assertEquals(expected.length(), itemIndex)
                }
            }
        }
    }
}
