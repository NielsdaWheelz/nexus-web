package app.nexus.android.offline

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.Inet6Address

class PublicHttpsPolicyTest {
    @Test
    fun `accepts credential-free public https`() {
        val policy = PublicHttpsPolicy(
            object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    return listOf(InetAddress.getByName("93.184.216.34"))
                }
            }
        )

        policy.validateUrl("https://audio.example/episode.mp3".toHttpUrl())
        assertEquals(
            listOf(InetAddress.getByName("93.184.216.34")),
            policy.lookupPublic("audio.example"),
        )
    }

    @Test
    fun `rejects credentials fragments cleartext and ip literals`() {
        val policy = PublicHttpsPolicy()
        val forbidden = listOf(
            "http://audio.example/episode.mp3",
            "https://user:secret@audio.example/episode.mp3",
            "https://audio.example/episode.mp3#fragment",
            "https://93.184.216.34/episode.mp3",
            "https://[2606:2800:220:1:248:1893:25c8:1946]/episode.mp3",
        )

        forbidden.forEach { raw ->
            val error = runCatching { policy.validateUrl(raw.toHttpUrl()) }.exceptionOrNull()
            assertTrue("expected SourceForbidden for $raw, got $error", error is OfflineMediaSourceException)
            assertEquals(
                "expected SourceForbidden for $raw",
                RejectionCode.SourceForbidden,
                (error as OfflineMediaSourceException).rejectionCode,
            )
        }
    }

    @Test
    fun `rejects private reserved and documentation addresses`() {
        val rejected = listOf(
            "0.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "2001:db8::1",
            "2001:2::1",
            "2001:10::1",
            "2001:11::1",
            "2001:20::1",
            "2002:808:808::1",
            "3fff::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        )
        rejected.forEach { raw ->
            assertFalse(
                "expected $raw to be classified non-global",
                PublicHttpsPolicy.isGlobalAddress(InetAddress.getByName(raw)),
            )
        }
        assertTrue(
            "expected a public resolver address to be classified global",
            PublicHttpsPolicy.isGlobalAddress(InetAddress.getByName("8.8.8.8")),
        )
        assertTrue(
            "expected a public IPv6 resolver address to be classified global",
            PublicHttpsPolicy.isGlobalAddress(InetAddress.getByName("2001:4860:4860::8888")),
        )
        assertTrue(
            "expected a public IPv4-mapped IPv6 address to remain global",
            PublicHttpsPolicy.isGlobalAddress(
                Inet6Address.getByAddress(
                    null,
                    byteArrayOf(
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                        0xff.toByte(), 0xff.toByte(),
                        8, 8, 8, 8,
                    ),
                    -1,
                )
            ),
        )
    }
}
