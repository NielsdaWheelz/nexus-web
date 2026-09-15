package app.nexus.android.offline.reading

import java.nio.charset.StandardCharsets
import java.text.Normalizer
import java.time.OffsetDateTime
import java.util.UUID
import org.jsoup.Jsoup
import org.jsoup.nodes.Comment
import org.jsoup.nodes.DocumentType
import org.jsoup.nodes.Node
import org.jsoup.nodes.XmlDeclaration

internal object OfflineReaderDocumentVerifier {
    private val REMOTE_OR_EXECUTABLE_URL =
        Regex("(?:https?|ftp|file|data|javascript|vbscript):|//", RegexOption.IGNORE_CASE)
    private val EXECUTABLE_TAGS = setOf(
        "applet", "base", "embed", "form", "frame", "frameset", "iframe", "input",
        "link", "meta", "object", "script", "style", "template",
    )
    private val SUBRESOURCE_TAGS = setOf("audio", "img", "picture", "source", "track", "video")
    private val URL_ATTRIBUTES = setOf(
        "action", "background", "cite", "formaction", "href", "ping", "poster", "src", "srcset",
        "xlink:href",
    )

    fun verify(
        bytes: ByteArray,
        manifest: OfflineReadingManifest,
    ) {
        require(bytes.size.toLong() <= OFFLINE_READING_MAX_READER_JSON_BYTES)
        val rootValue = StrictJson.parse(bytes)
        val common = setOf("readerContractVersion", "mediaId", "mediaKind", "title")
        val root = when (manifest.mediaKind) {
            OfflineReadingMediaKind.Pdf -> rootValue.requireObject(common + "documentPath")
            OfflineReadingMediaKind.Epub -> rootValue.requireObject(common + setOf("navigation", "fragments"))
            OfflineReadingMediaKind.WebArticle ->
                rootValue.requireObject(common + setOf("navigation", "fragments"))
        }
        require(root.getValue("readerContractVersion").requireLong() == OFFLINE_READING_READER_CONTRACT_VERSION.toLong())
        require(root.getValue("mediaId").requireString() == manifest.mediaId.toString())
        require(root.getValue("mediaKind").requireString() == manifest.mediaKind.name)
        require(root.getValue("title").requireString() == manifest.title)
        when (manifest.mediaKind) {
            OfflineReadingMediaKind.Pdf -> verifyPdf(root, manifest)
            OfflineReadingMediaKind.Epub -> verifyEpub(root, manifest)
            OfflineReadingMediaKind.WebArticle -> verifyWeb(root, manifest)
        }
    }

    private fun verifyPdf(
        root: Map<String, StrictJson>,
        manifest: OfflineReadingManifest,
    ) {
        val documentPath = root.getValue("documentPath").requireString()
        requireSafePackagePath(documentPath)
        require(manifest.entries.map { it.path }.toSet() == setOf("reader.json", documentPath))
        require(manifest.entries.single { it.path == documentPath }.mediaType == "application/pdf")
    }

    private data class FragmentCoordinate(val id: String, val index: Long, val length: Long)

    private fun verifyEpub(
        root: Map<String, StrictJson>,
        manifest: OfflineReadingManifest,
    ) {
        val declaredPaths = manifest.entries.map { it.path }.toSet()
        val referencedAssets = mutableSetOf<String>()
        var wordStart = 0L
        val fragments = root.getValue("fragments").requireArray().map { fragment ->
            val fields = fragment.requireObject(setOf(
                "fragment_id", "fragment_idx", "href_path", "generation", "html_sanitized",
                "canonical_text", "char_count", "word_count", "document_word_start", "created_at",
                "asset_paths",
            ))
            val identifier = requireUuid(fields.getValue("fragment_id"))
            val index = fields.getValue("fragment_idx").requireLong().also { require(it >= 0) }
            requireSafeHrefPath(fields.getValue("href_path").requireString())
            require(fields.getValue("generation").requireLong() == manifest.readerGeneration)
            OffsetDateTime.parse(fields.getValue("created_at").requireString())
            val canonicalText = fields.getValue("canonical_text").requireString()
            val length = canonicalText.codePointCount(0, canonicalText.length).toLong()
            require(fields.getValue("char_count").requireLong() == length)
            val words = fields.getValue("word_count").requireLong().also { require(it >= 0) }
            require(fields.getValue("document_word_start").requireLong() == wordStart)
            wordStart = Math.addExact(wordStart, words)
            val paths = fields.getValue("asset_paths").requireArray().map { value ->
                value.requireString().also(::requireSafePackagePath)
            }
            require(paths == paths.sortedWith(compareByUtf8Path()) && paths.size == paths.toSet().size)
            require(paths.all { it.startsWith("assets/") && it in declaredPaths })
            require(validateSanitizedHtml(fields.getValue("html_sanitized").requireString(), false) == paths.toSet())
            referencedAssets += paths
            FragmentCoordinate(identifier, index, length)
        }
        require(declaredPaths == referencedAssets + "reader.json")
        verifyNavigation(root.getValue("navigation"), manifest, "epub", fragments)
    }

    private fun verifyWeb(
        root: Map<String, StrictJson>,
        manifest: OfflineReadingManifest,
    ) {
        require(manifest.entries.map { it.path }.toSet() == setOf("reader.json"))
        val fragments = root.getValue("fragments").requireArray().map { fragment ->
            val fields = fragment.requireObject(setOf(
                "fragmentId", "fragmentIdx", "htmlSanitized", "canonicalText", "createdAt",
            ))
            val identifier = requireUuid(fields.getValue("fragmentId"))
            val index = fields.getValue("fragmentIdx").requireLong().also { require(it >= 0) }
            OffsetDateTime.parse(fields.getValue("createdAt").requireString())
            val canonicalText = fields.getValue("canonicalText").requireString()
            require(validateSanitizedHtml(fields.getValue("htmlSanitized").requireString(), true).isEmpty())
            FragmentCoordinate(identifier, index, canonicalText.codePointCount(0, canonicalText.length).toLong())
        }
        verifyNavigation(root.getValue("navigation"), manifest, "web_article", fragments)
    }

    private fun verifyNavigation(
        value: StrictJson,
        manifest: OfflineReadingManifest,
        kind: String,
        fragments: List<FragmentCoordinate>,
    ) {
        val fields = value.requireObject(setOf(
            "media_id", "kind", "generation", "fragments", "sections", "toc_nodes", "landmarks", "page_list",
        ))
        require(fields.getValue("media_id").requireString() == manifest.mediaId.toString())
        require(fields.getValue("kind").requireString() == kind)
        require(fields.getValue("generation").requireLong() == manifest.readerGeneration)
        require(fragments.isNotEmpty() && fragments.map { it.id }.toSet().size == fragments.size)
        require(fragments.map { it.index } == fragments.map { it.index }.distinct().sorted())
        val declaredFragments = fields.getValue("fragments").requireArray().map { fragment ->
            val item = fragment.requireObject(setOf("fragment_id", "fragment_idx", "char_count"))
            FragmentCoordinate(requireUuid(item.getValue("fragment_id")), item.getValue("fragment_idx").requireLong(), item.getValue("char_count").requireLong())
        }
        require(declaredFragments == fragments)
        val byId = fragments.associateBy { it.id }
        val fragmentStarts = mutableMapOf<String, Long>()
        var documentOffset = 0L
        fragments.forEach { fragment ->
            fragmentStarts[fragment.id] = documentOffset
            documentOffset = Math.addExact(documentOffset, fragment.length)
        }
        fun point(value: StrictJson): Long {
            val item = value.requireObject(setOf("fragment_id", "offset"))
            val fragment = byId.getValue(item.getValue("fragment_id").requireString())
            val offset = item.getValue("offset").requireLong()
            require(offset in 0..fragment.length)
            return Math.addExact(fragmentStarts.getValue(fragment.id), offset)
        }
        val parents = mutableMapOf<String, String?>()
        val starts = mutableMapOf<String, Long>()
        val ends = mutableMapOf<String, Long>()
        fields.getValue("sections").requireArray().forEach { section ->
            val item = section.requireObject(setOf("section_id", "label", "parent_section_id", "target", "anchor_id", "extent", "source"))
            val identifier = item.getValue("section_id").requireString()
            require(identifier !in parents)
            item.getValue("label").requireString()
            require(item.getValue("source").requireString() in setOf("Publisher", "Heading", "Both", "InferredNumberedEntry"))
            parents[identifier] = presence(item.getValue("parent_section_id"))?.requireString()
            presence(item.getValue("anchor_id"))?.requireString()
            val targetFields = item.getValue("target").requireObject(setOf("fragment_id", "offset"))
            val target = point(item.getValue("target"))
            starts[identifier] = target
            presence(item.getValue("extent"))?.let { extent ->
                val range = extent.requireObject(setOf("start", "end"))
                val startFields = range.getValue("start").requireObject(setOf("fragment_id", "offset"))
                val start = point(range.getValue("start"))
                val end = point(range.getValue("end"))
                require(startFields.getValue("fragment_id") == targetFields.getValue("fragment_id"))
                require(start == target && end >= start)
                ends[identifier] = end
            }
        }
        require(starts.values.zipWithNext().all { (left, right) -> left <= right })
        parents.keys.forEach { identifier ->
            val seen = mutableSetOf(identifier)
            var parent = parents.getValue(identifier)
            while (parent != null) {
                require(parent in parents && seen.add(parent))
                val end = ends[identifier]
                val parentEnd = ends[parent]
                if (end != null && parentEnd != null) {
                    require(starts.getValue(identifier) >= starts.getValue(parent))
                    require(end <= parentEnd)
                }
                parent = parents.getValue(parent)
            }
        }
        val nodeIds = mutableSetOf<String>()
        fun node(value: StrictJson) {
            val item = value.requireObject(setOf("id", "label", "section_id", "children"))
            require(nodeIds.add(item.getValue("id").requireString()))
            item.getValue("label").requireString()
            presence(item.getValue("section_id"))?.let { require(it.requireString() in parents) }
            item.getValue("children").requireArray().forEach(::node)
        }
        fields.getValue("toc_nodes").requireArray().forEach(::node)
        listOf("landmarks", "page_list").forEach { name ->
            fields.getValue(name).requireArray().forEach { location ->
                val item = location.requireObject(setOf("id", "label", "target"))
                item.getValue("id").requireString()
                item.getValue("label").requireString()
                presence(item.getValue("target"))?.let(::point)
            }
        }
    }

    private fun presence(value: StrictJson): StrictJson? {
        val kind = (value as? StrictJson.ObjectValue)?.fields?.get("kind")?.requireString()
        return when (kind) {
            "Absent" -> { value.requireObject(setOf("kind")); null }
            "Present" -> value.requireObject(setOf("kind", "value")).getValue("value")
            else -> error("navigation presence discriminator is invalid")
        }
    }

    private fun requireUuid(value: StrictJson): String = value.requireString().also {
        require(UUID.fromString(it).toString() == it)
    }

    private fun validateSanitizedHtml(html: String, webTextOnly: Boolean): Set<String> {
        val document = Jsoup.parseBodyFragment(html)
        require(document.childNodes().none(::forbiddenHtmlNode))
        val assets = mutableSetOf<String>()
        document.body().getAllElements().drop(1).forEach { element ->
            val tag = element.normalName()
            require(tag !in EXECUTABLE_TAGS)
            require(!(webTextOnly && tag in SUBRESOURCE_TAGS))
            require(webTextOnly || tag !in SUBRESOURCE_TAGS - "img")
            element.attributes().forEach { attribute ->
                val name = attribute.key.lowercase()
                val value = attribute.value
                require(!name.startsWith("on") && name !in setOf("srcdoc", "style"))
                if (name !in URL_ATTRIBUTES) return@forEach
                require(!REMOTE_OR_EXECUTABLE_URL.containsMatchIn(value))
                when {
                    tag == "a" && name == "href" && value.startsWith('#') -> Unit
                    !webTextOnly && tag == "img" && name == "src" -> {
                        requireSafePackagePath(value)
                        assets += value
                    }
                    else -> error("offline HTML contains an undeclared URL")
                }
            }
        }
        return assets
    }

    private fun forbiddenHtmlNode(node: Node): Boolean {
        if (node is Comment || node is DocumentType || node is XmlDeclaration) return true
        return node.childNodes().any(::forbiddenHtmlNode)
    }

    private fun requireSafeHrefPath(path: String) {
        require(path.isNotEmpty() && path.toByteArray().size <= 2048)
        require(Normalizer.normalize(path, Normalizer.Form.NFC) == path)
        require(!path.startsWith('/') && !path.startsWith('\\') && '\\' !in path)
        require('?' !in path && '#' !in path)
        require(!Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(path))
        require(path.split('/').all { it !in setOf("", ".", "..") })
    }

    private fun compareByUtf8Path(): Comparator<String> = Comparator { left, right ->
        val a = left.toByteArray(StandardCharsets.UTF_8)
        val b = right.toByteArray(StandardCharsets.UTF_8)
        for (index in 0 until minOf(a.size, b.size)) {
            val comparison = (a[index].toInt() and 0xff) - (b[index].toInt() and 0xff)
            if (comparison != 0) return@Comparator comparison
        }
        a.size - b.size
    }
}
