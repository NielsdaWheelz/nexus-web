package app.nexus.android.offline.reading

import java.text.Normalizer

internal data class LegacyReaderCanonical(
    val text: String,
    val sourceStarts: LongArray,
    val anchors: Map<String, Long>,
    val nodeStarts: LongArray,
    val nodeEnds: LongArray,
    val renderStart: Int,
    val end: Int,
)

/** The existing canonical-text transform, applied only to one admitted crop. */
internal fun canonicalizeLegacyReaderCrop(crop: LegacyReaderCrop, source: LegacyReaderText, start: Int): LegacyReaderCanonical {
    val nodes = crop.nodes
    val blocks = setOf("p", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "div", "section", "article", "header", "footer", "nav", "aside", "figure", "figcaption", "table", "tr", "td", "th")
    data class Ancestor(val index: Int, val name: String, val visible: Boolean)
    val ancestors = ArrayDeque<Ancestor>()
    val raw = StringBuilder()
    val rawSources = mutableListOf<Long>()
    val rawAnchors = linkedMapOf<String, Int>()
    val rawNodeStarts = IntArray(nodes.length())
    val rawNodeEnds = IntArray(nodes.length())
    fun append(character: Char, source: Long) {
        raw.append(character)
        rawSources += source
    }
    // A preceding source character lets new openings emit their separator while
    // retained ancestor openings remain inert. The sentinel is never published.
    val prefix = if (start > 0) 1 else 0
    if (prefix != 0) append('\u0000', -1)
    for (index in 0 until nodes.length()) {
        val node = nodes.getJSONObject(index)
        val parent = if (node.isNull("parent")) null else node.getInt("parent")
        while (ancestors.isNotEmpty() && ancestors.last().index != parent) {
            val closed = ancestors.removeLast()
            rawNodeEnds[closed.index] = raw.length
            if (closed.visible && closed.name in blocks && raw.isNotEmpty() && raw.last() != '\n') append('\n', crop.sourceEnds[closed.index])
        }
        val parentVisible = ancestors.lastOrNull()?.visible ?: true
        rawNodeStarts[index] = raw.length
        when (node.getString("kind")) {
            "Element" -> {
                val name = node.getString("name").lowercase()
                val attributes = node.getJSONArray("attributes")
                var visible = parentVisible && name !in setOf("script", "style", "noscript", "template")
                for (item in 0 until attributes.length()) {
                    val attribute = attributes.getJSONObject(item)
                    if (!attribute.isNull("namespace")) continue
                    val key = attribute.getString("name")
                    if (key == "hidden" || key == "aria-hidden" && attribute.optString("value").lowercase() == "true") visible = false
                }
                if (visible) {
                    if (name in blocks && crop.opened[index] && raw.isNotEmpty() && raw.last() != '\n') append('\n', crop.sourceStarts[index])
                    rawNodeStarts[index] = raw.length
                    for (item in 0 until attributes.length()) {
                        val attribute = attributes.getJSONObject(item)
                        if (attribute.isNull("namespace") && attribute.getString("name") in setOf("id", "name")) {
                            val id = attribute.getString("value")
                            if (id.isNotEmpty()) rawAnchors.putIfAbsent(id, raw.length)
                        }
                    }
                    if (name == "br") append('\n', crop.sourceStarts[index])
                }
                ancestors.addLast(Ancestor(index, name, visible))
            }
            "Text" -> if (parentVisible) {
                var whitespace = false
                var source = crop.sourceStarts[index]
                for (character in node.getString("text")) {
                    val separator = character.isWhitespace() || character == '\u0085'
                    if (!separator) append(character, source) else if (!whitespace) append(' ', source)
                    whitespace = separator
                    if (!character.isHighSurrogate()) source += 1
                }
            }
            "Comment" -> Unit
            else -> error("unsupported source node")
        }
        rawNodeEnds[index] = raw.length
    }
    while (ancestors.isNotEmpty()) {
        val ancestor = ancestors.removeLast()
        rawNodeEnds[ancestor.index] = raw.length
        if (crop.closed[ancestor.index] && ancestor.visible && ancestor.name in blocks && raw.isNotEmpty() && raw.last() != '\n') {
            append('\n', crop.sourceEnds[ancestor.index])
        }
    }
    // Real closing events can own pending canonical whitespace; synthetic crop
    // closures cannot. NFC still spans adjacent source text nodes.
    val rawText = raw.toString()
    val normalized = Normalizer.normalize(rawText, Normalizer.Form.NFC)
    val normalizedStarts = canonicalNormalizationStarts(rawText, normalized)
    val canonical = StringBuilder()
    val origins = mutableListOf<Int>()
    var pendingStart = 0
    var firstNewline = 0
    var newlines = 0
    for (index in normalized.indices) {
        val character = normalized[index]
        when (character) {
            ' ' -> Unit
            '\n' -> {
                if (newlines == 0) firstNewline = index
                newlines = minOf(newlines + 1, 2)
            }
            else -> {
                if (canonical.isNotEmpty()) {
                    if (newlines > 0) repeat(newlines) {
                        canonical.append('\n'); origins += normalizedStarts[firstNewline]
                    } else for (space in pendingStart until index) {
                        canonical.append(' '); origins += normalizedStarts[space]
                    }
                }
                newlines = 0
                canonical.append(character)
                origins += normalizedStarts[index]
                pendingStart = index + 1
            }
        }
    }
    var contentStart = prefix
    while (contentStart < canonical.length && canonical[contentStart] in " \n") contentStart += 1
    val text = canonical.substring(contentStart)
    var renderStart = start
    if (text.isNotEmpty()) while (renderStart < source.length && renderStart - start <= OFFLINE_READING_MAX_UNIT_CODEPOINTS &&
        source.characterAt(renderStart).let { it.isWhitespace() || it == '\u0085' }) renderStart += 1
    val renderEnd = renderStart + text.length
    val markerOrigins = mutableListOf<Int>()
    // Use the retained canonical whitespace. Later source can turn spaces into
    // newlines or expand one emitted newline to the contract's two-newline cap.
    val leading = origins.subList(prefix, contentStart)
    val leadingNewline = (prefix until contentStart).firstOrNull { canonical[it] == '\n' }
    repeat(renderStart - start) { index ->
        markerOrigins += if (leadingNewline != null) origins[leadingNewline]
            else leading.getOrElse(index) { -1 }
    }
    // Existing anchor policy counts canonical points preceding the raw marker.
    // Sorting preserves that definition even when NFC reorders combining marks.
    var character = 0
    while (character < text.length) {
        markerOrigins += origins[contentStart + character]
        character += Character.charCount(text.codePointAt(character))
    }
    var end = renderEnd
    if (canonical.isNotEmpty() && renderEnd <= source.length) {
        if (newlines > 0) {
            while (end < source.length && end - renderEnd < 2 && source.characterAt(end) == '\n') {
                markerOrigins += normalizedStarts[firstNewline]
                end += 1
            }
        } else for (space in pendingStart until normalized.length) {
            if (end >= source.length || source.characterAt(end) != ' ') break
            markerOrigins += normalizedStarts[space]
            end += 1
        }
    }
    val sourceStarts = LongArray(text.length + end - renderEnd) { index ->
        val origin = if (index < text.length) origins[contentStart + index]
            else markerOrigins[markerOrigins.size - (end - renderEnd) + index - text.length]
        rawSources[origin]
    }
    val anchorSources = markerOrigins.toIntArray()
    anchorSources.sort()
    fun canonicalOffset(rawOffset: Int): Long {
        var low = 0
        var high = anchorSources.size
        while (low < high) {
            val middle = (low + high) / 2
            if (anchorSources[middle] < rawOffset) low = middle + 1 else high = middle
        }
        return (low - (renderStart - start)).toLong()
    }
    return LegacyReaderCanonical(text, sourceStarts, rawAnchors.mapValues { canonicalOffset(it.value) },
        LongArray(nodes.length()) { canonicalOffset(rawNodeStarts[it]) },
        LongArray(nodes.length()) { canonicalOffset(rawNodeEnds[it]) }, renderStart, end)
}

/** The existing publisher's NFC source projection, bounded to one admitted crop. */
private fun canonicalNormalizationStarts(raw: String, normalized: String): IntArray {
    if (raw == normalized) return IntArray(raw.length) { it }
    val decomposedSources = mutableMapOf<Int, ArrayDeque<Int>>()
    var source = 0
    while (source < raw.length) {
        val length = Character.charCount(raw.codePointAt(source))
        val decomposed = Normalizer.normalize(raw.substring(source, source + length), Normalizer.Form.NFD)
        var offset = 0
        while (offset < decomposed.length) {
            val point = decomposed.codePointAt(offset)
            decomposedSources.getOrPut(point) { ArrayDeque() }.addLast(source)
            offset += Character.charCount(point)
        }
        source += length
    }
    val decomposed = Normalizer.normalize(raw, Normalizer.Form.NFD)
    val ordered = IntArray(decomposed.codePointCount(0, decomposed.length))
    var offset = 0
    for (index in ordered.indices) {
        val point = decomposed.codePointAt(offset)
        ordered[index] = decomposedSources.getValue(point).removeFirst()
        offset += Character.charCount(point)
    }
    val result = IntArray(normalized.length)
    var rawPoint = 0
    var index = 0
    while (index < normalized.length) {
        val length = Character.charCount(normalized.codePointAt(index))
        val decomposition = Normalizer.normalize(normalized.substring(index, index + length), Normalizer.Form.NFD)
        val count = decomposition.codePointCount(0, decomposition.length)
        var first = ordered[rawPoint]
        repeat(count) { first = minOf(first, ordered[rawPoint++]) }
        repeat(length) { result[index++] = first }
    }
    return result
}
