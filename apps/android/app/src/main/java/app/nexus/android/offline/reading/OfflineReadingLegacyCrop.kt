package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject

internal data class LegacyReaderCrop(val end: Long, val nodes: JSONArray, val sourceStarts: LongArray, val sourceEnds: LongArray, val sourceNodes: LongArray, val opened: BooleanArray, val closed: BooleanArray)

/** Private source coordinates charge elements and text, never canonical locators. */
internal fun cropLegacyReaderHtml(database: SQLiteDatabase, fragment: Long, start: Long, requestedEnd: Long): LegacyReaderCrop? {
    require(start >= 0 && requestedEnd > start)
    // Preorder source coordinates make all descendants a contiguous range.
    // Only the predecessor's parent chain can start before this range and still
    // overlap it. Bound both sets before hydrating any node/attribute payload.
    val selection = """
        WITH RECURSIVE predecessor AS (
            SELECT ordinal, parent, end_cp FROM html_nodes
            WHERE fragment_ordinal = ?1 AND start_cp < ?2 ORDER BY start_cp DESC LIMIT 1
        ), ancestors(ordinal, parent, end_cp) AS (
            SELECT ordinal, parent, end_cp FROM predecessor
            UNION ALL
            SELECT n.ordinal, n.parent, n.end_cp FROM html_nodes n JOIN ancestors a ON n.ordinal = a.parent
            WHERE n.fragment_ordinal = ?1 LIMIT ${OFFLINE_READING_MAX_UNIT_DOM_NODES}
        ), descendants AS (
            SELECT ordinal FROM html_nodes
            WHERE fragment_ordinal = ?1 AND start_cp >= ?2 AND start_cp < ?3
            LIMIT ${OFFLINE_READING_MAX_UNIT_DOM_NODES}
        ), selected AS (
            SELECT ordinal FROM descendants UNION ALL SELECT ordinal FROM ancestors WHERE end_cp > ?2
        )
    """.trimIndent()
    var end = requestedEnd
    var arguments = arrayOf(fragment.toString(), start.toString(), end.toString())
    database.rawQuery(selection + """
        SELECT count(*), max(CASE WHEN name IN ('svg', 'math', 'picture', 'audio', 'video', 'iframe', 'object') THEN end_cp END),
               (SELECT count(*) FROM ancestors)
        FROM selected JOIN html_nodes n ON n.fragment_ordinal = ?1 AND n.ordinal = selected.ordinal
    """, arguments).use {
        require(it.moveToFirst())
        if (it.getLong(0) > OFFLINE_READING_MAX_UNIT_DOM_NODES - 2 || it.getLong(2) == OFFLINE_READING_MAX_UNIT_DOM_NODES.toLong()) return null
        end = maxOf(end, if (it.isNull(1)) 0 else it.getLong(1))
    }
    if (end - start > OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) return null
    arguments = arrayOf(fragment.toString(), start.toString(), end.toString())
    database.rawQuery(selection + """
        SELECT count(*), coalesce(sum(length(attributes_json)), 0)
        FROM selected JOIN html_nodes n ON n.fragment_ordinal = ?1 AND n.ordinal = selected.ordinal
    """, arguments).use {
        require(it.moveToFirst())
        if (it.getLong(0) > OFFLINE_READING_MAX_UNIT_DOM_NODES - 2 ||
            it.getLong(1) + end - start > OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES
        ) return null
    }
    val listNumbers = mutableMapOf<Long, String>()
    database.rawQuery(selection + """
        SELECT l.node, l.number FROM selected JOIN html_list_numbers l
        ON l.fragment_ordinal = ?1 AND l.node = selected.ordinal ORDER BY l.node
    """, arguments).use {
        while (it.moveToNext()) listNumbers.putIfAbsent(it.getLong(0), it.getString(1))
    }
    val nodes = JSONArray()
    val sourceStarts = mutableListOf<Long>()
    val sourceEnds = mutableListOf<Long>()
    val sourceNodes = mutableListOf<Long>()
    val opened = mutableListOf<Boolean>()
    val closed = mutableListOf<Boolean>()
    val parents = mutableMapOf<Long, Int>()
    database.rawQuery(
        selection + "SELECT n.ordinal, n.parent, kind, namespace, name, attributes_json, start_cp, n.end_cp FROM selected JOIN html_nodes n ON n.fragment_ordinal = ?1 AND n.ordinal = selected.ordinal ORDER BY n.ordinal",
        arguments,
    ).use { source ->
        while (source.moveToNext()) {
            val id = source.getLong(0)
            val parent = if (source.isNull(1)) JSONObject.NULL else parents.getValue(source.getLong(1))
            val node = JSONObject().put("kind", source.getString(2)).put("parent", parent)
            if (source.getString(2) == "Text") {
                val text = StringBuilder()
                database.rawQuery(
                    "SELECT text, start_cp, end_cp FROM html_text WHERE fragment_ordinal = ?1 AND node = ?2 AND start_cp >= (SELECT start_cp FROM html_text WHERE fragment_ordinal = ?1 AND node = ?2 AND start_cp <= ?3 ORDER BY start_cp DESC LIMIT 1) AND start_cp < ?4 ORDER BY start_cp",
                    arrayOf(fragment.toString(), id.toString(), maxOf(start, source.getLong(6)).toString(), end.toString()),
                ).use { parts ->
                    while (parts.moveToNext()) {
                        val value = parts.getString(0)
                        val first = maxOf(start - parts.getLong(1), 0).toInt()
                        val last = (minOf(end, parts.getLong(2)) - parts.getLong(1)).toInt()
                        text.append(value, value.offsetByCodePoints(0, first), value.offsetByCodePoints(0, last))
                    }
                }
                require(text.isNotEmpty())
                node.put("text", text.toString())
            } else {
                val attributes = JSONArray(source.getString(5))
                val name = source.getString(4)
                if (start > source.getLong(6)) {
                    for (index in attributes.length() - 1 downTo 0) {
                        val attribute = attributes.getJSONObject(index)
                        if (attribute.isNull("namespace") && attribute.getString("name") in setOf("id", "name", "data-nexus-document-embed-id")) attributes.remove(index)
                    }
                    if (name == "li") attributes.put(JSONObject().put("namespace", JSONObject.NULL).put("name", "data-nexus-continuation").put("value", "list-item"))
                }
                if (source.getString(3) == "html" && name == "li") {
                    val number = listNumbers[id]
                    if (number != null) {
                        for (index in attributes.length() - 1 downTo 0) {
                            val attribute = attributes.getJSONObject(index)
                            if (attribute.isNull("namespace") && attribute.getString("name") == "value") attributes.remove(index)
                        }
                        attributes.put(JSONObject().put("namespace", JSONObject.NULL).put("name", "value").put("value", number))
                    }
                }
                node.put("namespace", source.getString(3)).put("name", name).put("attributes", attributes)
                parents[id] = nodes.length()
            }
            nodes.put(node)
            sourceStarts += maxOf(start, source.getLong(6))
            sourceEnds += minOf(end, source.getLong(7))
            sourceNodes += id
            opened += source.getLong(6) >= start
            closed += source.getLong(7) <= end
        }
    }
    if (nodes.toString().toByteArray().size > OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) return null
    return LegacyReaderCrop(end, nodes, sourceStarts.toLongArray(), sourceEnds.toLongArray(), sourceNodes.toLongArray(), opened.toBooleanArray(), closed.toBooleanArray())
}
