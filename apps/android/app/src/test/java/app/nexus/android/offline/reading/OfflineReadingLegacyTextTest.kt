package app.nexus.android.offline.reading

import android.icu.text.BreakIterator
import java.io.File
import java.text.CharacterIterator
import java.util.Locale
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
class OfflineReadingLegacyTextTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `ICU sees exact source characters and clusters across disk pages`() {
        val value = "a".repeat(4095) + "👩‍💻 e\u0301 🧠"
        val file = File(temporary.root, "source.utf16").apply { writeText(value, Charsets.UTF_16BE) }
        LegacyReaderText(file).use { source ->
            val cursor = source.iterator()
            cursor.setIndex(4095)
            val clone = cursor.clone() as CharacterIterator
            cursor.last()
            assertEquals("independent source cursor moved", 4095, clone.index)
            for (index in value.indices.reversed()) {
                assertEquals("source character changed across pages", value[index], cursor.setIndex(index))
            }
            cursor.first()
            assertEquals(CharacterIterator.DONE, cursor.previous())
            assertEquals(0, cursor.index)
            assertEquals(CharacterIterator.DONE, cursor.setIndex(value.length))
            assertEquals(value.last(), cursor.previous())
            val graphemes = BreakIterator.getCharacterInstance(Locale.ROOT)
            graphemes.setText(source.iterator())
            assertTrue(graphemes.isBoundary(4095))
            for (offset in 4096..4099) assertFalse("emoji was split at a disk page", graphemes.isBoundary(offset))
            assertEquals(4100, graphemes.following(4095))
            assertFalse(graphemes.isBoundary(4102))
            assertEquals(4103, graphemes.following(4101))
        }
    }
}
