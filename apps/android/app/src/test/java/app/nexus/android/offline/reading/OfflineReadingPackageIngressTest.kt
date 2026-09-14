package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingPackageIngressTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `new downloads refuse schema one before allocating its reader member`() {
        InstalledLegacyReadingFixture(temporary.newFolder()).use { original ->
            val members = listOf("manifest.json", "reader.json").map {
                CanonicalZipMember(it, File(original.installedDirectory, it).readBytes())
            }
            val archive = temporary.newFile().apply { writeBytes(encodeCanonicalOfflineReadingZip(members)) }
            val artifact = OfflineReadingTransferArtifact(archive, original.account, 7, archive.length(),
                original.reader.size.toLong(), archive.sha256Hex())
            val destination = File(temporary.newFolder(), "candidate")
            val outcome = runCatching { OfflineReadingPackageVerifier().verifyAndExtract(artifact, original.account, original.media, destination) }
            assertTrue("new download accepted retired schema-one allocation path", outcome.isFailure)
            assertEquals("retired schema-one archive entered current member validation", ReadingFailureReason.UnsupportedPackage, (outcome.exceptionOrNull() as OfflineReadingPackageException).reason)
            assertFalse(destination.exists())
            assertTrue(original.reader.contentEquals(File(original.installedDirectory, "reader.json").readBytes()))
        }
    }

    @Test
    fun `actual schema two producer archives install exact bytes including the manifest`() {
        val corpus = File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile, "offline-reading")
        val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        for (name in listOf("retained-unicode-schema-2", "retained-pdf-schema-2", "retained-epub-schema-2", "retained-table-context-schema-2")) {
            val archive = File(corpus, "$name.zip")
            val metadata = JSONObject(File(corpus, "$name.json").readText())
            val manifest = metadata.getJSONObject("manifest")
            val declared = manifest.getJSONArray("entries")
            val expanded = (0 until declared.length()).sumOf { declared.getJSONObject(it).getLong("sizeBytes") }
            val artifact = OfflineReadingTransferArtifact(archive, account, manifest.getLong("readerGeneration"), archive.length(), expanded, archive.sha256Hex())
            val destination = File(temporary.newFolder(), "candidate")
            val verified = OfflineReadingPackageVerifier().verifyAndExtract(artifact, account, UUID.fromString(manifest.getString("mediaId")), destination)
            assertEquals(2, verified.manifest.packageSchemaVersion)
            assertEquals(expanded + File(destination, "manifest.json").length(), verified.installedBytes)
            for (index in 0 until declared.length()) {
                val entry = declared.getJSONObject(index)
                val member = File(destination, entry.getString("path"))
                assertEquals(entry.getLong("sizeBytes"), member.length())
                assertEquals(entry.getString("sha256"), member.sha256Hex())
            }
        }
    }
}
