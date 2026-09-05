package app.nexus.android.offline.reading

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

internal fun interface OfflineReadingInstalledPackageVerifierPort {
    fun isValid(installed: OfflineReadingPackage, directory: File): Boolean
}

internal class OfflineReadingInstalledPackageVerifier : OfflineReadingInstalledPackageVerifierPort {
    override fun isValid(installed: OfflineReadingPackage, directory: File): Boolean = runCatching {
        require(directory.isDirectory)
        val manifestFile = File(directory, "manifest.json")
        require(manifestFile.isFile && manifestFile.length() <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
        val manifest = OfflineReadingManifestParser.parse(manifestFile.readBytes())
        require(manifest.mediaId == installed.mediaId)
        require(manifest.mediaKind == installed.mediaKind)
        require(manifest.title == installed.title)
        require(manifest.readerGeneration == installed.readerGeneration)
        require(manifest.readerRevisionKey == installed.readerRevisionKey)
        val expectedPaths = setOf("manifest.json") + manifest.entries.map { it.path }
        val actualPaths = directory.walkTopDown()
            .filter(File::isFile)
            .map { it.relativeTo(directory).invariantSeparatorsPath }
            .toSet()
        require(actualPaths == expectedPaths)
        manifest.entries.forEach { entry ->
            val file = File(directory, entry.path)
            require(file.isFile && file.length() == entry.sizeBytes)
            require(file.sha256Hex() == entry.sha256)
        }
        val reader = File(directory, "reader.json")
        require(reader.length() <= OFFLINE_READING_MAX_READER_JSON_BYTES)
        OfflineReaderDocumentVerifier.verify(reader.readBytes(), manifest)
        if (manifest.mediaKind == OfflineReadingMediaKind.Pdf) {
            val document = manifest.entries.single { it.path != "reader.json" }
            require(document.mediaType == "application/pdf")
            require(document.path.lowercase().endsWith(".pdf"))
            require(File(directory, document.path).inputStream().use { input ->
                input.readUpTo(5).contentEquals("%PDF-".toByteArray())
            })
        } else {
            val assetVerifier = OfflineReadingPackageVerifier()
            manifest.entries.filter { it.path != "reader.json" }.forEach { entry ->
                require(
                    assetVerifier.assetSignatureMatches(
                        entry.path,
                        entry.mediaType,
                        File(directory, entry.path),
                    )
                )
            }
        }
        true
    }.getOrDefault(false)
}

/** Reads at most [count] bytes, stopping early at end of stream (InputStream.readNBytes needs API 33). */
private fun InputStream.readUpTo(count: Int): ByteArray {
    val buffer = ByteArray(count)
    var offset = 0
    while (offset < count) {
        val read = read(buffer, offset, count - offset)
        if (read < 0) break
        offset += read
    }
    return buffer.copyOf(offset)
}

private fun File.sha256Hex(): String {
    val digest = MessageDigest.getInstance("SHA-256")
    inputStream().use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().toHex()
}
