package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import nu.validator.htmlparser.common.TokenHandler
import nu.validator.htmlparser.common.XmlViolationPolicy
import nu.validator.htmlparser.impl.ElementName
import nu.validator.htmlparser.impl.HtmlAttributes
import nu.validator.htmlparser.impl.Tokenizer
import nu.validator.htmlparser.impl.UTF16Buffer
import org.json.JSONArray
import org.json.JSONObject

/** HTML integer-prefix parsing, within the reader engines' signed 32-bit range. */
private fun listInteger(value: String?): Int? {
    if (value == null) return null
    var position = 0
    while (position < value.length && value[position] in " \t\n\r\u000c") position += 1
    val negative = position < value.length && value[position] == '-'
    if (position < value.length && value[position] in "+-") position += 1
    if (position == value.length || value[position] !in '0'..'9') return null
    val limit = if (negative) 2147483648L else 2147483647L
    var number = 0L
    while (position < value.length && value[position] in '0'..'9') {
        val digit = value[position++] - '0'
        if (number > (limit - digit) / 10) return null
        number = number * 10 + digit
    }
    return (if (negative) -number else number).toInt()
}

/** Freeze the serialized schema-1 source tree without constructing a document DOM. */
internal fun stageLegacyReaderHtml(staging: File, fragmentOrdinal: Long) {
    SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
        database.execSQL("CREATE TABLE IF NOT EXISTS html_complete (fragment_ordinal INTEGER PRIMARY KEY, source_sha256 TEXT NOT NULL)")
        database.execSQL("CREATE TABLE IF NOT EXISTS html_nodes (fragment_ordinal INTEGER NOT NULL, ordinal INTEGER NOT NULL, parent INTEGER, kind TEXT NOT NULL, namespace TEXT, name TEXT, attributes_json TEXT, start_cp INTEGER NOT NULL, end_cp INTEGER NOT NULL, PRIMARY KEY(fragment_ordinal, ordinal))")
        database.execSQL("CREATE TABLE IF NOT EXISTS html_text (fragment_ordinal INTEGER NOT NULL, node INTEGER NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL, start_cp INTEGER NOT NULL, end_cp INTEGER NOT NULL, PRIMARY KEY(fragment_ordinal, node, part))")
        database.execSQL("CREATE TABLE IF NOT EXISTS html_list_numbers (fragment_ordinal INTEGER NOT NULL, node INTEGER NOT NULL, parent INTEGER NOT NULL, number TEXT NOT NULL, relative INTEGER NOT NULL, PRIMARY KEY(fragment_ordinal, node))")
        database.execSQL("CREATE INDEX IF NOT EXISTS html_nodes_source ON html_nodes(fragment_ordinal, start_cp)")
        database.execSQL("CREATE INDEX IF NOT EXISTS html_text_source ON html_text(fragment_ordinal, node, start_cp)")
        database.execSQL("CREATE INDEX IF NOT EXISTS html_list_owner ON html_list_numbers(fragment_ordinal, parent)")
        val (path, digest) = database.rawQuery("SELECT html_path, html_sha256 FROM fragments WHERE ordinal = ?", arrayOf(fragmentOrdinal.toString())).use {
            require(it.moveToFirst())
            it.getString(0) to it.getString(1)
        }
        database.rawQuery("SELECT source_sha256 FROM html_complete WHERE fragment_ordinal = ?", arrayOf(fragmentOrdinal.toString())).use {
            if (it.moveToFirst()) {
                require(it.getString(0) == digest)
                return
            }
        }
        data class OrderedList(val ordinal: Long, var next: Int, var relative: Boolean, val reversed: Boolean, var count: Long = 0)
        data class OpenElement(val ordinal: Long, val name: String, val namespace: String, val htmlIntegration: Boolean, val list: OrderedList?, val suppressChildren: Boolean, var tableBody: Long? = null)
        val ancestors = ArrayDeque<OpenElement>()
        val voidTags = setOf("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr")
        var ordinal = 0L
        var position = 0L
        var textNode: Long? = null
        var textPart = 0L
        var pendingSurrogate: Char? = null
        val handler = object : TokenHandler {
            lateinit var tokenizer: Tokenizer
            override fun startTokenization(self: Tokenizer) { tokenizer = self }
            override fun wantsComments() = true
            override fun comment(buffer: CharArray, start: Int, length: Int) = error("legacy source contains a comment")
            override fun doctype(name: String?, publicId: String?, systemId: String?, forceQuirks: Boolean) = error("legacy source contains a declaration")
            override fun endTokenization() = Unit
            override fun ensureBufferSpace(inputLength: Int) = Unit
            override fun cdataSectionAllowed() = ancestors.lastOrNull()?.namespace.let { it != null && it != "html" }
            override fun zeroOriginatingReplacementCharacter() = characters(charArrayOf('\ufffd'), 0, 1)
            override fun eof() { require(ancestors.isEmpty() && pendingSurrogate == null) }

            override fun startTag(element: ElementName, attributes: HtmlAttributes, selfClosing: Boolean) {
                require(pendingSurrogate == null)
                textNode = null
                val name = element.name
                val parent = ancestors.lastOrNull()
                var namespace = parent?.namespace ?: "html"
                if (parent?.htmlIntegration == true ||
                    namespace == "mathml" && parent?.name in setOf("mi", "mo", "mn", "ms", "mtext") && name !in setOf("mglyph", "malignmark") ||
                    namespace == "mathml" && parent?.name == "annotation-xml" && name == "svg"
                ) namespace = "html"
                if (namespace == "html" && name in setOf("svg", "math")) namespace = if (name == "svg") "svg" else "mathml"
                val integration = namespace == "svg" && name in setOf("foreignobject", "desc", "title") ||
                    namespace == "mathml" && name == "annotation-xml" && attributes.getValue("encoding")?.lowercase() in setOf("text/html", "application/xhtml+xml")
                val renderName = if (namespace == "svg") element.camelCaseName else name
                if (namespace == "svg") attributes.adjustForSvg()
                if (namespace == "mathml") attributes.adjustForMath()
                val projected = JSONArray()
                for (index in 0 until attributes.length) {
                    val attribute = attributes.getAttributeName(index)
                    // The source projector expands known XML attributes even
                    // on HTML elements. The parser owns those name mappings.
                    val attributeNamespace = when (attribute.getUri(nu.validator.htmlparser.impl.AttributeName.SVG)) {
                        "" -> null
                        "http://www.w3.org/1999/xlink" -> "xlink"
                        "http://www.w3.org/XML/1998/namespace" -> "xml"
                        "http://www.w3.org/2000/xmlns/" -> "xmlns"
                        else -> error("legacy source has an unsupported attribute namespace")
                    }
                    val local = if (attributeNamespace == null) attributes.getLocalName(index)
                        else attribute.getLocal(nu.validator.htmlparser.impl.AttributeName.SVG)
                    projected.put(JSONObject().put("namespace", attributeNamespace ?: JSONObject.NULL)
                        .put("name", local).put("value", attributes.getValue(index)))
                }
                if (parent?.namespace == "html" && parent.name == "table") {
                    if (namespace == "html" && name == "tr") {
                        if (parent.tableBody == null) {
                            parent.tableBody = ordinal++
                            database.execSQL("INSERT INTO html_nodes VALUES(?, ?, ?, 'Element', 'html', 'tbody', '[]', ?, ?)",
                                arrayOf(fragmentOrdinal, parent.tableBody, parent.ordinal, position, position + 1))
                            position += 1
                        }
                    } else if (parent.tableBody != null) {
                        database.execSQL("UPDATE html_nodes SET end_cp = ? WHERE fragment_ordinal = ? AND ordinal = ?", arrayOf(position, fragmentOrdinal, parent.tableBody))
                        parent.tableBody = null
                    }
                }
                val id = ordinal++
                val hidden = if (namespace == "html") attributes.getValue("hidden") else null
                val hasBox = parent?.suppressChildren != true && (hidden == null || hidden.equals("until-found", ignoreCase = true))
                if (namespace == "html" && name == "li" && parent?.list != null && hasBox) {
                    val list = parent.list
                    listInteger(attributes.getValue("value"))?.let {
                        list.next = it
                        list.relative = false
                    }
                    database.execSQL("INSERT INTO html_list_numbers VALUES(?, ?, ?, ?, ?)", arrayOf(fragmentOrdinal, id, list.ordinal, list.next.toString(), if (list.relative) 1 else 0))
                    list.next = (list.next.toLong() + if (list.reversed) -1 else 1).coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
                    list.count += 1
                }
                database.execSQL("INSERT INTO html_nodes VALUES(?, ?, ?, 'Element', ?, ?, ?, ?, ?)",
                    arrayOf(fragmentOrdinal, id, parent?.tableBody ?: parent?.ordinal, namespace, renderName, projected.toString(), position, position + 1))
                position += 1
                if (namespace == "html" && name in voidTags || namespace != "html" && selfClosing) return
                val list = if (namespace == "html" && name == "ol") {
                    val reversed = attributes.getValue("reversed") != null
                    val number = listInteger(attributes.getValue("start"))
                    OrderedList(id, number ?: if (reversed) 0 else 1, number == null && reversed, reversed)
                } else if (namespace == "html" && name in setOf("ul", "menu")) null else parent?.list
                ancestors.addLast(OpenElement(id, name, namespace, integration, list, !hasBox || hidden != null))
                if (namespace == "html" && name in setOf("title", "textarea")) {
                    tokenizer.setStateAndEndTagExpectation(Tokenizer.RCDATA, element)
                }
            }

            override fun endTag(element: ElementName) {
                require(pendingSurrogate == null)
                textNode = null
                require(ancestors.lastOrNull()?.name == element.name)
                val closed = ancestors.removeLast()
                if (closed.namespace == "html" && closed.name == "ol" && closed.list?.reversed == true) {
                    // Relative values precede the first explicit li[value] and
                    // therefore fit the source's bounded owned-item count.
                    database.execSQL("UPDATE html_list_numbers SET number = CAST(CAST(number AS INTEGER) + ? AS TEXT), relative = 0 WHERE fragment_ordinal = ? AND parent = ? AND relative = 1", arrayOf(closed.list.count, fragmentOrdinal, closed.ordinal))
                }
                database.execSQL("UPDATE html_nodes SET end_cp = ? WHERE fragment_ordinal = ? AND ordinal = ?", arrayOf(position, fragmentOrdinal, closed.ordinal))
                if (closed.tableBody != null) database.execSQL("UPDATE html_nodes SET end_cp = ? WHERE fragment_ordinal = ? AND ordinal = ?", arrayOf(position, fragmentOrdinal, closed.tableBody))
            }

            override fun characters(buffer: CharArray, start: Int, length: Int) {
                if (length == 0) return
                var value = (pendingSurrogate?.toString() ?: "") + String(buffer, start, length)
                pendingSurrogate = if (value.last().isHighSurrogate()) value.last() else null
                if (pendingSurrogate != null) value = value.dropLast(1)
                if (value.isEmpty()) return
                if (textNode == null) {
                    textNode = ordinal++
                    textPart = 0
                    val parent = ancestors.lastOrNull()
                    database.execSQL("INSERT INTO html_nodes VALUES(?, ?, ?, 'Text', NULL, NULL, NULL, ?, ?)",
                        arrayOf(fragmentOrdinal, textNode, parent?.tableBody ?: parent?.ordinal, position, position))
                }
                val end = position + value.codePointCount(0, value.length)
                database.execSQL("INSERT INTO html_text VALUES(?, ?, ?, ?, ?, ?)", arrayOf(fragmentOrdinal, textNode, textPart++, value, position, end))
                position = end
                database.execSQL("UPDATE html_nodes SET end_cp = ? WHERE fragment_ordinal = ? AND ordinal = ?", arrayOf(position, fragmentOrdinal, textNode))
            }
        }
        database.transaction {
            execSQL("DELETE FROM html_list_numbers WHERE fragment_ordinal = ?", arrayOf(fragmentOrdinal))
            execSQL("DELETE FROM html_text WHERE fragment_ordinal = ?", arrayOf(fragmentOrdinal))
            execSQL("DELETE FROM html_nodes WHERE fragment_ordinal = ?", arrayOf(fragmentOrdinal))
            val tokenizer = Tokenizer(handler)
            tokenizer.setXmlnsPolicy(XmlViolationPolicy.ALLOW)
            tokenizer.setCommentPolicy(XmlViolationPolicy.ALLOW)
            tokenizer.start()
            try {
                File(staging, path).bufferedReader().use { input ->
                    val characters = CharArray(DEFAULT_BUFFER_SIZE)
                    var lastWasCr = false
                    while (true) {
                        val count = input.read(characters)
                        if (count < 0) break
                        val buffer = UTF16Buffer(characters, 0, count)
                        while (buffer.hasMore()) {
                            buffer.adjust(lastWasCr)
                            lastWasCr = false
                            if (buffer.hasMore()) lastWasCr = tokenizer.tokenizeBuffer(buffer)
                        }
                    }
                }
                tokenizer.eof()
            } finally {
                tokenizer.end()
            }
            execSQL("INSERT INTO html_complete VALUES(?, ?)", arrayOf(fragmentOrdinal, digest))
        }
    }
}
