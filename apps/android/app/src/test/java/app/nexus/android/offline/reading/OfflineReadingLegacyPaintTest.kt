package app.nexus.android.offline.reading

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingLegacyPaintTest {
    @Test
    fun `shared SVG paint corpus preserves local identity and rejects resources`() {
        val corpus = JSONObject(File(File(requireNotNull(System.getProperty("nexus.testdata.offlineReadingContract"))).parentFile,
            "offline-reading/legacy-svg-paint.json").readText())
        val cases = corpus.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val value = case.getString("value")
            val expected = case.getJSONObject("expected")
            when (expected.getString("kind")) {
                "Reject" -> assertThrows(value, IllegalArgumentException::class.java) { projectLegacySvgPaint(value) }
                "Literal" -> assertEquals(value, expected.getString("value"), projectLegacySvgPaint(value))
                "LocalFragment" -> {
                    val result = projectLegacySvgPaint(value)
                    assertTrue("SVG paint local identity requires a local reference: $value => $result", result is JSONObject)
                    val actual = result as JSONObject
                    assertEquals("SVG paint local identity: $value", expected.getString("fragment_id"), actual.getString("fragment_id"))
                    assertEquals(value, expected.get("fallback"), actual.get("fallback"))
                    assertEquals("LocalFragment", actual.getString("kind"))
                }
                else -> error("Unknown independent paint verdict")
            }
        }
    }

    @Test
    fun `mismatched component delimiters remain rejected`() {
        listOf("red)", "[red)").forEach { value ->
            assertThrows(value, IllegalArgumentException::class.java) { projectLegacySvgPaint(value) }
        }
    }
}
