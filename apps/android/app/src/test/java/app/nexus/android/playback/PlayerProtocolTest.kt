package app.nexus.android.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class PlayerProtocolTest {
    @Test
    fun `connect accepts only the exact versioned shape`() {
        val accepted = PlayerWire.parseCommand(
            """
            {
              "kind":"Connect",
              "requestId":"00000000-0000-4000-8000-000000000001",
              "protocolVersion":1,
              "accountId":"00000000-0000-4000-8000-000000000002"
            }
            """.trimIndent()
        )
        assertEquals(
            PlayerCommand.Connect(
                UUID.fromString("00000000-0000-4000-8000-000000000001"),
                UUID.fromString("00000000-0000-4000-8000-000000000002"),
            ),
            (accepted as PlayerCommandParseResult.Accepted).command,
        )

        val unknownKey = PlayerWire.parseCommand(
            """
            {
              "kind":"Connect",
              "requestId":"00000000-0000-4000-8000-000000000001",
              "protocolVersion":1,
              "accountId":"00000000-0000-4000-8000-000000000002",
              "fallback":true
            }
            """.trimIndent()
        )
        assertTrue(unknownKey is PlayerCommandParseResult.Rejected)
    }

    @Test
    fun `duplicate keys and noncanonical request ids are unreplyable`() {
        assertTrue(
            PlayerWire.parseCommand(
                """
                {
                  "kind":"GetSnapshot",
                  "kind":"Connect",
                  "requestId":"00000000-0000-4000-8000-000000000001",
                  "protocolVersion":1
                }
                """.trimIndent()
            ) is PlayerCommandParseResult.Unreplyable
        )
        assertTrue(
            PlayerWire.parseCommand(
                """
                {
                  "kind":"GetSnapshot",
                  "requestId":"00000000-0000-4000-8000-00000000000A",
                  "protocolVersion":1
                }
                """.trimIndent()
            ) is PlayerCommandParseResult.Unreplyable
        )
    }

    @Test
    fun `load canonical decodes the full session and rejects inconsistent rate state`() {
        val command = loadCanonicalCommand()
        val accepted = PlayerWire.parseCommand(command.toString())
        val loaded = (accepted as PlayerCommandParseResult.Accepted).command
            as PlayerCommand.LoadCanonical
        assertEquals("Episode title", loaded.session.descriptor.title)
        assertEquals(PauseShorteningMode.Natural, (loaded.session.descriptor.pauseShorteningMode as Presence.Present).value)
        assertEquals(1.5, loaded.rateState.base, 0.0)

        command.getJSONObject("rateState").put("base", 1.0)
        assertTrue(PlayerWire.parseCommand(command.toString()) is PlayerCommandParseResult.Rejected)
    }

    @Test
    fun `playable sources reject non HTTPS and IP literal schemes`() {
        val invalid = listOf(
            "file:///sdcard/episode.mp3",
            "content://app.nexus.android/episode",
            "data:audio/mpeg;base64,AA==",
            "http://audio.example/episode.mp3",
            "https://127.0.0.1/episode.mp3",
            "https://[::1]/episode.mp3",
        )
        invalid.forEach { source ->
            val canonical = loadCanonicalCommand()
            canonical
                .getJSONObject("session")
                .getJSONObject("descriptor")
                .getJSONObject("activation")
                .put("streamUrl", source)
            assertTrue(
                source,
                PlayerWire.parseCommand(canonical.toString()) is
                    PlayerCommandParseResult.Rejected,
            )

            val preview = loadPreviewCommand(source)
            assertTrue(
                source,
                PlayerWire.parseCommand(preview.toString()) is
                    PlayerCommandParseResult.Rejected,
            )
        }
    }

    @Test
    fun `pending natural end round trips exactly`() {
        val receipt = PendingNaturalEnd(
            accountId = UUID.fromString("00000000-0000-4000-8000-000000000010"),
            sessionKey = UUID.fromString("00000000-0000-4000-8000-000000000011"),
            mediaId = UUID.fromString("00000000-0000-4000-8000-000000000012"),
            origin = PlayerOrigin.Lectern(
                UUID.fromString("00000000-0000-4000-8000-000000000013")
            ),
            clientMutationId = UUID.fromString("00000000-0000-4000-8000-000000000014"),
            terminalListening = TerminalListening(
                positionMs = 120_000,
                durationMs = Presence.Present(120_000),
                episodePlaybackRate = Presence.Present(1.5),
                expectedWriteRevision = 7,
                expectedResetEpoch = 2,
            ),
            expectedConsumptionOverrideRevision = Presence.Present(4),
        )

        assertEquals(
            receipt,
            PlayerWire.decodePendingNaturalEnd(
                PlayerWire.encodePendingNaturalEnd(receipt)
            ),
        )
    }

    @Test
    fun `podcast playback settings install decodes both settings atomically`() {
        val command = JSONObject()
            .put("kind", "InstallPodcastPlaybackSettings")
            .put("requestId", "00000000-0000-4000-8000-000000000001")
            .put("protocolVersion", 1)
            .put("sessionKey", "00000000-0000-4000-8000-000000000002")
            .put("podcastId", "00000000-0000-4000-8000-000000000003")
            .put(
                "subscription",
                JSONObject()
                    .put("kind", "Present")
                    .put(
                        "value",
                        JSONObject()
                            .put(
                                "defaultPlaybackSpeed",
                                JSONObject()
                                    .put("kind", "Present")
                                    .put("value", 1.8),
                            )
                            .put(
                                "pauseShorteningMode",
                                JSONObject()
                                    .put("kind", "Present")
                                    .put("value", "Natural"),
                            ),
                    ),
            )
            .put(
                "rateState",
                canonicalRateState(
                    episodeRate = JSONObject().put("kind", "Absent"),
                    podcastPreference = JSONObject()
                        .put("kind", "Present")
                        .put(
                            "value",
                            JSONObject()
                                .put(
                                    "podcastId",
                                    "00000000-0000-4000-8000-000000000003",
                                )
                                .put(
                                    "value",
                                    JSONObject()
                                        .put("kind", "Present")
                                        .put("value", 1.8),
                                ),
                        ),
                    preferred = 1.8,
                ),
            )

        val parsed = PlayerWire.parseCommand(command.toString())
        val installed = (parsed as PlayerCommandParseResult.Accepted).command
            as PlayerCommand.InstallPodcastPlaybackSettings
        assertEquals(
            PauseShorteningMode.Natural,
            (
                (installed.subscription as Presence.Present)
                    .value.pauseShorteningMode as Presence.Present
                ).value,
        )
        assertEquals(1.8, installed.rateState.preferred, 0.0)

        command.put("podcastOverride", JSONObject().put("kind", "Absent"))
        assertTrue(
            PlayerWire.parseCommand(command.toString()) is
                PlayerCommandParseResult.Rejected
        )
    }

    @Test
    fun `absent snapshot carries only device pause settings`() {
        val raw = PlayerWire.snapshot(
            UUID.fromString("00000000-0000-4000-8000-000000000001"),
            PlayerSnapshot.Absent(
                deviceDefaultPauseShorteningMode = PauseShorteningMode.Natural,
                pauseShorteningSavedOnDeviceMs = 42,
            ),
            Presence.Absent,
        )
        val reply = JSONObject(raw)
        assertEquals(
            setOf(
                "kind",
                "requestId",
                "protocolVersion",
                "snapshot",
                "pendingNaturalEnd",
            ),
            reply.keys().asSequence().toSet(),
        )
        val snapshot = reply.getJSONObject("snapshot")
        assertEquals(
            setOf(
                "kind",
                "deviceDefaultPauseShorteningMode",
                "pauseShorteningSavedOnDeviceMs",
            ),
            snapshot.keys().asSequence().toSet(),
        )
        assertEquals("Natural", snapshot.getString("deviceDefaultPauseShorteningMode"))
        assertEquals(42, snapshot.getLong("pauseShorteningSavedOnDeviceMs"))
    }

    @Test
    fun `connected reply is the flat cross runtime wire union`() {
        val raw = JSONObject(
            PlayerWire.connected(
                UUID.fromString("00000000-0000-4000-8000-000000000001"),
                PlayerSnapshot.Absent(PauseShorteningMode.Off, 0),
                Presence.Absent,
            )
        )

        assertEquals(
            setOf(
                "kind",
                "requestId",
                "protocolVersion",
                "snapshot",
                "pendingNaturalEnd",
            ),
            raw.keys().asSequence().toSet(),
        )
        assertEquals("Connected", raw.getString("kind"))
        assertTrue(!raw.has("outcome"))
    }

    @Test
    fun `controller reconnect event carries authoritative snapshot and receipt presence`() {
        val snapshot = JSONObject(
            PlayerWire.snapshot(
                UUID.fromString("00000000-0000-4000-8000-000000000001"),
                PlayerSnapshot.Absent(PauseShorteningMode.Off, 7),
                Presence.Absent,
            )
        ).getJSONObject("snapshot")
        val event = JSONObject(
            PlayerWire.controllerReconnected(snapshot, null)
        )

        assertEquals(
            setOf(
                "protocolVersion",
                "kind",
                "snapshot",
                "pendingNaturalEnd",
            ),
            event.keys().asSequence().toSet(),
        )
        assertEquals("ControllerReconnected", event.getString("kind"))
        assertEquals(
            "Absent",
            event.getJSONObject("snapshot").getString("kind"),
        )
        assertEquals(
            setOf("kind"),
            event.getJSONObject("pendingNaturalEnd")
                .keys().asSequence().toSet(),
        )
        assertEquals(
            "Absent",
            event.getJSONObject("pendingNaturalEnd").getString("kind"),
        )
    }

    private fun loadCanonicalCommand(): JSONObject {
        val absent = JSONObject().put("kind", "Absent")
        val presentNatural = JSONObject()
            .put("kind", "Present")
            .put("value", "Natural")
        val activation = JSONObject()
            .put("kind", "FooterAudio")
            .put("streamUrl", "https://audio.example/episode.mp3")
            .put("sourceUrl", "https://podcast.example/episode")
            .put("positionMs", 0)
            .put("writeRevision", 3)
            .put("resetEpoch", 1)
            .put(
                "playbackRate",
                JSONObject()
                    .put("value", 1.5)
                    .put("source", "Episode")
                    .put("podcastPreference", absent),
            )
            .put("pauseShorteningMode", presentNatural)
            .put("consumptionOverrideRevision", absent)
            .put(
                "durationMs",
                JSONObject().put("kind", "Present").put("value", 120_000),
            )
            .put("artworkUrl", absent)
            .put("chapters", org.json.JSONArray())
        val descriptor = JSONObject()
            .put("mediaId", "00000000-0000-4000-8000-000000000003")
            .put("title", "Episode title")
            .put("subtitle", absent)
            .put("activation", activation)
        return JSONObject()
            .put("kind", "LoadCanonical")
            .put("requestId", "00000000-0000-4000-8000-000000000001")
            .put("protocolVersion", 1)
            .put("sessionKey", "00000000-0000-4000-8000-000000000002")
            .put(
                "session",
                JSONObject()
                    .put("descriptor", descriptor)
                    .put("origin", JSONObject().put("kind", "Direct")),
            )
            .put(
                "rateState",
                canonicalRateState(
                    episodeRate = JSONObject()
                        .put("kind", "Present")
                        .put("value", 1.5),
                    podcastPreference = absent,
                    preferred = 1.5,
                ),
            )
    }

    private fun canonicalRateState(
        episodeRate: JSONObject,
        podcastPreference: JSONObject,
        preferred: Double,
    ): JSONObject =
        JSONObject()
            .put("kind", "Canonical")
            .put("episodeRate", episodeRate)
            .put("podcastPreference", podcastPreference)
            .put("preferred", preferred)
            .put("temporaryNormal", false)
            .put("base", preferred)

    private fun loadPreviewCommand(audioUrl: String): JSONObject {
        val absent = JSONObject().put("kind", "Absent")
        return JSONObject()
            .put("kind", "LoadPreview")
            .put("requestId", "00000000-0000-4000-8000-000000000001")
            .put("protocolVersion", 1)
            .put("sessionKey", "00000000-0000-4000-8000-000000000002")
            .put(
                "descriptor",
                JSONObject()
                    .put("target", "preview")
                    .put("previewHref", "https://example.com/preview")
                    .put("title", "Preview")
                    .put("source", "Source")
                    .put("sourceHref", "https://example.com")
                    .put("audioUrl", audioUrl)
                    .put("imageUrl", absent)
                    .put("durationMs", absent),
            )
    }
}
