package app.nexus.android.authored

import android.content.Context
import android.util.Base64
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One serialized bundled-SQLite connection per bound account. Kotlin owns SQL
 * transactions, never CRDT merging. Every projection accompanies merged states
 * from the signed shared kernel. FULL commits precede all saved receipts.
 * Scope pages retry keyed staging upserts and durable cursors; complete activation
 * and immediate revocation advance the observable revision without authored writes.
 * Derived normalization may restart only an unfinished interval's stored raw rows.
 * Its final output transaction proves exact contiguous coverage before marking
 * completion; a peer reset returns ordinary retry rather than a sync failure.
 * Pages compare their requested durable cursor; effective withdrawal discards
 * staging and the final read's store revision fences atomic publication. */
internal class AuthoredStore(private val context: Context, val account: UUID) {
    private val queries = JSONObject(context.assets.open("app/authored-queries.json").bufferedReader().use { it.readText() })
    private val connection: SQLiteConnection
    init {
        val directory = context.filesDir.resolve("authored").also { check(it.exists() || it.mkdirs()) }
        connection = BundledSQLiteDriver().open(directory.resolve("$account.sqlite3").path)
        val schema = JSONArray(context.assets.open("app/authored-schema.json").bufferedReader().use { it.readText() })
        for (index in 0 until schema.length()) run(schema.getString(index))
        run("CREATE VIRTUAL TABLE temp.authored_fts_probe USING fts5(text)")
        run("DROP TABLE temp.authored_fts_probe")
        run("INSERT OR IGNORE INTO replica_state VALUES(1,?,?,0,0,0,0,1,0)", account.toString(), UUID.randomUUID().toString())
        check(replica().getString("account_id") == account.toString())
    }
    private fun run(sql: String, vararg values: Any?) { rows(sql, *values) }
    private fun rows(sql: String, vararg values: Any?): JSONArray {
        connection.prepare(sql).use { statement ->
            values.forEachIndexed { index, value -> when (value) {
                null, JSONObject.NULL -> statement.bindNull(index + 1)
                is ByteArray -> statement.bindBlob(index + 1, value)
                is Long -> statement.bindLong(index + 1, value)
                is Int -> statement.bindLong(index + 1, value.toLong())
                is Boolean -> statement.bindLong(index + 1, if (value) 1 else 0)
                else -> statement.bindText(index + 1, value.toString())
            } }
            val result = JSONArray()
            while (statement.step()) {
                val row = JSONObject()
                for (index in 0 until statement.getColumnCount()) {
                    val name = statement.getColumnName(index)
                    row.put(name, when {
                        statement.isNull(index) -> JSONObject.NULL
                        name == "merge_bytes" -> Base64.encodeToString(statement.getBlob(index), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                        else -> statement.getText(index)
                    })
                }
                result.put(row)
            }
            return result
        }
    }
    private fun <T> transaction(work: () -> T): T {
        run("BEGIN IMMEDIATE")
        try { val result = work(); run("COMMIT"); return result }
        catch (error: Throwable) { run("ROLLBACK"); throw error }
    }
    fun replica(): JSONObject {
        val row = rows("SELECT * FROM replica_state WHERE singleton=1").getJSONObject(0)
        row.remove("singleton")
        row.put("format_revision", row.getString("format_revision").toInt())
        row.put("provisioning_complete", row.getString("provisioning_complete") == "1")
        return row
    }
    fun readSnapshot(selection: JSONObject): JSONObject = JSONObject().put("replica", replica()).put("states", states(selection))
    fun states(selection: JSONObject): JSONObject {
        val result = JSONObject()
        for ((table, key, selector) in listOf(Triple("resources", "ref", "refs"), Triple("links", "link_id", "link_ids"), Triple("passages", "anchor_id", "anchor_ids"), Triple("source_stubs", "source_ref", "source_refs"))) {
            val ids = selection.optJSONArray(selector) ?: JSONArray()
            require(ids.length() <= 1000)
            val values = Array(ids.length()) { ids.getString(it) }
            val matches = if (ids.length() == 0) JSONArray() else rows("SELECT state_json${if (table == "resources") ",merge_bytes" else ""} FROM $table WHERE $key IN (${values.joinToString(",") { "?" }})", *values)
            val decoded = JSONArray()
            for (index in 0 until matches.length()) {
                val match = matches.getJSONObject(index)
                val state = JSONObject(match.getString("state_json"))
                if (table == "resources" && state.getString("kind") != "highlight") state.put(if (state.getString("kind") == "note") "body_state" else "title_state", match.getString("merge_bytes"))
                decoded.put(state)
            }
            result.put(table, decoded)
        }
        return result
    }
    private fun write(states: JSONObject) {
        val resources = states.getJSONArray("resources")
        val projections = states.getJSONArray("projections")
        val byRef = (0 until projections.length()).associate { projections.getJSONObject(it).let { row -> row.getString("ref") to row } }
        for (index in 0 until resources.length()) {
            val resource = JSONObject(resources.getJSONObject(index).toString())
            val ref = resource.getString("ref")
            val projection = byRef[ref] ?: error("missing authored projection")
            val encoded = when (resource.getString("kind")) { "note" -> resource.remove("body_state") as String; "page" -> resource.remove("title_state") as String; else -> null }
            val bytes = encoded?.let { Base64.decode(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
            run("INSERT INTO resources(ref,kind,state_json,merge_bytes,projection_json,visible,body_text,title,local_date,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET state_json=excluded.state_json,merge_bytes=excluded.merge_bytes,projection_json=excluded.projection_json,visible=excluded.visible,body_text=excluded.body_text,title=excluded.title,local_date=excluded.local_date,source_ref=excluded.source_ref", ref, resource.getString("kind"), resource.toString(), bytes, projection.toString(), projection.getBoolean("visible"), projection.opt("body_text"), projection.opt("title"), projection.opt("local_date"), projection.opt("source_ref"))
            run("DELETE FROM reference_index WHERE owner_ref=?", ref)
            val refs = projection.getJSONArray("embedded_refs")
            for (at in 0 until refs.length()) run("INSERT OR IGNORE INTO reference_index VALUES(?,?)", ref, refs.getString(at))
        }
        val links = states.getJSONArray("links")
        for (index in 0 until links.length()) {
            val link = links.getJSONObject(index)
            val added = link.getJSONObject("add_vv"); val removed = link.getJSONObject("remove_vv")
            val visible = added.keys().asSequence().any { added.getString(it).toLong() > removed.optString(it, "0").toLong() }
            run("INSERT INTO links VALUES(?,?,?,?,?,?,?) ON CONFLICT(link_id) DO UPDATE SET position_a=excluded.position_a,position_b=excluded.position_b,visible=excluded.visible,state_json=excluded.state_json", link.getString("link_id"), link.getString("endpoint_a"), link.getString("endpoint_b"), link.optJSONObject("position_a")?.getString("value"), link.optJSONObject("position_b")?.getString("value"), visible, link.toString())
        }
        val passages = states.getJSONArray("passages")
        for (index in 0 until passages.length()) {
            val state = passages.getJSONObject(index)
            val key = JSONArray().put(state.getString("source_ref")).put(state.getString("normalized_exact")).put(state.getString("prefix")).put(state.getString("suffix"))
            run("INSERT INTO passages VALUES(?,?,?,?) ON CONFLICT(anchor_id) DO UPDATE SET state_json=excluded.state_json", state.getString("anchor_id"), state.getString("source_ref"), key.toString(), state.toString())
        }
        val stubs = states.getJSONArray("source_stubs")
        for (index in 0 until stubs.length()) { val state = stubs.getJSONObject(index); run("INSERT INTO source_stubs VALUES(?,?) ON CONFLICT(source_ref) DO UPDATE SET state_json=excluded.state_json", state.getString("source_ref"), state.toString()) }
        val indexed = mutableSetOf<String>()
        for (index in 0 until resources.length()) indexed.add(resources.getJSONObject(index).getString("ref"))
        for (index in 0 until passages.length()) indexed.add("passage_anchor:${passages.getJSONObject(index).getString("anchor_id")}")
        for (index in 0 until stubs.length()) indexed.add(stubs.getJSONObject(index).getString("source_ref"))
        val searchSql = queries.getString("search_index")
        val removeSql = queries.getString("search_remove")
        for (ref in indexed) { run(removeSql, ref); run(searchSql, ref) }
    }
    fun commit(frame: JSONObject): JSONObject = transaction {
        val current = replica(); val change = frame.getJSONObject("change")
        val sequence = change.getString("command_seq").toLong()
        require(frame.getString("replica_id") == current.getString("replica_id"))
        if (sequence <= current.getString("command_seq").toLong()) return@transaction JSONObject().put("kind", "committed").put("command_seq", sequence.toString()).put("store_revision", current.getString("store_revision"))
        require(sequence == current.getString("command_seq").toLong() + 1)
        if (frame.getString("expected_store_revision") != current.getString("store_revision")) return@transaction JSONObject().put("kind", "stale").put("store_revision", current.getString("store_revision")).put("states", states(selection(change)))
        val source = change.toString(); val byteCount = source.toByteArray().size
        require(byteCount <= 2 * 1024 * 1024)
        write(frame.getJSONObject("states"))
        run("INSERT INTO pending_changes VALUES(?,?,?)", sequence, source, byteCount)
        val revision = current.getString("store_revision").toLong() + 1
        run("UPDATE replica_state SET command_seq=?,store_revision=?,lamport=MAX(lamport,?) WHERE singleton=1", sequence, revision, change.getString("lamport").toLong())
        JSONObject().put("kind", "committed").put("command_seq", sequence.toString()).put("store_revision", revision.toString())
    }
    fun uploaded(sequence: String): Boolean {
        require(sequence.toLong() <= replica().getString("command_seq").toLong())
        return rows("SELECT command_seq FROM pending_changes WHERE command_seq=?", sequence.toLong()).length() == 0
    }
    fun pending(): JSONArray {
        val records = rows("SELECT change_json,byte_length FROM pending_changes ORDER BY command_seq LIMIT 100")
        val changes = JSONArray(); var bytes = 256
        for (index in 0 until records.length()) { val row = records.getJSONObject(index); val size = row.getString("byte_length").toInt(); if (bytes + size > 3 * 1024 * 1024 - 1024) break; bytes += size + 1; changes.put(JSONObject(row.getString("change_json"))) }
        return changes
    }
    fun acknowledge(sequence: String) = transaction {
        require(sequence.toLong() <= replica().getString("command_seq").toLong())
        run("DELETE FROM pending_changes WHERE command_seq<=?", sequence.toLong())
    }
    fun applyRemote(frame: JSONObject): JSONObject = transaction {
        val current = replica()
        if (frame.getString("expected_store_revision") != current.getString("store_revision")) return@transaction JSONObject().put("kind", "stale")
        val entries = frame.getJSONArray("changes"); var cursor = current.getString("server_cursor").toLong(); var lamport = current.getString("lamport").toLong()
        for (index in 0 until entries.length()) { val entry = entries.getJSONObject(index); val next = entry.getString("server_seq").toLong(); require(next == cursor + 1); cursor = next; lamport = maxOf(lamport, entry.getJSONObject("change").getString("lamport").toLong()) }
        require(cursor.toString() == frame.getString("next_cursor"))
        write(frame.getJSONObject("states"))
        run("UPDATE replica_state SET server_cursor=?,store_revision=store_revision+?,lamport=? WHERE singleton=1", cursor, entries.length(), lamport)
        replica()
    }
    fun resetProvisioning() = transaction { for (table in listOf("resources", "links", "passages", "source_stubs", "reference_index", "search_documents")) run("DELETE FROM $table") }
    fun stage(states: JSONObject) = transaction { require(!replica().getBoolean("provisioning_complete")); write(states) }
    fun finishProvisioning(cursor: String, counts: JSONObject, lamport: String) = transaction {
        for (table in listOf("resources", "links", "passages", "source_stubs")) require(rows("SELECT COUNT(*) AS count FROM $table").getJSONObject(0).getString("count").toLong() == counts.getLong(table))
        run("UPDATE replica_state SET provisioning_complete=1,server_cursor=?,store_revision=store_revision+1,lamport=MAX(lamport,?) WHERE singleton=1", cursor.toLong(), lamport.toLong())
    }
    private fun scopeSql(name: String): String = queries.getString(name)
    fun scopeProgress(): JSONObject {
        val state = rows(scopeSql("scope_state")).getJSONObject(0)
        val pending = if (state.getInt("metadata_complete") == 1) rows(scopeSql("scope_pending_reading")) else JSONArray()
        return state.put("metadata_complete", state.getInt("metadata_complete") == 1)
            .put("reading_ref", if (pending.length() > 0) pending.getJSONObject(0).getString("reading_ref") else JSONObject.NULL)
            .put("text_cursor", if (pending.length() > 0) pending.getJSONObject(0).opt("cursor") else JSONObject.NULL)
            .put("raw_complete", pending.length() > 0 && pending.getJSONObject(0).getInt("raw_complete") == 1)
    }
    fun scopeRefs(after: String?): JSONObject {
        val records = rows(scopeSql("scope_active_refs"), after, after)
        return JSONObject().put("refs", JSONArray().apply { for (index in 0 until records.length()) put(records.getJSONObject(index).getString("scope_ref")) })
    }
    fun scopeRepairRefs(refs: JSONArray): JSONObject {
        val records = rows(scopeSql("scope_repair_refs"), refs.toString())
        return JSONObject().put("refs", JSONArray().apply { for (index in 0 until records.length()) put(records.getJSONObject(index).getString("scope_ref")) })
    }
    private fun pruneScope() {
        for (table in listOf("scope_facts", "scope_readings", "scope_intervals", "scope_text", "scope_normalized", "scope_normalized_complete", "scope_text_complete", "scope_text_progress")) run(scopeSql("${table}_prune"))
    }
    fun scopeReset(revision: String, repair: Boolean) = transaction {
        val state = scopeProgress()
        if (state.optString("staging_revision") != revision) {
            pruneScope()
            if (state.optString("active_revision") == revision && !repair) run(scopeSql("scope_discard")) else run(scopeSql("scope_begin"), revision)
        }
    }
    fun scopeRevoke(refs: JSONArray): Boolean = transaction {
        if (refs.length() == 0) return@transaction false
        val input = refs.toString()
        if (rows(scopeSql("scope_revoke_effective"), input).getJSONObject(0).getInt("effective") != 1) return@transaction false
        for (name in listOf("scope_revoke", "scope_revoke_text", "scope_revoke_complete", "scope_revoke_progress", "scope_revoke_intervals", "scope_revoke_normalized", "scope_revoke_normalized_complete")) run(scopeSql(name), input)
        run(scopeSql("scope_discard")); run(scopeSql("scope_changed"))
        true
    }
    fun scopeMetadata(page: JSONObject, requestedCursor: String?): Boolean = transaction {
        val revision = page.getString("revision")
        val state = scopeProgress()
        val cursor = if (state.isNull("metadata_cursor")) null else state.getString("metadata_cursor")
        if (state.optString("staging_revision") != revision || state.getBoolean("metadata_complete") || cursor != requestedCursor) return@transaction false
        val input = page.getJSONArray("records").toString()
        for (name in listOf("scope_metadata_facts", "scope_metadata_readings", "scope_metadata_intervals")) run(scopeSql(name), revision, input)
        run(scopeSql("scope_metadata_cursor"), page.opt("next_cursor"), page.isNull("next_cursor"), revision)
        true
    }
    fun scopeText(page: JSONObject, requestedCursor: String?): Boolean = transaction {
        val revision = page.getString("revision"); val reading = page.getString("reading_ref")
        val state = scopeProgress()
        val cursor = if (state.isNull("text_cursor")) null else state.getString("text_cursor")
        if (state.optString("staging_revision") != revision || !state.getBoolean("metadata_complete") || state.optString("reading_ref") != reading || state.getBoolean("raw_complete") || cursor != requestedCursor) return@transaction false
        run(scopeSql("scope_text_chunks"), revision, reading, page.getJSONArray("chunks").toString())
        run(scopeSql("scope_text_cursor"), revision, reading, page.opt("next_cursor"), page.isNull("next_cursor"))
        true
    }
    fun scopeNormalizationNext(revision: String, reading: String): JSONObject {
        val records = rows(scopeSql("scope_normalization_next"), revision, reading)
        return JSONObject().put("interval", if (records.length() == 0) JSONObject.NULL else records.getJSONObject(0).apply {
            put("start_offset", getLong("start_offset")); put("end_offset", getLong("end_offset"))
        })
    }
    fun scopeNormalizationRead(request: JSONObject): JSONObject {
        val after = request.opt("after")
        val records = rows(scopeSql("scope_normalization_raw"), request.getString("revision"), request.getString("reading_ref"), request.getString("interval_key"), after, after)
        return JSONObject().put("chunk", if (records.length() == 0) JSONObject.NULL else records.getJSONObject(0).apply { put("start_offset", getLong("start_offset")) })
    }
    fun scopeNormalizationObservation(request: JSONObject): JSONObject = transaction {
        JSONObject().put("progress", scopeProgress())
            .put("interval", scopeNormalizationNext(request.getString("revision"), request.getString("reading_ref")).get("interval"))
            .put("chunk", scopeNormalizationRead(request).get("chunk"))
    }
    fun scopeNormalizationReset(request: JSONObject) = transaction {
        if (scopeProgress().optString("staging_revision") == request.getString("revision"))
            run(scopeSql("scope_normalization_reset"), request.getString("revision"), request.getString("reading_ref"), request.getString("interval_key"))
    }
    fun scopeNormalized(request: JSONObject): Boolean = transaction {
        val revision = request.getString("revision"); val reading = request.getString("reading_ref"); val interval = request.getString("interval_key")
        val state = scopeProgress()
        if (state.optString("staging_revision") != revision) return@transaction state.optString("active_revision") == revision
        if (rows(scopeSql("scope_normalized_is_complete"), revision, reading, interval).length() > 0) return@transaction true
        run(scopeSql("scope_normalized_chunks"), revision, reading, interval, request.getJSONArray("chunks").toString())
        if (!request.isNull("normalized_length")) {
            val coverage = rows(scopeSql("scope_normalized_coverage"), revision, reading, interval, request.getLong("normalized_length"))
            if (coverage.getJSONObject(0).getInt("accepted") != 1) return@transaction false
            run(scopeSql("scope_normalized_done"), revision, reading, interval)
        }
        true
    }
    fun scopeTextComplete(revision: String, reading: String): Boolean = transaction {
        val state = scopeProgress()
        if (state.optString("staging_revision") != revision || state.optString("reading_ref") != reading || !state.getBoolean("raw_complete") || !scopeNormalizationNext(revision, reading).isNull("interval")) return@transaction false
        run(scopeSql("scope_text_done"), revision, reading)
        true
    }
    fun scopePublish(revision: String, expectedStoreRevision: String): Boolean = transaction {
        if (replica().getString("store_revision") != expectedStoreRevision) return@transaction false
        val state = scopeProgress()
        if (state.optString("active_revision") == revision && state.isNull("staging_revision")) return@transaction true
        if (state.optString("staging_revision") != revision || !state.getBoolean("metadata_complete") || !state.isNull("reading_ref")) return@transaction false
        run(scopeSql("scope_publish")); run(scopeSql("scope_readmitted")); pruneScope(); run(scopeSql("scope_changed"))
        true
    }
    fun searchRead(params: JSONArray, planKey: String): JSONObject {
        require(replica().getBoolean("provisioning_complete"))
        require(planKey.startsWith("search_read:") && queries.has(planKey) && params.length() <= 100)
        return JSONObject().put("rows", rows(queries.getString(planKey), *Array(params.length()) { params.opt(it) }))
    }
    fun searchMatch(text: String, expression: String): JSONObject {
        run(queries.getString("search_match_create")); run(queries.getString("search_match_clear"))
        return try {
            run(queries.getString("search_match_insert"), text)
            JSONObject().put("matched", rows(queries.getString("search_match_read"), expression).length() > 0)
        } finally { run(queries.getString("search_match_clear")) }
    }
    fun query(query: JSONObject, params: JSONArray, planKey: String): JSONObject {
        require(replica().getBoolean("provisioning_complete"))
        val kind = query.getString("kind")
        require(planKey.startsWith("$kind:") && queries.has(planKey) && params.length() <= 100)
        val sql = queries.getString(planKey)
        val records = rows(sql, *Array(params.length()) { params.opt(it) })
        if (kind == "outline_children") {
            val children = JSONArray()
            for (index in 0 until records.length()) {
                val row = records.getJSONObject(index)
                children.put(if (row.isNull("child_available")) JSONObject.NULL else row.getInt("child_available") == 1)
            }
            return JSONObject().put("store_revision", replica().getString("store_revision")).put("rows", JSONArray())
                .put("next_cursor", JSONObject.NULL).put("previous_cursor", JSONObject.NULL)
                .put("binding_id", JSONObject.NULL).put("positions", JSONArray()).put("children", children).put("scope_available", true)
        }
        if (kind == "binding") return JSONObject().put("store_revision", replica().getString("store_revision")).put("rows", JSONArray()).put("children", JSONArray()).put("next_cursor", JSONObject.NULL).put("previous_cursor", JSONObject.NULL).put("positions", JSONArray()).put("binding_id", if (records.length() == 0) JSONObject.NULL else records.getJSONObject(0).getString("binding_id")).put("scope_available", true)
        if (kind == "positions") {
            val positions = JSONArray()
            for (index in 0 until records.length()) positions.put(JSONObject(records.getJSONObject(index).getString("position_json")))
            val at = query.getJSONObject("at")
            val cursor: Any = if (at.getString("kind") == "tie" && positions.length() == minOf(100, at.getInt("limit")) && positions.length() > 0) records.getJSONObject(records.length() - 1).getString("cursor_json") else JSONObject.NULL
            return JSONObject().put("store_revision", replica().getString("store_revision")).put("rows", JSONArray()).put("children", JSONArray()).put("positions", positions).put("next_cursor", cursor).put("previous_cursor", JSONObject.NULL).put("binding_id", JSONObject.NULL).put("scope_available", true)
        }
        val output = JSONArray()
        for (index in 0 until records.length()) {
            val row = records.getJSONObject(index)
            output.put(JSONObject().put("resource", JSONObject(row.getString("projection_json"))).put("link", if (row.isNull("link_json")) JSONObject.NULL else JSONObject(row.getString("link_json"))).put("match_text", JSONObject.NULL))
        }
        var cursor: Any = JSONObject.NULL
        if (query.has("limit") && output.length() == minOf(100, query.getInt("limit")) && output.length() > 0) {
            val last = output.getJSONObject(output.length() - 1)
            val record = records.getJSONObject(records.length() - 1)
            cursor = if (record.has("cursor_json")) record.getString("cursor_json") else last.getJSONObject("resource").getString("ref")
        }
        return JSONObject().put("store_revision", replica().getString("store_revision")).put("rows", output).put("children", JSONArray()).put("next_cursor", cursor).put("previous_cursor", if (records.length() > 0 && records.getJSONObject(0).has("previous_cursor")) records.getJSONObject(0).opt("previous_cursor") else JSONObject.NULL).put("positions", JSONArray()).put("binding_id", JSONObject.NULL).put("scope_available", true)
    }
    fun close() { connection.close() }
    companion object {
        fun selection(change: JSONObject): JSONObject = JSONObject().apply {
            for ((table, key, selector) in listOf(Triple("resources", "ref", "refs"), Triple("links", "link_id", "link_ids"), Triple("passages", "anchor_id", "anchor_ids"), Triple("source_stubs", "source_ref", "source_refs"))) {
                val values = change.getJSONArray(table); put(selector, JSONArray().apply { for (index in 0 until values.length()) put(values.getJSONObject(index).getString(key)) })
            }
        }
    }
}
