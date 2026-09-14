package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReaderPublicationIdentityTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `installed opaque fragment identities survive unchanged and do not become paths`() {
        val media = UUID.fromString("11111111-1111-4111-8111-111111111111")
        val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        for ((index, id) in listOf("fragment-a", "../a/b?#c", "🧠".repeat(256)).withIndex()) {
            val directory = File(temporary.root, "valid-$index")
            OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, fragmentId = id), account, media, directory)
            assertEquals(id, JSONObject(File(directory, "units/first.json").readText()).getString("fragment_id"))
        }
        for ((index, id) in listOf("", " \t", "🧠".repeat(257)).withIndex()) {
            assertThrows("invalid identity was accepted", OfflineReadingPackageException::class.java) {
                OfflineReadingPackageVerifier().verifyAndExtract(readerPublicationArtifact(temporary.root, fragmentId = id), account, media, File(temporary.root, "invalid-$index"))
            }
        }
    }
}
