package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Historical installed bytes enter the real streaming converter, never new-download ingress. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyContractTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `historical reader verdicts survive streaming conversion and final graph validation`() {
        val corpus = JSONObject(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).readText())
        val packages = corpus.getJSONArray("validPackages")
        val readers = corpus.getJSONArray("readerDocuments")
        for (index in 0 until readers.length()) {
            val vector = readers.getJSONObject(index)
            val raw = vector.getString("utf8")
            val packageName = vector.optString("package").takeIf { it.isNotEmpty() } ?: when {
                raw.contains("\"mediaKind\":\"Pdf\"") -> "pdf-verified-copy"
                raw.contains("\"mediaKind\":\"Epub\"") -> "epub-local-asset-copy"
                else -> "web-text-only-copy"
            }
            val source = temporary.newFolder()
            val original = (0 until packages.length()).map(packages::getJSONObject)
                .single { it.getString("name") == packageName }.getJSONObject("package")
            val manifest = JSONObject(original.getJSONObject("manifest").toString())
            val entries = manifest.getJSONArray("entries")
            val bodies = original.getJSONArray("entryBodies")
            for (bodyIndex in 0 until bodies.length()) {
                val body = bodies.getJSONObject(bodyIndex)
                val path = body.getString("path")
                val bytes = (if (path == "reader.json") raw else body.getString("utf8")).toByteArray()
                File(source, path).apply { parentFile!!.mkdirs(); writeBytes(bytes) }
                val entry = (0 until entries.length()).map(entries::getJSONObject).single { it.getString("path") == path }
                entry.put("sizeBytes", bytes.size).put("sha256", sha256Hex(bytes))
            }
            val declared = (0 until entries.length()).map(entries::getJSONObject).map {
                OfflineReadingManifestEntry(it.getString("path"), it.getString("mediaType"), it.getLong("sizeBytes"), it.getString("sha256"))
            }
            manifest.put("readerRevisionKey", OfflineReadingRevision.compute(manifest.getLong("readerGeneration"), declared))
            File(source, "manifest.json").writeText(manifest.toString())
            val staging = temporary.newFolder()
            val outcome = runCatching {
                if (manifest.getString("mediaKind") == "Pdf") {
                    // The historical PDF body is signature-only. This verdict owns its
                    // metadata parser, not Android PDF rendering or full migration.
                    stageLegacyReaderSource(source, OfflineReadingManifestParser.parse(manifest.toString().toByteArray()), staging, NoOpDurability)
                } else {
                    val converted = stageLegacyReaderPackage(source, staging, NoOpDurability)
                    assertEquals(2, converted.manifest.packageSchemaVersion)
                }
            }
            val expected = vector.getJSONObject("expect").getString("kind") == "Accept"
            assertEquals("historical reader ${vector.getString("id")} changed its validity: ${outcome.exceptionOrNull()}", expected, outcome.isSuccess)
            assertTrue("migration changed original source", raw.toByteArray().contentEquals(File(source, "reader.json").readBytes()))
        }
    }
    @Test
    fun `legacy URL prose remains valid while remote or executable attributes never activate`() {
        val media = UUID.fromString("018f2e74-5efc-7d2f-8a3a-142857142857")
        val canonical = "Read https://example.com in prose."
        fun convert(html: String): Result<Unit> = runCatching {
            val directory = temporary.newFolder()
            val staging = temporary.newFolder()
            val bytes = JSONObject().put("readerContractVersion", 1).put("mediaId", media.toString())
                .put("mediaKind", "WebArticle").put("title", "Original prose")
                .put("navigation", JSONArray()).put("fragments", JSONArray().put(JSONObject()
                    .put("fragmentId", "intro").put("ordinal", 0).put("htmlSanitized", html).put("canonicalText", canonical)))
                .toString().toByteArray()
            File(directory, "reader.json").writeBytes(bytes)
            val originalEntries = listOf(OfflineReadingManifestEntry("reader.json", "application/json", bytes.size.toLong(), sha256Hex(bytes)))
            val original = OfflineReadingManifest(media, OfflineReadingMediaKind.WebArticle, "Original prose", 7,
                OfflineReadingRevision.compute(7, originalEntries), originalEntries, 1)
            stageLegacyReaderSource(directory, original, staging, NoOpDurability)
            stageLegacyReaderUnits(staging, original, NoOpDurability)
            val entries = stageLegacyReaderIndex(directory, staging, original, NoOpDurability)
            OfflineReaderPublicationVerifier.verify(File(staging, "publication"), original.copy(
                readerRevisionKey = OfflineReadingRevision.compute(7, entries), entries = entries, packageSchemaVersion = 2), PublicationOrigin.Retained)
        }
        assertTrue(convert("<article><p>$canonical</p></article>").isSuccess)
        for (attribute in listOf("href=\"https://example.com\"", "href=javascript:alert(1)",
            "href=jav&#x61;script:alert(1)", "\nhref=https://example.com")) {
            assertTrue("legacy remote attribute activated: $attribute", convert("<p><a $attribute>Read</a> https://example.com in prose.</p>").isFailure)
        }
        assertTrue("legacy undeclared image activated", convert("<p>$canonical</p><img src=//example.com/pixel.png>").isFailure)
    }

}
