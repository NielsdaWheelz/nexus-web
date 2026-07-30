package app.nexus.android.offline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.UUID

class OfflineMediaContractTest {
    private val requestId = UUID.fromString("11111111-1111-4111-8111-111111111111")
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val mediaId = UUID.fromString("33333333-3333-4333-8333-333333333333")

    @Test
    fun `strictly decodes every command`() {
        val commands = listOf(
            command("Connect", ""","accountId":"$accountId"""") to OfflineMediaCommand.Connect::class,
            command("GetSnapshot") to OfflineMediaCommand.GetSnapshot::class,
            command(
                "Enqueue",
                ""","spec":{"kind":"ProgressiveAudio","mediaId":"$mediaId","title":"Episode","sourceUrl":"https://audio.example/episode.mp3"}"""
            ) to OfflineMediaCommand.Enqueue::class,
            command("Cancel", ""","mediaId":"$mediaId"""") to OfflineMediaCommand.Cancel::class,
            command("Retry", ""","mediaId":"$mediaId"""") to OfflineMediaCommand.Retry::class,
            command("Remove", ""","mediaId":"$mediaId"""") to OfflineMediaCommand.Remove::class,
            command("SetNetworkPolicy", ""","policy":"AnyConnected"""") to
                OfflineMediaCommand.SetNetworkPolicy::class,
        )

        commands.forEach { (raw, expectedClass) ->
            val parsed = OfflineMediaWire.parseCommand(raw)
            assertTrue("expected $expectedClass from $raw, got $parsed", parsed is CommandParseResult.Accepted)
            assertEquals(
                "expected the exact command variant from $raw",
                expectedClass,
                (parsed as CommandParseResult.Accepted).command::class,
            )
        }
    }

    @Test
    fun `rejects extra keys noncanonical identifiers and wrong versions`() {
        val malformed = listOf(
            command("GetSnapshot", ""","extra":true"""),
            """{"kind":"GetSnapshot","requestId":"11111111-1111-4111-8111-111111111111","protocolVersion":2}""",
            """{"kind":"Cancel","requestId":"11111111-1111-4111-8111-111111111111","protocolVersion":1,"mediaId":"33333333333343338333333333333333"}""",
            command(
                "Enqueue",
                ""","spec":{"kind":"ProgressiveAudio","mediaId":"$mediaId","title":"","sourceUrl":"https://audio.example/episode.mp3"}"""
            ),
        )

        malformed.forEach { raw ->
            assertEquals(
                "expected strict rejection for $raw",
                CommandParseResult.Rejected(requestId),
                OfflineMediaWire.parseCommand(raw),
            )
        }
    }

    @Test
    fun `malformed and oversized messages without a trusted request id are unreplyable`() {
        assertEquals(CommandParseResult.Unreplyable, OfflineMediaWire.parseCommand("{"))
        assertEquals(
            CommandParseResult.Unreplyable,
            OfflineMediaWire.parseCommand(
                """{"kind":"Cancel","requestId":"11111111-1111-0111-8111-111111111111","protocolVersion":1,"mediaId":"$mediaId"}"""
            ),
        )
        assertEquals(
            CommandParseResult.Unreplyable,
            OfflineMediaWire.parseCommand(
                """{"kind":"Cancel","requestId":"11111111-1111-4111-c111-111111111111","protocolVersion":1,"mediaId":"$mediaId"}"""
            ),
        )
        assertEquals(
            CommandParseResult.Unreplyable,
            OfflineMediaWire.parseCommand("x".repeat(OFFLINE_MEDIA_MESSAGE_LIMIT_BYTES + 1)),
        )
    }

    @Test
    fun `snapshot and events encode exact presence and state shapes`() {
        val snapshot = JSONObject(
            OfflineMediaWire.snapshot(
                requestId,
                listOf(
                    OfflineMediaItem(
                        mediaId,
                        "Episode",
                        NativeLocalAvailability.Downloading(
                            47,
                            Presence.Present(100),
                        ),
                    )
                ),
                NetworkPolicy.UnmeteredOnly,
            )
        )
        val outcome = snapshot.getJSONObject("outcome")
        val item = outcome.getJSONArray("items").getJSONObject(0)
        val state = item.getJSONObject("state")
        assertEquals("Present", state.getString("kind"))
        assertEquals("Downloading", state.getJSONObject("value").getString("kind"))
        assertEquals(
            100L,
            state.getJSONObject("value")
                .getJSONObject("totalBytes")
                .getLong("value"),
        )

        val removed = JSONObject(OfflineMediaWire.stateChanged(mediaId, Presence.Absent))
        assertEquals("Absent", removed.getJSONObject("state").getString("kind"))

        val ready = JSONObject(
            OfflineMediaWire.stateChanged(
                mediaId,
                Presence.Present(
                    NativeLocalAvailability.Ready(
                        2048,
                        "audio/mpeg",
                        Instant.parse("2026-07-30T12:34:56Z"),
                    )
                ),
            )
        )
        assertEquals(
            "2026-07-30T12:34:56Z",
            ready.getJSONObject("state").getJSONObject("value").getString("updatedAt"),
        )
    }

    @Test
    fun `metadata round trips exact presence`() {
        val metadata = OfflineMediaMetadata(
            accountId,
            mediaId,
            "Episode",
            "audio/mp4",
            Presence.Absent,
        )
        assertEquals(metadata, OfflineMediaMetadata.decode(metadata.encode()))
    }

    @Test
    fun `title bounds count Unicode code points`() {
        val acceptedTitle = "🎙️".repeat(256)
        assertTrue(
            OfflineMediaWire.parseCommand(
                command(
                    "Enqueue",
                    ""","spec":{"kind":"ProgressiveAudio","mediaId":"$mediaId","title":"$acceptedTitle","sourceUrl":"https://audio.example/episode.mp3"}"""
                )
            ) is CommandParseResult.Accepted
        )
        val rejectedTitle = "🎙".repeat(513)
        assertEquals(
            CommandParseResult.Rejected(requestId),
            OfflineMediaWire.parseCommand(
                command(
                    "Enqueue",
                    ""","spec":{"kind":"ProgressiveAudio","mediaId":"$mediaId","title":"$rejectedTitle","sourceUrl":"https://audio.example/episode.mp3"}"""
                )
            ),
        )
    }

    private fun command(kind: String, tail: String = ""): String {
        return """{"kind":"$kind","requestId":"$requestId","protocolVersion":1$tail}"""
    }
}
