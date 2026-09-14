package app.nexus.android.offline.reading

import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.Deflater
import org.json.JSONArray
import org.json.JSONObject

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
    val members: List<CanonicalZipMember>,
)

/** External schema-2 bytes; source identity/coordinates remain independently declared. */
internal fun buildWebArticleReadingPackage(
    mediaId: UUID,
    title: String,
    readerGeneration: Long = 7,
): BuiltOfflineReadingPackage {
    val bodies = sortedMapOf<String, ByteArray>()
    fun reference(path: String) = JSONObject().put("key", path)
        .put("bytes", bodies.getValue(path).size).put("sha256", sha256Hex(bodies.getValue(path)))
    bodies["units/intro.json"] = JSONObject("""{
      "fragment_id":"intro","fragment_idx":0,"fragment_document_start_cp":0,"fragment_length_cp":6,
      "document_word_start":0,"starts_in_word":false,"start_cp":0,"end_cp":6,
      "render_start_cp":0,"render_end_cp":6,"canonical_text":"reader","word_boundaries":[0,6],
      "render_nodes":[{"kind":"Element","parent":null,"namespace":"html","name":"p","attributes":[]},
        {"kind":"Text","parent":0,"text":"reader"}],
      "assets":[],"table_contexts":[],"epub_target":null,"document_embeds":[]
    }""").toString().toByteArray()
    val unit = reference("units/intro.json")
    bodies["index/0.json"] = JSONObject("""{
      "units":[],"sections":[],"toc":[],"landmarks":[],"page_list":[],"table_metadata":[],"anchors":[],"next_ref":null
    }""").put("units", JSONArray().put(JSONObject().put("member", unit).put("ordinal", 0)
        .put("fragment_id", "intro").put("fragment_idx", 0).put("start_cp", 0).put("end_cp", 6)))
        .toString().toByteArray()
    bodies["descriptor.json"] = JSONObject().put("media_id", mediaId.toString())
        .put("reader_generation", readerGeneration).put("kind", "web_article").put("title", title)
        .put("reader_contract_version", 1).put("first_unit_ref", unit).put("index_ref", reference("index/0.json"))
        .put("contents_ref", JSONObject.NULL).put("table_metadata_ref", JSONObject.NULL).put("unit_count", 1).put("canonical_length", 6).toString().toByteArray()
    val entries = bodies.map { (path, bytes) -> OfflineReadingManifestEntry(path, "application/json", bytes.size.toLong(), sha256Hex(bytes)) }
    val manifest = JSONObject().put("packageSchemaVersion", 2).put("readerContractVersion", 1)
        .put("minimumReaderBundleVersion", 2).put("mediaId", mediaId.toString()).put("mediaKind", "WebArticle")
        .put("title", title).put("readerGeneration", readerGeneration)
        .put("readerRevisionKey", OfflineReadingRevision.compute(readerGeneration, entries))
        .put("entries", JSONArray(entries.map { entry -> JSONObject().put("path", entry.path).put("mediaType", entry.mediaType)
            .put("sizeBytes", entry.sizeBytes).put("sha256", entry.sha256) })).toString().toByteArray()
    val members = listOf(CanonicalZipMember("manifest.json", manifest)) + bodies.map { (path, bytes) -> CanonicalZipMember(path, bytes) }
    val archive = encodeCanonicalOfflineReadingZip(members)
    return BuiltOfflineReadingPackage(archive, readerGeneration, entries.sumOf { it.sizeBytes }, sha256Hex(archive), members)
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
