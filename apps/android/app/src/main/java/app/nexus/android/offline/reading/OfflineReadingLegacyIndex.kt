package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import java.io.File
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Staging only. The caller copies declared assets and owns manifest publication. */
internal fun stageLegacyReaderIndex(
    directory: File,
    staging: File,
    manifest: OfflineReadingManifest,
    durability: OfflineReadingDurability,
): List<OfflineReadingManifestEntry> {
    require(manifest.packageSchemaVersion == 1)
    val publication = File(staging, "publication").apply { require(mkdir() || isDirectory) }
    val entries = mutableListOf<OfflineReadingManifestEntry>()
    fun record(entry: OfflineReadingManifestEntry): OfflineReadingManifestEntry {
        require(entries.size < OFFLINE_READING_MAX_ENTRIES) { "converted publication has too many members" }
        entries += entry
        return entry
    }
    fun write(key: String, body: JSONObject, limit: Long): OfflineReadingManifestEntry {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= limit) { "converted publication member exceeds capacity" }
        val file = File(publication, key)
        require(file.parentFile!!.mkdir() || file.parentFile!!.isDirectory)
        file.outputStream().use { it.write(bytes); it.fd.sync() }
        return record(OfflineReadingManifestEntry(key, "application/json", bytes.size.toLong(),
            MessageDigest.getInstance("SHA-256").digest(bytes).toHex()))
    }
    fun reference(entry: OfflineReadingManifestEntry): JSONObject = JSONObject()
        .put("key", entry.path).put("bytes", entry.sizeBytes).put("sha256", entry.sha256)
    val descriptor = JSONObject().put("media_id", manifest.mediaId.toString())
        .put("reader_generation", manifest.readerGeneration).put("title", manifest.title)
        .put("reader_contract_version", 1)
    SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
        database.rawQuery("SELECT source_sha256 FROM complete", null).use {
            require(it.moveToFirst() && it.getString(0) == manifest.entries.single { entry -> entry.path == "reader.json" }.sha256)
        }
        if (manifest.mediaKind == OfflineReadingMediaKind.Pdf) {
            val sourcePath = database.rawQuery("SELECT document_path FROM document", null).use { require(it.moveToFirst()); it.getString(0) }
            val original = manifest.entries.single { it.path == sourcePath }
            require(original.mediaType == "application/pdf")
            database.execSQL("CREATE TABLE IF NOT EXISTS pdf_metadata (page_count INTEGER NOT NULL)")
            val count = database.rawQuery("SELECT page_count FROM pdf_metadata", null).use { if (it.moveToFirst()) it.getInt(0) else null }
                ?: ParcelFileDescriptor.open(File(directory, sourcePath), ParcelFileDescriptor.MODE_READ_ONLY).use { file ->
                    PdfRenderer(file).use { renderer -> renderer.pageCount.also { pages ->
                        require(pages > 0)
                        database.execSQL("INSERT INTO pdf_metadata VALUES(?)", arrayOf(pages))
                    } }
                }
            require(count > 0)
            descriptor.put("kind", "pdf").put("page_count", count)
                .put("document_asset_ref", reference(record(original.copy(path = "assets/document.pdf"))))
        } else {
            database.rawQuery("SELECT 1 FROM fragments LEFT JOIN units_complete ON fragments.ordinal = units_complete.fragment_ordinal WHERE units_complete.fragment_ordinal IS NULL LIMIT 1", null).use { require(!it.moveToFirst()) }
            val fields = listOf("units", "sections", "toc", "landmarks", "page_list", "table_metadata", "anchors")
            fun blank() = JSONObject().also { page -> fields.forEach { page.put(it, JSONArray()) } }.put("next_ref", JSONObject.NULL)
            // Pages are accumulated forward and linked backward. Only one bounded
            // page is in memory; staged files are never visible to a reader.
            class Pages(val prefix: String) {
                var page = blank()
                var count = 0
                val maximumNext = JSONObject().put("key", "index/table-metadata-${OFFLINE_READING_MAX_ENTRIES}.json")
                    .put("bytes", OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES).put("sha256", "f".repeat(64))
                val baseBytes = blank().put("next_ref", maximumNext).toString().toByteArray(Charsets.UTF_8).size
                var pageBytes = baseBytes
                fun flush() {
                    require(count < OFFLINE_READING_MAX_ENTRIES)
                    val file = File(staging, "$prefix$count.index")
                    file.outputStream().use { output -> output.write(page.put("next_ref", JSONObject.NULL).toString().toByteArray(Charsets.UTF_8)); output.fd.sync() }
                    count++
                    page = blank()
                    pageBytes = baseBytes
                }
                fun add(field: String, row: JSONObject) {
                    val rowBytes = row.toString().toByteArray(Charsets.UTF_8).size
                    var rows = page.getJSONArray(field)
                    var added = rowBytes + if (rows.length() == 0) 0 else 1
                    if (pageBytes + added > OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) {
                        require(fields.any { page.getJSONArray(it).length() > 0 }) { "one converted index row exceeds capacity" }
                        flush()
                        rows = page.getJSONArray(field)
                        added = rowBytes
                        require(pageBytes + added <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
                    }
                    rows.put(row)
                    pageBytes += added
                }
                fun finish(): JSONObject? {
                    if (fields.any { page.getJSONArray(it).length() > 0 }) flush()
                    var next: JSONObject? = null
                    for (number in count - 1 downTo 0) {
                        val file = File(staging, "$prefix$number.index")
                        require(file.length() <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
                        val body = JSONObject(file.readText(Charsets.UTF_8)).put("next_ref", next ?: JSONObject.NULL)
                        next = reference(write("index/$prefix$number.json", body, OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES))
                    }
                    return next
                }
            }
            val index = Pages("")
            val contents = Pages("contents-")
            val tables = Pages("table-metadata-")
            var first: JSONObject? = null
            var unitCount = 0
            database.rawQuery("SELECT u.member_key, u.bytes, u.sha256, u.ordinal, f.fragment_id, f.fragment_idx, u.start_cp, u.end_cp FROM publication_units u JOIN fragments f ON f.ordinal = u.fragment_ordinal ORDER BY u.ordinal", null).use { units ->
                while (units.moveToNext()) {
                    require(units.getLong(3) == unitCount.toLong())
                    val member = reference(record(OfflineReadingManifestEntry(units.getString(0), "application/json", units.getLong(1), units.getString(2))))
                    if (first == null) first = member
                    index.add("units", JSONObject().put("member", member).put("ordinal", unitCount++)
                        .put("fragment_id", units.getString(4)).put("fragment_idx", units.getLong(5))
                        .put("start_cp", units.getLong(6)).put("end_cp", units.getLong(7)))
                }
            }
            require(unitCount > 0)
            val hasNavigation = database.rawQuery("SELECT 1 FROM navigation LIMIT 1", null).use { it.moveToFirst() }
            val epub = manifest.mediaKind == OfflineReadingMediaKind.Epub
            val sectionQuery = if (epub)
                "SELECT s.section_id, s.ordinal, s.fragment_id, f.fragment_idx, s.start_cp, s.end_cp, s.href_path, s.anchor_id, n.label FROM sections s JOIN fragments f ON f.fragment_id = s.fragment_id LEFT JOIN navigation n ON n.target_id = s.section_id ORDER BY s.ordinal"
            else "SELECT f.fragment_id, f.ordinal, f.fragment_id, f.fragment_idx, 0, f.canonical_length, NULL, NULL, n.label FROM fragments f LEFT JOIN navigation n ON n.target_id = f.fragment_id ORDER BY f.ordinal"
            database.rawQuery(sectionQuery, null).use { sections ->
                while (sections.moveToNext()) {
                    val id = sections.getString(0)
                    val fragmentId = sections.getString(2)
                    val start = sections.getLong(4)
                    val anchorKey = if (epub && !sections.isNull(7)) database.rawQuery(
                        "SELECT unit_key FROM publication_anchors WHERE href_path = ? AND anchor_id = ? AND offset_cp = ?",
                        arrayOf(sections.getString(6), sections.getString(7), start.toString()),
                    ).use { if (it.moveToFirst()) it.getString(0) else null } else null
                    val key = anchorKey ?: database.rawQuery("SELECT u.member_key FROM publication_units u JOIN fragments f ON f.ordinal = u.fragment_ordinal WHERE f.fragment_id = ? AND u.start_cp <= ? AND u.end_cp >= ? ORDER BY CASE WHEN u.start_cp = ? THEN 0 ELSE 1 END, u.ordinal ASC LIMIT 1",
                        arrayOf(fragmentId, start.toString(), start.toString(), start.toString())).use { require(it.moveToFirst()); it.getString(0) }
                    val section = JSONObject().put("section_id", id).put("unit_key", key)
                        .put("label", if (sections.isNull(8)) "Part ${sections.getLong(1) + 1}" else sections.getString(8))
                        .put("ordinal", sections.getLong(1)).put("fragment_id", fragmentId).put("fragment_idx", sections.getLong(3))
                        .put("level", JSONObject.NULL).put("depth", JSONObject.NULL)
                        .put("start_offset", start).put("end_offset", sections.getLong(5))
                        .put("href_path", if (sections.isNull(6)) JSONObject.NULL else sections.getString(6))
                        .put("href_fragment", if (sections.isNull(7)) JSONObject.NULL else sections.getString(7))
                        .put("anchor_id", if (sections.isNull(7)) JSONObject.NULL else sections.getString(7))
                    index.add("sections", section)
                    if (!hasNavigation) contents.add("sections", section)
                }
            }
            if (hasNavigation) database.rawQuery(if (epub)
                "SELECT n.target_id, n.label, n.ordinal, f.fragment_idx, s.href_path FROM navigation n JOIN sections s ON s.section_id = n.target_id JOIN fragments f ON f.fragment_id = s.fragment_id ORDER BY n.ordinal"
                else "SELECT n.target_id, n.label, n.ordinal, f.fragment_idx, NULL FROM navigation n JOIN fragments f ON f.fragment_id = n.target_id ORDER BY n.ordinal", null).use { navigation ->
                while (navigation.moveToNext()) contents.add("toc", JSONObject().put("id", navigation.getString(0))
                    .put("parent_id", JSONObject.NULL).put("label", navigation.getString(1)).put("ordinal", navigation.getLong(2))
                    .put("href", if (navigation.isNull(4)) JSONObject.NULL else navigation.getString(4))
                    .put("fragment_idx", navigation.getLong(3)).put("level", JSONObject.NULL).put("depth", 0)
                    .put("section_id", navigation.getString(0)))
            }
            if (epub) database.rawQuery("SELECT href_path, anchor_id, unit_key, offset_cp FROM publication_anchors ORDER BY href_path, anchor_id", null).use { anchors ->
                while (anchors.moveToNext()) index.add("anchors", JSONObject().put("href_path", anchors.getString(0))
                    .put("anchor_id", anchors.getString(1)).put("unit_key", anchors.getString(2)).put("offset_cp", anchors.getLong(3)))
            }
            val length = database.rawQuery("SELECT sum(canonical_length) FROM fragments", null).use { require(it.moveToFirst()); it.getLong(0) }
            appendLegacyTableMetadata(database) { tables.add("table_metadata", it) }
            descriptor.put("kind", if (epub) "epub" else "web_article").put("first_unit_ref", requireNotNull(first))
                .put("index_ref", requireNotNull(index.finish())).put("contents_ref", contents.finish() ?: JSONObject.NULL)
                .put("table_metadata_ref", tables.finish() ?: JSONObject.NULL)
                .put("unit_count", unitCount).put("canonical_length", length)
            manifest.entries.filter { it.path.startsWith("assets/") }.forEach(::record)
            durability.syncDirectory(File(publication, "index"))
        }
        write("descriptor.json", descriptor, OFFLINE_READING_MAX_DESCRIPTOR_BYTES)
        durability.syncDirectory(publication)
        durability.syncDirectory(staging)
    }
    // Package keys are restricted to ASCII; natural order is UTF-8 byte order.
    return entries.sortedBy { it.path }
}
