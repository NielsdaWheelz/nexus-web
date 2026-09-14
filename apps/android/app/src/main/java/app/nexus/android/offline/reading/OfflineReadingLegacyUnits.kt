package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import android.icu.text.BreakIterator
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

private val LEGACY_REMOTE_URL = Regex("(?:https?|ftp|file|data|javascript|vbscript):|//", RegexOption.IGNORE_CASE)
private val LEGACY_URL_ATTRIBUTES = setOf("action", "background", "cite", "formaction", "href", "poster", "src", "srcset", "xlink:href")
private val LEGACY_SUBRESOURCE_TAGS = setOf("audio", "img", "picture", "source", "track", "video")

/** Only thrown after proving an original complete grapheme exceeds the full unit budget. */
internal class OfflineReadingGraphemeCapacityException : Exception("original grapheme exceeds the current publication unit capacity")

/** Convert original fragments in source order; a completed fragment is the resume checkpoint. */
internal fun stageLegacyReaderUnits(staging: File, manifest: OfflineReadingManifest, durability: OfflineReadingDurability) {
    require(manifest.packageSchemaVersion == 1 && manifest.mediaKind != OfflineReadingMediaKind.Pdf)
    SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
        database.execSQL("CREATE TABLE IF NOT EXISTS publication_units (fragment_ordinal INTEGER NOT NULL, part INTEGER NOT NULL, member_key TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, start_cp INTEGER NOT NULL, end_cp INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL)")
        database.execSQL("CREATE TABLE IF NOT EXISTS units_complete (fragment_ordinal INTEGER PRIMARY KEY, document_word_end INTEGER NOT NULL)")
        database.execSQL("CREATE TABLE IF NOT EXISTS publication_anchors (href_path TEXT NOT NULL, anchor_id TEXT NOT NULL, unit_key TEXT NOT NULL, offset_cp INTEGER NOT NULL, PRIMARY KEY(href_path, anchor_id))")
        // A crash after the candidate rename but before the installed-row commit
        // leaves an orphan directory. Reconciliation removes it; retain the
        // staged source and rebuild only its missing derived unit files.
        if (!File(staging, "publication/units").isDirectory) database.transaction {
            execSQL("DELETE FROM units_complete")
            execSQL("DELETE FROM publication_units")
            execSQL("DELETE FROM publication_anchors")
        }
        val publication = File(staging, "publication").apply { require(mkdir() || isDirectory) }
        val unitDirectory = File(publication, "units").apply { require(mkdir() || isDirectory) }
        durability.syncDirectory(unitDirectory.parentFile!!)
        durability.syncDirectory(staging)
        val assets = manifest.entries.filter { it.path.startsWith("assets/") }.associateBy { it.path }
        var documentStart = 0L
        var documentWords = 0L
        var unitOrdinal = 0L
        // Other connections stage this same database. Close each cursor before
        // staging; source fragment identities stay immutable throughout conversion.
        data class StagedFragment(val ordinal: Long, val id: String, val index: Long, val length: Long)
        var previousFragmentIndex = -1L
        while (true) {
            val row = database.rawQuery(
                "SELECT ordinal, fragment_id, fragment_idx, canonical_length FROM fragments WHERE fragment_idx > ? ORDER BY fragment_idx LIMIT 1",
                arrayOf(previousFragmentIndex.toString()),
            ).use { fragments ->
                if (!fragments.moveToFirst()) null else StagedFragment(
                    fragments.getLong(0), fragments.getString(1), fragments.getLong(2), fragments.getLong(3),
                )
            } ?: break
            previousFragmentIndex = row.index
            val fragment = row.ordinal
            val fragmentId = row.id
            val fragmentIndex = row.index
            val fragmentLength = row.length
            val complete = database.rawQuery("SELECT document_word_end FROM units_complete WHERE fragment_ordinal = ?", arrayOf(fragment.toString())).use {
                if (it.moveToFirst()) it.getLong(0) else null
            }
            if (complete != null) {
                // A crash can commit the fragment before unlinking its spool.
                Files.deleteIfExists(File(staging, "$fragment.utf16").toPath())
                documentStart += fragmentLength
                documentWords = complete
                unitOrdinal += database.rawQuery("SELECT count(*) FROM publication_units WHERE fragment_ordinal = ?", arrayOf(fragment.toString())).use { require(it.moveToFirst()); it.getLong(0) }
                continue
            }
            stageLegacyReaderHtml(staging, fragment)
            stageLegacyReaderTables(staging, fragment)
            val textFile = stageLegacyReaderText(staging, fragment, durability)
            val sourceEnd = database.rawQuery("SELECT coalesce(max(end_cp), 0) FROM html_nodes WHERE fragment_ordinal = ?", arrayOf(fragment.toString())).use { require(it.moveToFirst()); it.getLong(0) }
            val epubTarget = if (manifest.mediaKind != OfflineReadingMediaKind.Epub) JSONObject.NULL else {
                database.rawQuery("SELECT section_id, href_path, anchor_id FROM sections WHERE fragment_id = ? ORDER BY ordinal LIMIT 1", arrayOf(fragmentId)).use {
                    require(it.moveToFirst())
                    JSONObject().put("section_id", it.getString(0)).put("href_path", it.getString(1)).put("anchor_id", if (it.isNull(2)) JSONObject.NULL else it.getString(2))
                }
            }
            var sourcePosition = 0L
            var canonicalPosition = 0L
            var utf16Position = 0
            var part = 0
            var inWord = false
            LegacyReaderText(textFile).use { text ->
                val graphemes = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text.iterator()) }
                data class Candidate(val crop: LegacyReaderCrop, val canonical: LegacyReaderCanonical, val body: JSONObject, val renderStart: Int)
                fun candidate(crop: LegacyReaderCrop): Candidate? {
                    val tables = projectLegacyTableUnit(database, fragment, fragmentId, fragmentLength, sourcePosition, crop) ?: return null
                    val mapped = canonicalizeLegacyReaderCrop(crop, text, utf16Position)
                    val render = mapped.text
                    val renderStart = mapped.renderStart
                    val renderEnd = renderStart + render.length
                    if (renderEnd > text.length) return null
                    var end = mapped.end
                    if (crop.end == sourceEnd) end = text.length
                    if (end - utf16Position > OFFLINE_READING_MAX_UNIT_CODEPOINTS * 2) return null
                    val canonical = buildString(end - utf16Position) { for (index in utf16Position until end) append(text.characterAt(index)) }
                    val codePoints = canonical.codePointCount(0, canonical.length)
                    if (codePoints > OFFLINE_READING_MAX_UNIT_CODEPOINTS) return null
                    val references = linkedMapOf<String, JSONObject>()
                    for (index in 0 until crop.nodes.length()) {
                        val node = crop.nodes.getJSONObject(index)
                        if (node.getString("kind") != "Element") continue
                        val tag = node.getString("name").lowercase(Locale.ROOT)
                        require(tag !in LEGACY_SUBRESOURCE_TAGS ||
                            (manifest.mediaKind == OfflineReadingMediaKind.Epub && tag == "img"))
                        val attributes = node.getJSONArray("attributes")
                        for (item in attributes.length() - 1 downTo 0) {
                            val attribute = attributes.getJSONObject(item)
                            val historicalName = (if (attribute.isNull("namespace")) attribute.getString("name")
                                else "${attribute.getString("namespace")}:${attribute.getString("name")}").lowercase(Locale.ROOT)
                            if (historicalName in LEGACY_URL_ATTRIBUTES) {
                                val value = attribute.getString("value")
                                require(!LEGACY_REMOTE_URL.containsMatchIn(value))
                                require((tag == "a" && historicalName == "href" && value.startsWith('#')) ||
                                    (manifest.mediaKind == OfflineReadingMediaKind.Epub && tag == "img" && historicalName == "src" && value in assets))
                            }
                            if (!attribute.isNull("namespace")) continue
                            val name = attribute.getString("name")
                            // Schema 1 has no embed records; its cards remain their original static content.
                            if (name == "data-nexus-document-embed-id") { attributes.remove(item); continue }
                            if (node.getString("namespace") == "svg" && name in setOf("fill", "stroke", "clip-path")) {
                                attribute.put("value", projectLegacySvgPaint(attribute.getString("value")))
                            }
                            if (node.getString("name") == "img" && name == "src") {
                                val entry = assets[attribute.getString("value")] ?: error("legacy image is not declared")
                                attribute.put("value", "nexus-reader-member:${entry.path}")
                                references[entry.path] = JSONObject().put("kind", "Captured")
                                    .put("member", JSONObject().put("key", entry.path).put("bytes", entry.sizeBytes).put("sha256", entry.sha256))
                                    .put("media_type", entry.mediaType).put("package_href", JSONObject.NULL)
                            }
                        }
                    }
                    val unit = JSONObject().put("fragment_id", fragmentId).put("fragment_idx", fragmentIndex)
                        .put("fragment_document_start_cp", documentStart).put("fragment_length_cp", fragmentLength)
                        .put("document_word_start", documentWords).put("starts_in_word", inWord)
                        .put("start_cp", canonicalPosition).put("end_cp", canonicalPosition + codePoints)
                        .put("render_start_cp", canonicalPosition + canonical.codePointCount(0, renderStart - utf16Position))
                        .put("render_end_cp", canonicalPosition + canonical.codePointCount(0, renderEnd - utf16Position))
                        .put("render_nodes", crop.nodes).put("canonical_text", canonical).put("word_boundaries", JSONObject.NULL)
                        .put("assets", JSONArray(references.values)).put("epub_target", epubTarget)
                        .put("table_contexts", tables).put("document_embeds", JSONArray())
                    return if (unit.toString().toByteArray().size <= OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES) Candidate(crop, mapped, unit, renderStart) else null
                }
                database.transaction {
                    beginLegacyTablePublication(database, fragment)
                    execSQL("DELETE FROM publication_anchors WHERE unit_key IN (SELECT member_key FROM publication_units WHERE fragment_ordinal = ?)", arrayOf(fragment))
                    execSQL("DELETE FROM publication_units WHERE fragment_ordinal = ?", arrayOf(fragment))
                    do {
                        var lower = sourcePosition + 1
                        var upper = minOf(sourceEnd, sourcePosition + OFFLINE_READING_MAX_PUBLICATION_MEMBER_BYTES)
                        var accepted: Candidate? = if (sourceEnd == 0L) {
                            candidate(LegacyReaderCrop(0, JSONArray(), longArrayOf(), longArrayOf(), longArrayOf(), booleanArrayOf(), booleanArrayOf()))
                        } else null
                        while (lower <= upper) {
                            val middle = (lower + upper) / 2
                            val crop = cropLegacyTableUnit(database, fragment, sourcePosition, middle)
                            val unit = crop?.let(::candidate)
                            if (crop != null && unit != null) { accepted = unit; lower = crop.end + 1 }
                            else upper = middle - 1
                        }
                        if (accepted == null && excerptLegacyTableAt(database, fragment, sourcePosition)) continue
                        var chosen = requireNotNull(accepted) { "source element exceeds publication capacity" }
                        var common = 0
                        val rendered = chosen.canonical.text
                        while (common < rendered.length && chosen.renderStart + common < text.length &&
                            rendered[common] == text.characterAt(chosen.renderStart + common)
                        ) common += 1
                        val renderEnd = chosen.renderStart + rendered.length
                        if (common != rendered.length || !graphemes.isBoundary(renderEnd) || !graphemes.isBoundary(chosen.canonical.end)) {
                            val incomplete = if (common != rendered.length || !graphemes.isBoundary(renderEnd)) chosen.renderStart + common
                                else chosen.canonical.end
                            val boundary = if (graphemes.isBoundary(incomplete)) incomplete else graphemes.preceding(incomplete)
                            val following = maxOf(0, boundary - chosen.renderStart)
                            require(following < chosen.canonical.sourceStarts.size)
                            val cut = chosen.canonical.sourceStarts[following]
                            if (cut <= sourcePosition || cut >= chosen.crop.end) {
                                // A failed source mapping alone is a defect. Prove the
                                // separate limitation against the original complete ICU
                                // grapheme and the FULL unit budget, not this crop's space.
                                val atomEnd = graphemes.following(boundary)
                                check(atomEnd > boundary)
                                var atomPosition = boundary
                                var atomCodePoints = 0
                                while (atomPosition < atomEnd && atomCodePoints <= OFFLINE_READING_MAX_UNIT_CODEPOINTS) {
                                    val first = text.characterAt(atomPosition++)
                                    if (first.isHighSurrogate() && atomPosition < atomEnd && text.characterAt(atomPosition).isLowSurrogate()) atomPosition += 1
                                    atomCodePoints += 1
                                }
                                if (atomCodePoints > OFFLINE_READING_MAX_UNIT_CODEPOINTS) throw OfflineReadingGraphemeCapacityException()
                            }
                            require(cut > sourcePosition && cut < chosen.crop.end) { "canonical grapheme exceeds publication capacity" }
                            chosen = requireNotNull(candidate(requireNotNull(cropLegacyTableUnit(database, fragment, sourcePosition, cut))))
                        }
                        val crop = chosen.crop
                        val unit = chosen.body
                        val finalRender = chosen.canonical.text
                        require(graphemes.isBoundary(chosen.renderStart + finalRender.length))
                        require(graphemes.isBoundary(chosen.canonical.end))
                        for (index in finalRender.indices) require(finalRender[index] == text.characterAt(chosen.renderStart + index)) {
                            "mapped partition changed original canonical content"
                        }
                        if (crop.end == sourceEnd) for (index in chosen.renderStart + finalRender.length until text.length) {
                            require(text.characterAt(index).let { it.isWhitespace() || it == '\u0085' }) { "partition omitted canonical source content" }
                        }
                        val bytes = unit.toString().toByteArray()
                        val key = "$fragment-${part++}.json"
                        File(unitDirectory, key).outputStream().use { output -> output.write(bytes); output.fd.sync() }
                        execSQL("INSERT INTO publication_units VALUES(?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(fragment, part - 1, "units/$key", unitOrdinal++, canonicalPosition, unit.getLong("end_cp"), bytes.size, MessageDigest.getInstance("SHA-256").digest(bytes).toHex()))
                        recordLegacyTableRanges(database, fragment, "units/$key", unit.getLong("render_start_cp"), crop, chosen.canonical)
                        if (epubTarget is JSONObject) for ((anchor, offset) in chosen.canonical.anchors) {
                            execSQL("INSERT OR IGNORE INTO publication_anchors VALUES(?, ?, ?, ?)", arrayOf(epubTarget.getString("href_path"), anchor, "units/$key", unit.getLong("render_start_cp") + offset))
                        }
                        val canonical = unit.getString("canonical_text")
                        for (character in canonical) {
                            if (isReaderMetricWordSeparator(character)) inWord = false else if (!inWord) { documentWords += 1; inWord = true }
                        }
                        sourcePosition = crop.end
                        canonicalPosition = unit.getLong("end_cp")
                        utf16Position += canonical.length
                    } while (sourcePosition < sourceEnd)
                    require(canonicalPosition == fragmentLength && utf16Position == text.length)
                    finishLegacyTableUnits(database, staging, fragment, fragmentId)
                    durability.syncDirectory(unitDirectory)
                    execSQL("INSERT INTO units_complete VALUES(?, ?)", arrayOf(fragment, documentWords))
                    // Derived scratch that existed only to convert this
                    // fragment. Dropping the checkpoints with the rows keeps
                    // an interrupted document resumable: an incomplete
                    // fragment is re-derived from its retained source file,
                    // and a complete one is never re-read.
                    execSQL("DELETE FROM html_list_numbers WHERE fragment_ordinal = ?", arrayOf(fragment))
                    execSQL("DELETE FROM html_text WHERE fragment_ordinal = ?", arrayOf(fragment))
                    execSQL("DELETE FROM html_nodes WHERE fragment_ordinal = ?", arrayOf(fragment))
                    execSQL("DELETE FROM html_complete WHERE fragment_ordinal = ?", arrayOf(fragment))
                    execSQL("DELETE FROM text_complete WHERE fragment_ordinal = ?", arrayOf(fragment))
                }
            }
            // The fixed-width copy is released only after its checkpoint
            // commits, so a rolled back fragment still finds the file.
            Files.deleteIfExists(textFile.toPath())
            documentStart += fragmentLength
        }
    }
}
