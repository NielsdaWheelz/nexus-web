package app.nexus.android.offline.reading

import java.nio.charset.StandardCharsets
import java.net.URI
import java.text.Normalizer
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
        "action", "background", "cite", "formaction", "href", "poster", "src", "srcset",
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
            OfflineReadingMediaKind.Epub -> rootValue.requireObject(common + setOf("navigation", "sections"))
            OfflineReadingMediaKind.WebArticle ->
                rootValue.requireObject(common + setOf("navigation", "fragments"))
        }
        require(root.getValue("readerContractVersion").requireLong() == 1L)
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

    private fun verifyEpub(
        root: Map<String, StrictJson>,
        manifest: OfflineReadingManifest,
    ) {
        val navigationIds = root.getValue("navigation").requireArray().map { item ->
            val fields = item.requireObject(setOf("sectionId", "label"))
            requireBoundedText(fields.getValue("label").requireString(), OFFLINE_READING_MAX_TITLE_CODEPOINTS)
            requireBoundedText(fields.getValue("sectionId").requireString(), 256)
        }
        require(navigationIds.toSet().size == navigationIds.size)
        val declaredPaths = manifest.entries.map { it.path }.toSet()
        val sectionIds = root.getValue("sections").requireArray().mapIndexed { index, section ->
            val fields = section.requireObject(
                setOf(
                    "sectionId",
                    "ordinal",
                    "fragmentId",
                    "fragmentIdx",
                    "hrefPath",
                    "anchorId",
                    "startOffset",
                    "endOffset",
                    "htmlSanitized",
                    "canonicalText",
                    "assetPaths",
                )
            )
            val sectionId = requireBoundedText(fields.getValue("sectionId").requireString(), 256)
            require(fields.getValue("ordinal").requireLong() == index.toLong())
            val fragmentIdText = fields.getValue("fragmentId").requireString()
            require(UUID.fromString(fragmentIdText).toString() == fragmentIdText)
            require(fields.getValue("fragmentIdx").requireLong() >= 0)
            requireSafeHrefPath(fields.getValue("hrefPath").requireString())
            val anchor = fields.getValue("anchorId")
            require(
                anchor is StrictJson.NullValue ||
                    (anchor is StrictJson.StringValue &&
                        anchor.value.isNotBlank() &&
                        anchor.value.codePointCount(0, anchor.value.length) <= 256)
            )
            val startOffset = fields.getValue("startOffset").requireLong()
            val endOffset = fields.getValue("endOffset").requireLong()
            require(startOffset >= 0 && endOffset >= startOffset)
            val canonicalText = fields.getValue("canonicalText").requireString()
            require(endOffset <= canonicalText.codePointCount(0, canonicalText.length))
            val assetPaths = fields.getValue("assetPaths").requireArray().map { value ->
                value.requireString().also(::requireSafePackagePath)
            }
            require(assetPaths == assetPaths.sortedWith(compareByUtf8Path()))
            require(assetPaths.toSet().size == assetPaths.size)
            require(assetPaths.all { it.startsWith("assets/") && it in declaredPaths })
            require(
                validateSanitizedHtml(
                    fields.getValue("htmlSanitized").requireString(),
                    webTextOnly = false,
                ) == assetPaths.toSet()
            )
            sectionId
        }
        require(sectionIds.isNotEmpty() && sectionIds.toSet().size == sectionIds.size)
        require(navigationIds.all { it in sectionIds })
        val referencedAssets = root.getValue("sections").requireArray().flatMap { section ->
            section.requireObject(
                setOf(
                    "sectionId",
                    "ordinal",
                    "fragmentId",
                    "fragmentIdx",
                    "hrefPath",
                    "anchorId",
                    "startOffset",
                    "endOffset",
                    "htmlSanitized",
                    "canonicalText",
                    "assetPaths",
                )
            ).getValue("assetPaths").requireArray().map { it.requireString() }
        }.toSet()
        require(declaredPaths == referencedAssets + "reader.json")
    }

    private fun verifyWeb(
        root: Map<String, StrictJson>,
        manifest: OfflineReadingManifest,
    ) {
        require(manifest.entries.map { it.path }.toSet() == setOf("reader.json"))
        val navigationIds = root.getValue("navigation").requireArray().map { item ->
            val fields = item.requireObject(setOf("fragmentId", "label"))
            requireBoundedText(fields.getValue("label").requireString(), OFFLINE_READING_MAX_TITLE_CODEPOINTS)
            requireBoundedText(fields.getValue("fragmentId").requireString(), 256)
        }
        require(navigationIds.toSet().size == navigationIds.size)
        val fragmentIds = root.getValue("fragments").requireArray().mapIndexed { index, fragment ->
            val fields = fragment.requireObject(
                setOf("fragmentId", "ordinal", "htmlSanitized", "canonicalText")
            )
            val fragmentId = requireBoundedText(fields.getValue("fragmentId").requireString(), 256)
            require(fields.getValue("ordinal").requireLong() == index.toLong())
            fields.getValue("canonicalText").requireString()
            val html = fields.getValue("htmlSanitized").requireString()
            require(validateSanitizedHtml(html, webTextOnly = true).isEmpty())
            fragmentId
        }
        require(fragmentIds.isNotEmpty() && fragmentIds.toSet().size == fragmentIds.size)
        require(navigationIds.all { it in fragmentIds })
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

    private fun requireBoundedText(value: String, maximumCodePoints: Int): String {
        require(value.isNotBlank())
        require(value.codePointCount(0, value.length) <= maximumCodePoints)
        return value
    }

    private fun requireSafeHrefPath(path: String) {
        require(path.isNotBlank() && path.toByteArray().size <= 2048)
        require(Normalizer.normalize(path, Normalizer.Form.NFC) == path)
        require(!path.startsWith('/') && !path.startsWith('\\') && '\\' !in path)
        val parsed = URI(path)
        require(
            parsed.scheme == null && parsed.rawAuthority == null && parsed.rawQuery == null &&
                parsed.rawFragment == null
        )
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
