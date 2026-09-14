package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

// Producer experiment, not a qualified browser/device layout profile.
private const val LEGACY_ORDINARY_TABLE_SLOTS = 8192L
private val TABLE_STRUCTURE = setOf("table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "caption")

internal fun beginLegacyTablePublication(db: SQLiteDatabase, fragment: Long) {
    db.execSQL("CREATE TABLE IF NOT EXISTS publication_table_layout (fragment INTEGER NOT NULL, node INTEGER NOT NULL, ordinary INTEGER NOT NULL, PRIMARY KEY(fragment, node))")
    db.execSQL("CREATE TABLE IF NOT EXISTS publication_table_ranges (fragment INTEGER NOT NULL, node INTEGER NOT NULL, unit_key TEXT NOT NULL, start_cp INTEGER NOT NULL, end_cp INTEGER NOT NULL, PRIMARY KEY(fragment, node))")
    db.execSQL("DELETE FROM publication_table_layout WHERE fragment=?", arrayOf(fragment))
    db.execSQL("DELETE FROM publication_table_ranges WHERE fragment=?", arrayOf(fragment))
    db.execSQL("""INSERT INTO publication_table_layout
        SELECT fragment, node, CASE WHEN max(1, rows)<=? / max(1, columns) THEN 1 ELSE 0 END
        FROM legacy_tables WHERE fragment=?""", arrayOf(LEGACY_ORDINARY_TABLE_SLOTS, fragment))
}

/** Raw crops charge source; this owner alone keeps fitting ordinary tables whole. */
internal fun cropLegacyTableUnit(db: SQLiteDatabase, fragment: Long, start: Long, requestedEnd: Long): LegacyReaderCrop? {
    var crop = cropLegacyReaderHtml(db, fragment, start, requestedEnd) ?: return null
    while (true) {
        var end = crop.end
        for (index in 0 until crop.nodes.length()) {
            val node = crop.nodes.getJSONObject(index)
            if (node.optString("namespace") != "html" || node.optString("name") != "table") continue
            db.rawQuery("""SELECT n.end_cp FROM publication_table_layout l JOIN html_nodes n
                ON n.fragment_ordinal=l.fragment AND n.ordinal=l.node
                WHERE l.fragment=? AND l.node=? AND l.ordinary=1""", arrayOf("$fragment", "${crop.sourceNodes[index]}")).use {
                if (it.moveToFirst()) end = maxOf(end, it.getLong(0))
            }
        }
        if (end == crop.end) return crop
        crop = cropLegacyReaderHtml(db, fragment, start, end) ?: return null
    }
}

/** A rejected whole atom becomes an excerpt before any of its units are published. */
internal fun excerptLegacyTableAt(db: SQLiteDatabase, fragment: Long, start: Long): Boolean {
    val crop = cropLegacyReaderHtml(db, fragment, start, start + 1) ?: return false
    for (index in 0 until crop.nodes.length()) {
        val node = crop.nodes.getJSONObject(index)
        if (node.optString("namespace") != "html" || node.optString("name") != "table") continue
        val changed = db.compileStatement("UPDATE publication_table_layout SET ordinary=0 WHERE fragment=? AND node=? AND ordinary=1").use {
            it.bindLong(1, fragment); it.bindLong(2, crop.sourceNodes[index]); it.executeUpdateDelete()
        }
        if (changed != 0) return true
    }
    return false
}

/** One admitted crop bounds these scalar maps and the provisional caption reservation. */
internal fun projectLegacyTableUnit(db: SQLiteDatabase, fragment: Long, fragmentId: String, fragmentLength: Long,
    start: Long, crop: LegacyReaderCrop): JSONArray? {
    data class Table(val ordinal: Long, val ordinary: Boolean, val context: JSONObject)
    data class Ancestor(val index: Int, val table: Table?)
    val ancestors = ArrayDeque<Ancestor>()
    val contexts = JSONArray()
    var slots = 0L
    for (index in 0 until crop.nodes.length()) {
        val node = crop.nodes.getJSONObject(index)
        val parent = if (node.isNull("parent")) null else node.getInt("parent")
        while (ancestors.isNotEmpty() && ancestors.last().index != parent) ancestors.removeLast()
        if (node.getString("kind") != "Element") continue
        var table = ancestors.lastOrNull()?.table
        val html = node.getString("namespace") == "html"
        val name = node.getString("name")
        if (html && name == "table") {
            table = db.rawQuery("""SELECT t.ordinal, t.rows, t.columns, t.caption_node, l.ordinary FROM legacy_tables t
                JOIN publication_table_layout l ON l.fragment=t.fragment AND l.node=t.node
                WHERE t.fragment=? AND t.node=?""", arrayOf("$fragment", "${crop.sourceNodes[index]}")).use {
                check(it.moveToFirst())
                val ordinary = it.getInt(4) != 0
                if (ordinary) slots += maxOf(1, it.getLong(1)) * maxOf(1, it.getLong(2))
                // The final key and numeric offsets cannot exceed this reservation.
                val caption = if (it.isNull(3)) JSONObject.NULL else JSONObject()
                    .put("unit_key", "units/${Long.MAX_VALUE}-$OFFLINE_READING_MAX_ENTRIES.json")
                    .put("fragment_id", fragmentId).put("start_cp", fragmentLength).put("end_cp", fragmentLength)
                val context = JSONObject().put("table_ordinal", it.getLong(0)).put("row_count", it.getLong(1))
                    .put("column_count", it.getLong(2)).put("caption", caption).put("cells", JSONArray())
                if (!ordinary) contexts.put(context)
                Table(it.getLong(0), ordinary, context)
            }
            if (slots > LEGACY_ORDINARY_TABLE_SLOTS) return null
        }
        val owned = table
        if (html && name in TABLE_STRUCTURE && owned != null) {
            val attributes = node.getJSONArray("attributes")
            for (item in attributes.length() - 1 downTo 0) {
                val attribute = attributes.getJSONObject(item)
                if (attribute.isNull("namespace") && (attribute.getString("name") == "data-nexus-table" ||
                    !owned.ordinary && ((name in setOf("td", "th") && attribute.getString("name") in setOf("rowspan", "colspan", "headers")) ||
                        name in setOf("col", "colgroup") && attribute.getString("name") == "span"))) attributes.remove(item)
            }
            if (!owned.ordinary) {
                attributes.put(JSONObject().put("namespace", JSONObject.NULL).put("name", "data-nexus-table").put("value", owned.ordinal.toString()))
                if (name in setOf("td", "th")) db.rawQuery("""SELECT c.row_start, c.column_start, c.row_end, c.column_end, n.start_cp, n.end_cp
                    FROM legacy_table_cells c JOIN html_nodes n ON n.fragment_ordinal=c.fragment AND n.ordinal=c.node
                    WHERE c.fragment=? AND c.node=?""", arrayOf("$fragment", "${crop.sourceNodes[index]}")).use {
                    check(it.moveToFirst())
                    owned.context.getJSONArray("cells").put(JSONObject().put("row", it.getLong(0)).put("column", it.getLong(1))
                        .put("row_span", it.getLong(2) - it.getLong(0)).put("column_span", it.getLong(3) - it.getLong(1))
                        .put("continued_before", it.getLong(4) < start).put("continued_after", it.getLong(5) > crop.end))
                }
            }
        }
        ancestors.addLast(Ancestor(index, table))
    }
    return contexts
}

internal fun recordLegacyTableRanges(db: SQLiteDatabase, fragment: Long, key: String, renderStart: Long,
    crop: LegacyReaderCrop, canonical: LegacyReaderCanonical) {
    for (index in 0 until crop.nodes.length()) {
        val node = crop.nodes.getJSONObject(index)
        if (node.optString("namespace") != "html" || node.optString("name") !in setOf("td", "th", "caption")) continue
        val attributes = node.getJSONArray("attributes")
        if ((0 until attributes.length()).none { attributes.getJSONObject(it).getString("name") == "data-nexus-table" }) continue
        val source = crop.sourceNodes[index]
        db.execSQL("INSERT OR IGNORE INTO publication_table_ranges VALUES (?, ?, ?, ?, ?)",
            arrayOf(fragment, source, key, renderStart + canonical.nodeStarts[index], renderStart + canonical.nodeEnds[index]))
        db.execSQL("UPDATE publication_table_ranges SET end_cp=max(end_cp, ?) WHERE fragment=? AND node=?",
            arrayOf(renderStart + canonical.nodeEnds[index], fragment, source))
    }
}

private fun legacyTableRange(db: SQLiteDatabase, fragment: Long, fragmentId: String, node: Long): JSONObject =
    db.rawQuery("SELECT unit_key, start_cp, end_cp FROM publication_table_ranges WHERE fragment=? AND node=?", arrayOf("$fragment", "$node")).use {
        check(it.moveToFirst()) { "table source node has no publication range" }
        JSONObject().put("unit_key", it.getString(0)).put("fragment_id", fragmentId).put("start_cp", it.getLong(1)).put("end_cp", it.getLong(2))
    }

/** Later captions are resolved before the existing fragment completion checkpoint. */
internal fun finishLegacyTableUnits(db: SQLiteDatabase, staging: File, fragment: Long, fragmentId: String) {
    db.rawQuery("""SELECT 1 FROM legacy_tables t JOIN publication_table_layout l ON l.fragment=t.fragment AND l.node=t.node
        WHERE t.fragment=? AND l.ordinary=0 AND t.caption_node IS NOT NULL LIMIT 1""", arrayOf("$fragment")).use {
        if (!it.moveToFirst()) return
    }
    db.rawQuery("SELECT member_key FROM publication_units WHERE fragment_ordinal=? ORDER BY ordinal", arrayOf("$fragment")).use { units ->
        while (units.moveToNext()) {
            val key = units.getString(0)
            val file = File(staging, "publication/$key")
            require(file.length() <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
            val body = JSONObject(file.readText())
            val contexts = body.getJSONArray("table_contexts")
            var changed = false
            for (index in 0 until contexts.length()) {
                val context = contexts.getJSONObject(index)
                if (context.isNull("caption")) continue
                val node = db.rawQuery("SELECT caption_node FROM legacy_tables WHERE fragment=? AND ordinal=?",
                    arrayOf("$fragment", context.getLong("table_ordinal").toString())).use { check(it.moveToFirst()); it.getLong(0) }
                context.put("caption", legacyTableRange(db, fragment, fragmentId, node))
                changed = true
            }
            if (changed) {
                val bytes = body.toString().toByteArray()
                require(bytes.size <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
                file.outputStream().use { it.write(bytes); it.fd.sync() }
                db.execSQL("UPDATE publication_units SET bytes=?, sha256=? WHERE member_key=?", arrayOf(bytes.size, file.sha256Hex(), key))
            }
        }
    }
}

internal fun appendLegacyTableMetadata(db: SQLiteDatabase, append: (JSONObject) -> Unit) {
    db.rawQuery("""SELECT t.fragment, f.fragment_id, t.node, t.ordinal, t.rows, t.columns, t.caption_node
        FROM legacy_tables t JOIN publication_table_layout l ON l.fragment=t.fragment AND l.node=t.node
        JOIN fragments f ON f.ordinal=t.fragment WHERE l.ordinary=0 ORDER BY f.fragment_idx, t.ordinal""", null).use { tables ->
        while (tables.moveToNext()) {
            val fragment = tables.getLong(0)
            val fragmentId = tables.getString(1)
            val table = tables.getLong(2)
            val ordinal = tables.getLong(3)
            fun record(kind: String) = JSONObject().put("kind", kind).put("fragment_id", fragmentId).put("table_ordinal", ordinal)
            append(record("Table").put("row_count", tables.getLong(4)).put("column_count", tables.getLong(5))
                .put("caption", if (tables.isNull(6)) JSONObject.NULL else legacyTableRange(db, fragment, fragmentId, tables.getLong(6))))
            db.rawQuery("SELECT start, end FROM legacy_table_columns WHERE fragment=? AND table_node=? ORDER BY start", arrayOf("$fragment", "$table")).use {
                while (it.moveToNext()) append(record("ColumnGroup").put("start", it.getLong(0)).put("end", it.getLong(1)))
            }
            db.rawQuery("""SELECT c.node, c.row_start, c.column_start, c.row_end, c.column_end, c.row_group, h.kind, h.empty, h.explicit_headers
                FROM legacy_table_cells c JOIN legacy_table_headers h ON h.fragment=c.fragment AND h.node=c.node
                WHERE c.fragment=? AND c.table_node=? ORDER BY c.node""", arrayOf("$fragment", "$table")).use { cells ->
                while (cells.moveToNext()) {
                    val node = cells.getLong(0)
                    val row = cells.getLong(1)
                    val column = cells.getLong(2)
                    append(record("Cell").put("row", row).put("column", column).put("row_span", cells.getLong(3) - row)
                        .put("column_span", cells.getLong(4) - column).put("row_group", if (cells.isNull(5)) JSONObject.NULL else cells.getLong(5))
                        .put("header_kind", cells.getString(6)).put("empty", cells.getInt(7) != 0).put("explicit_headers", cells.getInt(8) != 0)
                        .put("range", legacyTableRange(db, fragment, fragmentId, node)))
                    db.rawQuery("""SELECT c.row_start, c.column_start FROM legacy_table_explicit e JOIN legacy_table_cells c
                        ON c.fragment=e.fragment AND c.node=e.target_node WHERE e.fragment=? AND e.node=? ORDER BY e.ordinal""", arrayOf("$fragment", "$node")).use {
                        while (it.moveToNext()) append(record("ExplicitHeader").put("row", row).put("column", column)
                            .put("target_row", it.getLong(0)).put("target_column", it.getLong(1)))
                    }
                }
            }
        }
    }
}
