package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReaderPublicationEpubTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `all epub units retain the first source section as their independently usable default`() {
        val media = UUID.fromString("11111111-1111-4111-8111-111111111111")
        val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        val directory = File(temporary.root, "valid")
        OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, "epub"), account, media, directory)
        assertEquals("chapter-1", JSONObject(File(directory, "units/second.json").readText()).getJSONObject("epub_target").getString("section_id"))
        for (fault in listOf("epub-inconsistent", "epub-missing-section", "epub-wrong-section", "epub-wrong-unit", "epub-duplicate-section")) {
            assertThrows("invalid epub default was accepted: $fault", OfflineReadingPackageException::class.java) {
                OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, fault), account, media, File(temporary.root, fault))
            }
        }
    }
}
