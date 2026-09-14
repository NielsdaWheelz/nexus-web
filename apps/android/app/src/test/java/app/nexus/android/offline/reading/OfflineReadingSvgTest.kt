package app.nexus.android.offline.reading

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class OfflineReadingSvgTest {
    @get:Rule val temporary = TemporaryFolder()
    private val verifier = OfflineReadingPackageVerifier()

    @Test
    fun `maximum dense SVG is traversed completely and a final executable node is rejected`() {
        val prefix = "<svg xmlns=\"http://www.w3.org/2000/svg\">"
        val node = "<g><path d=\"M0 0h1\"/></g>"
        for (executable in listOf(false, true)) {
            val file = File(temporary.root, "dense-$executable.svg")
            val suffix = (if (executable) "<script/>" else "") + "</svg>"
            file.bufferedWriter().use { output ->
                output.write(prefix)
                var remaining = OFFLINE_READING_MAX_SVG_BYTES - prefix.length - suffix.length
                while (remaining >= node.length) {
                    output.write(node)
                    remaining -= node.length
                }
                repeat(remaining.toInt()) { output.write(" ") }
                output.write(suffix)
            }
            assertEquals(OFFLINE_READING_MAX_SVG_BYTES, file.length())
            assertEquals("maximum SVG's final element was not validated", !executable,
                verifier.assetSignatureMatches("assets/dense.svg", "image/svg+xml", file, 1))
        }
    }

    @Test
    fun `streamed XML preserves namespace decisions and rejects declarations regardless of encoding`() {
        val valid = File(temporary.root, "valid.svg").apply {
            writeText("""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="shape" d="M0 0h1"/></defs><use xlink:href="#shape" fill="currentColor"/><title>café &amp; 🧠</title></svg>""")
        }
        assertTrue(verifier.assetSignatureMatches("assets/test.svg", "image/svg+xml", valid, 1))
        val invalid = listOf(
            "<!DOCTYPE svg [<!ENTITY local 'expanded'>]><svg>&local;</svg>" to Charsets.UTF_16,
            ("<!--" + " ".repeat(8184) + "<!DOCTYPE svg>--><svg/>") to Charsets.UTF_8,
            "<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\"><use xlink:href=\"https://example.test/image.svg\"/></svg>" to Charsets.UTF_8,
            "<svg>&missing;</svg>" to Charsets.UTF_8,
            "<svg/><svg/>" to Charsets.UTF_8,
            "<svg><g></svg>" to Charsets.UTF_8,
        )
        invalid.forEachIndexed { index, (source, encoding) ->
            val file = File(temporary.root, "invalid-$index.svg").apply { writeText(source, encoding) }
            assertFalse("SVG declaration or invalid XML accepted at case $index",
                verifier.assetSignatureMatches("assets/test.svg", "image/svg+xml", file, 1))
        }
    }
}
