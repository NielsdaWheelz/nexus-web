package app.nexus.android.offline.reading

import java.io.File
import java.nio.file.Files

internal data class OfflineReadingTableSourceRange(
    val unitKey: String, val fragmentId: String, val start: Long, val end: Long,
)

internal sealed interface OfflineReadingTableMetadata {
    val fragmentId: String
    val tableOrdinal: Long

    data class Table(override val fragmentId: String, override val tableOrdinal: Long,
        val rows: Long, val columns: Long, val caption: OfflineReadingTableSourceRange?) : OfflineReadingTableMetadata
    data class ColumnGroup(override val fragmentId: String, override val tableOrdinal: Long,
        val start: Long, val end: Long) : OfflineReadingTableMetadata
    data class Cell(override val fragmentId: String, override val tableOrdinal: Long,
        val row: Long, val column: Long, val rowSpan: Long, val columnSpan: Long,
        val rowGroup: Long?, val headerKind: String, val empty: Boolean, val explicitHeaders: Boolean,
        val range: OfflineReadingTableSourceRange) : OfflineReadingTableMetadata
    data class ExplicitHeader(override val fragmentId: String, override val tableOrdinal: Long,
        val row: Long, val column: Long, val targetRow: Long, val targetColumn: Long) : OfflineReadingTableMetadata
}

internal fun requireTableSourceRange(value: StrictJson): OfflineReadingTableSourceRange {
    val fields = value.requireObject(setOf("unit_key", "fragment_id", "start_cp", "end_cp"))
    val key = fields.getValue("unit_key").requireString()
    require(key.startsWith("units/"))
    val fragment = fields.getValue("fragment_id").requireString()
    require(fragment.isNotBlank() && fragment.codePointCount(0, fragment.length) <= 256)
    val start = fields.getValue("start_cp").requireLong()
    val end = fields.getValue("end_cp").requireLong()
    require(start >= 0 && end >= start)
    return OfflineReadingTableSourceRange(key, fragment, start, end)
}

/** Exact bounded member reads shared by source verification and derived preparation. */
internal class OfflineReadingPublicationMembers(private val directory: File, manifest: OfflineReadingManifest) {
    val declared = manifest.entries.associateBy { it.path }
    val visited = mutableSetOf("descriptor.json")

    fun member(value: StrictJson, prefix: String): OfflineReadingManifestEntry {
        val ref = value.requireObject(setOf("key", "bytes", "sha256"))
        val key = ref.getValue("key").requireString()
        require(key.startsWith(prefix))
        val entry = declared[key] ?: error("publication references an undeclared member")
        require(entry.sizeBytes == ref.getValue("bytes").requireLong())
        require(entry.sha256 == ref.getValue("sha256").requireString())
        visited += key
        return entry
    }

    fun json(entry: OfflineReadingManifestEntry, maximum: Long): StrictJson {
        require(entry.mediaType == "application/json" && entry.sizeBytes <= maximum)
        val file = File(directory, entry.path)
        require(Files.size(file.toPath()) == entry.sizeBytes)
        return StrictJson.parse(file.readBytes())
    }

    /** The current bounded page remains owned until its last record is consumed. */
    fun tableMetadata(first: OfflineReadingManifestEntry): Sequence<OfflineReadingTableMetadata> = sequence {
        val chain = mutableSetOf<String>()
        var entry = first
        while (true) {
            require(chain.add(entry.path))
            visited += entry.path
            val page = json(entry, OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES).requireObject(
                setOf("units", "sections", "toc", "landmarks", "page_list", "next_ref", "table_metadata", "anchors"))
            listOf("units", "sections", "toc", "landmarks", "page_list", "anchors").forEach {
                require(page.getValue(it).requireArray().isEmpty())
            }
            val records = page.getValue("table_metadata").requireArray()
            require(records.isNotEmpty())
            for (value in records) {
                val fields = (value as? StrictJson.ObjectValue)?.fields ?: error("invalid table metadata record")
                val kind = fields.getValue("kind").requireString()
                val identity = setOf("kind", "fragment_id", "table_ordinal")
                value.requireObject(identity + when (kind) {
                    "Table" -> setOf("row_count", "column_count", "caption")
                    "ColumnGroup" -> setOf("start", "end")
                    "Cell" -> setOf("row", "column", "row_span", "column_span", "row_group", "header_kind", "empty", "explicit_headers", "range")
                    "ExplicitHeader" -> setOf("row", "column", "target_row", "target_column")
                    else -> error("unsupported table metadata record")
                })
                val fragment = fields.getValue("fragment_id").requireString()
                require(fragment.isNotBlank() && fragment.codePointCount(0, fragment.length) <= 256)
                fun coordinate(name: String): Long = fields.getValue(name).requireLong().also {
                    require(it in 0..9_007_199_254_740_991L)
                }
                fun boolean(name: String): Boolean = (fields.getValue(name) as? StrictJson.BooleanValue)?.value
                    ?: error("invalid table metadata boolean")
                val ordinal = coordinate("table_ordinal")
                yield(when (kind) {
                    "Table" -> OfflineReadingTableMetadata.Table(fragment, ordinal,
                        coordinate("row_count"), coordinate("column_count"), fields.getValue("caption").let {
                            if (it == StrictJson.NullValue) null else requireTableSourceRange(it)
                        })
                    "ColumnGroup" -> OfflineReadingTableMetadata.ColumnGroup(fragment, ordinal,
                        coordinate("start"), coordinate("end"))
                    "Cell" -> {
                        val height = coordinate("row_span")
                        val width = coordinate("column_span")
                        require(height > 0 && width in 1..1000)
                        val role = fields.getValue("header_kind").requireString()
                        require(role in setOf("data", "none", "row", "column", "rowgroup", "colgroup"))
                        OfflineReadingTableMetadata.Cell(fragment, ordinal, coordinate("row"), coordinate("column"), height, width,
                            fields.getValue("row_group").let { if (it == StrictJson.NullValue) null else coordinate("row_group") },
                            role, boolean("empty"), boolean("explicit_headers"),
                            requireTableSourceRange(fields.getValue("range")))
                    }
                    else -> OfflineReadingTableMetadata.ExplicitHeader(fragment, ordinal, coordinate("row"), coordinate("column"),
                        coordinate("target_row"), coordinate("target_column"))
                })
            }
            val following = page.getValue("next_ref")
            if (following == StrictJson.NullValue) break
            entry = member(following, "index/")
        }
    }
}
