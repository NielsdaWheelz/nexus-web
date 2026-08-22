package app.nexus.android.offline.reading

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.xml.parsers.DocumentBuilderFactory

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

internal data class VerifiedOfflineReadingPackage(
    val manifest: OfflineReadingManifest,
    val extractedDirectory: File,
    val packageSha256: String,
    val compressedBytes: Long,
)

internal fun interface OfflineReadingPackageVerifierPort {
    fun verifyAndExtract(
        artifact: OfflineReadingTransferArtifact,
        expectedAccountId: UUID,
        expectedMediaId: UUID,
        destination: File,
    ): VerifiedOfflineReadingPackage
}

internal class OfflineReadingPackageVerifier : OfflineReadingPackageVerifierPort {
    override fun verifyAndExtract(
        artifact: OfflineReadingTransferArtifact,
        expectedAccountId: UUID,
        expectedMediaId: UUID,
        destination: File,
    ): VerifiedOfflineReadingPackage {
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

                check(destination.mkdirs())
                writeVerifiedFile(destination, "manifest.json", manifestBytes)
                var readerBytes: ByteArray? = null
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
                    if (declared.path == "reader.json") {
                        require(declared.sizeBytes <= OFFLINE_READING_MAX_READER_JSON_BYTES)
                        readerBytes = target.inputStream().use { input ->
                            input.readBounded(declared.sizeBytes)
                        }
                    }
                }
                OfflineReaderDocumentVerifier.verify(
                    readerBytes ?: error("reader.json was not extracted"),
                    manifest,
                )
                verifySignatures(manifest, destination)
                return VerifiedOfflineReadingPackage(
                    manifest,
                    destination,
                    artifact.packageSha256,
                    artifact.compressedBytes,
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
            val document = manifest.entries.single { it.path != "reader.json" }
            require(document.path.lowercase().endsWith(".pdf"))
            require(File(root, document.path).readPrefix(5).startsWith("%PDF-".toByteArray()))
            return
        }
        manifest.entries.filter { it.path != "reader.json" }.forEach { entry ->
            require(assetSignatureMatches(entry.path, entry.mediaType, File(root, entry.path)))
        }
    }

    internal fun assetSignatureMatches(path: String, mediaType: String, file: File): Boolean {
        val expectedMediaType = ASSET_MEDIA_TYPES[path.substringAfterLast('.', "").lowercase()]
            ?: return false
        if (expectedMediaType != mediaType) return false
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
        val bytes = file.readBytes()
        if (Regex("<!DOCTYPE|<!ENTITY", RegexOption.IGNORE_CASE).containsMatchIn(bytes.toString(Charsets.UTF_8))) {
            return false
        }
        return runCatching {
            val factory = DocumentBuilderFactory.newInstance().apply {
                isNamespaceAware = true
                isXIncludeAware = false
                setExpandEntityReferences(false)
                setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
                setFeature("http://xml.org/sax/features/external-general-entities", false)
                setFeature("http://xml.org/sax/features/external-parameter-entities", false)
            }
            val document = bytes.inputStream().use { factory.newDocumentBuilder().parse(it) }
            val root = document.documentElement ?: return@runCatching false
            if (root.localName?.lowercase() != "svg") return@runCatching false
            val elements = document.getElementsByTagName("*")
            for (elementIndex in 0 until elements.length) {
                val element = elements.item(elementIndex)
                val tag = (element.localName ?: element.nodeName.substringAfterLast(':')).lowercase()
                if (tag in SVG_FORBIDDEN_TAGS) return@runCatching false
                val attributes = element.attributes
                for (attributeIndex in 0 until attributes.length) {
                    val attribute = attributes.item(attributeIndex)
                    // Namespace declarations are identifiers, never fetched subresources.
                    // The Python owner's lxml verifier never sees them (`attrib` excludes
                    // xmlns), so skipping them here keeps the cross-language decision
                    // identical for the shared vector.
                    if (
                        attribute.namespaceURI == "http://www.w3.org/2000/xmlns/" ||
                        attribute.nodeName == "xmlns" ||
                        attribute.nodeName.startsWith("xmlns:")
                    ) {
                        continue
                    }
                    val name = (attribute.localName ?: attribute.nodeName.substringAfterLast(':')).lowercase()
                    val value = attribute.nodeValue.orEmpty()
                    if (name.startsWith("on") || name == "style") return@runCatching false
                    if (REMOTE_OR_EXECUTABLE_SVG_URL.containsMatchIn(value)) return@runCatching false
                    if (name in SVG_URL_ATTRIBUTES && !value.startsWith('#')) return@runCatching false
                }
            }
            true
        }.getOrDefault(false)
    }

    private fun writeVerifiedFile(root: File, path: String, bytes: ByteArray) {
        val target = File(root, path)
        require(target.canonicalFile.toPath().startsWith(root.canonicalFile.toPath()))
        ensureParentDirectory(target)
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
        ensureParentDirectory(target)
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

    private fun ensureParentDirectory(target: File) {
        // mkdirs() returns false when the directory already exists; only assert the
        // parent is a directory after ensuring it, never assert the mkdirs() result.
        val parent = checkNotNull(target.parentFile)
        parent.mkdirs()
        check(parent.isDirectory)
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
