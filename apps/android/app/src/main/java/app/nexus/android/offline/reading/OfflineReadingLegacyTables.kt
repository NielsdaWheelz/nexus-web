package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.Locale
import org.json.JSONArray

private fun legacyTableSpan(value: String?, maximum: Long, zero: Boolean = false): Long {
    if (value == null) return 1
    var position = 0
    while (position < value.length && value[position] in "\t\n\u000c\r ") position++
    val negative = position < value.length && value[position] == '-'
    if (position < value.length && value[position] in "+-") position++
    if (position == value.length || value[position] !in '0'..'9') return 1
    var number = 0L
    while (position < value.length && value[position] in '0'..'9') {
        number = minOf(maximum, number * 10 + (value[position++] - '0'))
        if (number == maximum || negative && number > 0) break
    }
    if (negative && number > 0) return 1
    return if (number > 0 || zero) number else 1
}

private fun JSONArray.tableAttribute(name: String): String? {
    for (index in 0 until length()) {
        val value = getJSONObject(index)
        if (value.isNull("namespace") && value.getString("name") == name) return value.getString("value")
    }
    return null
}

/** Disjoint column intervals, stored in the existing migration database. */
private class LegacyTableOccupancy(private val db: SQLiteDatabase) {
    fun clear() {
        db.execSQL("DELETE FROM table_occupancy")
        db.execSQL("INSERT INTO table_occupancy VALUES(0, 0)")
    }

    private fun coalesce(start: Long) {
        val value = db.rawQuery("SELECT until FROM table_occupancy WHERE start=?", arrayOf("$start")).use {
            if (!it.moveToFirst()) return
            if (it.isNull(0)) null else it.getLong(0)
        }
        var kept = start
        db.rawQuery("SELECT start, until FROM table_occupancy WHERE start<? ORDER BY start DESC LIMIT 1", arrayOf("$start")).use {
            if (it.moveToFirst() && (if (it.isNull(1)) null else it.getLong(1)) == value) {
                kept = it.getLong(0)
                db.execSQL("DELETE FROM table_occupancy WHERE start=?", arrayOf(start))
            }
        }
        db.rawQuery("SELECT start, until FROM table_occupancy WHERE start>? ORDER BY start LIMIT 1", arrayOf("$kept")).use {
            if (it.moveToFirst() && (if (it.isNull(1)) null else it.getLong(1)) == value) {
                val following = it.getLong(0)
                db.execSQL("DELETE FROM table_occupancy WHERE start=?", arrayOf(following))
            }
        }
    }

    fun expire(row: Long) {
        while (true) {
            val start = db.rawQuery("SELECT start FROM table_occupancy WHERE until>0 AND until<=? ORDER BY until, start LIMIT 1", arrayOf("$row")).use {
                if (it.moveToFirst()) it.getLong(0) else null
            } ?: return
            db.execSQL("UPDATE table_occupancy SET until=0 WHERE start=?", arrayOf(start))
            coalesce(start)
        }
    }

    fun nextFree(column: Long): Long {
        db.rawQuery("SELECT until FROM table_occupancy WHERE start<=? ORDER BY start DESC LIMIT 1", arrayOf("$column")).use {
            check(it.moveToFirst())
            if (!it.isNull(0) && it.getLong(0) == 0L) return column
        }
        return db.rawQuery("SELECT start FROM table_occupancy WHERE until=0 AND start>=? ORDER BY start LIMIT 1", arrayOf("$column")).use {
            check(it.moveToFirst()); it.getLong(0)
        }
    }

    fun cover(start: Long, end: Long, until: Long?) {
        require(end - start in 1..1000)
        for (point in longArrayOf(start, end)) db.execSQL("""INSERT OR IGNORE INTO table_occupancy
            SELECT ?, until FROM table_occupancy WHERE start<=? ORDER BY start DESC LIMIT 1""", arrayOf(point, point))
        // Integer columns and the normative colspan ceiling bound this list.
        val points = db.rawQuery("SELECT start FROM table_occupancy WHERE start>=? AND start<=? ORDER BY start", arrayOf("$start", "$end")).use {
            val result = ArrayList<Long>()
            while (it.moveToNext()) { check(result.size <= 1000); result += it.getLong(0) }
            result
        }
        db.execSQL("""UPDATE table_occupancy SET until=CASE WHEN until IS NULL OR ? IS NULL
            THEN NULL ELSE max(until, ?) END WHERE start>=? AND start<?""", arrayOf(until, until, start, end))
        points.forEach(::coalesce)
    }
}

/** Immutable staged source nodes own table membership; geometry never expands slots. */
internal fun stageLegacyReaderTables(staging: File, fragment: Long) {
    require(staging.isDirectory)
    SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { db ->
        configureTableQuery(db, OFFLINE_READING_TABLE_PREPARATION_CACHE_KIB)
        db.execSQL("CREATE INDEX IF NOT EXISTS html_nodes_parent ON html_nodes(fragment_ordinal, parent, ordinal)")
        db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_tables (
            fragment INTEGER NOT NULL, node INTEGER NOT NULL, ordinal INTEGER NOT NULL,
            rows INTEGER NOT NULL, columns INTEGER NOT NULL, caption_node INTEGER,
            PRIMARY KEY(fragment, node), UNIQUE(fragment, ordinal))""")
        db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_table_cells (
            fragment INTEGER NOT NULL, node INTEGER NOT NULL, table_node INTEGER NOT NULL,
            row_start INTEGER NOT NULL, column_start INTEGER NOT NULL, row_end INTEGER NOT NULL,
            column_end INTEGER NOT NULL, row_group INTEGER, downward INTEGER NOT NULL,
            PRIMARY KEY(fragment, node), UNIQUE(fragment, table_node, row_start, column_start))""")
        db.execSQL("CREATE INDEX IF NOT EXISTS legacy_table_cells_source ON legacy_table_cells(fragment, table_node, node)")
        db.execSQL("CREATE INDEX IF NOT EXISTS legacy_table_cells_downward ON legacy_table_cells(fragment, table_node) WHERE downward=1")
        db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_table_columns (
            fragment INTEGER NOT NULL, table_node INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
            PRIMARY KEY(fragment, table_node, start))""")
        db.execSQL("CREATE TABLE IF NOT EXISTS legacy_tables_complete (fragment INTEGER PRIMARY KEY)")
        db.execSQL("CREATE TABLE IF NOT EXISTS table_occupancy (start INTEGER PRIMARY KEY, until INTEGER)")
        db.execSQL("CREATE INDEX IF NOT EXISTS table_occupancy_expiry ON table_occupancy(until, start) WHERE until>0")
        db.execSQL("CREATE INDEX IF NOT EXISTS table_occupancy_free ON table_occupancy(start) WHERE until=0")
        db.rawQuery("SELECT 1 FROM legacy_tables_complete WHERE fragment=?", arrayOf("$fragment")).use {
            if (it.moveToFirst()) return
        }
        db.transaction {
            db.rawQuery("SELECT 1 FROM html_complete WHERE fragment_ordinal=?", arrayOf("$fragment")).use { require(it.moveToFirst()) }
            val occupancy = LegacyTableOccupancy(db)
            var ordinal = 0L
            db.rawQuery("SELECT ordinal FROM html_nodes WHERE fragment_ordinal=? AND namespace='html' AND name='table' ORDER BY ordinal", arrayOf("$fragment")).use { tables ->
                while (tables.moveToNext()) {
                    val table = tables.getLong(0)
                    var row = 0L
                    var height = 0L
                    var width = 0L
                    var group = 0L
                    var rowsStarted = false
                    var caption: Long? = null
                    occupancy.clear()
                    fun endGroup() {
                        db.execSQL("UPDATE legacy_table_cells SET row_end=?, downward=0 WHERE fragment=? AND table_node=? AND downward=1",
                            arrayOf(height, fragment, table))
                        occupancy.clear()
                        row = height
                    }
                    fun processRow(node: Long, rowGroup: Long?) {
                        occupancy.expire(row)
                        height = maxOf(height, Math.addExact(row, 1))
                        var column = 0L
                        db.rawQuery("SELECT ordinal, attributes_json FROM html_nodes WHERE fragment_ordinal=? AND parent=? AND namespace='html' AND name IN ('td', 'th') ORDER BY ordinal", arrayOf("$fragment", "$node")).use { cells ->
                            while (cells.moveToNext()) {
                                val source = cells.getLong(0)
                                val attributes = JSONArray(cells.getString(1))
                                val columnSpan = legacyTableSpan(attributes.tableAttribute("colspan"), 1000)
                                val rowSpan = legacyTableSpan(attributes.tableAttribute("rowspan"), 65534, zero = true)
                                column = occupancy.nextFree(column)
                                val lastColumn = Math.addExact(column, columnSpan)
                                val lastRow = Math.addExact(row, maxOf(1, rowSpan))
                                db.execSQL("INSERT INTO legacy_table_cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                    arrayOf(fragment, source, table, row, column, lastRow, lastColumn, rowGroup, if (rowSpan == 0L) 1 else 0))
                                if (rowSpan != 1L) occupancy.cover(column, lastColumn, if (rowSpan == 0L) null else Math.addExact(row, rowSpan))
                                height = maxOf(height, lastRow)
                                column = lastColumn
                                width = maxOf(width, column)
                            }
                        }
                        row = Math.addExact(row, 1)
                    }
                    fun processGroup(node: Long) {
                        val start = height
                        db.rawQuery("SELECT ordinal FROM html_nodes WHERE fragment_ordinal=? AND parent=? AND namespace='html' AND name='tr' ORDER BY ordinal", arrayOf("$fragment", "$node")).use { rows ->
                            while (rows.moveToNext()) processRow(rows.getLong(0), group)
                        }
                        if (height > start) group++
                        endGroup()
                    }
                    db.rawQuery("SELECT ordinal, name, attributes_json FROM html_nodes WHERE fragment_ordinal=? AND parent=? AND namespace='html' ORDER BY ordinal", arrayOf("$fragment", "$table")).use { children ->
                        while (children.moveToNext()) {
                            val node = children.getLong(0)
                            when (children.getString(1)) {
                                "caption" -> if (caption == null) caption = node
                                "colgroup" -> if (!rowsStarted) {
                                    val start = width
                                    var any = false
                                    db.rawQuery("SELECT attributes_json FROM html_nodes WHERE fragment_ordinal=? AND parent=? AND namespace='html' AND name='col' ORDER BY ordinal", arrayOf("$fragment", "$node")).use { columns ->
                                        while (columns.moveToNext()) {
                                            any = true
                                            width = Math.addExact(width, legacyTableSpan(JSONArray(columns.getString(0)).tableAttribute("span"), 1000))
                                        }
                                    }
                                    if (!any) width = Math.addExact(width, legacyTableSpan(JSONArray(children.getString(2)).tableAttribute("span"), 1000))
                                    db.execSQL("INSERT INTO legacy_table_columns VALUES (?, ?, ?, ?)", arrayOf(fragment, table, start, width))
                                }
                                "tr" -> { rowsStarted = true; processRow(node, null) }
                                "thead", "tbody", "tfoot" -> {
                                    rowsStarted = true
                                    endGroup()
                                    if (children.getString(1) != "tfoot") processGroup(node)
                                }
                            }
                        }
                    }
                    endGroup()
                    // Deferred footers keep their original node ids/source order.
                    db.rawQuery("SELECT ordinal FROM html_nodes WHERE fragment_ordinal=? AND parent=? AND namespace='html' AND name='tfoot' ORDER BY ordinal", arrayOf("$fragment", "$table")).use { footers ->
                        while (footers.moveToNext()) processGroup(footers.getLong(0))
                    }
                    db.execSQL("INSERT INTO legacy_tables VALUES (?, ?, ?, ?, ?, ?)", arrayOf(fragment, table, ordinal++, height, width, caption))
                }
            }
            occupancy.clear()
            stageLegacyTableHeaders(db, fragment)
            db.execSQL("INSERT INTO legacy_tables_complete VALUES (?)", arrayOf(fragment))
        }
    }
}

/** Source-sized scalar classification, never all-cell header associations. */
private fun stageLegacyTableHeaders(db: SQLiteDatabase, fragment: Long) {
    db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_table_headers (
        fragment INTEGER NOT NULL, node INTEGER NOT NULL, kind TEXT NOT NULL,
        empty INTEGER NOT NULL, explicit_headers INTEGER NOT NULL, PRIMARY KEY(fragment, node))""")
    db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_table_explicit (
        fragment INTEGER NOT NULL, node INTEGER NOT NULL, ordinal INTEGER NOT NULL, target_node INTEGER NOT NULL,
        PRIMARY KEY(fragment, node, ordinal), UNIQUE(fragment, node, target_node))""")
    db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_source_ids (
        fragment INTEGER NOT NULL, id TEXT NOT NULL, node INTEGER NOT NULL, PRIMARY KEY(fragment, id))""")
    for (axis in listOf("rows", "columns")) db.execSQL("""CREATE TABLE IF NOT EXISTS legacy_table_data_$axis (
        fragment INTEGER NOT NULL, table_node INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
        PRIMARY KEY(fragment, table_node, start))""")
    db.rawQuery("SELECT ordinal, attributes_json FROM html_nodes WHERE fragment_ordinal=? AND kind='Element' ORDER BY ordinal", arrayOf("$fragment")).use { nodes ->
        while (nodes.moveToNext()) {
            val id = JSONArray(nodes.getString(1)).tableAttribute("id")
            if (!id.isNullOrEmpty()) db.execSQL("INSERT OR IGNORE INTO legacy_source_ids VALUES (?, ?, ?)", arrayOf(fragment, id, nodes.getLong(0)))
        }
    }
    db.rawQuery("SELECT node FROM legacy_tables WHERE fragment=? ORDER BY ordinal", arrayOf("$fragment")).use { tables ->
        while (tables.moveToNext()) {
            val table = tables.getLong(0)
            for ((axis, coordinate) in listOf("rows" to "row", "columns" to "column")) {
                var start: Long? = null
                var end = 0L
                db.rawQuery("""SELECT c.${coordinate}_start, c.${coordinate}_end FROM legacy_table_cells c
                    JOIN html_nodes n ON n.fragment_ordinal=c.fragment AND n.ordinal=c.node
                    WHERE c.fragment=? AND c.table_node=? AND n.name='td' ORDER BY c.${coordinate}_start, c.${coordinate}_end""", arrayOf("$fragment", "$table")).use { cells ->
                    while (cells.moveToNext()) {
                        val next = cells.getLong(0)
                        val until = cells.getLong(1)
                        if (start == null) { start = next; end = until }
                        else if (next <= end) end = maxOf(end, until)
                        else {
                            db.execSQL("INSERT INTO legacy_table_data_$axis VALUES (?, ?, ?, ?)", arrayOf(fragment, table, start, end))
                            start = next; end = until
                        }
                    }
                }
                if (start != null) db.execSQL("INSERT INTO legacy_table_data_$axis VALUES (?, ?, ?, ?)", arrayOf(fragment, table, start, end))
            }
            fun hasData(axis: String, start: Long, end: Long): Boolean = db.rawQuery(
                "SELECT end FROM legacy_table_data_$axis WHERE fragment=? AND table_node=? AND start<? ORDER BY start DESC LIMIT 1",
                arrayOf("$fragment", "$table", "$end")).use { it.moveToFirst() && it.getLong(0) > start }
            db.rawQuery("""SELECT c.node, c.row_start, c.column_start, c.row_end, c.column_end, n.name, n.attributes_json
                FROM legacy_table_cells c JOIN html_nodes n ON n.fragment_ordinal=c.fragment AND n.ordinal=c.node
                WHERE c.fragment=? AND c.table_node=? ORDER BY c.node""", arrayOf("$fragment", "$table")).use { cells ->
                while (cells.moveToNext()) {
                    val node = cells.getLong(0)
                    val attributes = JSONArray(cells.getString(6))
                    val kind = if (cells.getString(5) == "td") "data" else when (attributes.tableAttribute("scope")?.lowercase(Locale.ROOT)) {
                        "row" -> "row"
                        "col" -> "column"
                        "rowgroup" -> "rowgroup"
                        "colgroup" -> "colgroup"
                        else -> if (!hasData("rows", cells.getLong(1), cells.getLong(3))) "column"
                            else if (!hasData("columns", cells.getLong(2), cells.getLong(4))) "row" else "none"
                    }
                    var empty = db.rawQuery("SELECT 1 FROM html_nodes WHERE fragment_ordinal=? AND parent=? AND kind='Element' LIMIT 1", arrayOf("$fragment", "$node")).use { !it.moveToFirst() }
                    if (empty) db.rawQuery("""SELECT t.text FROM html_nodes n JOIN html_text t ON t.fragment_ordinal=n.fragment_ordinal AND t.node=n.ordinal
                        WHERE n.fragment_ordinal=? AND n.parent=? ORDER BY n.ordinal, t.part""", arrayOf("$fragment", "$node")).use { text ->
                        while (empty && text.moveToNext()) empty = text.getString(0).all { it in "\t\n\u000c\r " }
                    }
                    val headers = attributes.tableAttribute("headers")
                    db.execSQL("INSERT INTO legacy_table_headers VALUES (?, ?, ?, ?, ?)", arrayOf(fragment, node, kind, if (empty) 1 else 0, if (headers == null) 0 else 1))
                    if (headers != null) {
                        var ordinal = 0L
                        for (token in Regex("[^\\t\\n\\u000c\\r ]+").findAll(headers)) {
                            val target = db.rawQuery("""SELECT c.node FROM legacy_source_ids i JOIN legacy_table_cells c ON c.fragment=i.fragment AND c.node=i.node
                                WHERE i.fragment=? AND i.id=? AND c.table_node=? AND c.node!=?""", arrayOf("$fragment", token.value, "$table", "$node")).use {
                                if (it.moveToFirst()) it.getLong(0) else null
                            }
                            if (target != null) db.execSQL("INSERT OR IGNORE INTO legacy_table_explicit VALUES (?, ?, ?, ?)", arrayOf(fragment, node, ordinal++, target))
                        }
                    }
                }
            }
            // Classification consumes these intervals once; reuse their pages
            // for the next table instead of retaining every prior projection.
            for (axis in listOf("rows", "columns")) db.execSQL(
                "DELETE FROM legacy_table_data_$axis WHERE fragment=? AND table_node=?", arrayOf(fragment, table))
        }
    }
    db.execSQL("DELETE FROM legacy_source_ids WHERE fragment=?", arrayOf(fragment))
}
