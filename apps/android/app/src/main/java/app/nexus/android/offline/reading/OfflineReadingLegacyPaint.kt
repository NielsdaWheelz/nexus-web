package app.nexus.android.offline.reading

import android.net.Uri
import org.htmlunit.cssparser.parser.CssCharStream
import org.htmlunit.cssparser.parser.javacc.CSS3ParserConstants
import org.htmlunit.cssparser.parser.javacc.CSS3ParserTokenManager
import org.htmlunit.cssparser.parser.javacc.CharStream
import org.htmlunit.cssparser.parser.javacc.TokenMgrException
import org.json.JSONObject
import java.io.StringReader

/** Migration only. The maintained lexer owns token boundaries; no CSS AST is serialized. */
internal fun projectLegacySvgPaint(value: String): Any {
    val next = paintTokenReader(value)
    var token = next()
    if (token.kind == CSS3ParserConstants.EOF) return value
    var reference: String? = null
    var referenceEnd = 0
    if (token.kind == CSS3ParserConstants.URI) {
        val body = token.raw.substringAfter('(').dropLast(1).trim(::cssWhitespace)
        val quoted = body.startsWith('"') || body.startsWith('\'')
        require(!quoted || body.length >= 2 && body.last() == body.first()) { "Malformed legacy SVG URL" }
        reference = decodePaintEscape(if (quoted) body.substring(1, body.length - 1) else body, quoted)
        referenceEnd = token.end
        token = next()
    } else if (token.functionName() == "url") {
        val bodyStart = token.end
        var close = next()
        while (close.kind != CSS3ParserConstants.RROUND && close.kind != CSS3ParserConstants.EOF) close = next()
        val bodyEnd = if (close.kind == CSS3ParserConstants.EOF) value.length else close.end - 1
        // CSS Syntax closes a URL/function at EOF. Reuse the maintained URI
        // rule after normalizing only the decoded function name/implicit close.
        val url = paintTokenReader("url(" + value.substring(bodyStart, bodyEnd) + ")")
        val normalized = url()
        require(normalized.kind == CSS3ParserConstants.URI && url().kind == CSS3ParserConstants.EOF) { "Malformed legacy SVG URL" }
        val body = normalized.raw.substringAfter('(').dropLast(1).trim(::cssWhitespace)
        val quoted = body.startsWith('"') || body.startsWith('\'')
        reference = decodePaintEscape(if (quoted) body.substring(1, body.length - 1) else body, quoted)
        referenceEnd = if (close.kind == CSS3ParserConstants.EOF) value.length else close.end
        token = if (close.kind == CSS3ParserConstants.EOF) close else next()
    }
    val closes = ArrayDeque<Char>()
    var hasFallback = false
    while (token.kind != CSS3ParserConstants.EOF) {
        require(token.kind != CSS3ParserConstants.URI && token.functionName() != "url") {
            "Legacy SVG paint contains a nested resource"
        }
        hasFallback = true
        if (token.kind != CSS3ParserConstants.STRING) {
            val raw = token.raw
            require(raw != "\\" && raw != "\"" && raw != "'") { "Malformed legacy SVG paint" }
            when {
                token.functionName() != null || raw == "(" -> closes.addLast(')')
                raw == "[" -> closes.addLast(']')
                raw == "{" -> closes.addLast('}')
                raw == ")" || raw == "]" || raw == "}" -> {
                    require(closes.isNotEmpty() && closes.removeLast() == raw[0]) { "Malformed legacy SVG paint" }
                }
            }
        }
        token = next()
    }
    // Component blocks are implicitly closed by CSS Syntax at EOF.
    if (reference == null) return value
    require(reference.startsWith('#') && reference.length > 1) { "Legacy SVG paint references an external resource" }
    return JSONObject().put("kind", "LocalFragment")
        .put("fragment_id", Uri.decode(reference.substring(1)))
        .put("fallback", if (hasFallback) value.substring(referenceEnd).trim(::cssWhitespace) else JSONObject.NULL)
}

private fun paintTokenReader(value: String): () -> PaintToken {
    val stream = PaintCharStream(CssCharStream(StringReader(value), 1, 1))
    val lexer = CSS3ParserTokenManager(stream)
    return fun(): PaintToken {
        try {
            var token = lexer.nextToken
            while (token.kind == CSS3ParserConstants.S) token = lexer.nextToken
            return PaintToken(token.kind, if (token.kind == CSS3ParserConstants.EOF) ""
                else value.substring(stream.start, stream.offset), stream.offset)
        } catch (error: TokenMgrException) {
            throw IllegalArgumentException("Malformed legacy SVG paint", error)
        }
    }
}

private data class PaintToken(val kind: Int, val raw: String, val end: Int) {
    fun functionName(): String? = if (kind != CSS3ParserConstants.STRING && raw.length > 1 && raw.endsWith('('))
        decodePaintEscape(raw.dropLast(1), false).lowercase(java.util.Locale.ROOT) else null
}

/** Count actual lexer consumption, including lookahead/backup and skipped comments. */
private class PaintCharStream(private val delegate: CharStream) : CharStream by delegate {
    var offset = 0
        private set
    var start = 0
        private set
    override fun beginToken(): Char {
        start = offset
        return delegate.beginToken().also { offset++ }
    }
    override fun readChar(): Char = delegate.readChar().also { offset++ }
    override fun backup(amount: Int) {
        delegate.backup(amount)
        offset -= amount
    }
}

private fun cssWhitespace(char: Char) = char == ' ' || char == '\t' || char == '\r' || char == '\n' || char == '\u000c'

/** CSS Syntax consume-escaped-code-point; unlike HtmlUnit's AST decoder, this preserves supplementary scalars. */
private fun decodePaintEscape(value: String, string: Boolean): String = buildString {
    var offset = 0
    while (offset < value.length) {
        var cp = value.codePointAt(offset)
        offset += Character.charCount(cp)
        if (cp == '\\'.code) {
            if (offset == value.length) {
                append('\ufffd')
                continue
            }
            var digits = 0
            var scalar = 0
            while (offset < value.length && digits < 6) {
                val char = value[offset]
                val digit = when (char) {
                    in '0'..'9' -> char.code - '0'.code
                    in 'a'..'f' -> char.code - 'a'.code + 10
                    in 'A'..'F' -> char.code - 'A'.code + 10
                    else -> -1
                }
                if (digit < 0) break
                scalar = scalar * 16 + digit
                offset++
                digits++
            }
            if (digits > 0) {
                cp = scalar
                if (offset < value.length && cssWhitespace(value[offset])) {
                    val whitespace = value[offset++]
                    if (whitespace == '\r' && offset < value.length && value[offset] == '\n') offset++
                }
            } else {
                cp = value.codePointAt(offset)
                offset += Character.charCount(cp)
                if (cp == '\n'.code || cp == '\r'.code || cp == '\u000c'.code) {
                    require(string) { "Invalid newline escape in legacy SVG paint" }
                    if (cp == '\r'.code && offset < value.length && value[offset] == '\n') offset++
                    continue
                }
            }
        }
        appendCodePoint(if (cp == 0 || cp in 0xd800..0xdfff || cp > 0x10ffff) 0xfffd else cp)
    }
}
