package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Current archive invariants use a valid schema-2 base, so rejecting schema 1 cannot mask them. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingSharedContractTest {
    @get:Rule val temporary = TemporaryFolder()
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val mediaId = UUID.fromString("018f2e74-5efc-7d2f-8a3a-142857142857")

    @Test
    fun `current archive rejects malformed metadata member bytes and zip authority`() {
        val original = buildWebArticleReadingPackage(mediaId, "Archive integrity")
        val accepted = OfflineReadingPackageVerifier().verifyAndExtract(
            original.stageArtifact(temporary.newFile(), accountId), accountId, mediaId,
            File(temporary.newFolder(), "accepted"))
        assertEquals(2, accepted.manifest.packageSchemaVersion)
        for (member in original.members) assertTrue(member.bytes.contentEquals(File(accepted.extractedDirectory, member.path).readBytes()))
        val cases: List<Pair<String, (JSONObject, MutableList<CanonicalZipMember>) -> Unit>> = listOf(
            "future schema" to { manifest, _ -> manifest.put("packageSchemaVersion", 3); Unit },
            "future reader" to { manifest, _ -> manifest.put("readerContractVersion", 2); Unit },
            "future bundle" to { manifest, _ -> manifest.put("minimumReaderBundleVersion", 3); Unit },
            "empty title" to { manifest, _ -> manifest.put("title", ""); Unit },
            "zero generation" to { manifest, _ -> manifest.put("readerGeneration", 0); Unit },
            "uppercase revision" to { manifest, _ -> manifest.put("readerRevisionKey", "A".repeat(64)); Unit },
            "unsorted entries" to { manifest, _ ->
                val entries = manifest.getJSONArray("entries"); val first = entries.get(0)
                entries.put(0, entries.get(1)); entries.put(1, first); Unit
            },
            "traversal path" to { manifest, _ -> manifest.getJSONArray("entries").getJSONObject(0).put("path", "../document.json"); Unit },
            "backslash path" to { manifest, _ -> manifest.getJSONArray("entries").getJSONObject(0).put("path", "assets\\document.json"); Unit },
            "duplicate path" to { manifest, _ ->
                val entries = manifest.getJSONArray("entries"); entries.getJSONObject(1).put("path", entries.getJSONObject(0).getString("path")); Unit
            },
            "manifest member" to { manifest, _ -> manifest.getJSONArray("entries").getJSONObject(0).put("path", "manifest.json"); Unit },
            "missing member" to { _, members -> members.removeAt(1); Unit },
            "undeclared member" to { _, members -> members.add(CanonicalZipMember("assets/unlisted.svg", "<svg/>".toByteArray())); Unit },
            "changed bytes" to { _, members ->
                val unit = members.indexOfFirst { it.path.startsWith("units/") }
                members[unit] = members[unit].copy(bytes = members[unit].bytes.toString(Charsets.UTF_8).replace("reader", "readeX").toByteArray())
            },
            "changed length" to { _, members -> members[1] = members[1].copy(bytes = members[1].bytes + byteArrayOf(32)) },
            "symbolic link" to { _, members -> members[1] = members[1].copy(unixMode = 0xA1A4) },
            "nonfixed timestamp" to { _, members -> members[1] = members[1].copy(dosTime = 0x6000, dosDate = 0x2a21) },
            "nested archive" to { _, members -> members.add(CanonicalZipMember("assets/cover.zip", byteArrayOf(0x50, 0x4b))); Unit },
        )
        for ((name, mutate) in cases) {
            val manifest = JSONObject(original.members.first().bytes.toString(Charsets.UTF_8))
            val members = original.members.toMutableList()
            mutate(manifest, members)
            members[0] = CanonicalZipMember("manifest.json", manifest.toString().toByteArray())
            val archive = temporary.newFile().apply { writeBytes(encodeCanonicalOfflineReadingZip(members)) }
            val destination = File(temporary.newFolder(), "candidate")
            val outcome = runCatching {
                OfflineReadingPackageVerifier().verifyAndExtract(
                    OfflineReadingTransferArtifact(archive, accountId, 7, archive.length(), original.expandedBytes, archive.sha256Hex()),
                    accountId, mediaId, destination)
            }
            assertTrue("schema-two archive accepted $name", outcome.isFailure)
            assertTrue(outcome.exceptionOrNull() is OfflineReadingPackageException)
            assertFalse("failed archive retained candidate files", destination.exists())
        }
    }

    /**
     * The reviewed cross-language corpus still owns the verdict for every
     * schema-1 package it declares valid: the current ingress must refuse all of
     * them, and refuse them for the retired schema rather than as corruption.
     * Deleting the schema guard turns this red instead of silently re-admitting
     * the old whole-document reader.
     */
    @Test
    fun `every shared schema one package is refused for its schema, not as corruption`() {
        val corpus = JSONObject(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).readText())
        val documents = corpus.getJSONArray("readerDocuments").let { rows ->
            (0 until rows.length()).associate { rows.getJSONObject(it).getString("id") to rows.getJSONObject(it).getString("utf8") }
        }
        val packages = corpus.getJSONArray("validPackages")
        assertEquals("reviewed valid package corpus lost its vectors", 3, packages.length())
        for (index in 0 until packages.length()) {
            val vector = packages.getJSONObject(index)
            val name = vector.getString("name")
            val manifest = vector.getJSONObject("package").getJSONObject("manifest")
            assertEquals(name, 1, manifest.getInt("packageSchemaVersion"))
            val bodies = vector.getJSONObject("package").getJSONArray("entryBodies")
            val members = mutableListOf(CanonicalZipMember("manifest.json", manifest.toString().toByteArray()))
            for (body in 0 until bodies.length()) {
                val member = bodies.getJSONObject(body)
                val utf8 = if (member.has("readerDocument")) documents.getValue(member.getString("readerDocument"))
                    else member.getString("utf8")
                members += CanonicalZipMember(member.getString("path"), utf8.toByteArray())
            }
            val archive = temporary.newFile().apply { writeBytes(encodeCanonicalOfflineReadingZip(members)) }
            val destination = File(temporary.newFolder(), "candidate")
            val error = assertThrows(name, OfflineReadingPackageException::class.java) {
                OfflineReadingPackageVerifier().verifyAndExtract(
                    OfflineReadingTransferArtifact(archive, accountId, manifest.getLong("readerGeneration"),
                        archive.length(), members.drop(1).sumOf { it.bytes.size.toLong() }, archive.sha256Hex()),
                    accountId, UUID.fromString(manifest.getString("mediaId")), destination)
            }
            assertEquals(name, ReadingFailureReason.UnsupportedPackage, error.reason)
            assertFalse("refused schema-one package retained candidate files for $name", destination.exists())
        }
    }

    @Test
    fun `shared SVG namespace and raw JSON verdicts retain their actual owners`() {
        val corpus = JSONObject(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).readText())
        val svg = corpus.getJSONArray("validSvgAssetCases")
        for (index in 0 until svg.length()) {
            val vector = svg.getJSONObject(index)
            val file = temporary.newFile().apply { writeText(vector.getString("utf8")) }
            assertEquals(vector.getString("name"), vector.getJSONObject("expect").getString("kind") == "Accept",
                OfflineReadingPackageVerifier().assetSignatureMatches(vector.getString("path"), vector.getString("mediaType"), file, 2))
        }
        val malformed = corpus.getJSONArray("invalidRawJsonCases")
        for (index in 0 until malformed.length()) {
            val vector = malformed.getJSONObject(index)
            assertTrue(vector.getString("name"), runCatching { OfflineReadingManifestParser.parse(vector.getString("utf8").toByteArray()) }.isFailure)
        }
    }
}
