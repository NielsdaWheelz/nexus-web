package app.nexus.android.offline.reading

import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** Prepare verified schema-2 bytes without changing the installed row or source. */
internal fun stageLegacyReaderPackage(
    directory: File,
    staging: File,
    durability: OfflineReadingDurability,
): VerifiedOfflineReadingMembers {
    val originalFile = File(directory, "manifest.json")
    require(originalFile.length() <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
    val original = OfflineReadingManifestParser.parse(originalFile.readBytes())
    require(original.packageSchemaVersion == 1)
    stageLegacyReaderSource(directory, original, staging, durability)
    if (original.mediaKind != OfflineReadingMediaKind.Pdf) stageLegacyReaderUnits(staging, original, durability)
    val entries = stageLegacyReaderIndex(directory, staging, original, durability)
    val publication = File(staging, "publication")
    for (entry in entries.filter { it.path.startsWith("assets/") }) {
        val source = if (original.mediaKind == OfflineReadingMediaKind.Pdf) {
            original.entries.single { it.mediaType == "application/pdf" }.path
        } else entry.path
        val target = File(publication, entry.path)
        if (target.isFile && target.length() == entry.sizeBytes && target.sha256Hex() == entry.sha256) continue
        var parent = publication
        for (segment in entry.path.substringBeforeLast('/').split('/')) {
            parent = File(parent, segment)
            require(parent.mkdir() || parent.isDirectory)
        }
        File(directory, source).inputStream().use { input ->
            target.outputStream().use { output -> input.copyTo(output); output.fd.sync() }
        }
        require(target.length() == entry.sizeBytes && target.sha256Hex() == entry.sha256)
    }
    val revision = OfflineReadingRevision.compute(original.readerGeneration, entries)
    val manifest = original.copy(readerRevisionKey = revision, entries = entries, packageSchemaVersion = 2)
    val bytes = JSONObject().put("packageSchemaVersion", 2).put("readerContractVersion", 1)
        .put("minimumReaderBundleVersion", 2).put("mediaId", manifest.mediaId.toString())
        .put("mediaKind", manifest.mediaKind.name).put("title", manifest.title)
        .put("readerGeneration", manifest.readerGeneration).put("readerRevisionKey", revision)
        .put("entries", JSONArray(entries.map { entry -> JSONObject().put("path", entry.path)
            .put("mediaType", entry.mediaType).put("sizeBytes", entry.sizeBytes).put("sha256", entry.sha256) }))
        .toString().toByteArray(Charsets.UTF_8)
    require(bytes.size <= OFFLINE_READING_MAX_MANIFEST_JSON_BYTES)
    val declared = entries.map { it.path }.toSet() + "manifest.json"
    // An interrupted, uncommitted fragment may have left unused unit files.
    publication.walkTopDown().filter(File::isFile).forEach { file ->
        if (file.relativeTo(publication).invariantSeparatorsPath !in declared) check(file.delete())
    }
    File(publication, "manifest.json").outputStream().use { output -> output.write(bytes); output.fd.sync() }
    require(OfflineReadingManifestParser.parse(bytes) == manifest)
    entries.forEach { entry ->
        val file = File(publication, entry.path)
        require(file.length() == entry.sizeBytes && file.sha256Hex() == entry.sha256)
    }
    OfflineReaderPublicationVerifier.verify(publication, manifest, PublicationOrigin.Retained)
    durability.syncTree(publication)
    return VerifiedOfflineReadingMembers(manifest, publication, entries.sumOf { it.sizeBytes } + bytes.size)
}
