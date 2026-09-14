package app.nexus.android.offline.reading

import java.io.FilterInputStream
import java.io.IOException
import javax.xml.parsers.SAXParser
import javax.xml.parsers.SAXParserFactory
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.xml.sax.InputSource
import org.xml.sax.Parser
import org.xml.sax.XMLReader
import org.xml.sax.helpers.XMLFilterImpl

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingSvgResourceTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `SVG parser input failure is not evidence of corrupt installed bytes`() {
        val bytes = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"3\" height=\"4\"/></svg>".toByteArray()
        val source = temporary.newFile().apply { writeBytes(bytes) }
        val verifier = OfflineReadingPackageVerifier()
        assertTrue(verifier.assetSignatureMatches("assets/vector", "image/svg+xml", source, 2))

        // JAXP is the external parser boundary. The real platform parser still
        // consumes real SVG bytes; only its later input stream fails after a prefix.
        val property = "javax.xml.parsers.SAXParserFactory"
        val previous = System.getProperty(property)
        FailingSaxFactory.platform = SAXParserFactory.newInstance()
        FailingSaxFactory.bytesRead = 0
        System.setProperty(property, FailingSaxFactory::class.java.name)
        try {
            val outcome = runCatching {
                verifier.assetSignatureMatches("assets/vector", "image/svg+xml", source, 2)
            }
            assertTrue("external SAX parser did not consume its actual input", FailingSaxFactory.bytesRead > 0)
            assertTrue("SVG resource failure was classified as corrupt source", outcome.exceptionOrNull() is IOException)
            assertTrue(bytes.contentEquals(source.readBytes()))
        } finally {
            if (previous == null) System.clearProperty(property) else System.setProperty(property, previous)
        }

        assertTrue(verifier.assetSignatureMatches("assets/vector", "image/svg+xml", source, 2))
        for (invalid in listOf(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect></svg>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"https://example.com/pixel\"/></svg>",
        )) {
            source.writeText(invalid)
            assertFalse(verifier.assetSignatureMatches("assets/vector", "image/svg+xml", source, 2))
        }
    }

    class FailingSaxFactory : SAXParserFactory() {
        companion object {
            lateinit var platform: SAXParserFactory
            var bytesRead = 0
        }

        override fun setNamespaceAware(awareness: Boolean) { platform.isNamespaceAware = awareness }
        override fun setValidating(validating: Boolean) { platform.isValidating = validating }
        override fun getFeature(name: String): Boolean = platform.getFeature(name)
        override fun setFeature(name: String, value: Boolean) = platform.setFeature(name, value)

        override fun newSAXParser(): SAXParser {
            val parser = platform.newSAXParser()
            val reader = object : XMLFilterImpl(parser.xmlReader) {
                override fun parse(input: InputSource) {
                    val stream = requireNotNull(input.byteStream)
                    input.byteStream = object : FilterInputStream(stream) {
                        override fun read(): Int {
                            if (bytesRead >= 17) throw IOException("external SVG input became unavailable")
                            return super.read().also { if (it >= 0) bytesRead += 1 }
                        }
                        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                            if (bytesRead >= 17) throw IOException("external SVG input became unavailable")
                            return super.read(buffer, offset, minOf(length, 17 - bytesRead))
                                .also { if (it > 0) bytesRead += it }
                        }
                    }
                    super.parse(input)
                }
            }
            return object : SAXParser() {
                @Suppress("DEPRECATION")
                override fun getParser(): Parser = parser.parser
                override fun getXMLReader(): XMLReader = reader
                override fun isNamespaceAware(): Boolean = parser.isNamespaceAware
                override fun isValidating(): Boolean = parser.isValidating
                override fun getProperty(name: String): Any = parser.getProperty(name)
                override fun setProperty(name: String, value: Any?) = parser.setProperty(name, value)
            }
        }
    }
}
