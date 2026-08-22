package app.nexus.android.offline.reading

import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * Test-only fixture plumbing: assembles the server's canonical deterministic ZIP encoding
 * (fixed 1980-01-01 DOS timestamp, unix create-system, 0644 regular-file mode, deflate,
 * no extra/comment, declared order) so tests can drive the REAL
 * [OfflineReadingPackageVerifier] instead of a fixture fake. The accept/reject decision
 * always belongs to the production verifier; this file only encodes bytes.
 */
internal data class CanonicalZipMember(
    val path: String,
    val bytes: ByteArray,
    val dosTime: Int = 0,
    val dosDate: Int = 0x21,
    val unixMode: Int = 0x81A4,
)

internal fun encodeCanonicalOfflineReadingZip(members: List<CanonicalZipMember>): ByteArray {
    val output = ByteArrayOutputStream()
    data class Record(val member: CanonicalZipMember, val crc: Long, val compressed: ByteArray, val offset: Int)
    val records = members.map { member ->
        val offset = output.size()
        val crc = CRC32().apply { update(member.bytes) }.value
        val deflater = Deflater(Deflater.DEFAULT_COMPRESSION, true)
        deflater.setInput(member.bytes)
        deflater.finish()
        val compressed = ByteArrayOutputStream().let { sink ->
            val buffer = ByteArray(8192)
            while (!deflater.finished()) {
                val produced = deflater.deflate(buffer)
                sink.write(buffer, 0, produced)
            }
            deflater.end()
            sink.toByteArray()
        }
        val name = member.path.toByteArray(Charsets.UTF_8)
        output.u32(0x04034b50L)
        output.u16(20)                      // version needed
        output.u16(0)                       // flags
        output.u16(8)                       // deflate
        output.u16(member.dosTime)
        output.u16(member.dosDate)
        output.u32(crc)
        output.u32(compressed.size.toLong())
        output.u32(member.bytes.size.toLong())
        output.u16(name.size)
        output.u16(0)                       // extra length
        output.write(name)
        output.write(compressed)
        Record(member, crc, compressed, offset)
    }
    val centralOffset = output.size()
    records.forEach { record ->
        val name = record.member.path.toByteArray(Charsets.UTF_8)
        output.u32(0x02014b50L)
        output.u16((3 shl 8) or 20)         // made by: unix, 2.0
        output.u16(20)                      // version needed
        output.u16(0)                       // flags
        output.u16(8)                       // deflate
        output.u16(record.member.dosTime)
        output.u16(record.member.dosDate)
        output.u32(record.crc)
        output.u32(record.compressed.size.toLong())
        output.u32(record.member.bytes.size.toLong())
        output.u16(name.size)
        output.u16(0)                       // extra length
        output.u16(0)                       // comment length
        output.u16(0)                       // disk number start
        output.u16(0)                       // internal attributes
        output.u32(record.member.unixMode.toLong() shl 16)
        output.u32(record.offset.toLong())
        output.write(name)
    }
    val centralSize = output.size() - centralOffset
    output.u32(0x06054b50L)
    output.u16(0)                           // this disk
    output.u16(0)                           // central-directory disk
    output.u16(records.size)
    output.u16(records.size)
    output.u32(centralSize.toLong())
    output.u32(centralOffset.toLong())
    output.u16(0)                           // comment length
    return output.toByteArray()
}

private fun ByteArrayOutputStream.u16(value: Int) {
    require(value in 0..0xffff)
    write(value and 0xff)
    write((value ushr 8) and 0xff)
}

private fun ByteArrayOutputStream.u32(value: Long) {
    require(value in 0..0xffffffffL)
    write((value and 0xff).toInt())
    write(((value ushr 8) and 0xff).toInt())
    write(((value ushr 16) and 0xff).toInt())
    write(((value ushr 24) and 0xff).toInt())
}

internal fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

internal data class BuiltOfflineReadingPackage(
    val archiveBytes: ByteArray,
    val readerGeneration: Long,
    val expandedBytes: Long,
    val packageSha256: String,
    val readerJson: ByteArray,
    val manifestJson: ByteArray,
)

/**
 * Builds a minimal valid WebArticle package (manifest.json + reader.json) in the
 * canonical archive encoding. The revision key is computed with the production
 * algorithm, which is itself proven against the independently reviewed shared vector.
 */
internal fun buildWebArticleReadingPackage(
    mediaId: UUID,
    title: String,
    readerGeneration: Long = 7,
): BuiltOfflineReadingPackage {
    val readerJson = (
        """{"readerContractVersion":1,"mediaId":"$mediaId","mediaKind":"WebArticle",""" +
            """"title":"$title","navigation":[],"fragments":[{"fragmentId":"intro",""" +
            """"ordinal":0,"htmlSanitized":"<p>reader</p>","canonicalText":"reader"}]}"""
        ).toByteArray()
    val entry = OfflineReadingManifestEntry(
        "reader.json",
        "application/json",
        readerJson.size.toLong(),
        sha256Hex(readerJson),
    )
    val revision = OfflineReadingRevision.compute(readerGeneration, listOf(entry))
    val manifestJson = (
        """{"packageSchemaVersion":1,"readerContractVersion":1,"minimumReaderBundleVersion":1,""" +
            """"mediaId":"$mediaId","mediaKind":"WebArticle","title":"$title",""" +
            """"readerGeneration":$readerGeneration,"readerRevisionKey":"$revision",""" +
            """"entries":[{"path":"reader.json","mediaType":"application/json",""" +
            """"sizeBytes":${entry.sizeBytes},"sha256":"${entry.sha256}"}]}"""
        ).toByteArray()
    val archive = encodeCanonicalOfflineReadingZip(
        listOf(
            CanonicalZipMember("manifest.json", manifestJson),
            CanonicalZipMember("reader.json", readerJson),
        )
    )
    return BuiltOfflineReadingPackage(
        archiveBytes = archive,
        readerGeneration = readerGeneration,
        expandedBytes = entry.sizeBytes,
        packageSha256 = sha256Hex(archive),
        readerJson = readerJson,
        manifestJson = manifestJson,
    )
}

/** Writes the built package into [archive] and returns the production-shaped artifact. */
internal fun BuiltOfflineReadingPackage.stageArtifact(
    archive: File,
    accountId: UUID,
): OfflineReadingTransferArtifact {
    archive.writeBytes(archiveBytes)
    return OfflineReadingTransferArtifact(
        archive = archive,
        accountId = accountId,
        readerGeneration = readerGeneration,
        compressedBytes = archiveBytes.size.toLong(),
        expandedBytes = expandedBytes,
        packageSha256 = packageSha256,
    )
}
