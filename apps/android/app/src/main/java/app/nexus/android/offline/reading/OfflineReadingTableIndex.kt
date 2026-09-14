package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteConstraintException
import android.database.sqlite.SQLiteDoneException
import java.io.File

// Explicit qualification input, not a released device profile.
internal const val OFFLINE_READING_TABLE_PREPARATION_CACHE_KIB = 1024
internal const val OFFLINE_READING_TABLE_INDEX_NAME = ".table-context.sqlite"

/** Complete member and cross-member validation, ready for atomic publication. */
internal data class PreparedOfflineReadingPackage(
    val source: VerifiedOfflineReadingMembers,
    val installedBytes: Long,
    val tableIndexSha256: String?,
)

/** Called only after installed member verification; format 2 attests all deferred joins. */
internal fun installedTableIndexIsReady(installed: OfflineReadingPackage, directory: File): Boolean {
    if (installed.packageSchemaVersion != 2) return false
    val manifestFile = File(directory, "manifest.json")
    require(manifestFile.length() <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
    val manifest = OfflineReadingManifestParser.parse(manifestFile.readBytes())
    val sourceBytes = Math.addExact(manifestFile.length(), manifest.entries.sumOf { it.sizeBytes })
    val indexBytes = installed.sizeBytes - sourceBytes
    val file = File(directory, OFFLINE_READING_TABLE_INDEX_NAME)
    val members = OfflineReadingPublicationMembers(directory, manifest)
    val descriptor = (members.json(members.declared.getValue("descriptor.json"),
        OFFLINE_READING_MAX_DESCRIPTOR_BYTES) as StrictJson.ObjectValue).fields
    val required = manifest.mediaKind == OfflineReadingMediaKind.Epub ||
        manifest.mediaKind != OfflineReadingMediaKind.Pdf && descriptor.getValue("table_metadata_ref") != StrictJson.NullValue
    if (!required) return installed.tableIndexSha256 == null && indexBytes == 0L && !file.exists()
    if (installed.tableIndexSha256 == null || indexBytes <= 0 || !file.isFile || file.length() != indexBytes ||
        file.sha256Hex() != installed.tableIndexSha256) return false
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
        if (db.version != 2) return false
        db.rawQuery("SELECT revision FROM identity", null).use {
            return it.moveToFirst() && it.getString(0) == installed.readerRevisionKey && !it.moveToNext()
        }
    }
}

/** Copy only attested members into the existing revision-replacement staging. */
internal fun stageRetainedReadingPackage(directory: File, staging: File): PreparedOfflineReadingPackage {
    require(staging.isDirectory)
    val manifestFile = File(directory, "manifest.json")
    require(manifestFile.length() <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
    val manifest = OfflineReadingManifestParser.parse(manifestFile.readBytes())
    require(manifest.packageSchemaVersion == 2)
    val candidate = File(staging, "publication")
    check(candidate.mkdir() || candidate.isDirectory)
    // Resume an interrupted attempt with the legacy stager's rule: a member already
    // staged at its manifest length and digest is done, so only the rest is copied.
    for (entry in manifest.entries) {
        val target = File(candidate, entry.path)
        if (target.isFile && target.length() == entry.sizeBytes && target.sha256Hex() == entry.sha256) continue
        var parent = candidate
        for (part in entry.path.split('/').dropLast(1)) {
            parent = File(parent, part)
            check(parent.mkdir() || parent.isDirectory)
        }
        File(directory, entry.path).inputStream().use { input ->
            target.outputStream().use { output -> input.copyTo(output); output.fd.sync() }
        }
        require(target.length() == entry.sizeBytes && target.sha256Hex() == entry.sha256)
    }
    // Delete only what this manifest does not declare: a partial member from an
    // interrupted attempt, and any index that attempt had already begun writing.
    val declared = manifest.entries.map { it.path }.toSet() + "manifest.json"
    candidate.walkTopDown().filter(File::isFile).forEach { file ->
        if (file.relativeTo(candidate).invariantSeparatorsPath !in declared) check(file.delete())
    }
    File(directory, "manifest.json").inputStream().use { input ->
        File(candidate, "manifest.json").outputStream().use { output -> input.copyTo(output); output.fd.sync() }
    }
    val sourceBytes = Math.addExact(File(candidate, "manifest.json").length(), manifest.entries.sumOf { it.sizeBytes })
    return prepareOfflineReadingPackage(VerifiedOfflineReadingMembers(manifest, candidate, sourceBytes))
}

internal fun prepareOfflineReadingPackage(source: VerifiedOfflineReadingMembers): PreparedOfflineReadingPackage {
    val manifest = source.manifest
    require(manifest.packageSchemaVersion == 2)
    val members = OfflineReadingPublicationMembers(source.extractedDirectory, manifest)
    val descriptor = (members.json(members.declared.getValue("descriptor.json"),
        OFFLINE_READING_MAX_DESCRIPTOR_BYTES) as StrictJson.ObjectValue).fields
    val first = if (manifest.mediaKind == OfflineReadingMediaKind.Pdf) StrictJson.NullValue
        else descriptor.getValue("table_metadata_ref")
    if (first == StrictJson.NullValue && manifest.mediaKind != OfflineReadingMediaKind.Epub)
        return PreparedOfflineReadingPackage(source, source.installedBytes, null)
    val file = File(source.extractedDirectory, OFFLINE_READING_TABLE_INDEX_NAME)
    writeTableIndex(file, manifest.readerRevisionKey, OFFLINE_READING_TABLE_PREPARATION_CACHE_KIB) { db ->
        // Ordinary disk tables, not TEMP: Android may keep temporary tables in memory.
        // Only the at-most-4,096 ordered member keys stay in the preparation heap.
        db.execSQL("""CREATE TABLE pending_anchors (
            href TEXT NOT NULL, id TEXT NOT NULL, unit_key TEXT NOT NULL,
            PRIMARY KEY(href, id)) WITHOUT ROWID""")
        val unitKeys = ArrayList<String>()
        db.compileStatement("INSERT INTO pending_anchors VALUES (?, ?, ?)").use { insert ->
            var next: StrictJson = descriptor.getValue("index_ref")
            while (next != StrictJson.NullValue) {
                val index = (members.json(members.member(next, "index/"),
                    OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) as StrictJson.ObjectValue).fields
                for (value in index.getValue("units").requireArray()) {
                    val position = (value as StrictJson.ObjectValue).fields
                    unitKeys += members.member(position.getValue("member"), "units/").path
                }
                for (value in index.getValue("anchors").requireArray()) {
                    // The current wire permits anchors only for EPUB; do not
                    // let another kind bypass the required preparation owner.
                    require(manifest.mediaKind == OfflineReadingMediaKind.Epub)
                    val anchor = (value as StrictJson.ObjectValue).fields
                    insert.bindString(1, anchor.getValue("href_path").requireString())
                    insert.bindString(2, anchor.getValue("anchor_id").requireString())
                    insert.bindString(3, anchor.getValue("unit_key").requireString())
                    try { insert.executeInsert() } catch (error: SQLiteConstraintException) {
                        throw IllegalArgumentException("publication anchor identity is duplicated", error)
                    }
                }
                next = index.getValue("next_ref")
            }
        }
        db.execSQL("""CREATE TABLE source_tables (
            id INTEGER PRIMARY KEY, fragment TEXT NOT NULL, ordinal INTEGER NOT NULL,
            rows INTEGER NOT NULL, columns INTEGER NOT NULL,
            caption_unit TEXT, caption_start INTEGER, caption_end INTEGER,
            UNIQUE(fragment, ordinal))""")
        db.execSQL("""CREATE TABLE cell_sources (
            id INTEGER PRIMARY KEY, unit_key TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL)""")
        var tableId = 0L
        var cellId = 0L
        var targetOrdinal = 0L
        val records = if (first == StrictJson.NullValue) emptySequence() else members.tableMetadata(members.member(first, "index/"))
        for (record in records) {
            when (record) {
                is OfflineReadingTableMetadata.Table -> {
                    tableId = Math.addExact(tableId, 1)
                    db.execSQL("INSERT INTO source_tables VALUES (?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(
                        tableId, record.fragmentId, record.tableOrdinal, record.rows, record.columns,
                        record.caption?.unitKey, record.caption?.start, record.caption?.end))
                }
                is OfflineReadingTableMetadata.ColumnGroup -> db.execSQL(
                    "INSERT INTO column_groups VALUES (?, ?, ?)", arrayOf(tableId, record.start, record.end))
                is OfflineReadingTableMetadata.Cell -> {
                    cellId = Math.addExact(cellId, 1)
                    targetOrdinal = 0
                    try {
                        db.execSQL("INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(
                            cellId, tableId, record.row, record.column,
                            Math.addExact(record.row, record.rowSpan), Math.addExact(record.column, record.columnSpan),
                            record.headerKind, if (record.empty) 1 else 0, record.rowGroup,
                            if (record.explicitHeaders) 1 else 0))
                    } catch (error: SQLiteConstraintException) {
                        throw IllegalArgumentException("table source cell coordinate is duplicated", error)
                    }
                    db.execSQL("INSERT INTO cell_sources VALUES (?, ?, ?, ?)", arrayOf(
                        cellId, record.range.unitKey, record.range.start, record.range.end))
                }
                is OfflineReadingTableMetadata.ExplicitHeader -> try {
                    db.execSQL("INSERT INTO explicit_headers VALUES (?, ?, ?, ?)",
                        arrayOf(cellId, targetOrdinal++, record.targetRow, record.targetColumn))
                } catch (error: SQLiteConstraintException) {
                    throw IllegalArgumentException("table header target is duplicated", error)
                }
            }
        }
        // The source pass attests order and ranges. These exact indexed joins
        // establish references without an additional all-cell coordinate map.
        db.rawQuery("""SELECT 1 FROM explicit_headers e JOIN cells p ON p.id=e.principal
            LEFT JOIN cells h ON h.table_id=p.table_id AND h.row_start=e.row_start AND h.column_start=e.column_start
            WHERE h.id IS NULL LIMIT 1""", null).use { require(!it.moveToFirst()) { "table header target has no source cell" } }
        db.compileStatement("SELECT unit_key FROM pending_anchors WHERE href=? AND id=?").use { anchor ->
            db.compileStatement("DELETE FROM pending_anchors WHERE href=? AND id=?").use { consume ->
                db.compileStatement("""SELECT id FROM source_tables WHERE fragment=? AND ordinal=? AND rows=? AND columns=?
                    AND caption_unit IS ? AND caption_start IS ? AND caption_end IS ?""").use { table ->
                    db.compileStatement("""SELECT COUNT(*) FROM cells c JOIN cell_sources s ON s.id=c.id
                        WHERE c.table_id=? AND c.row_start=? AND c.column_start=? AND c.row_end=? AND c.column_end=?
                        AND s.start<=? AND s.end>=?""").use { cell ->
                        // At most one additional decode per bounded unit, independent
                        // of its number of table excerpts and source ranges.
                        for (unitKey in unitKeys) {
                            val entry = members.declared.getValue(unitKey)
                            val unit = (members.json(entry, OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) as StrictJson.ObjectValue).fields
                            val epubTarget = unit.getValue("epub_target")
                            if (epubTarget is StrictJson.ObjectValue) {
                                val href = epubTarget.fields.getValue("href_path").requireString()
                                anchor.bindString(1, href); consume.bindString(1, href)
                                for (id in visibleOriginalIds(unit.getValue("render_nodes").requireArray())) {
                                    anchor.bindString(2, id); consume.bindString(2, id)
                                    val key = try { anchor.simpleQueryForString() } catch (_: SQLiteDoneException) { null }
                                    require(key == null || key == entry.path) { "publication anchor names a later original id" }
                                    if (key != null) consume.executeUpdateDelete()
                                }
                            }
                            val fragment = unit.getValue("fragment_id").requireString()
                            val start = unit.getValue("start_cp").requireLong()
                            val end = unit.getValue("end_cp").requireLong()
                            for (value in unit.getValue("table_contexts").requireArray()) {
                                val context = (value as StrictJson.ObjectValue).fields
                                table.bindString(1, fragment)
                                table.bindLong(2, context.getValue("table_ordinal").requireLong())
                                table.bindLong(3, context.getValue("row_count").requireLong())
                                table.bindLong(4, context.getValue("column_count").requireLong())
                                val caption = context.getValue("caption")
                                if (caption == StrictJson.NullValue) {
                                    table.bindNull(5); table.bindNull(6); table.bindNull(7)
                                } else {
                                    val range = requireTableSourceRange(caption)
                                    table.bindString(5, range.unitKey); table.bindLong(6, range.start); table.bindLong(7, range.end)
                                }
                                val selectedTable = try {
                                    table.simpleQueryForLong()
                                } catch (error: SQLiteDoneException) {
                                    throw IllegalArgumentException("table excerpt differs from source table", error)
                                }
                                for (part in context.getValue("cells").requireArray()) {
                                    val fields = (part as StrictJson.ObjectValue).fields
                                    val row = fields.getValue("row").requireLong()
                                    val column = fields.getValue("column").requireLong()
                                    cell.bindLong(1, selectedTable); cell.bindLong(2, row); cell.bindLong(3, column)
                                    cell.bindLong(4, Math.addExact(row, fields.getValue("row_span").requireLong()))
                                    cell.bindLong(5, Math.addExact(column, fields.getValue("column_span").requireLong()))
                                    cell.bindLong(6, end); cell.bindLong(7, start)
                                    require(cell.simpleQueryForLong() == 1L) { "table excerpt differs from source geometry" }
                                    // Continued-before/after include zero-text source nodes;
                                    // canonical inequalities cannot attest those booleans.
                                }
                            }
                        }
                    }
                }
            }
        }
        db.rawQuery("SELECT 1 FROM pending_anchors LIMIT 1", null).use {
            require(!it.moveToFirst()) { "publication anchor has no visible original id" }
        }
        db.execSQL("DROP TABLE pending_anchors")
    }
    return PreparedOfflineReadingPackage(source, Math.addExact(source.installedBytes, file.length()), file.sha256Hex())
}

/** Input nodes already passed the member preorder/attribute contract. */
private fun visibleOriginalIds(nodes: List<StrictJson>): Sequence<String> = sequence {
    val visible = BooleanArray(nodes.size)
    for ((index, value) in nodes.withIndex()) {
        val node = (value as StrictJson.ObjectValue).fields
        if (node.getValue("kind").requireString() != "Element") continue
        val parent = node.getValue("parent")
        if (parent != StrictJson.NullValue && !visible[parent.requireLong().toInt()]) continue
        if (node.getValue("name").requireString().lowercase() in setOf("script", "style", "noscript", "template")) continue
        val attributes = node.getValue("attributes").requireArray()
        if (attributes.any { attributeValue ->
            val attribute = (attributeValue as StrictJson.ObjectValue).fields
            attribute.getValue("namespace") == StrictJson.NullValue &&
                (attribute.getValue("name").requireString() == "hidden" ||
                    attribute.getValue("name").requireString() == "aria-hidden" &&
                    attribute.getValue("value").requireString().lowercase() == "true")
        }) continue
        visible[index] = true
        for (attributeValue in attributes) {
            val attribute = (attributeValue as StrictJson.ObjectValue).fields
            if (attribute.getValue("namespace") == StrictJson.NullValue &&
                attribute.getValue("name").requireString() in setOf("id", "name")) {
                yield(attribute.getValue("value").requireString())
            }
        }
    }
}

internal fun writeTableIndex(file: File, revision: String, cacheKiB: Int, populate: (SQLiteDatabase) -> Unit) {
    require(file.parentFile?.isDirectory == true && !file.exists())
    require(revision.matches(Regex("[0-9a-f]{64}")))
    SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
        configureTableQuery(db, cacheKiB)
        db.beginTransaction()
        try {
            db.execSQL("CREATE TABLE identity (revision TEXT NOT NULL)")
            db.execSQL("INSERT INTO identity VALUES (?)", arrayOf(revision))
            db.execSQL("""CREATE TABLE cells (
                id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL,
                row_start INTEGER NOT NULL, column_start INTEGER NOT NULL,
                row_end INTEGER NOT NULL, column_end INTEGER NOT NULL,
                kind TEXT NOT NULL, empty INTEGER NOT NULL, row_group INTEGER,
                explicit_headers INTEGER NOT NULL,
                UNIQUE(table_id, row_start, column_start))""")
            db.execSQL("CREATE INDEX cells_source ON cells(table_id, id)")
            db.execSQL("CREATE INDEX cells_eligible ON cells(table_id, kind, id) WHERE empty=0")
            db.execSQL("CREATE INDEX cells_rowgroup ON cells(table_id, row_group, id) WHERE kind='rowgroup' AND empty=0")
            db.execSQL("""CREATE TABLE explicit_headers (
                principal INTEGER NOT NULL, ordinal INTEGER NOT NULL,
                row_start INTEGER NOT NULL, column_start INTEGER NOT NULL,
                PRIMARY KEY(principal, ordinal),
                UNIQUE(principal, row_start, column_start)) WITHOUT ROWID""")
            db.execSQL("""CREATE TABLE column_groups (
                table_id INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
                PRIMARY KEY(table_id, start)) WITHOUT ROWID""")
            populate(db)
            db.version = 2
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        // Reclaim the source-sized pending identity table before publication.
        // VACUUM's temporary disk overlap belongs to this same preparation owner.
        db.execSQL("VACUUM")
    }
    file.inputStream().use { it.fd.sync() }
}

internal fun configureTableQuery(db: SQLiteDatabase, cacheKiB: Int) {
    require(cacheKiB > 0)
    db.execSQL("PRAGMA cache_size = -$cacheKiB")
    db.rawQuery("PRAGMA mmap_size = 0", null).use { it.moveToFirst() }
    db.execSQL("PRAGMA temp_store = FILE")
    db.rawQuery("PRAGMA journal_mode = DELETE", null).use { it.moveToFirst() }
}
