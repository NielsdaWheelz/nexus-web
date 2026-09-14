package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal fun readerPublicationArtifact(root: File, fault: String? = null, fragmentId: String = "22222222-2222-4222-8222-222222222222"): OfflineReadingTransferArtifact {
    val mediaId = UUID.fromString("11111111-1111-4111-8111-111111111111")
    val accountId = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    val content = linkedMapOf<String, ByteArray>()
    fun ref(path: String): JSONObject = JSONObject().put("key", path)
        .put("bytes", content.getValue(path).size).put("sha256", sha256Hex(content.getValue(path)))
    fun element(name: String, parent: Int? = null, vararg attributes: Pair<String, String>): JSONObject = JSONObject()
        .put("kind", "Element").put("parent", parent ?: JSONObject.NULL).put("namespace", "html").put("name", name)
        .put("attributes", JSONArray(attributes.map { (name, value) -> JSONObject()
            .put("namespace", JSONObject.NULL).put("name", name).put("value", value) }))
    fun textNode(text: String, parent: Int?): JSONObject = JSONObject().put("kind", "Text")
        .put("parent", parent ?: JSONObject.NULL).put("text", text)
    // The sparse-range proof needs 256 distinct windows, so that one case gives
    // the first unit a canonical text long enough to carry them.
    val interiorWord = fault == "word-interior"
    val firstText = when {
        interiorWord -> "ab"
        fault == "many-table-ranges" -> "a😀b" + "x".repeat(512)
        else -> "a😀b"
    }
    val firstLength = firstText.codePointCount(0, firstText.length)
    val canonicalLength = if (interiorWord) 6 else firstLength + 1
    // Original words are `abcdef` or `a`, emoji, and the final b...c word.
    // Slice their boundaries without inventing unit edges.
    fun boundaries(start: Int, text: String): JSONArray {
        val original = if (interiorWord) listOf(0, 6) else listOf(0, 1, 2, canonicalLength)
        val end = start + text.codePointCount(0, text.length)
        return JSONArray(original.filter { it in start..end })
    }
    fun unit(start: Int, text: String, nodes: JSONArray): JSONObject = JSONObject()
        .put("fragment_id", fragmentId).put("fragment_idx", 0)
        .put("fragment_document_start_cp", 0).put("fragment_length_cp", canonicalLength)
        .put("document_word_start", if (start == 0) 0 else 1).put("starts_in_word", start > 0)
        .put("start_cp", start).put("end_cp", start + text.codePointCount(0, text.length))
        .put("render_start_cp", start).put("render_end_cp", start + text.codePointCount(0, text.length))
        .put("render_nodes", nodes).put("canonical_text", text)
        .put("word_boundaries", if (fault == "no-find") JSONObject.NULL else boundaries(start, text)).put("assets", JSONArray())
        .put("table_contexts", JSONArray()).put("epub_target", JSONObject.NULL).put("document_embeds", JSONArray())
    val firstNodes = JSONArray().put(element("p")).put(textNode(firstText, 0))
    val first = unit(0, firstText, firstNodes)
    if (fault == "captured-image") {
        val path = "assets/web/" + "a".repeat(64)
        content[path] = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8LxsAAAAASUVORK5CYII=")
        firstNodes.put(element("img", null, "src" to "nexus-reader-member:$path", "alt" to "captured"))
        first.put("assets", JSONArray().put(JSONObject().put("kind", "Captured")
            .put("member", ref(path)).put("media_type", "image/png").put("package_href", JSONObject.NULL)))
    }
    val epub = fault?.startsWith("epub") == true
    val anchorCase = fault?.startsWith("epub-anchor-") == true
    val hiddenAnchor = fault in setOf("epub-anchor-hidden-first", "epub-anchor-aria-hidden-first")
    val laterAnchor = hiddenAnchor || fault == "epub-anchor-later"
    if (anchorCase && !hiddenAnchor && fault !in setOf("epub-anchor-missing", "epub-anchor-name")) {
        firstNodes.getJSONObject(0).getJSONArray("attributes").put(JSONObject()
            .put("namespace", JSONObject.NULL).put("name", "id").put("value", "target"))
    }
    if (fault in setOf("epub-anchor-name", "epub-anchor-id-name")) firstNodes.getJSONObject(0).getJSONArray("attributes").put(JSONObject()
        .put("namespace", JSONObject.NULL).put("name", "name").put("value", if (fault == "epub-anchor-name") "target" else "alternate"))
    if (hiddenAnchor) {
        val parent = firstNodes.length()
        firstNodes.put(element("div", null, if (fault == "epub-anchor-hidden-first") "hidden" to "" else "aria-hidden" to "true"))
            .put(element("span", parent, "id" to "target"))
    }
    val target = JSONObject().put("section_id", "chapter-1").put("href_path", "chapter.xhtml").put("anchor_id", JSONObject.NULL)
    if (epub) first.put("epub_target", target)
    val embed = JSONObject().put("id", "33333333-3333-4333-8333-333333333333")
        .put("ordinal", 0).put("occurrence_key", "original-embed").put("provider", "youtube")
        .put("embed_kind", "video").put("source_shape", "iframe").put("placeholder_text", "video")
        .put("source_url", JSONObject.NULL).put("canonical_source_url", JSONObject.NULL)
        .put("provider_target_ref", JSONObject.NULL).put("title", JSONObject.NULL).put("authored_text", JSONObject.NULL)
        .put("canonical_start_offset", 3).put("canonical_end_offset", 4)
        .put("target", JSONObject().put("kind", "materialized").put("media_id", mediaId.toString()))
    if (fault?.startsWith("embed") == true) {
        first.put("document_embeds", JSONArray().put(embed))
        if (fault != "embed-missing-marker") firstNodes.put(element("div", null, "data-nexus-document-embed-id" to "original-embed"))
        if (fault == "embed-invalid-child") embed.getJSONObject("target").put("media_id", "fragment-a")
        if (fault == "embed-half-range") embed.put("canonical_start_offset", JSONObject.NULL)
        if (fault == "embed-outside-source") embed.put("canonical_end_offset", 5)
    }
    val rangeCount = if (fault == "many-table-ranges") 256 else if (fault?.startsWith("table-") == true) 2 else 0
    val rowCount = rangeCount + if (fault == "table-missing-target") 1 else 0
    if (rangeCount > 0) {
        val nodes = JSONArray().put(element("table"))
        val cells = JSONArray()
        for (row in 0 until rangeCount) {
            val parent = nodes.length()
            nodes.put(element("tr", 0)).put(element("th", parent, "scope" to "col"))
            cells.put(JSONObject().put("row", row).put("column", 0).put("row_span", 1).put("column_span", 1)
                .put("continued_before", false).put("continued_after", false))
        }
        if (fault == "table-excerpt-span") cells.getJSONObject(0).put("row_span", 2)
        val paragraph = nodes.length()
        nodes.put(element("p")).put(textNode("a😀b", paragraph))
        nodes.put(JSONObject().put("kind", "Comment").put("parent", JSONObject.NULL).put("text", "source comment ".repeat(4096)))
        first.put("render_nodes", nodes).put("table_contexts", JSONArray().put(JSONObject()
            .put("table_ordinal", 0).put("row_count", if (fault == "table-excerpt-count") rowCount + 1 else rowCount).put("column_count", 1)
            .put("caption", JSONObject.NULL).put("cells", cells)))
    }
    content["units/first.json"] = first.toString().toByteArray()
    val secondStart = if (fault == "gap") firstLength + 1 else firstLength
    val secondText = if (interiorWord) "cd" else "c"
    val secondNodes = JSONArray().put(when (fault) {
        "ping" -> element("a", null, "href" to "#local", "ping" to "https://example.test/audit")
        "local-ping" -> element("a", null, "href" to "#local", "ping" to "#audit")
        "cite" -> element("blockquote", null, "cite" to "https://example.test/source")
        "bad-name" -> element("p:invalid")
        "duplicate-attribute" -> element("p", null, "title" to "one", "title" to "two")
        else -> element("p")
    }).put(textNode(if (fault == "empty-text") "" else secondText, if (fault == "parent-future") 3 else 0))
    when (fault) {
        "live-image" -> secondNodes.put(element("img", null, "src" to "https://example.test/tracker.png"))
        "parent-text" -> secondNodes.put(element("span", 1))
        "noncontiguous" -> secondNodes.put(element("p")).put(element("span", 0))
    }
    if (fault?.startsWith("paint") == true) {
        val paint = JSONObject().put("kind", "LocalFragment")
            .put("fragment_id", if (fault == "paint-empty") "" else "local 🧠%20")
            .put("fallback", if (fault == "paint-fallback") 7 else "currentColor")
        if (fault == "paint-extra") paint.put("url", "https://example.test/image.svg")
        secondNodes.put(element("path").put("namespace", if (fault == "paint-html") "html" else "svg")
            .put("attributes", JSONArray().put(JSONObject()
                .put("namespace", if (fault == "paint-namespace") "xlink" else JSONObject.NULL)
                .put("name", if (fault == "paint-attribute") "href" else "fill")
                .put("value", paint))))
    }
    val second = unit(secondStart, secondText, secondNodes)
    if (laterAnchor) {
        secondNodes.getJSONObject(0).getJSONArray("attributes").put(JSONObject()
            .put("namespace", JSONObject.NULL).put("name", "id").put("value", "target"))
    }
    if (epub) second.put("epub_target", if (fault == "epub-inconsistent") JSONObject(target.toString()).put("section_id", "chapter-2") else target)
    if (fault == "embed-duplicate") {
        second.put("document_embeds", JSONArray().put(embed))
        secondNodes.put(element("div", null, "data-nexus-document-embed-id" to "original-embed"))
    }
    if (fault == "embed-extra-marker") secondNodes.put(element("div", null, "data-nexus-document-embed-id" to "undeclared"))
    content["units/second.json"] = second.toString().toByteArray()
    if (interiorWord) content["units/third.json"] = unit(4, "ef",
        JSONArray().put(element("p")).put(textNode("ef", 0))).toString().toByteArray()
    fun position(path: String, ordinal: Int, start: Int, end: Int): JSONObject = JSONObject()
        .put("member", ref(path)).put("ordinal", ordinal).put("fragment_id", fragmentId)
        .put("fragment_idx", 0).put("start_cp", start).put("end_cp", end)
    val units = JSONArray().put(position("units/first.json", 0, 0, firstLength))
        .put(position(if (fault == "duplicate-unit") "units/first.json" else "units/second.json", 1, secondStart, secondStart + secondText.length))
    if (interiorWord) units.put(position("units/third.json", 2, 4, 6))
    val sections = JSONArray()
    if (epub && fault != "epub-missing-section") sections.put(JSONObject()
        .put("section_id", if (fault == "epub-wrong-section") "chapter-2" else "chapter-1")
        .put("unit_key", if (fault == "epub-wrong-unit") "units/second.json" else "units/first.json")
        .put("label", "chapter one").put("ordinal", 0).put("fragment_id", fragmentId).put("fragment_idx", 0)
        .put("level", JSONObject.NULL).put("depth", JSONObject.NULL).put("start_offset", 0).put("end_offset", canonicalLength)
        .put("href_path", "chapter.xhtml").put("href_fragment", JSONObject.NULL).put("anchor_id", JSONObject.NULL))
    if (fault == "epub-duplicate-section") sections.put(JSONObject(sections.getJSONObject(0).toString()).put("ordinal", 1))
    val anchors = if (anchorCase) JSONArray().put(JSONObject()
        .put("href_path", "chapter.xhtml").put("anchor_id", "target")
        .put("unit_key", if (laterAnchor) "units/second.json" else "units/first.json").put("offset_cp", if (laterAnchor) 3 else 0)) else JSONArray()
    if (fault == "epub-anchor-id-name") anchors.put(JSONObject(anchors.getJSONObject(0).toString()).put("anchor_id", "alternate"))
    if (fault == "epub-anchor-duplicate") anchors.put(JSONObject(anchors.getJSONObject(0).toString()))
    content["index/0.json"] = JSONObject().put("units", units).put("sections", sections)
        .put("toc", JSONArray()).put("landmarks", JSONArray()).put("page_list", JSONArray())
        .put("table_metadata", JSONArray()).put("anchors", anchors)
        .put("next_ref", JSONObject.NULL).toString().toByteArray()
    if (sections.length() > 0) content["index/contents-0.json"] = JSONObject()
        .put("units", JSONArray()).put("sections", sections).put("toc", JSONArray())
        .put("landmarks", JSONArray()).put("page_list", JSONArray()).put("table_metadata", JSONArray()).put("anchors", JSONArray())
        .put("next_ref", JSONObject.NULL).toString().toByteArray()
    if (rangeCount > 0) {
        val records = JSONArray().put(JSONObject().put("kind", "Table").put("fragment_id", fragmentId)
            .put("table_ordinal", 0).put("row_count", rowCount).put("column_count", 1).put("caption", JSONObject.NULL))
        for (row in 0 until rangeCount) records.put(JSONObject().put("kind", "Cell").put("fragment_id", fragmentId)
            .put("table_ordinal", 0).put("row", if (fault == "table-duplicate-cell") 0 else row).put("column", 0).put("row_span", 1).put("column_span", 1)
            .put("row_group", 0).put("header_kind", "column").put("empty", true)
            .put("explicit_headers", row == rangeCount - 1 && fault in setOf("table-missing-target", "table-duplicate-target"))
            .put("range", JSONObject().put("unit_key", "units/first.json").put("fragment_id", fragmentId)
                // Distinct non-degenerate windows: a range-keyed decode memo
                // cannot satisfy the bounded-read oracle by collapsing them.
                .put("start_cp", if (fault == "many-table-ranges") row else 0)
                .put("end_cp", if (fault == "many-table-ranges") row + 1 else 0)))
        if (fault in setOf("table-missing-target", "table-duplicate-target")) {
            val targetRecord = JSONObject().put("kind", "ExplicitHeader").put("fragment_id", fragmentId)
                .put("table_ordinal", 0).put("row", rangeCount - 1).put("column", 0)
                .put("target_row", if (fault == "table-missing-target") rangeCount else 0).put("target_column", 0)
            records.put(targetRecord)
            if (fault == "table-duplicate-target") records.put(JSONObject(targetRecord.toString()))
        }
        content["index/table-metadata-0.json"] = JSONObject().put("units", JSONArray()).put("sections", JSONArray())
            .put("toc", JSONArray()).put("landmarks", JSONArray()).put("page_list", JSONArray()).put("anchors", JSONArray())
            .put("table_metadata", records).put("next_ref", JSONObject.NULL).toString().toByteArray()
    }
    content["descriptor.json"] = JSONObject().put("media_id", mediaId.toString())
        .put("reader_generation", if (fault == "generation") 8 else 7)
        .put("kind", if (epub) "epub" else "web_article").put("title", "Bounded publication").put("reader_contract_version", 1)
        .put("first_unit_ref", ref("units/first.json")).put("index_ref", ref("index/0.json"))
        .put("contents_ref", if (sections.length() > 0) ref("index/contents-0.json") else JSONObject.NULL)
        .put("table_metadata_ref", if (rangeCount > 0) ref("index/table-metadata-0.json") else JSONObject.NULL).put("unit_count", if (interiorWord) 3 else 2).put("canonical_length", canonicalLength).toString().toByteArray()
    val entries = content.toSortedMap().map { (path, body) ->
        OfflineReadingManifestEntry(path, if (path.startsWith("assets/")) "image/png" else "application/json", body.size.toLong(), sha256Hex(body))
    }
    val manifest = JSONObject().put("packageSchemaVersion", 2).put("readerContractVersion", 1)
        .put("minimumReaderBundleVersion", 2).put("mediaId", mediaId.toString()).put("mediaKind", if (epub) "Epub" else "WebArticle")
        .put("title", "Bounded publication").put("readerGeneration", 7)
        .put("readerRevisionKey", OfflineReadingRevision.compute(7, entries))
        .put("entries", JSONArray(entries.map { entry -> JSONObject().put("path", entry.path)
            .put("mediaType", entry.mediaType).put("sizeBytes", entry.sizeBytes).put("sha256", entry.sha256) }))
    val bytes = encodeCanonicalOfflineReadingZip(listOf(CanonicalZipMember("manifest.json", manifest.toString().toByteArray())) +
        content.toSortedMap().map { (path, body) -> CanonicalZipMember(path, body) })
    val file = File(root, "${fault ?: "valid"}.zip").apply { writeBytes(bytes) }
    return OfflineReadingTransferArtifact(file, accountId, 7, bytes.size.toLong(), entries.sumOf { it.sizeBytes }, sha256Hex(bytes))
}
