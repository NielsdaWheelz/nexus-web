package app.nexus.android.offline.reading

import java.io.File
import java.security.MessageDigest

internal fun interface OfflineReadingInstalledPackageVerifierPort {
    fun membersAreValid(installed: OfflineReadingPackage, directory: File): Boolean
}

internal class OfflineReadingInstalledPackageVerifier : OfflineReadingInstalledPackageVerifierPort {
    override fun membersAreValid(installed: OfflineReadingPackage, directory: File): Boolean = try {
        require(directory.isDirectory)
        val manifestFile = File(directory, "manifest.json")
        require(manifestFile.isFile && manifestFile.length() <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
        val manifest = OfflineReadingManifestParser.parse(manifestFile.readBytes())
        require(manifest.mediaId == installed.mediaId)
        require(manifest.mediaKind == installed.mediaKind)
        require(manifest.title == installed.title)
        require(manifest.readerGeneration == installed.readerGeneration)
        require(manifest.readerRevisionKey == installed.readerRevisionKey)
        require(manifest.packageSchemaVersion == installed.packageSchemaVersion)
        require(OfflineReadingRevision.compute(manifest.readerGeneration, manifest.entries) == manifest.readerRevisionKey)
        val expectedPaths = setOf("manifest.json") + manifest.entries.map { it.path }
        val actualPaths = directory.walkTopDown()
            .filter(File::isFile)
            .map { it.relativeTo(directory).invariantSeparatorsPath }
            .toSet()
        // This single private reconstructible file has a separate readiness
        // verdict. Its damage cannot revoke attested source bytes.
        val sourcePaths = if (manifest.packageSchemaVersion == 2) actualPaths - OFFLINE_READING_TABLE_INDEX_NAME else actualPaths
        require(sourcePaths == expectedPaths)
        manifest.entries.forEach { entry ->
            val file = File(directory, entry.path)
            require(file.isFile && file.length() == entry.sizeBytes)
            require(file.sha256Hex() == entry.sha256)
        }
        if (manifest.packageSchemaVersion == 2) {
            OfflineReaderPublicationVerifier.verify(directory, manifest, PublicationOrigin.Retained)
        }
        // Schema 1 is only attested here. Its streaming converter validates the
        // source before schema 2 activation; the old whole-document reader is
        // never opened by the new bundle.
        if (manifest.mediaKind == OfflineReadingMediaKind.Pdf) {
            val document = manifest.entries.single { it.mediaType == "application/pdf" }
            require(document.mediaType == "application/pdf")
            if (manifest.packageSchemaVersion == 1) require(document.path.lowercase().endsWith(".pdf"))
            require(File(directory, document.path).inputStream().use { input ->
                input.readNBytes(5).contentEquals("%PDF-".toByteArray())
            })
        } else {
            val assetVerifier = OfflineReadingPackageVerifier()
            manifest.entries.filter { it.mediaType != "application/json" }.forEach { entry ->
                require(
                    assetVerifier.assetSignatureMatches(
                        entry.path,
                        entry.mediaType,
                        File(directory, entry.path),
                        manifest.packageSchemaVersion,
                    )
                )
            }
        }
        true
    } catch (_: IllegalArgumentException) {
        false
    } catch (_: IllegalStateException) {
        false
    }
    // I/O failures and VM errors are not evidence of corruption. They propagate
    // to reconciliation, which preserves the installed row and files for retry.
}

internal fun File.sha256Hex(): String {
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
