package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import java.util.zip.ZipFile
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReaderPublicationVerifierTest {
    @get:Rule val temporary = TemporaryFolder()
    private val mediaId = UUID.fromString("11111111-1111-4111-8111-111111111111")
    private val accountId = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    private val fragmentId = "22222222-2222-4222-8222-222222222222"

    @Test
    fun `python produced archives preserve unicode and separate sparse table chains`() {
        val fixtures = File(File(System.getProperty("nexus.testdata.offlineReadingContract")
            ?: error("testdata root is missing")).parentFile, "offline-reading")
        for (name in listOf("retained-unicode-schema-2", "retained-table-context-schema-2")) {
            val metadata = JSONObject(File(fixtures, "$name.json").readText())
            val file = File(fixtures, "$name.zip")
            val id = UUID.fromString("00000000-0000-4000-8000-000000000007")
            val transfer = OfflineReadingTransferArtifact(file, accountId, 7, file.length(),
                metadata.getLong("expanded_bytes"), metadata.getString("package_sha256"))
            val directory = File(temporary.root, name)
            val verified = OfflineReadingPackageVerifier().verifyAndExtract(transfer, accountId, id, directory)
            assertEquals(7L, verified.manifest.readerGeneration)
            val first = JSONObject(File(directory, "units/00000000-0000-4000-8000-000000000008/0-7-0.json").readText())
            val second = JSONObject(File(directory, "units/00000000-0000-4000-8000-000000000008/7-10-0.json").readText())
            assertEquals("café 🧠\ncat", first.getString("canonical_text") + second.getString("canonical_text"))
            assertFalse(first.has("html_sanitized"))
            assertTrue(first.getJSONArray("render_nodes").length() > 0)
            assertEquals(7L, second.getLong("start_cp"))
            if (name == "retained-table-context-schema-2") {
                val headers = JSONObject(File(directory,
                    "index/tables/00000000-0000-4000-8000-000000000008/0/1-0/0.json").readText())
                assertEquals(0, headers.getJSONArray("units").length())
                val records = headers.getJSONArray("table_metadata")
                assertEquals("Table", records.getJSONObject(0).getString("kind"))
                val header = records.getJSONObject(1)
                assertEquals("Cell", header.getString("kind"))
                assertEquals("column", header.getString("header_kind"))
                val range = header.getJSONObject("range")
                assertEquals(0L, range.getLong("start_cp"))
                assertEquals(6L, range.getLong("end_cp"))
                val continuation = JSONObject(File(directory, headers.getJSONObject("next_ref").getString("key")).readText())
                val explicit = continuation.getJSONArray("table_metadata").getJSONObject(0)
                assertEquals("ExplicitHeader", explicit.getString("kind"))
                assertEquals(1L, explicit.getLong("row"))
                assertEquals(0L, explicit.getLong("target_row"))
                assertEquals(0L, explicit.getLong("target_column"))
            }
        }
    }

    @Test
    fun `schema two verifies unique units with original unicode offsets`() {
        val artifact = readerPublicationArtifact(temporary.root, "captured-image")
        val directory = File(temporary.root, "verified")
        val verified = try {
            OfflineReadingPackageVerifier().verifyAndExtract(artifact, accountId, mediaId, directory)
        } catch (error: OfflineReadingPackageException) {
            throw AssertionError("valid unicode publication was rejected", error)
        }
        assertEquals(2, verified.manifest.packageSchemaVersion)
        assertEquals(7L, verified.manifest.readerGeneration)
        assertFalse(File(directory, "reader.json").exists())
        assertTrue(File(directory, "descriptor.json").length() < 1024)
        val last = JSONObject(File(directory, "units/second.json").readText())
        assertEquals(3L, last.getLong("start_cp"))
        assertEquals(4L, last.getLong("end_cp"))
        assertEquals("c", last.getString("canonical_text"))
    }

    @Test
    fun `generation mismatch and broken member closure never publish a verified directory`() {
        listOf("generation", "gap", "live-image", "ping", "local-ping", "cite", "duplicate-unit",
            "parent-text", "parent-future", "noncontiguous", "bad-name", "duplicate-attribute", "empty-text",
            "paint-html", "paint-namespace", "paint-attribute", "paint-empty", "paint-extra", "paint-fallback").forEach { fault ->
            val directory = File(temporary.root, "verified-$fault")
            val error = assertThrows(OfflineReadingPackageException::class.java) {
                OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, fault), accountId, mediaId, directory)
            }
            assertEquals(fault, ReadingFailureReason.Integrity, error.reason)
            assertFalse("partial publication survived $fault", directory.exists())
        }
    }

    @Test
    // No committed producer archive carries a typed SVG paint value, so this
    // acceptance rule is bound to a hand-authored wire on both sides. The name
    // records that gap until the publication owner ships such a fixture.
    fun `svg paint keeps decoded fragment identity and literal fallback, hand authored wire only`() {
        val directory = File(temporary.root, "paint")
        try {
            OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, "paint"), accountId, mediaId, directory)
        } catch (error: OfflineReadingPackageException) {
            throw AssertionError("valid typed paint publication was rejected", error)
        }
        val nodes = JSONObject(File(directory, "units/second.json").readText()).getJSONArray("render_nodes")
        val paint = nodes.getJSONObject(2).getJSONArray("attributes").getJSONObject(0).getJSONObject("value")
        assertEquals("local 🧠%20", paint.getString("fragment_id"))
        assertEquals("currentColor", paint.getString("fallback"))
    }

    @Test
    fun `original word slices admit empty interiors and refuse missing hosted metadata`() {
        val directory = File(temporary.root, "word-interior")
        val rejectedSlice = try {
            OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, "word-interior"), accountId, mediaId, directory)
            null
        } catch (error: OfflineReadingPackageException) { error }
        assertEquals("original fragment word boundaries were rejected", null, rejectedSlice)
        val first = JSONObject(File(directory, "units/first.json").readText())
        val middle = JSONObject(File(directory, "units/second.json").readText())
        val last = JSONObject(File(directory, "units/third.json").readText())
        assertEquals("abcdef", first.getString("canonical_text") + middle.getString("canonical_text") + last.getString("canonical_text"))
        assertEquals("[0]", first.getJSONArray("word_boundaries").toString())
        assertEquals("[]", middle.getJSONArray("word_boundaries").toString())
        assertEquals("[6]", last.getJSONArray("word_boundaries").toString())
        val missing = File(temporary.root, "no-find")
        val error = assertThrows("download accepted missing hosted Find metadata", OfflineReadingPackageException::class.java) {
            OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, "no-find"), accountId, mediaId, missing)
        }
        assertEquals(ReadingFailureReason.Integrity, error.reason)
        assertEquals("downloaded publication unit omits Find metadata", error.cause?.message)
        assertFalse(missing.exists())
    }

    @Test
    fun `actual source table members retain original word boundaries inside unit edges`() {
        val fixtures = File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile, "offline-reading")
        val fixture = File(fixtures, "source-table-schema-2-members.json")
        assertEquals("d0ae33c2a0eea0a2aa219354b19b8197e037da7bd9c577a6b51f430da02e5184", fixture.sha256Hex())
        val members = JSONObject(fixture.readText()).getJSONObject("members")
        val directory = temporary.newFolder("source-table")
        val entries = members.keys().asSequence().toList().sorted().map { key ->
            val file = File(directory, key)
            check(file.parentFile.mkdirs() || file.parentFile.isDirectory)
            file.writeText(members.getString(key))
            OfflineReadingManifestEntry(key, "application/json", file.length(), file.sha256Hex())
        }
        val descriptor = JSONObject(members.getString("descriptor.json"))
        val generation = descriptor.getLong("reader_generation")
        // Only native attestation metadata is constructed. Every publication
        // member is the exact retained producer string; no archive is recreated.
        val manifest = OfflineReadingManifest(UUID.fromString(descriptor.getString("media_id")), OfflineReadingMediaKind.WebArticle,
            descriptor.getString("title"), generation, OfflineReadingRevision.compute(generation, entries), entries, 2)
        val first = JSONObject(members.getString(descriptor.getJSONObject("first_unit_ref").getString("key")))
        val boundaries = first.getJSONArray("word_boundaries")
        assertEquals(158L, first.getLong("end_cp"))
        assertEquals(105L, boundaries.getLong(boundaries.length() - 1))
        val rejectedSource = try {
            OfflineReaderPublicationVerifier.verify(directory, manifest, PublicationOrigin.Downloaded)
            null
        } catch (error: IllegalArgumentException) { error }
        assertEquals("original fragment word boundaries were rejected", null, rejectedSource)
        for (entry in entries) assertEquals(entry.sha256, File(directory, entry.path).sha256Hex())
    }

    @Test
    fun `the same bytes are admitted as a local conversion and refused as a download`() {
        val directory = File(temporary.root, "converted").apply { check(mkdirs()) }
        val artifact = readerPublicationArtifact(temporary.root, "no-find")
        ZipFile(artifact.archive).use { archive ->
            archive.entries().asSequence().forEach { entry ->
                val target = File(directory, entry.name)
                check(target.parentFile!!.mkdirs() || target.parentFile!!.isDirectory)
                archive.getInputStream(entry).use { input -> target.outputStream().use { output -> input.copyTo(output) } }
            }
        }
        val manifest = OfflineReadingManifestParser.parse(File(directory, "manifest.json").readBytes())
        OfflineReaderPublicationVerifier.verify(directory, manifest, PublicationOrigin.Retained)
        val refused = assertThrows(IllegalArgumentException::class.java) {
            OfflineReaderPublicationVerifier.verify(directory, manifest, PublicationOrigin.Downloaded)
        }
        assertEquals("downloaded publication unit omits Find metadata", refused.message)
        assertTrue(JSONObject(File(directory, "units/first.json").readText()).isNull("word_boundaries"))
    }

}
