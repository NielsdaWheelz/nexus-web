package app.nexus.android.offline.reading

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.xml.parsers.SAXParserFactory
import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.SAXException
import org.xml.sax.SAXParseException
import org.xml.sax.ext.DefaultHandler2

internal class OfflineReadingPackageException(
    val reason: ReadingFailureReason,
    cause: Throwable? = null,
) : Exception(reason.name, cause)

internal data class OfflineReadingTransferArtifact(
    val archive: File,
    val accountId: UUID,
    val readerGeneration: Long,
    val compressedBytes: Long,
    val expandedBytes: Long,
    val packageSha256: String,
)

/** Attested bytes and member contracts; cross-member joins still require preparation. */
internal data class VerifiedOfflineReadingMembers(
    val manifest: OfflineReadingManifest,
    val extractedDirectory: File,
    val installedBytes: Long,
)

internal fun interface OfflineReadingPackageVerifierPort {
    fun verifyAndExtract(
        artifact: OfflineReadingTransferArtifact,
        expectedAccountId: UUID,
        expectedMediaId: UUID,
        destination: File,
    ): VerifiedOfflineReadingMembers
}

internal class OfflineReadingPackageVerifier : OfflineReadingPackageVerifierPort {
    override fun verifyAndExtract(
        artifact: OfflineReadingTransferArtifact,
        expectedAccountId: UUID,
        expectedMediaId: UUID,
        destination: File,
    ): VerifiedOfflineReadingMembers {
        try {
            require(artifact.accountId == expectedAccountId)
            require(artifact.readerGeneration > 0)
            require(artifact.compressedBytes == artifact.archive.length())
            require(artifact.compressedBytes in 1..OFFLINE_READING_MAX_ARCHIVE_BYTES)
            require(artifact.expandedBytes in 1..OFFLINE_READING_MAX_EXPANDED_BYTES)
            require(artifact.packageSha256.matches(Regex("[0-9a-f]{64}")))
            require(sha256(artifact.archive) == artifact.packageSha256)
            require(!destination.exists())

            val metadata = ZipCentralDirectory.read(artifact.archive)
            ZipFile(artifact.archive).use { archive ->
                val members = archive.entries().asSequence().toList()
                require(members.size == metadata.size)
                require(members.map { it.name } == metadata.map { it.name })
                require(members.map { it.name }.toSet().size == members.size)
                members.zip(metadata).forEach { (entry, raw) -> verifyArchiveEntry(entry, raw) }
                require(members.firstOrNull()?.name == "manifest.json")

                val manifestEntry = members.first()
                val manifestBytes = archive.getInputStream(manifestEntry).use { input ->
                    input.readBounded(OFFLINE_READING_MAX_MANIFEST_JSON_BYTES.toLong())
                }
                val manifest = OfflineReadingManifestParser.parse(manifestBytes)
                if (manifest.packageSchemaVersion != 2) throw UnsupportedOfflineReadingPackageException()
                require(manifest.mediaId == expectedMediaId)
                require(manifest.readerGeneration == artifact.readerGeneration)
                require(manifest.entries.sumOf { it.sizeBytes } == artifact.expandedBytes)
                require(
                    OfflineReadingRevision.compute(
                        manifest.readerGeneration,
                        manifest.entries,
                    ) == manifest.readerRevisionKey
                )
                require(
                    members.map { it.name } ==
                        listOf("manifest.json") + manifest.entries.map { it.path }
                )

                Files.createDirectory(destination.toPath())
                writeVerifiedFile(destination, "manifest.json", manifestBytes)
                manifest.entries.forEach { declared ->
                    val entry = members.single { it.name == declared.path }
                    require(entry.size == declared.sizeBytes)
                    val target = File(destination, declared.path)
                    streamVerifiedFile(
                        root = destination,
                        target = target,
                        maximum = declared.sizeBytes,
                        expectedSha256 = declared.sha256,
                        input = archive.getInputStream(entry),
                    )
                }
                OfflineReaderPublicationVerifier.verify(destination, manifest, PublicationOrigin.Downloaded)
                verifySignatures(manifest, destination)
                return VerifiedOfflineReadingMembers(
                    manifest,
                    destination,
                    Math.addExact(artifact.expandedBytes, manifestBytes.size.toLong()),
                )
            }
        } catch (error: UnsupportedOfflineReadingPackageException) {
            destination.deleteRecursively()
            throw OfflineReadingPackageException(ReadingFailureReason.UnsupportedPackage, error)
        } catch (error: OfflineReadingPackageException) {
            destination.deleteRecursively()
            throw error
        } catch (error: Exception) {
            destination.deleteRecursively()
            throw OfflineReadingPackageException(ReadingFailureReason.Integrity, error)
        }
    }

    private fun verifyArchiveEntry(entry: ZipEntry, raw: ZipCentralDirectory.Entry) {
        require(!entry.isDirectory)
        require(entry.method == ZipEntry.DEFLATED)
        require(entry.extra == null || entry.extra.isEmpty())
        require(entry.comment.isNullOrEmpty())
        require(raw.dosTime == 0 && raw.dosDate == 0x21)
        require(raw.flags and 0x1 == 0)
        require(raw.extraLength == 0 && raw.commentLength == 0)
        require(raw.createSystem == 3)
        require(raw.unixMode and 0xf000 == 0x8000)
        require(raw.unixMode and 0x0fff == 0x1a4)
        if (entry.name != "manifest.json") {
            requireSafePackagePath(entry.name)
        }
    }

    private fun verifySignatures(
        manifest: OfflineReadingManifest,
        root: File,
    ) {
        if (manifest.mediaKind == OfflineReadingMediaKind.Pdf) {
            val document = manifest.entries.single { it.mediaType == "application/pdf" }
            require(File(root, document.path).readPrefix(5).startsWith("%PDF-".toByteArray()))
            return
        }
        manifest.entries.filter { it.mediaType != "application/json" }.forEach { entry ->
            require(assetSignatureMatches(entry.path, entry.mediaType, File(root, entry.path), manifest.packageSchemaVersion))
        }
    }

    internal fun assetSignatureMatches(path: String, mediaType: String, file: File, packageSchemaVersion: Int): Boolean {
        if (packageSchemaVersion == 1) {
            val expectedMediaType = ASSET_MEDIA_TYPES[path.substringAfterLast('.', "").lowercase()]
                ?: return false
            if (expectedMediaType != mediaType) return false
        } else {
            require(packageSchemaVersion == 2)
        }
        val body = file.readPrefix(32)
        return when (mediaType) {
            "image/png" -> body.startsWith(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
            "image/jpeg" -> body.startsWith(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte()))
            "image/gif" -> body.startsWith("GIF87a".toByteArray()) || body.startsWith("GIF89a".toByteArray())
            "image/webp" -> body.size >= 12 && body.copyOfRange(0, 4).contentEquals("RIFF".toByteArray()) &&
                body.copyOfRange(8, 12).contentEquals("WEBP".toByteArray())
            "image/avif" -> body.size >= 12 && body.copyOfRange(4, 8).contentEquals("ftyp".toByteArray()) &&
                body.copyOfRange(8, minOf(32, body.size)).toString(Charsets.ISO_8859_1).contains("avif")
            "font/woff" -> body.startsWith("wOFF".toByteArray())
            "font/woff2" -> body.startsWith("wOF2".toByteArray())
            "font/ttf" -> body.startsWith(byteArrayOf(0, 1, 0, 0)) || body.startsWith("true".toByteArray())
            "font/otf" -> body.startsWith("OTTO".toByteArray())
            "image/svg+xml" -> verifySvg(file)
            else -> false
        }
    }

    private fun verifySvg(file: File): Boolean {
        if (file.length() > OFFLINE_READING_MAX_SVG_BYTES) return false
        // Preserve the byte-level declaration policy without retaining the file.
        // Read/setup failures are resource failures, never invalid source evidence.
        file.bufferedReader(Charsets.ISO_8859_1).use { input ->
            val buffer = CharArray(DEFAULT_BUFFER_SIZE)
            val declarations = Regex("<!DOCTYPE|<!ENTITY", RegexOption.IGNORE_CASE)
            var tail = ""
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                val chunk = tail + String(buffer, 0, count)
                if (declarations.containsMatchIn(chunk)) return false
                tail = chunk.takeLast(8)
            }
        }
        var rootSeen = false
        val handler = object : DefaultHandler2() {
            override fun startDTD(name: String?, publicId: String?, systemId: String?) {
                throw InvalidSvgSource("SVG declarations are forbidden")
            }
            override fun resolveEntity(publicId: String?, systemId: String?): InputSource {
                throw InvalidSvgSource("SVG external entities are forbidden")
            }
            override fun skippedEntity(name: String?) {
                throw InvalidSvgSource("SVG unresolved entities are forbidden")
            }
            override fun startElement(uri: String, localName: String, qName: String, attributes: Attributes) {
                val tag = localName.lowercase()
                if (!rootSeen) {
                    if (tag != "svg") throw InvalidSvgSource("SVG root is required")
                    rootSeen = true
                }
                if (tag in SVG_FORBIDDEN_TAGS) throw InvalidSvgSource("SVG element is forbidden")
                for (index in 0 until attributes.length) {
                    // Namespace declarations are identifiers; the namespace-aware
                    // parser excludes them here.
                    val name = attributes.getLocalName(index).lowercase()
                    val value = attributes.getValue(index)
                    if (name.startsWith("on") || name == "style")
                        throw InvalidSvgSource("SVG executable attributes are forbidden")
                    if (REMOTE_OR_EXECUTABLE_SVG_URL.containsMatchIn(value))
                        throw InvalidSvgSource("SVG external resources are forbidden")
                    if (name in SVG_URL_ATTRIBUTES && !value.startsWith('#'))
                        throw InvalidSvgSource("SVG reference must be local")
                }
            }
        }
        val parser = SAXParserFactory.newInstance().apply {
            isNamespaceAware = true
        }.newSAXParser().xmlReader
        parser.setFeature("http://xml.org/sax/features/external-general-entities", false)
        parser.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        parser.setProperty("http://xml.org/sax/properties/lexical-handler", handler)
        parser.contentHandler = handler
        parser.entityResolver = handler
        return try {
            file.inputStream().use { parser.parse(InputSource(it)) }
            rootSeen
        } catch (_: InvalidSvgSource) {
            false
        } catch (error: SAXParseException) {
            // A parser can wrap an input/setup exception. Only uncaused syntax
            // rejection proves malformed bytes; preserve a wrapped resource error.
            if (error.exception != null || error.cause != null) throw error
            false
        }
    }

    private class InvalidSvgSource(message: String) : SAXException(message)

    private fun writeVerifiedFile(root: File, path: String, bytes: ByteArray) {
        val target = File(root, path)
        require(target.canonicalFile.toPath().startsWith(root.canonicalFile.toPath()))
        ensureParentDirectory(root, target)
        FileOutputStream(target).use { output ->
            output.write(bytes)
            output.fd.sync()
        }
    }

    private fun streamVerifiedFile(
        root: File,
        target: File,
        maximum: Long,
        expectedSha256: String,
        input: java.io.InputStream,
    ) {
        require(target.canonicalFile.toPath().startsWith(root.canonicalFile.toPath()))
        ensureParentDirectory(root, target)
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        input.use { source ->
            FileOutputStream(target).use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    total = Math.addExact(total, read.toLong())
                    require(total <= maximum)
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
                output.fd.sync()
            }
        }
        require(total == maximum)
        require(digest.digest().toHex() == expectedSha256)
    }

    private fun ensureParentDirectory(root: File, target: File) {
        var parent = root
        for (part in target.relativeTo(root).invariantSeparatorsPath.split('/').dropLast(1)) {
            parent = File(parent, part)
            // The store owns the staging root; extraction cannot recreate retired ancestry.
            if (!parent.isDirectory) Files.createDirectory(parent.toPath())
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().toHex()
    }

    private fun java.io.InputStream.readBounded(maximum: Long): ByteArray {
        require(maximum in 0..Int.MAX_VALUE.toLong())
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        while (true) {
            val read = read(buffer)
            if (read < 0) break
            total = Math.addExact(total, read.toLong())
            require(total <= maximum)
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private companion object {
        val ASSET_MEDIA_TYPES = mapOf(
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "avif" to "image/avif",
            "svg" to "image/svg+xml",
            "woff" to "font/woff",
            "woff2" to "font/woff2",
            "ttf" to "font/ttf",
            "otf" to "font/otf",
        )
    }
}

private fun File.readPrefix(maximum: Int): ByteArray = inputStream().use { input ->
    val output = ByteArray(maximum)
    var total = 0
    while (total < maximum) {
        val read = input.read(output, total, maximum - total)
        if (read < 0) break
        total += read
    }
    output.copyOf(total)
}

private object ZipCentralDirectory {
    data class Entry(
        val name: String,
        val createSystem: Int,
        val flags: Int,
        val dosTime: Int,
        val dosDate: Int,
        val extraLength: Int,
        val commentLength: Int,
        val unixMode: Int,
    )

    fun read(file: File): List<Entry> {
        RandomAccessFile(file, "r").use { archive ->
            val tailSize = minOf(archive.length(), 65_557L).toInt()
            val tail = ByteArray(tailSize)
            archive.seek(archive.length() - tailSize)
            archive.readFully(tail)
            val eocd = (tail.size - 22 downTo 0).firstOrNull { index ->
                tail.u32(index) == 0x06054b50L
            } ?: error("ZIP end-of-central-directory record is missing")
            require(tail.u16(eocd + 4) == 0 && tail.u16(eocd + 6) == 0)
            val entries = tail.u16(eocd + 10)
            require(entries == tail.u16(eocd + 8) && entries in 1..OFFLINE_READING_MAX_ENTRIES + 1)
            require(tail.u16(eocd + 20) == 0)
            val centralSize = tail.u32(eocd + 12)
            val centralOffset = tail.u32(eocd + 16)
            val eocdOffset = archive.length() - tailSize + eocd
            validateOfflineReadingCentralDirectoryBounds(
                archive.length(),
                centralOffset,
                centralSize,
                eocdOffset,
            )
            val bytes = ByteArray(centralSize.toInt())
            archive.seek(centralOffset)
            archive.readFully(bytes)
            val result = mutableListOf<Entry>()
            var offset = 0
            repeat(entries) {
                require(bytes.u32(offset) == 0x02014b50L)
                val nameLength = bytes.u16(offset + 28)
                val extraLength = bytes.u16(offset + 30)
                val commentLength = bytes.u16(offset + 32)
                val end = offset + 46 + nameLength + extraLength + commentLength
                require(end <= bytes.size)
                val nameBytes = bytes.copyOfRange(offset + 46, offset + 46 + nameLength)
                val name = Charsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(nameBytes))
                    .toString()
                val versionMadeBy = bytes.u16(offset + 4)
                result += Entry(
                    name = name,
                    createSystem = versionMadeBy ushr 8,
                    flags = bytes.u16(offset + 8),
                    dosTime = bytes.u16(offset + 12),
                    dosDate = bytes.u16(offset + 14),
                    extraLength = extraLength,
                    commentLength = commentLength,
                    unixMode = (bytes.u32(offset + 38) ushr 16).toInt(),
                )
                offset = end
            }
            require(offset == bytes.size)
            return result
        }
    }

    private fun ByteArray.u16(offset: Int): Int {
        require(offset >= 0 && offset + 2 <= size)
        return (this[offset].toInt() and 0xff) or ((this[offset + 1].toInt() and 0xff) shl 8)
    }

    private fun ByteArray.u32(offset: Int): Long {
        require(offset >= 0 && offset + 4 <= size)
        return u16(offset).toLong() or (u16(offset + 2).toLong() shl 16)
    }
}

private fun ByteArray.startsWith(prefix: ByteArray): Boolean =
    size >= prefix.size && copyOfRange(0, prefix.size).contentEquals(prefix)

internal const val OFFLINE_READING_MAX_CENTRAL_DIRECTORY_BYTES = 4L * 1024L * 1024L

internal fun validateOfflineReadingCentralDirectoryBounds(
    archiveLength: Long,
    centralOffset: Long,
    centralSize: Long,
    eocdOffset: Long,
) {
    require(centralSize in 0..OFFLINE_READING_MAX_CENTRAL_DIRECTORY_BYTES)
    require(centralOffset in 0..archiveLength)
    require(centralSize <= archiveLength - centralOffset)
    require(centralOffset + centralSize == eocdOffset)
}

private val SVG_FORBIDDEN_TAGS = setOf(
    "animate",
    "animatemotion",
    "animatetransform",
    "discard",
    "foreignobject",
    "iframe",
    "script",
    "set",
    "style",
)
private val SVG_URL_ATTRIBUTES = setOf("href", "src")
private val REMOTE_OR_EXECUTABLE_SVG_URL =
    Regex("(?:https?|ftp|file|data|javascript|vbscript):|//", RegexOption.IGNORE_CASE)
