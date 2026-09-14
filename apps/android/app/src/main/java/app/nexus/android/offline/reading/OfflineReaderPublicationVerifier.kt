package app.nexus.android.offline.reading

import java.io.File
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.UUID

// Candidate wire bounds; schema-2 activation requires the shared capacity gate.
internal const val OFFLINE_READING_MAX_DESCRIPTOR_BYTES = 16L * 1024L
internal const val OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES = 256L * 1024L
internal const val OFFLINE_READING_MAX_UNIT_CODEPOINTS = 65_536
internal const val OFFLINE_READING_MAX_UNIT_DOM_NODES = 8192

private data class PublicationUnitFacts(
    val fragment: String,
    val fragmentIndex: Long,
    val start: Long,
    val end: Long,
    val fragmentLength: Long,
    val epubPathDigest: String?,
)

/**
 * Which admission the bytes under verification are under. Find metadata is a
 * producer capability, not a device one, so the rule differs by admission and
 * must be supplied by the caller that knows where the bytes came from.
 */
internal enum class PublicationOrigin {
    /** Hosted worker output crossing the download boundary. Find metadata is required. */
    Downloaded,
    /**
     * Bytes this device converted from a retained schema-1 package, and the
     * re-verification of bytes an earlier admission already accepted. A
     * conversion cannot recover worker-computed boundaries, so it may declare
     * Find metadata absent.
     */
    Retained,
}

/** Verify one bounded member at a time; retain cross-member identities only. */
internal object OfflineReaderPublicationVerifier {
    fun verify(directory: File, manifest: OfflineReadingManifest, origin: PublicationOrigin) {
        require(manifest.packageSchemaVersion == 2)
        val members = OfflineReadingPublicationMembers(directory, manifest)
        val declared = members.declared
        val visited = members.visited
        val member = members::member
        val json = members::json
        val common = setOf("media_id", "reader_generation", "kind", "title", "reader_contract_version")
        val pdf = manifest.mediaKind == OfflineReadingMediaKind.Pdf
        val descriptor = json(declared.getValue("descriptor.json"), OFFLINE_READING_MAX_DESCRIPTOR_BYTES)
            .requireObject(common + if (pdf) setOf("document_asset_ref", "page_count")
                else setOf("first_unit_ref", "index_ref", "contents_ref", "table_metadata_ref", "unit_count", "canonical_length"))
        require(descriptor.getValue("media_id").requireString() == manifest.mediaId.toString())
        require(descriptor.getValue("reader_generation").requireLong() == manifest.readerGeneration)
        require(descriptor.getValue("title").requireString() == manifest.title)
        require(descriptor.getValue("reader_contract_version").requireLong() == 1L)
        val kind = when (manifest.mediaKind) {
            OfflineReadingMediaKind.Pdf -> "pdf"
            OfflineReadingMediaKind.Epub -> "epub"
            OfflineReadingMediaKind.WebArticle -> "web_article"
        }
        require(descriptor.getValue("kind").requireString() == kind)
        if (pdf) {
            require(descriptor.getValue("page_count").requireLong() > 0)
            require(member(descriptor.getValue("document_asset_ref"), "assets/").mediaType == "application/pdf")
            require(visited == declared.keys)
            return
        }
        val first = member(descriptor.getValue("first_unit_ref"), "units/")
        val expectedCount = descriptor.getValue("unit_count").requireLong()
        require(expectedCount in 1..OFFLINE_READING_MAX_ENTRIES.toLong())
        val canonicalLength = descriptor.getValue("canonical_length").requireLong()
        require(canonicalLength >= 0)
        var next = member(descriptor.getValue("index_ref"), "index/")
        val indexKeys = mutableSetOf<String>()
        // This replaces the existing unit-key set: at most the enforced 4,096
        // manifest entries, with fixed scalar facts and one retained fragment
        // string per contiguous source fragment. No unit body is retained.
        val units = mutableMapOf<String, PublicationUnitFacts>()
        val captionUnits = mutableSetOf<String>()
        val sectionIds = mutableMapOf<String, String>()
        val navigationSections = mutableSetOf<String>()
        val contextUnits = mutableSetOf<String>()
        var tableContextsPresent = false
        fun sourceRange(range: OfflineReadingTableSourceRange, fragment: String) {
            require(range.fragmentId == fragment)
            val unit = units[range.unitKey] ?: error("table context names an undeclared unit")
            require(unit.fragment == fragment)
            require(range.start in unit.start..unit.end)
            require(range.end in range.start..unit.fragmentLength)
        }
        var ordinal = 0L
        var previousFragment: String? = null
        var previousFragmentIndex = -1L
        var previousEnd = 0L
        var fragmentDocumentStart = 0L
        var fragmentLength = 0L
        var documentWordStart = 0L
        var inWord = false
        val fragments = mutableMapOf<String, Long>()
        val epubTargets = mutableMapOf<String, String>()
        val embedIds = mutableSetOf<UUID>()
        val embedKeys = mutableSetOf<String>()
        while (true) {
            require(indexKeys.add(next.path))
            val index = json(next, OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES).requireObject(
                setOf("units", "sections", "toc", "landmarks", "page_list", "next_ref", "table_metadata", "anchors")
            )
            require(index.getValue("table_metadata").requireArray().isEmpty())
            index.getValue("anchors").requireArray().forEach { value ->
                require(manifest.mediaKind == OfflineReadingMediaKind.Epub)
                val anchor = value.requireObject(setOf("href_path", "anchor_id", "unit_key", "offset_cp"))
                require(anchor.getValue("href_path").requireString().isNotEmpty())
                require(anchor.getValue("anchor_id").requireString().isNotEmpty())
                val key = anchor.getValue("unit_key").requireString()
                require(key.startsWith("units/"))
                val declaredKey = requireNotNull(declared[key]).path
                contextUnits += declaredKey
                anchor.getValue("offset_cp").requireLong()
            }
            val continuation = index.getValue("next_ref")
            if (continuation == StrictJson.NullValue) break
            next = member(continuation, "index/")
        }
        // Unit positions precede the lookup tail. Read only the bounded index
        // chain first to establish declared source keys before bounded unit decoding.
        for (indexKey in indexKeys) {
            val index = (json(declared.getValue(indexKey), OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) as StrictJson.ObjectValue).fields
            index.getValue("sections").requireArray().forEach { value ->
                val section = value.requireObject(setOf(
                    "section_id", "unit_key", "label", "ordinal", "fragment_id", "fragment_idx", "level", "depth",
                    "start_offset", "end_offset", "href_path", "href_fragment", "anchor_id",
                ))
                val sectionId = section.getValue("section_id").requireString()
                require(sectionId.isNotEmpty() && sectionId.codePointCount(0, sectionId.length) <= 256)
                require(sectionIds.put(sectionId, identityDigest(section.keys.sorted().map { section.getValue(it) })) == null)
                section.getValue("label").requireString()
                require(section.getValue("ordinal").requireLong() >= 0)
                requireFragmentId(section.getValue("fragment_id"))
                require(section.getValue("fragment_idx").requireLong() >= 0)
                val start = section.getValue("start_offset").requireLong()
                require(start >= 0)
                val end = section.getValue("end_offset")
                require(end == StrictJson.NullValue || end.requireLong() >= start)
                val key = section.getValue("unit_key").requireString()
                require(key.startsWith("units/"))
                contextUnits += key
                listOf("level", "depth").forEach { nullableLong(section.getValue(it)) }
                listOf("href_path", "href_fragment", "anchor_id").forEach { nullableString(section.getValue(it)) }
            }
            require(index.getValue("toc").requireArray().isEmpty())
            listOf("landmarks", "page_list").forEach { field ->
                index.getValue(field).requireArray().forEach { value ->
                    val target = value.requireObject(setOf("id", "label", "ordinal", "href", "fragment_idx", "section_id"))
                    target.getValue("id").requireString()
                    target.getValue("label").requireString()
                    target.getValue("ordinal").requireLong()
                    nullableString(target.getValue("href"))
                    nullableString(target.getValue("section_id"))
                    if (target.getValue("section_id") != StrictJson.NullValue) navigationSections += target.getValue("section_id").requireString()
                    nullableLong(target.getValue("fragment_idx"))
                }
            }
            index.getValue("units").requireArray().forEach { value ->
                val position = value.requireObject(setOf("member", "ordinal", "fragment_id", "fragment_idx", "start_cp", "end_cp"))
                val entry = member(position.getValue("member"), "units/")
                require(entry.path !in units)
                require(position.getValue("ordinal").requireLong() == ordinal)
                if (ordinal == 0L) require(entry == first)
                ordinal += 1
                val fragment = requireFragmentId(position.getValue("fragment_id"))
                val fragmentIndex = position.getValue("fragment_idx").requireLong()
                val start = position.getValue("start_cp").requireLong()
                val end = position.getValue("end_cp").requireLong()
                require(start >= 0 && end >= start && fragmentIndex >= 0)
                val sameFragment = fragment == previousFragment
                if (sameFragment) {
                    require(fragmentIndex == previousFragmentIndex && start == previousEnd)
                } else {
                    require(fragments.put(fragment, fragmentIndex) == null)
                    require(fragmentIndex > previousFragmentIndex && start == 0L)
                    require(previousEnd == fragmentLength)
                    inWord = false
                    embedKeys.clear()
                }
                previousFragment = if (sameFragment) requireNotNull(previousFragment) else fragment
                previousFragmentIndex = fragmentIndex
                previousEnd = end
                val unit = json(entry, OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES).requireObject(setOf(
                    "fragment_id", "epub_target", "fragment_idx", "start_cp", "end_cp", "render_start_cp", "render_end_cp",
                    "render_nodes", "canonical_text", "word_boundaries", "assets",
                    "fragment_document_start_cp", "fragment_length_cp",
                    "document_word_start", "starts_in_word",
                    "table_contexts", "document_embeds",
                ))
                listOf("fragment_id", "fragment_idx", "start_cp", "end_cp").forEach { require(unit[it] == position[it]) }
                val epubTarget = unit.getValue("epub_target")
                var epubPathDigest: String? = null
                if (manifest.mediaKind == OfflineReadingMediaKind.Epub) {
                    val fields = OfflineReaderStateValidator.requireEpubTarget(epubTarget)
                    epubPathDigest = identityDigest(listOf(fields.getValue("href_path")))
                    val digest = identityDigest(listOf(fields.getValue("section_id"), fields.getValue("href_path"), fields.getValue("anchor_id")))
                    require(epubTargets.putIfAbsent(fragment, digest).let { it == null || it == digest })
                } else require(epubTarget == StrictJson.NullValue)
                val documentStart = unit.getValue("fragment_document_start_cp").requireLong()
                val sourceLength = unit.getValue("fragment_length_cp").requireLong()
                require(sourceLength >= end && documentStart >= 0 && documentStart <= canonicalLength)
                require(sourceLength <= canonicalLength - documentStart)
                if (sameFragment) {
                    require(documentStart == fragmentDocumentStart && sourceLength == fragmentLength)
                } else {
                    require(documentStart == fragmentDocumentStart + fragmentLength)
                    fragmentDocumentStart = documentStart
                    fragmentLength = sourceLength
                }
                units[entry.path] = PublicationUnitFacts(requireNotNull(previousFragment), fragmentIndex,
                    start, end, sourceLength, epubPathDigest)
                val text = unit.getValue("canonical_text").requireString()
                require(unit.getValue("document_word_start").requireLong() == documentWordStart)
                require(unit.getValue("starts_in_word") == StrictJson.BooleanValue(inWord))
                for (character in text) {
                    if (isReaderMetricWordSeparator(character)) inWord = false else if (!inWord) {
                        documentWordStart += 1
                        inWord = true
                    }
                }
                val length = text.codePointCount(0, text.length)
                require(length <= OFFLINE_READING_MAX_UNIT_CODEPOINTS && length.toLong() == end - start)
                val renderStart = unit.getValue("render_start_cp").requireLong()
                val renderEnd = unit.getValue("render_end_cp").requireLong()
                require(start <= renderStart && renderStart <= renderEnd && renderEnd <= end)
                val from = text.offsetByCodePoints(0, (renderStart - start).toInt())
                val until = text.offsetByCodePoints(0, (renderEnd - start).toInt())
                require(text.substring(0, from).all(::separator) && text.substring(until).all(::separator))
                var previousBoundary = -1L
                // Hosted metadata is a slice of original-fragment boundaries.
                // A unit inside a word may have no boundaries or omit either edge.
                val wordBoundaries = unit.getValue("word_boundaries")
                if (wordBoundaries == StrictJson.NullValue) {
                    require(origin == PublicationOrigin.Retained) { "downloaded publication unit omits Find metadata" }
                } else wordBoundaries.requireArray().forEach { point ->
                    val offset = point.requireLong()
                    require(offset in start..end && offset > previousBoundary)
                    previousBoundary = offset
                }
                val assets = mutableSetOf<String>()
                val unavailable = mutableSetOf<String>()
                unit.getValue("assets").requireArray().forEach { assetValue ->
                    val fields = (assetValue as? StrictJson.ObjectValue)?.fields ?: error("invalid publication asset")
                    when (fields.getValue("kind").requireString()) {
                        "Captured" -> {
                            val asset = assetValue.requireObject(setOf("kind", "member", "media_type", "package_href"))
                            val captured = member(asset.getValue("member"), "assets/")
                            require(captured.mediaType == asset.getValue("media_type").requireString())
                            nullableString(asset.getValue("package_href"))
                            require(assets.add(captured.path))
                        }
                        "Unavailable" -> {
                            val asset = assetValue.requireObject(setOf("kind", "source_url", "reason"))
                            require(asset.getValue("reason").requireString() in setOf("NotFound", "InvalidImage"))
                            require(unavailable.add(asset.getValue("source_url").requireString()))
                        }
                        else -> error("unsupported publication asset")
                    }
                }
                val unitEmbedKeys = mutableSetOf<String>()
                var previousEmbedOrdinal = -1L
                unit.getValue("document_embeds").requireArray().forEach { value ->
                    val embed = value.requireObject(setOf("id", "ordinal", "occurrence_key", "provider", "embed_kind", "source_shape", "source_url", "canonical_source_url", "provider_target_ref", "title", "authored_text", "placeholder_text", "canonical_start_offset", "canonical_end_offset", "target"))
                    require(embedIds.add(UUID.fromString(requireUuid(embed.getValue("id")))))
                    val occurrence = embed.getValue("occurrence_key").requireString()
                    require(occurrence.isNotEmpty() && unitEmbedKeys.add(occurrence))
                    require(embedKeys.add(identityDigest(listOf(embed.getValue("occurrence_key")))))
                    val embedOrdinal = embed.getValue("ordinal").requireLong()
                    require(embedOrdinal > previousEmbedOrdinal)
                    previousEmbedOrdinal = embedOrdinal
                    require(embed.getValue("provider").requireString() in setOf("youtube", "x", "substack", "vimeo", "spotify", "generic", "unknown"))
                    require(embed.getValue("embed_kind").requireString() in setOf("video", "post", "audio", "link_preview", "unknown"))
                    require(embed.getValue("source_shape").requireString() in setOf("iframe", "blockquote", "anchor", "video_tag", "provider_json", "unknown"))
                    listOf("source_url", "canonical_source_url", "provider_target_ref", "title", "authored_text").forEach { nullableString(embed.getValue(it)) }
                    embed.getValue("placeholder_text").requireString()
                    val sourceStart = embed.getValue("canonical_start_offset")
                    val sourceEnd = embed.getValue("canonical_end_offset")
                    if (sourceStart == StrictJson.NullValue) require(sourceEnd == StrictJson.NullValue)
                    else require(sourceStart.requireLong() in 0..sourceEnd.requireLong() && sourceEnd.requireLong() <= sourceLength)
                    val target = embed.getValue("target")
                    when ((target as? StrictJson.ObjectValue)?.fields?.get("kind")?.requireString()) {
                        "materialized" -> requireUuid(target.requireObject(setOf("kind", "media_id")).getValue("media_id"))
                        "terminal" -> {
                            val fields = target.requireObject(setOf("kind", "status", "error_code", "error_message"))
                            require(fields.getValue("status").requireString() in setOf("unsupported", "failed"))
                            nullableString(fields.getValue("error_code"))
                            nullableString(fields.getValue("error_message"))
                        }
                        else -> error("invalid retained embed target")
                    }
                }
                verifyRenderNodes(unit.getValue("render_nodes").requireArray(), assets, unavailable, unitEmbedKeys)
                unit.getValue("table_contexts").requireArray().forEach { contextValue ->
                    tableContextsPresent = true
                    val context = contextValue.requireObject(setOf("table_ordinal", "row_count", "column_count", "caption", "cells"))
                    require(context.getValue("table_ordinal").requireLong() >= 0)
                    val rows = context.getValue("row_count").requireLong()
                    val columns = context.getValue("column_count").requireLong()
                    require(rows >= 0 && columns >= 0)
                    val caption = context.getValue("caption")
                    if (caption != StrictJson.NullValue) captionUnits += entry.path
                    context.getValue("cells").requireArray().forEach { cellValue ->
                        val cell = cellValue.requireObject(setOf("row", "column", "row_span", "column_span", "continued_before", "continued_after"))
                        val row = cell.getValue("row").requireLong()
                        val column = cell.getValue("column").requireLong()
                        require(row in 0 until rows && column in 0 until columns)
                        require(cell.getValue("row_span").requireLong() in 1..rows - row)
                        require(cell.getValue("column_span").requireLong() in 1..columns - column)
                        listOf("continued_before", "continued_after").forEach {
                            require(cell.getValue(it) is StrictJson.BooleanValue)
                        }

                    }
                }
            }
        }
        // An authored caption may follow its table cells and start in a later
        // unit. Validate those references after the complete unit pass, once
        // per containing member rather than once per source range.
        for (key in captionUnits) {
            val body = (json(declared.getValue(key), OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) as StrictJson.ObjectValue).fields
            for (value in body.getValue("table_contexts").requireArray()) {
                val context = (value as StrictJson.ObjectValue).fields
                val caption = context.getValue("caption")
                if (caption != StrictJson.NullValue) sourceRange(requireTableSourceRange(caption), units.getValue(key).fragment)
            }
        }
        val tableReference = descriptor.getValue("table_metadata_ref")
        if (tableReference == StrictJson.NullValue) require(!tableContextsPresent) else {
            var current: OfflineReadingTableMetadata.Table? = null
            var lastCell: OfflineReadingTableMetadata.Cell? = null
            var lastFragmentIndex = -1L
            var lastTableOrdinal = -1L
            var groupEnd = 0L
            var cellsStarted = false
            for (record in members.tableMetadata(member(tableReference, "index/"))) {
                if (record is OfflineReadingTableMetadata.Table) {
                    val index = fragments[record.fragmentId] ?: error("table names an undeclared source fragment")
                    require(index > lastFragmentIndex || index == lastFragmentIndex && record.tableOrdinal > lastTableOrdinal)
                    lastFragmentIndex = index
                    lastTableOrdinal = record.tableOrdinal
                    current = record
                    lastCell = null
                    groupEnd = 0
                    cellsStarted = false
                    record.caption?.let { sourceRange(it, record.fragmentId) }
                    continue
                }
                val table = requireNotNull(current) { "table record has no source table" }
                require(record.fragmentId == table.fragmentId && record.tableOrdinal == table.tableOrdinal)
                when (record) {
                    is OfflineReadingTableMetadata.ColumnGroup -> {
                        require(!cellsStarted && record.start >= groupEnd && record.end > record.start && record.end <= table.columns)
                        groupEnd = record.end
                    }
                    is OfflineReadingTableMetadata.Cell -> {
                        require(record.row in 0 until table.rows && record.column in 0 until table.columns)
                        require(record.rowSpan <= table.rows - record.row && record.columnSpan <= table.columns - record.column)
                        sourceRange(record.range, table.fragmentId)
                        require(lastCell == null || record.range.start >= requireNotNull(lastCell).range.start)
                        lastCell = record
                        cellsStarted = true
                    }
                    is OfflineReadingTableMetadata.ExplicitHeader -> {
                        val cell = requireNotNull(lastCell) { "explicit headers have no source cell" }
                        require(cell.explicitHeaders && record.row == cell.row && record.column == cell.column)
                        require(record.targetRow in 0 until table.rows && record.targetColumn in 0 until table.columns)
                    }
                    is OfflineReadingTableMetadata.Table -> error("table transition was not consumed")
                }
            }
        }
        val contentsReference = descriptor.getValue("contents_ref")
        if (contentsReference == StrictJson.NullValue) require(sectionIds.isEmpty()) else {
            var contents = member(contentsReference, "index/")
            val contentsKeys = mutableSetOf<String>()
            val displaySections = mutableSetOf<String>()
            val tocIds = mutableSetOf<String>()
            var displayKind: String? = null
            while (true) {
                require(contents.path !in indexKeys && contentsKeys.add(contents.path))
                val index = json(contents, OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES).requireObject(
                    setOf("units", "sections", "toc", "landmarks", "page_list", "next_ref", "table_metadata", "anchors")
                )
                listOf("units", "landmarks", "page_list", "table_metadata", "anchors").forEach { require(index.getValue(it).requireArray().isEmpty()) }
                val tocRows = index.getValue("toc").requireArray()
                val sectionRows = index.getValue("sections").requireArray()
                require(tocRows.isNotEmpty() != sectionRows.isNotEmpty())
                val kind = if (tocRows.isEmpty()) "sections" else "toc"
                require(displayKind == null || displayKind == kind)
                displayKind = kind
                for (row in sectionRows) {
                    val fields = row.requireObject(setOf(
                        "section_id", "unit_key", "label", "ordinal", "fragment_id", "fragment_idx", "level", "depth",
                        "start_offset", "end_offset", "href_path", "href_fragment", "anchor_id",
                    ))
                    val id = fields.getValue("section_id").requireString()
                    require(displaySections.add(id))
                    require(sectionIds[id] == identityDigest(fields.keys.sorted().map { fields.getValue(it) }))
                }
                for (row in tocRows) {
                    val toc = row.requireObject(setOf(
                        "id", "parent_id", "label", "ordinal", "href", "fragment_idx", "level", "depth", "section_id",
                    ))
                    val id = toc.getValue("id").requireString()
                    val parent = toc.getValue("parent_id")
                    require(parent == StrictJson.NullValue || parent.requireString() in tocIds)
                    require(id.isNotEmpty() && tocIds.add(id))
                    toc.getValue("label").requireString()
                    toc.getValue("ordinal").requireLong()
                    listOf("parent_id", "href", "section_id").forEach { nullableString(toc.getValue(it)) }
                    if (toc.getValue("section_id") != StrictJson.NullValue) navigationSections += toc.getValue("section_id").requireString()
                    listOf("fragment_idx", "level", "depth").forEach { nullableLong(toc.getValue(it)) }
                }
                val following = index.getValue("next_ref")
                if (following == StrictJson.NullValue) break
                contents = member(following, "index/")
            }
            if (displayKind == "sections") require(displaySections == sectionIds.keys)
        }
        require(contextUnits.all { it in units })
        require(navigationSections.all { it in sectionIds })
        // The existing bounded second index pass validates references from
        // exact scalar unit facts. Forward references never trigger a body read.
        for (key in indexKeys) {
            val index = (json(declared.getValue(key), OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) as StrictJson.ObjectValue).fields
            for (value in index.getValue("anchors").requireArray()) {
                val anchor = (value as StrictJson.ObjectValue).fields
                val addressed = units.getValue(anchor.getValue("unit_key").requireString())
                require(addressed.epubPathDigest == identityDigest(listOf(anchor.getValue("href_path"))))
                require(anchor.getValue("offset_cp").requireLong() in addressed.start..addressed.end)
            }
            for (value in index.getValue("sections").requireArray()) {
                val section = (value as StrictJson.ObjectValue).fields
                val addressed = units.getValue(section.getValue("unit_key").requireString())
                val fragment = section.getValue("fragment_id").requireString()
                require(fragment == addressed.fragment)
                require(section.getValue("fragment_idx").requireLong() == addressed.fragmentIndex)
                require(section.getValue("start_offset").requireLong() in addressed.start..addressed.end)
                val end = section.getValue("end_offset")
                require(end == StrictJson.NullValue || end.requireLong() <= addressed.fragmentLength)
                val expected = epubTargets.remove(fragment) ?: continue
                require(expected == identityDigest(listOf(section.getValue("section_id"), section.getValue("href_path"), section.getValue("anchor_id"))))
            }
        }
        require(epubTargets.isEmpty())
        require(ordinal == expectedCount && visited == declared.keys)
        require(previousEnd == fragmentLength && fragmentDocumentStart + fragmentLength == canonicalLength)
    }

    private fun verifyRenderNodes(nodes: List<StrictJson>, assets: Set<String>, unavailable: Set<String>, embeds: Set<String>) {
        // The prepared root and HtmlRenderer host are real, separately owned nodes.
        require(nodes.size <= OFFLINE_READING_MAX_UNIT_DOM_NODES - 2)
        val ancestors = ArrayDeque<Int>()
        val elementName = Regex("[A-Za-z][A-Za-z0-9_.-]*")
        val attributeName = Regex("[A-Za-z_][A-Za-z0-9_.:-]*")
        val markers = mutableSetOf<String>()
        nodes.forEachIndexed { index, value ->
            val kind = (value as? StrictJson.ObjectValue)?.fields?.get("kind")?.requireString()
            require(kind in setOf("Element", "Text", "Comment"))
            val node = value.requireObject(if (kind == "Element")
                setOf("kind", "parent", "namespace", "name", "attributes")
                else setOf("kind", "parent", "text"))
            val parent = node.getValue("parent").let { if (it == StrictJson.NullValue) null else it.requireLong() }
            require(parent == null || parent in 0 until index.toLong())
            while (ancestors.isNotEmpty() && ancestors.last().toLong() != parent) ancestors.removeLast()
            require(parent == null || ancestors.isNotEmpty())
            if (kind != "Element") {
                val text = node.getValue("text").requireString()
                require(kind != "Text" || text.isNotEmpty())
                return@forEachIndexed
            }
            val elementNamespace = node.getValue("namespace").requireString()
            require(elementNamespace in setOf("html", "svg", "mathml"))
            val localName = node.getValue("name").requireString()
            require(elementName.matches(localName))
            val tag = localName.lowercase()
            require(tag !in setOf("script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "form", "input", "template"))
            val keys = mutableSetOf<Pair<String?, String>>()
            node.getValue("attributes").requireArray().forEach { attributeValue ->
                val attribute = attributeValue.requireObject(setOf("namespace", "name", "value"))
                val namespace = attribute.getValue("namespace").let { if (it == StrictJson.NullValue) null else it.requireString() }
                require(namespace == null || namespace in setOf("xlink", "xml", "xmlns"))
                val local = attribute.getValue("name").requireString()
                require(attributeName.matches(local) && (namespace == null || ':' !in local))
                require(keys.add(namespace to local))
                val name = (if (namespace == null) local else "$namespace:$local").lowercase()
                require(!name.startsWith("on") && name !in setOf("srcdoc", "style", "ping"))
                val attributeContent = attribute.getValue("value")
                if (attributeContent is StrictJson.ObjectValue) {
                    require(elementNamespace == "svg" && namespace == null && local in setOf("fill", "stroke", "clip-path"))
                    val reference = attributeContent.requireObject(setOf("kind", "fragment_id", "fallback"))
                    require(reference.getValue("kind").requireString() == "LocalFragment")
                    require(reference.getValue("fragment_id").requireString().isNotEmpty())
                    nullableString(reference.getValue("fallback"))
                    // The publication owner validates CSS; native verifies the
                    // closed wire shape and member integrity, never reparses CSS.
                    return@forEach
                }
                val attributeText = attributeContent.requireString()
                if (namespace == null && local == "data-nexus-document-embed-id") require(markers.add(attributeText))
                if (name !in setOf("href", "xlink:href", "src", "srcset", "poster", "background", "action", "formaction", "cite")) return@forEach
                val values = if (name == "srcset") attributeText.split(',').map { it.trim().substringBefore(' ') }
                    else listOf(attributeText)
                values.forEach { url ->
                    when {
                        url.startsWith("nexus-reader-member:") -> require(url.removePrefix("nexus-reader-member:").substringBefore('#') in assets)
                        url.startsWith("nexus-reader-unavailable:") -> {
                            require(elementNamespace == "html" && tag == "img" && name == "src")
                            val encoded = url.removePrefix("nexus-reader-unavailable:").substringBefore('#')
                            require(URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8") in unavailable)
                        }
                        url.startsWith('#') -> Unit
                        tag == "a" && name == "href" -> {
                            val uri = URI(url)
                            require(uri.scheme == null || uri.scheme.lowercase() in setOf("http", "https", "mailto"))
                        }
                        else -> error("publication render tree contains a live subresource")
                    }
                }
            }
            ancestors.addLast(index)
        }
        require(markers == embeds)
    }

    private fun separator(value: Char): Boolean = value.isWhitespace() || value == '\u0085'
    private fun requireUuid(value: StrictJson): String = value.requireString().also { require(UUID.fromString(it).toString() == it) }
    private fun requireFragmentId(value: StrictJson): String = value.requireString().also { require(it.isNotBlank() && it.codePointCount(0, it.length) <= 256) }
    private fun identityDigest(values: List<StrictJson>): String = MessageDigest.getInstance("SHA-256")
        .digest(StrictJson.ArrayValue(values).toJson().toByteArray()).toHex()
    private fun nullableString(value: StrictJson) { if (value != StrictJson.NullValue) value.requireString() }
    private fun nullableLong(value: StrictJson) { if (value != StrictJson.NullValue) value.requireLong() }
}
