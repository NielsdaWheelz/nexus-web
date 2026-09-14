package app.nexus.android.offline.reading

import android.graphics.Color
import android.graphics.ImageDecoder
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Host capability observation, not all-frame attestation or allocation qualification. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OfflineReadingRasterDecoderTest {
    @Test
    fun `public native decoder exposes its selected raster from independently encoded sources`() {
        val fixtures = File(File(System.getProperty("nexus.testdata.offlineReadingContract")
            ?: error("testdata root is missing")).parentFile, "offline-reading")
        val body = File(fixtures, "reader-raster-source-facts.json").readBytes()
        assertEquals("6930524638e1506dab43090c812700b7748ccade552b9da15ae5f01116fe2944",
            MessageDigest.getInstance("SHA-256").digest(body).toHex())
        val cases = JSONObject(body.toString(Charsets.UTF_8)).getJSONArray("cases")
        assertEquals(2, cases.length())
        val observations = JSONArray()
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val name = case.getString("name")
            val bytes = Base64.getDecoder().decode(case.getString("source_base64"))
            assertEquals(case.getString("sha256"),
                MessageDigest.getInstance("SHA-256").digest(bytes).toHex())
            val observation = JSONObject().put("name", name)
                .put("source_sha256", case.getString("sha256"))
                .put("independent_all_frame_facts", case.getJSONObject("expected"))
            val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                observation.put("header_width", info.size.width).put("header_height", info.size.height)
                    .put("mime_type", info.mimeType).put("animated", info.isAnimated)
            }
            try {
                assertTrue(bitmap.width > 0 && bitmap.height > 0)
                // Independently authored source pixels: palette index zero in the first
                // GIF frame, and solid CSS green in both embedded ICO PNG images.
                assertEquals(if (name == "later-gif-canvas") Color.BLACK else Color.rgb(0, 128, 0),
                    bitmap.getPixel(0, 0))
                observation.put("decoded_width", bitmap.width).put("decoded_height", bitmap.height)
                    .put("decoded_allocation_bytes", bitmap.allocationByteCount)
            } finally { bitmap.recycle() }
            observations.put(observation)
        }
        println("native_raster_decoder=" + JSONObject()
            .put("scope", "public first-image decode; no frame enumeration, capacity, or handset claim")
            .put("observations", observations))
    }
}
