package app.nexus.android.offline.reading

import com.squareup.moshi.JsonReader
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.charset.StandardCharsets
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID

internal const val OFFLINE_READING_MAX_ARCHIVE_BYTES = 512L * 1024L * 1024L
internal const val OFFLINE_READING_MAX_EXPANDED_BYTES = 512L * 1024L * 1024L
internal const val OFFLINE_READING_MAX_ENTRY_BYTES = 512L * 1024L * 1024L
internal const val OFFLINE_READING_MAX_SVG_BYTES = 8L * 1024L * 1024L
internal const val OFFLINE_READING_MAX_ENTRIES = 4096
internal const val OFFLINE_READING_MAX_PATH_BYTES = 512
internal const val OFFLINE_READING_MAX_TITLE_CODEPOINTS = 512
internal const val OFFLINE_READING_MAX_MEDIA_TYPE_BYTES = 127
internal const val OFFLINE_READING_MAX_MANIFEST_JSON_BYTES = 4 * 1024 * 1024
internal const val OFFLINE_READING_MAX_READER_JSON_BYTES = 64L * 1024L * 1024L

private val SHA256_HEX = Regex("[0-9a-f]{64}")
private val MEDIA_TYPE = Regex("[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*")
private val SAFE_PATH_SEGMENT = Regex("[A-Za-z0-9][A-Za-z0-9._-]*")
private val NESTED_ARCHIVE_SUFFIXES = setOf(
    ".7z", ".apk", ".bz2", ".epub", ".gz", ".jar", ".rar", ".tar", ".xz", ".zip",
)

internal data class OfflineReadingManifestEntry(
    val path: String,
    val mediaType: String,
    val sizeBytes: Long,
    val sha256: String,
) {
    init {
        requireSafePackagePath(path)
        require(sizeBytes in 0..OFFLINE_READING_MAX_ENTRY_BYTES)
        if (path == "reader.json") require(sizeBytes <= OFFLINE_READING_MAX_READER_JSON_BYTES)
        if (mediaType == "image/svg+xml") require(sizeBytes <= OFFLINE_READING_MAX_SVG_BYTES)
        require(mediaType.toByteArray(StandardCharsets.US_ASCII).size == mediaType.length)
        require(mediaType.length in 1..OFFLINE_READING_MAX_MEDIA_TYPE_BYTES)
        require(MEDIA_TYPE.matches(mediaType))
        require(SHA256_HEX.matches(sha256))
    }
}

internal data class OfflineReadingManifest(
    val mediaId: UUID,
    val mediaKind: OfflineReadingMediaKind,
    val title: String,
    val readerGeneration: Long,
    val readerRevisionKey: String,
    val entries: List<OfflineReadingManifestEntry>,
) {
    init {
        require(readerGeneration > 0)
        require(SHA256_HEX.matches(readerRevisionKey))
        requireTitle(title)
        require(entries.isNotEmpty() && entries.size <= OFFLINE_READING_MAX_ENTRIES)
        require(entries.map { it.path } == entries.map { it.path }.sortedWith(UTF8_PATH_COMPARATOR))
        require(entries.map { it.path }.toSet().size == entries.size)
        require(entries.any { it.path == "reader.json" })
        require(entries.single { it.path == "reader.json" }.mediaType == "application/json")
        require(entries.fold(0L) { total, entry -> Math.addExact(total, entry.sizeBytes) } <=
            OFFLINE_READING_MAX_EXPANDED_BYTES)
    }
}

internal object OfflineReadingManifestParser {
    fun parse(bytes: ByteArray): OfflineReadingManifest {
        require(bytes.size <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
        require(!bytes.startsWith(UTF8_BOM))
        val value = StrictJson.parse(bytes)
        val root = value.requireObject(
            setOf(
                "packageSchemaVersion",
                "readerContractVersion",
                "minimumReaderBundleVersion",
                "mediaId",
                "mediaKind",
                "title",
                "readerGeneration",
                "readerRevisionKey",
                "entries",
            )
        )
        if (
            root.getValue("packageSchemaVersion").requireLong() != 1L ||
            root.getValue("readerContractVersion").requireLong() != 1L ||
            root.getValue("minimumReaderBundleVersion").requireLong() != 1L
        ) {
            throw UnsupportedOfflineReadingPackageException()
        }
        val mediaIdText = root.getValue("mediaId").requireString()
        val mediaId = UUID.fromString(mediaIdText)
        require(mediaId.toString() == mediaIdText)
        val entries = root.getValue("entries").requireArray().map { entryValue ->
            val entry = entryValue.requireObject(
                setOf("path", "mediaType", "sizeBytes", "sha256")
            )
            OfflineReadingManifestEntry(
                entry.getValue("path").requireString(),
                entry.getValue("mediaType").requireString(),
                entry.getValue("sizeBytes").requireLong(),
                entry.getValue("sha256").requireString(),
            )
        }
        return OfflineReadingManifest(
            mediaId = mediaId,
            mediaKind = enumValues<OfflineReadingMediaKind>().single {
                it.name == root.getValue("mediaKind").requireString()
            },
            title = root.getValue("title").requireString(),
            readerGeneration = root.getValue("readerGeneration").requireLong(),
            readerRevisionKey = root.getValue("readerRevisionKey").requireString(),
            entries = entries,
        )
    }
}

internal class UnsupportedOfflineReadingPackageException : IllegalArgumentException()

internal object OfflineReadingRevision {
    fun compute(
        readerGeneration: Long,
        entries: List<OfflineReadingManifestEntry>,
    ): String {
        require(readerGeneration > 0)
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("NexusOfflineReadingRevision\u0000".toByteArray(StandardCharsets.UTF_8))
        digest.update(longBytes(readerGeneration))
        entries.sortedWith(compareBy(UTF8_PATH_COMPARATOR) { it.path }).forEach { entry ->
            val path = entry.path.toByteArray(StandardCharsets.UTF_8)
            val mediaType = entry.mediaType.toByteArray(StandardCharsets.US_ASCII)
            digest.update(intBytes(path.size))
            digest.update(path)
            digest.update(hexBytes(entry.sha256))
            digest.update(longBytes(entry.sizeBytes))
            digest.update(shortBytes(mediaType.size))
            digest.update(mediaType)
        }
        return digest.digest().toHex()
    }

    private fun intBytes(value: Int): ByteArray = binary { writeInt(value) }

    private fun longBytes(value: Long): ByteArray = binary { writeLong(value) }

    private fun shortBytes(value: Int): ByteArray = binary { writeShort(value) }

    private fun binary(write: DataOutputStream.() -> Unit): ByteArray {
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use { write.invoke(it) }
        return output.toByteArray()
    }
}

internal fun requireSafePackagePath(path: String) {
    val pathBytes = path.toByteArray(StandardCharsets.UTF_8)
    require(pathBytes.isNotEmpty() && pathBytes.size <= OFFLINE_READING_MAX_PATH_BYTES)
    require(Normalizer.normalize(path, Normalizer.Form.NFC) == path)
    require(!path.startsWith('/') && '\\' !in path && path != "manifest.json")
    val segments = path.split('/')
    require(segments.all { it !in setOf("", ".", "..") && SAFE_PATH_SEGMENT.matches(it) })
    require(NESTED_ARCHIVE_SUFFIXES.none { path.lowercase().endsWith(it) })
}

internal fun requireTitle(title: String) {
    require(title.isNotBlank())
    require(title.codePointCount(0, title.length) <= OFFLINE_READING_MAX_TITLE_CODEPOINTS)
}

internal sealed interface StrictJson {
    data class ObjectValue(val fields: Map<String, StrictJson>) : StrictJson
    data class ArrayValue(val values: List<StrictJson>) : StrictJson
    data class StringValue(val value: String) : StrictJson
    data class NumberValue(val value: String) : StrictJson
    data class BooleanValue(val value: Boolean) : StrictJson
    data object NullValue : StrictJson

    fun toJson(): String = when (this) {
        is ObjectValue -> fields.entries.joinToString(prefix = "{", postfix = "}") { (key, value) ->
            "${quoteJson(key)}:${value.toJson()}"
        }
        is ArrayValue -> values.joinToString(prefix = "[", postfix = "]") { it.toJson() }
        is StringValue -> quoteJson(value)
        is NumberValue -> value
        is BooleanValue -> value.toString()
        NullValue -> "null"
    }

    fun requireObject(exactKeys: Set<String>): Map<String, StrictJson> {
        val value = (this as? ObjectValue)?.fields ?: error("expected JSON object")
        require(value.keys == exactKeys)
        return value
    }

    fun requireArray(): List<StrictJson> =
        (this as? ArrayValue)?.values ?: error("expected JSON array")

    fun requireString(): String =
        (this as? StringValue)?.value ?: error("expected JSON string")

    fun requireLong(): Long {
        val text = (this as? NumberValue)?.value ?: error("expected JSON integer")
        require(INTEGER.matches(text))
        return text.toLong()
    }

    companion object {
        private val INTEGER = Regex("-?(0|[1-9][0-9]*)")

        fun parse(bytes: ByteArray): StrictJson {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(bytes))
            val reader = JsonReader.of(Buffer().write(bytes)).apply { isLenient = false }
            val value = read(reader, depth = 0)
            require(reader.peek() == JsonReader.Token.END_DOCUMENT)
            return value
        }

        private fun read(reader: JsonReader, depth: Int): StrictJson {
            require(depth <= 64)
            return when (reader.peek()) {
                JsonReader.Token.BEGIN_OBJECT -> {
                    val fields = linkedMapOf<String, StrictJson>()
                    reader.beginObject()
                    while (reader.hasNext()) {
                        val name = reader.nextName()
                        require(name !in fields)
                        fields[name] = read(reader, depth + 1)
                    }
                    reader.endObject()
                    ObjectValue(fields)
                }
                JsonReader.Token.BEGIN_ARRAY -> {
                    val values = mutableListOf<StrictJson>()
                    reader.beginArray()
                    while (reader.hasNext()) {
                        values += read(reader, depth + 1)
                    }
                    reader.endArray()
                    ArrayValue(values)
                }
                JsonReader.Token.STRING -> StringValue(reader.nextString())
                JsonReader.Token.NUMBER -> NumberValue(reader.nextString())
                JsonReader.Token.BOOLEAN -> BooleanValue(reader.nextBoolean())
                JsonReader.Token.NULL -> {
                    reader.nextNull<Unit>()
                    NullValue
                }
                else -> error("unexpected JSON token ${reader.peek()}")
            }
        }
    }
}

private fun quoteJson(value: String): String {
    val output = StringBuilder(value.length + 2).append('"')
    value.forEach { character ->
        when (character) {
            '"' -> output.append("\\\"")
            '\\' -> output.append("\\\\")
            '\b' -> output.append("\\b")
            '\u000c' -> output.append("\\f")
            '\n' -> output.append("\\n")
            '\r' -> output.append("\\r")
            '\t' -> output.append("\\t")
            else -> if (character < ' ') {
                output.append("\\u%04x".format(character.code))
            } else {
                output.append(character)
            }
        }
    }
    return output.append('"').toString()
}

private val UTF8_BOM = byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte())
private val UTF8_PATH_COMPARATOR = Comparator<String> { left, right ->
    val leftBytes = left.toByteArray(StandardCharsets.UTF_8)
    val rightBytes = right.toByteArray(StandardCharsets.UTF_8)
    for (index in 0 until minOf(leftBytes.size, rightBytes.size)) {
        val comparison = (leftBytes[index].toInt() and 0xff) - (rightBytes[index].toInt() and 0xff)
        if (comparison != 0) return@Comparator comparison
    }
    leftBytes.size - rightBytes.size
}

private fun ByteArray.startsWith(prefix: ByteArray): Boolean =
    size >= prefix.size && copyOfRange(0, prefix.size).contentEquals(prefix)

private fun hexBytes(value: String): ByteArray {
    require(SHA256_HEX.matches(value))
    return ByteArray(value.length / 2) { index ->
        value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
}

internal fun ByteArray.toHex(): String = joinToString(separator = "") { byte ->
    "%02x".format(byte.toInt() and 0xff)
}
