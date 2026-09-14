package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReaderPublicationEmbedTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `retained embeds bind one original marker and allow their source range across a unit cut`() {
        val media = UUID.fromString("11111111-1111-4111-8111-111111111111")
        val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        val directory = File(temporary.root, "valid")
        OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, "embed"), account, media, directory)
        val embed = JSONObject(File(directory, "units/first.json").readText()).getJSONArray("document_embeds").getJSONObject(0)
        assertEquals("original-embed", embed.getString("occurrence_key"))
        assertEquals(4, embed.getInt("canonical_end_offset"))
        assertEquals(media.toString(), embed.getJSONObject("target").getString("media_id"))
        for (fault in listOf("embed-missing-marker", "embed-extra-marker", "embed-duplicate", "embed-invalid-child", "embed-half-range", "embed-outside-source")) {
            val destination = File(temporary.root, fault)
            assertThrows("invalid retained embed was accepted: $fault", OfflineReadingPackageException::class.java) {
                OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, fault), account, media, destination)
            }
            assertFalse(destination.exists())
        }
    }
}
