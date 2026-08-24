package app.nexus.android.offline.reading

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.util.UUID

/**
 * The independently reviewed shared vector is the oracle; the REAL
 * [OfflineReadingPackageVerifier] is the decision maker for every package vector. The
 * test only assembles bytes — it re-implements no integrity rule, so deleting a
 * production check turns the corresponding reject vector red here.
 */
class OfflineReadingSharedContractTest {
    private val contract = JSONObject(
        File(
            System.getProperty("nexus.testdata.offlineReadingContract")
                ?: error("offline-reading shared contract path is missing"),
        ).readText()
    )

    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")

    @Test
    fun `Kotlin accepts every shared valid package and rejects every package and reader fault`() {
        val readerDocuments = contract.getJSONArray("readerDocuments")
            .objects()
            .associateBy { it.getString("id") }
        val validPackages = contract.getJSONArray("validPackages").objects()
            .associateBy { it.getString("name") }

        validPackages.values.forEach { vector ->
            val assembled = assemblePackage(vector.getJSONObject("package"), readerDocuments)
            verifyAssembled(assembled) { verified ->
                // Accepted vectors must extract byte-identically through the real verifier.
                assertArrayEquals(
                    "manifest.json for ${vector.getString("name")}",
                    assembled.manifestBytes,
                    verified.extractedDirectory.resolve("manifest.json").readBytes(),
                )
                assertEquals(
                    assembled.mediaId,
                    verified.manifest.mediaId,
                )
                assembled.bodies.forEach { (path, bytes) ->
                    assertArrayEquals(
                        "$path for ${vector.getString("name")}",
                        bytes,
                        verified.extractedDirectory.resolve(path).readBytes(),
                    )
                }
            }
        }

        contract.getJSONArray("invalidPackageCases").objects().forEach { vector ->
            val packageWrapper = JSONObject(validPackages.getValue(vector.getString("base")).toString())
            applyPatches(packageWrapper, vector.getJSONArray("patch"))
            val assembled = assemblePackage(packageWrapper.getJSONObject("package"), readerDocuments)
            assertThrows(
                "expected ${vector.getString("name")} to reject",
                OfflineReadingPackageException::class.java,
            ) {
                verifyAssembled(assembled)
            }
        }

        contract.getJSONArray("invalidArchiveCases").objects().forEach { vector ->
            val assembled = assembleArchiveFault(vector, validPackages, readerDocuments)
            assertThrows(
                "expected ${vector.getString("name")} to reject",
                OfflineReadingPackageException::class.java,
            ) {
                verifyAssembled(assembled)
            }
        }

        readerDocuments.values.forEach { vector ->
            val expected = vector.getJSONObject("expect").getString("kind")
            val packageName = vector.optString("package").takeIf { it.isNotEmpty() }
                ?: when {
                    vector.getString("utf8").contains("\"mediaKind\":\"Pdf\"") -> "pdf-verified-copy"
                    vector.getString("utf8").contains("\"mediaKind\":\"Epub\"") -> "epub-local-asset-copy"
                    else -> "web-text-only-copy"
                }
            val manifest = OfflineReadingManifestParser.parse(
                validPackages.getValue(packageName)
                    .getJSONObject("package")
                    .getJSONObject("manifest")
                    .toString()
                    .toByteArray()
            )
            if (expected == "Accept") {
                OfflineReaderDocumentVerifier.verify(vector.getString("utf8").toByteArray(), manifest)
            } else {
                assertThrows("expected ${vector.getString("id")} to reject", RuntimeException::class.java) {
                    OfflineReaderDocumentVerifier.verify(vector.getString("utf8").toByteArray(), manifest)
                }
            }
        }

        contract.getJSONArray("invalidRawJsonCases").objects().forEach { vector ->
            assertThrows("expected ${vector.getString("name")} to reject", RuntimeException::class.java) {
                OfflineReadingManifestParser.parse(vector.getString("utf8").toByteArray())
            }
        }
    }

    @Test
    fun `Kotlin accepts every shared SVG namespace declaration vector`() {
        val readerDocuments = contract.getJSONArray("readerDocuments")
            .objects()
            .associateBy { it.getString("id") }
        val basePackage = contract.getJSONArray("validPackages")
            .objects()
            .single { it.getString("name") == "epub-local-asset-copy" }
            .getJSONObject("package")

        contract.getJSONArray("validSvgAssetCases").objects().forEach { vector ->
            assertEquals("Accept", vector.getJSONObject("expect").getString("kind"))
            val packageValue = JSONObject(basePackage.toString())
            val manifest = packageValue.getJSONObject("manifest")
            val path = vector.getString("path")
            val body = vector.getString("utf8").toByteArray()
            val entry = manifest.getJSONArray("entries").objects()
                .single { it.getString("path") == path }
            entry.put("mediaType", vector.getString("mediaType"))
            entry.put("sizeBytes", body.size)
            entry.put("sha256", sha256Hex(body))
            packageValue.getJSONArray("entryBodies").objects()
                .single { it.getString("path") == path }
                .put("utf8", vector.getString("utf8"))
            val entries = manifest.getJSONArray("entries").objects().map {
                OfflineReadingManifestEntry(
                    path = it.getString("path"),
                    mediaType = it.getString("mediaType"),
                    sizeBytes = it.getLong("sizeBytes"),
                    sha256 = it.getString("sha256"),
                )
            }
            manifest.put(
                "readerRevisionKey",
                OfflineReadingRevision.compute(manifest.getLong("readerGeneration"), entries),
            )

            val assembled = assemblePackage(packageValue, readerDocuments)
            verifyAssembled(assembled) { verified ->
                assertArrayEquals(
                    vector.getString("name"),
                    body,
                    verified.extractedDirectory.resolve(path).readBytes(),
                )
            }
        }
    }

    private data class AssembledVector(
        val members: List<CanonicalZipMember>,
        val manifestBytes: ByteArray,
        val bodies: Map<String, ByteArray>,
        val mediaId: UUID,
        val readerGeneration: Long,
        val expandedBytes: Long,
    )

    /**
     * Pure byte assembly from the vector's raw JSON. Deliberately reads the manifest with
     * org.json rather than the production parser so a malformed manifest still assembles
     * into an archive and the production verifier makes the reject decision.
     */
    private fun assemblePackage(
        packageValue: JSONObject,
        readers: Map<String, JSONObject>,
    ): AssembledVector {
        val manifestJson = packageValue.getJSONObject("manifest")
        val manifestBytes = manifestJson.toString().toByteArray()
        val bodies = LinkedHashMap<String, ByteArray>()
        packageValue.getJSONArray("entryBodies").objects().forEach { body ->
            bodies[body.getString("path")] = when {
                body.has("utf8") -> body.getString("utf8").toByteArray()
                else -> readers.getValue(body.getString("readerDocument")).getString("utf8").toByteArray()
            }
        }
        val declared = manifestJson.getJSONArray("entries").objects()
        val declaredOrder = declared.map { it.getString("path") }
        val ordered = LinkedHashMap<String, ByteArray>()
        declaredOrder.forEach { path -> bodies[path]?.let { ordered[path] = it } }
        bodies.forEach { (path, memberBytes) ->
            if (path !in ordered) ordered[path] = memberBytes
        }
        return AssembledVector(
            members = listOf(CanonicalZipMember("manifest.json", manifestBytes)) +
                ordered.map { (path, memberBytes) -> CanonicalZipMember(path, memberBytes) },
            manifestBytes = manifestBytes,
            bodies = ordered,
            mediaId = UUID.fromString(manifestJson.getString("mediaId")),
            readerGeneration = manifestJson.getLong("readerGeneration"),
            expandedBytes = declared.sumOf { it.getLong("sizeBytes") },
        )
    }

    private fun assembleArchiveFault(
        vector: JSONObject,
        validPackages: Map<String, JSONObject>,
        readers: Map<String, JSONObject>,
    ): AssembledVector {
        val entryPath = vector.getString("entryPath")
        val baseName = if (entryPath.startsWith("assets/")) {
            "epub-local-asset-copy"
        } else {
            "pdf-verified-copy"
        }
        val base = assemblePackage(
            validPackages.getValue(baseName).getJSONObject("package"),
            readers,
        )
        val members = when (val attribute = vector.getString("zipAttribute")) {
            "symlink" -> base.members.map { member ->
                if (member.path == entryPath) member.copy(unixMode = 0xA1FF) else member
            }
            "nestedArchive" -> base.members + CanonicalZipMember(entryPath, byteArrayOf(0x50, 0x4b))
            "timestamp-not-1980-01-01T00:00:00" -> base.members.map { member ->
                if (member.path == entryPath) {
                    member.copy(dosTime = 0x6000, dosDate = 0x2a21)
                } else {
                    member
                }
            }
            else -> error("unsupported shared-contract zip attribute $attribute")
        }
        return base.copy(members = members)
    }

    private fun verifyAssembled(
        assembled: AssembledVector,
        inspect: (VerifiedOfflineReadingPackage) -> Unit = {},
    ) {
        val workDirectory = kotlin.io.path.createTempDirectory("offline-shared-contract").toFile()
        try {
            val archiveBytes = encodeCanonicalOfflineReadingZip(assembled.members)
            val archive = workDirectory.resolve("package.zip").apply { writeBytes(archiveBytes) }
            val verified = OfflineReadingPackageVerifier().verifyAndExtract(
                OfflineReadingTransferArtifact(
                    archive = archive,
                    accountId = accountId,
                    readerGeneration = assembled.readerGeneration,
                    compressedBytes = archiveBytes.size.toLong(),
                    expandedBytes = assembled.expandedBytes,
                    packageSha256 = sha256Hex(archiveBytes),
                ),
                expectedAccountId = accountId,
                expectedMediaId = assembled.mediaId,
                destination = workDirectory.resolve("verified").resolve("package"),
            )
            inspect(verified)
        } finally {
            workDirectory.deleteRecursively()
        }
    }

    private fun applyPatches(root: JSONObject, patches: JSONArray) {
        patches.objects().forEach { patch ->
            when (patch.getString("op")) {
                "replace" -> set(root, patch.getString("path"), patch.get("value"), replace = true)
                "add" -> set(root, patch.getString("path"), patch.get("value"), replace = false)
                "remove" -> remove(root, patch.getString("path"))
                "move" -> {
                    val moved = remove(root, patch.getString("from"))
                    set(root, patch.getString("path"), moved, replace = false)
                }
                else -> error("unsupported shared-contract patch operation ${patch.getString("op")}")
            }
        }
    }

    private fun set(root: JSONObject, pointer: String, value: Any, replace: Boolean) {
        val (parent, token) = resolveParent(root, pointer)
        when (parent) {
            is JSONObject -> {
                if (replace) require(parent.has(token))
                parent.put(token, value)
            }
            is JSONArray -> {
                if (token == "-") {
                    parent.put(value)
                } else {
                    val index = token.toInt()
                    if (replace) {
                        parent.put(index, value)
                    } else {
                        val values = (0 until parent.length()).map(parent::get).toMutableList()
                        values.add(index, value)
                        while (parent.length() > 0) parent.remove(parent.length() - 1)
                        values.forEach(parent::put)
                    }
                }
            }
            else -> error("JSON patch parent is not a container")
        }
    }

    private fun remove(root: JSONObject, pointer: String): Any {
        val (parent, token) = resolveParent(root, pointer)
        return when (parent) {
            is JSONObject -> parent.remove(token) ?: error("JSON patch key $token is absent")
            is JSONArray -> parent.remove(token.toInt()) ?: error("JSON patch index $token is absent")
            else -> error("JSON patch parent is not a container")
        }
    }

    private fun resolveParent(root: JSONObject, pointer: String): Pair<Any, String> {
        val tokens = pointer.removePrefix("/").split('/').map {
            it.replace("~1", "/").replace("~0", "~")
        }
        var current: Any = root
        tokens.dropLast(1).forEach { token ->
            current = when (current) {
                is JSONObject -> current.get(token)
                is JSONArray -> current.get(token.toInt())
                else -> error("JSON patch traversed a scalar")
            }
        }
        return current to tokens.last()
    }

    private fun JSONArray.objects(): List<JSONObject> =
        (0 until length()).map(::getJSONObject)
}
