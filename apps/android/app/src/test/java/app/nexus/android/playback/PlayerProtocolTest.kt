package app.nexus.android.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import java.util.UUID

class PlayerProtocolTest {
    private val protocolCorpusBytes by lazy {
        requireNotNull(
            javaClass.classLoader?.getResourceAsStream("player-protocol.json")
        ).use { it.readBytes() }
    }

    private val rawProtocolCorpus by lazy {
        JSONObject(protocolCorpusBytes.decodeToString())
    }

    private val protocolCorpus by lazy {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(protocolCorpusBytes)
            .joinToString("") { "%02x".format(it) }
        require(digest == PLAYER_PROTOCOL_CONTRACT_SHA256)
        JSONObject(
            protocolCorpusBytes.decodeToString()
                .replace("\$PROTOCOL_CONTRACT_SHA256", digest)
        )
    }

    @Test
    fun `canonical v2 command corpus is exhaustive and accepted`() {
        assertEquals(PLAYER_PROTOCOL_VERSION, rawProtocolCorpus.getInt("version"))
        val token = "\$PROTOCOL_CONTRACT_SHA256"
        var envelopeCount = 0
        listOf("commands", "replies", "rejections", "events").forEach { owner ->
            val envelopes = rawProtocolCorpus.getJSONArray(owner)
            repeat(envelopes.length()) { index ->
                val envelope = envelopes.getJSONObject(index)
                assertEquals(PLAYER_PROTOCOL_VERSION, envelope.getInt("protocolVersion"))
                assertEquals(token, envelope.getString("protocolContractSha256"))
                envelopeCount += 1
            }
        }
        assertEquals(
            envelopeCount,
            Regex(Regex.escape(token))
                .findAll(protocolCorpusBytes.decodeToString())
                .count(),
        )
        val commands = protocolCorpus.getJSONArray("commands")
        val acceptedKinds = mutableListOf<String>()

        repeat(commands.length()) { index ->
            val command = commands.getJSONObject(index)
            val parsed = PlayerWire.parseCommand(command.toString())
            assertTrue(
                "${command.getString("kind")} must be accepted, got $parsed",
                parsed is PlayerCommandParseResult.Accepted,
            )
            acceptedKinds += kindOf((parsed as PlayerCommandParseResult.Accepted).command)
        }
        assertEquals(
            protocolCorpus.getJSONObject("inventory").stringList("commands"),
            acceptedKinds,
        )
        assertEquals(
            protocolCorpus.getJSONObject("inventory").stringList("rejectionCodes"),
            PlayerRejectionCode.entries.map { it.name },
        )
    }

    @Test
    fun `canonical inventory is exhaustive over native wire variants`() {
        val inventory = protocolCorpus.getJSONObject("inventory")

        assertEquals(
            listOf("Absent", "Canonical", "Preview"),
            inventory.stringList("snapshots"),
        )
        assertEquals(
            listOf("Absent", "Present"),
            inventory.stringList("presence"),
        )
        assertEquals(
            listOf("Direct", "Lectern"),
            inventory.stringList("origins"),
        )
        assertEquals(
            listOf("Canonical", "Preview"),
            inventory.stringList("playbackRateStates"),
        )
        assertEquals(
            PlaybackRateResolution.Source.entries.map { it.name },
            inventory.stringList("playbackRateSources"),
        )
        assertEquals(
            PlaybackPhase.entries.map { it.name },
            inventory.stringList("playbackPhases"),
        )
        assertEquals(
            listOf("Ready", "Suspended"),
            inventory.stringList("persistence"),
        )
        assertEquals(
            PersistenceSuspension.entries.map { it.name },
            inventory.stringList("persistenceSuspensions"),
        )
        assertEquals(
            PauseShorteningMode.entries.map { it.name },
            inventory.stringList("pauseShorteningModes"),
        )
        assertEquals(
            PauseShorteningProvenance.entries.map { it.name },
            inventory.stringList("pauseShorteningProvenance"),
        )
        assertEquals(
            listOf("Recording", "Idle", "Paused", "Blocked"),
            inventory.stringList("activityCapture"),
        )
        assertEquals(
            NativeActivityCapture.Blocked.Reason.entries.map { it.name },
            inventory.stringList("activityCaptureBlocks"),
        )
        assertEquals(
            listOf("Synced", "Pending", "Failed"),
            inventory.stringList("activitySync"),
        )
    }

    @Test
    fun `canonical v2 snapshots replies and events are emitted exactly`() {
        val absentOff = PlayerSnapshot.Absent(PauseShorteningMode.Off, 0)
        val absentNatural = PlayerSnapshot.Absent(
            deviceDefaultPauseShorteningMode = PauseShorteningMode.Natural,
            pauseShorteningSavedOnDeviceMs = 42,
            activitySync = PlayerActivitySyncSnapshot(
                NativeActivityCapture.Paused,
                NativeActivitySync.Synced,
                9,
            ),
        )
        val canonical = canonicalCorpusSnapshot()
        val preview = previewCorpusSnapshot()
        assertJsonArraySimilar(
            protocolCorpus.getJSONArray("snapshots"),
            listOf(
                snapshotJson(absentOff),
                snapshotJson(canonical),
                snapshotJson(preview),
            ),
        )

        val replies = buildList {
            add(
                JSONObject(
                    PlayerWire.connected(
                        uuid(30),
                        absentOff,
                        Presence.Absent,
                    )
                )
            )
            add(
                JSONObject(
                    PlayerWire.snapshot(
                        uuid(31),
                        absentNatural,
                        Presence.Absent,
                    )
                )
            )
            add(JSONObject(PlayerWire.accepted(uuid(32))))
            PlayerRejectionCode.entries.forEachIndexed { index, code ->
                add(JSONObject(PlayerWire.rejected(uuid(33 + index), code)))
            }
        }
        assertJsonArraySimilar(
            protocolCorpus.getJSONArray("replies"),
            replies.take(3),
        )
        assertJsonArraySimilar(
            protocolCorpus.getJSONArray("rejections"),
            replies.drop(3),
        )

        val pendingNaturalEnd = PendingNaturalEnd(
            accountId = uuid(2),
            sessionKey = uuid(8),
            mediaId = uuid(9),
            origin = PlayerOrigin.Direct,
            clientMutationId = uuid(29),
            terminalListening = TerminalListening(
                positionMs = 120_000,
                durationMs = Presence.Present(120_000),
                episodePlaybackRate = Presence.Present(1.5),
                expectedWriteRevision = 4,
                expectedResetEpoch = 1,
            ),
            expectedConsumptionOverrideRevision = Presence.Present(4),
        )
        assertJsonArraySimilar(
            protocolCorpus.getJSONArray("events"),
            listOf(
                JSONObject(PlayerWire.snapshotChanged(absentOff)),
                JSONObject(
                    PlayerWire.controllerReconnected(
                        snapshotJson(absentNatural),
                        null,
                    )
                ),
                JSONObject(PlayerWire.naturalEndPending(pendingNaturalEnd)),
            ),
        )
    }

    @Test
    fun `canonical nested variants are emitted exactly by native owners`() {
        val nested = protocolCorpus.getJSONObject("nestedVariants")
        val canonical = canonicalCorpusSnapshot()

        val captures = listOf(
            NativeActivityCapture.Recording,
            NativeActivityCapture.Idle,
            NativeActivityCapture.Paused,
            NativeActivityCapture.Blocked(
                NativeActivityCapture.Blocked.Reason.StorageUnavailable
            ),
            NativeActivityCapture.Blocked(
                NativeActivityCapture.Blocked.Reason.CapacityReached
            ),
        )
        assertJsonArraySimilar(
            nested.getJSONArray("activityCapture"),
            captures.map { capture ->
                snapshotJson(
                    canonical.copy(
                        activitySync = canonical.activitySync.copy(capture = capture)
                    )
                ).getJSONObject("activitySync").getJSONObject("capture")
            },
        )

        val syncStates = listOf(
            NativeActivitySync.Synced,
            NativeActivitySync.Pending(1, "2026-08-10T00:00:00Z"),
            NativeActivitySync.Failed(1),
        )
        assertJsonArraySimilar(
            nested.getJSONArray("activitySync"),
            syncStates.map { sync ->
                snapshotJson(
                    canonical.copy(
                        activitySync = canonical.activitySync.copy(sync = sync)
                    )
                ).getJSONObject("activitySync").getJSONObject("sync")
            },
        )

        val origins = listOf(PlayerOrigin.Direct, PlayerOrigin.Lectern(uuid(11)))
        assertJsonArraySimilar(
            nested.getJSONArray("origins"),
            origins.map { origin ->
                snapshotJson(
                    canonical.copy(session = canonical.session.copy(origin = origin))
                ).getJSONObject("session").getJSONObject("origin")
            },
        )

        val persistenceStates = listOf(
            PlayerPersistence.Ready,
            PlayerPersistence.Suspended(
                PersistenceSuspension.Network,
                "Network unavailable",
            ),
            PlayerPersistence.Suspended(
                PersistenceSuspension.AuthExpired,
                "Authentication expired",
            ),
        )
        assertJsonArraySimilar(
            nested.getJSONArray("persistence"),
            persistenceStates.map { persistence ->
                snapshotJson(canonical.copy(persistence = persistence))
                    .getJSONObject("persistence")
            },
        )

        val rateResolutions = listOf(
            PlaybackRateResolution(
                1.5,
                PlaybackRateResolution.Source.Episode,
                Presence.Absent,
            ),
            PlaybackRateResolution(
                1.25,
                PlaybackRateResolution.Source.Podcast,
                Presence.Present(
                    PodcastRatePreference(uuid(10), Presence.Present(1.25))
                ),
            ),
            PlaybackRateResolution(
                1.0,
                PlaybackRateResolution.Source.Product,
                Presence.Absent,
            ),
        )
        assertEquals(
            nested.stringList("playbackRateSources"),
            rateResolutions.map { resolution ->
                snapshotJson(
                    canonical.copy(
                        session = canonical.session.copy(
                            descriptor = canonical.session.descriptor.copy(
                                playbackRate = resolution
                            )
                        )
                    )
                ).getJSONObject("session")
                    .getJSONObject("descriptor")
                    .getJSONObject("activation")
                    .getJSONObject("playbackRate")
                    .getString("source")
            },
        )

        assertEquals(
            nested.stringList("playbackPhases"),
            PlaybackPhase.entries.map { phase ->
                snapshotJson(canonical.copy(phase = phase)).getString("phase")
            },
        )
        assertEquals(
            nested.stringList("pauseShorteningModes"),
            PauseShorteningMode.entries.map { mode ->
                snapshotJson(
                    canonical.copy(
                        pauseShortening = canonical.pauseShortening.copy(
                            deviceDefaultMode = mode
                        )
                    )
                ).getJSONObject("pauseShortening").getString("deviceDefaultMode")
            },
        )
        assertEquals(
            nested.stringList("pauseShorteningProvenance"),
            PauseShorteningProvenance.entries.map { provenance ->
                snapshotJson(
                    canonical.copy(
                        pauseShortening = canonical.pauseShortening.copy(
                            provenance = provenance
                        )
                    )
                ).getJSONObject("pauseShortening").getString("provenance")
            },
        )

        val presenceStates: List<Presence<Long>> = listOf(
            Presence.Absent,
            Presence.Present(1),
        )
        assertJsonArraySimilar(
            nested.getJSONArray("presence"),
            presenceStates.map { presence ->
                snapshotJson(
                    canonical.copy(
                        session = canonical.session.copy(
                            descriptor = canonical.session.descriptor.copy(
                                durationMs = presence
                            )
                        )
                    )
                ).getJSONObject("session")
                    .getJSONObject("descriptor")
                    .getJSONObject("activation")
                    .getJSONObject("durationMs")
            },
        )
    }

    @Test
    fun `replyable identity mismatch wins before command body validation`() {
        val requestId = "00000000-0000-4000-8000-000000000001"
        val wrongVersion = JSONObject()
            .put("kind", "UnknownCommand")
            .put("requestId", requestId)
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION + 1)
        assertEquals(
            PlayerCommandParseResult.Rejected(
                UUID.fromString(requestId),
                PlayerRejectionCode.ProtocolMismatch,
            ),
            PlayerWire.parseCommand(wrongVersion.toString()),
        )

        val wrongDigest = JSONObject()
            .put("kind", "UnknownCommand")
            .put("requestId", requestId)
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("protocolContractSha256", "0".repeat(64))
        assertEquals(
            PlayerCommandParseResult.Rejected(
                UUID.fromString(requestId),
                PlayerRejectionCode.ProtocolMismatch,
            ),
            PlayerWire.parseCommand(wrongDigest.toString()),
        )

        wrongDigest.put("protocolContractSha256", PLAYER_PROTOCOL_CONTRACT_SHA256)
        assertEquals(
            PlayerCommandParseResult.Rejected(
                UUID.fromString(requestId),
                PlayerRejectionCode.InvalidRequest,
            ),
            PlayerWire.parseCommand(wrongDigest.toString()),
        )
    }

    @Test
    fun `connect accepts only the exact versioned shape`() {
        val accepted = PlayerWire.parseCommand(
            """
            {
              "kind":"Connect",
              "requestId":"00000000-0000-4000-8000-000000000001",
              "protocolVersion":2,
              "protocolContractSha256":"$PLAYER_PROTOCOL_CONTRACT_SHA256",
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
              "protocolVersion":2,
              "protocolContractSha256":"$PLAYER_PROTOCOL_CONTRACT_SHA256",
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
                  "protocolVersion":2,
                  "protocolContractSha256":"$PLAYER_PROTOCOL_CONTRACT_SHA256"
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
                  "protocolVersion":2,
                  "protocolContractSha256":"$PLAYER_PROTOCOL_CONTRACT_SHA256"
                }
                """.trimIndent()
            ) is PlayerCommandParseResult.Unreplyable
        )
    }

    @Test
    fun `activity recovery commands accept only their exact account-fenced shape`() {
        listOf("RetryFailedActivity", "DiscardFailedActivity").forEach { kind ->
            val exact = JSONObject()
                .put("kind", kind)
                .put("requestId", "00000000-0000-4000-8000-000000000001")
                .putProtocolIdentity()
            assertTrue(
                PlayerWire.parseCommand(exact.toString()) is
                    PlayerCommandParseResult.Accepted
            )

            exact.put("accountId", "00000000-0000-4000-8000-000000000002")
            assertTrue(
                PlayerWire.parseCommand(exact.toString()) is
                    PlayerCommandParseResult.Rejected
            )
        }
    }

    @Test
    fun `Activity pause requires an exact boolean payload`() {
        val exact = JSONObject()
            .put("kind", "SetActivityPaused")
            .put("requestId", "00000000-0000-4000-8000-000000000001")
            .putProtocolIdentity()
            .put("paused", true)
        assertEquals(
            PlayerCommand.SetActivityPaused(
                UUID.fromString("00000000-0000-4000-8000-000000000001"),
                true,
            ),
            (PlayerWire.parseCommand(exact.toString()) as
                PlayerCommandParseResult.Accepted).command,
        )

        exact.put("paused", 1)
        assertTrue(
            PlayerWire.parseCommand(exact.toString()) is
                PlayerCommandParseResult.Rejected
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
            .putProtocolIdentity()
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
    fun `absent snapshot carries strict device and activity sync state`() {
        val raw = PlayerWire.snapshot(
            UUID.fromString("00000000-0000-4000-8000-000000000001"),
            PlayerSnapshot.Absent(
                deviceDefaultPauseShorteningMode = PauseShorteningMode.Natural,
                pauseShorteningSavedOnDeviceMs = 42,
                activitySync = PlayerActivitySyncSnapshot(
                    capture = NativeActivityCapture.Paused,
                    sync = NativeActivitySync.Pending(2, "2026-08-10T00:00:00Z"),
                    acceptedRevision = 7,
                ),
            ),
            Presence.Absent,
        )
        val reply = JSONObject(raw)
        assertEquals(
            setOf(
                "kind",
                "requestId",
                "protocolVersion",
                "protocolContractSha256",
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
                "activitySync",
            ),
            snapshot.keys().asSequence().toSet(),
        )
        assertEquals("Natural", snapshot.getString("deviceDefaultPauseShorteningMode"))
        assertEquals(42, snapshot.getLong("pauseShorteningSavedOnDeviceMs"))
        val activitySync = snapshot.getJSONObject("activitySync")
        assertEquals(
            setOf("capture", "sync", "acceptedRevision"),
            activitySync.keys().asSequence().toSet(),
        )
        assertEquals("Paused", activitySync.getJSONObject("capture").getString("kind"))
        assertEquals("Pending", activitySync.getJSONObject("sync").getString("kind"))
        assertEquals(
            7,
            activitySync.getLong("acceptedRevision"),
        )
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
                "protocolContractSha256",
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
                "protocolContractSha256",
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

    private fun canonicalCorpusSnapshot(): PlayerSnapshot.Canonical {
        val loaded = acceptedCommand("LoadCanonical") as PlayerCommand.LoadCanonical
        return PlayerSnapshot.Canonical(
            sessionKey = loaded.sessionKey,
            session = loaded.session.copy(
                descriptor = loaded.session.descriptor.copy(
                    playbackRate = loaded.session.descriptor.playbackRate.copy(
                        podcastPreference = Presence.Absent,
                    ),
                    artworkUrl = Presence.Absent,
                    chapters = emptyList(),
                ),
                origin = PlayerOrigin.Direct,
            ),
            phase = PlaybackPhase.Playing,
            positionMs = 12_000,
            durationMs = 120_000,
            bufferedMs = 30_000,
            volume = 0.75,
            observedBaseRate = 1.5,
            rateState = loaded.rateState.copy(
                podcastPreference = Presence.Absent,
            ),
            persistence = PlayerPersistence.Ready,
            playbackFailure = Presence.Absent,
            pauseShortening = PauseShorteningSnapshot(
                deviceDefaultMode = PauseShorteningMode.Off,
                podcastOverride = Presence.Present(PauseShorteningMode.Natural),
                sessionOverride = Presence.Absent,
                effectiveMode = PauseShorteningMode.Natural,
                provenance = PauseShorteningProvenance.Podcast,
                savedOnDeviceMs = 2_500,
            ),
            activitySync = PlayerActivitySyncSnapshot(
                NativeActivityCapture.Recording,
                NativeActivitySync.Pending(2, "2026-08-10T00:00:00Z"),
                7,
            ),
        )
    }

    private fun previewCorpusSnapshot(): PlayerSnapshot.Preview {
        val loaded = acceptedCommand("LoadPreview") as PlayerCommand.LoadPreview
        return PlayerSnapshot.Preview(
            sessionKey = loaded.sessionKey,
            descriptor = loaded.descriptor,
            phase = PlaybackPhase.Paused,
            positionMs = 5_000,
            durationMs = 30_000,
            bufferedMs = 10_000,
            volume = 0.5,
            observedBaseRate = 1.0,
            rateState = PlaybackRateState.Preview(),
            persistence = PlayerPersistence.Suspended(
                PersistenceSuspension.Network,
                "Network unavailable",
            ),
            playbackFailure = Presence.Present(
                PlayerFailure("PreviewFailed", "Preview failed")
            ),
            pauseShortening = PauseShorteningSnapshot(
                deviceDefaultMode = PauseShorteningMode.Natural,
                podcastOverride = Presence.Absent,
                sessionOverride = Presence.Present(PauseShorteningMode.Off),
                effectiveMode = PauseShorteningMode.Off,
                provenance = PauseShorteningProvenance.Session,
                savedOnDeviceMs = 0,
            ),
            activitySync = PlayerActivitySyncSnapshot(
                NativeActivityCapture.Blocked(
                    NativeActivityCapture.Blocked.Reason.StorageUnavailable
                ),
                NativeActivitySync.Failed(1),
                8,
            ),
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
            .putProtocolIdentity()
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
            .putProtocolIdentity()
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

    private fun JSONObject.putProtocolIdentity(): JSONObject =
        put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("protocolContractSha256", PLAYER_PROTOCOL_CONTRACT_SHA256)

    private fun JSONObject.stringList(key: String): List<String> {
        val values = getJSONArray(key)
        return List(values.length()) { values.getString(it) }
    }

    private fun acceptedCommand(kind: String): PlayerCommand {
        val commands = protocolCorpus.getJSONArray("commands")
        repeat(commands.length()) { index ->
            val command = commands.getJSONObject(index)
            if (command.getString("kind") == kind) {
                return (PlayerWire.parseCommand(command.toString()) as
                    PlayerCommandParseResult.Accepted).command
            }
        }
        error("protocol corpus is missing $kind")
    }

    private fun snapshotJson(snapshot: PlayerSnapshot): JSONObject =
        JSONObject(
            PlayerWire.snapshot(
                uuid(99),
                snapshot,
                Presence.Absent,
            )
        ).getJSONObject("snapshot")

    private fun assertJsonArraySimilar(
        expected: org.json.JSONArray,
        actual: List<JSONObject>,
    ) {
        assertEquals(expected.length(), actual.size)
        actual.forEachIndexed { index, value ->
            assertTrue(
                "corpus entry $index differs: expected=${expected.get(index)} actual=$value",
                expected.getJSONObject(index).similar(value),
            )
        }
    }

    private fun uuid(suffix: Int): UUID = UUID.fromString(
        "00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}"
    )

    private fun kindOf(command: PlayerCommand): String = when (command) {
        is PlayerCommand.Connect -> "Connect"
        is PlayerCommand.GetSnapshot -> "GetSnapshot"
        is PlayerCommand.RetryFailedActivity -> "RetryFailedActivity"
        is PlayerCommand.DiscardFailedActivity -> "DiscardFailedActivity"
        is PlayerCommand.SetActivityPaused -> "SetActivityPaused"
        is PlayerCommand.LoadCanonical -> "LoadCanonical"
        is PlayerCommand.LoadPreview -> "LoadPreview"
        is PlayerCommand.Play -> "Play"
        is PlayerCommand.Pause -> "Pause"
        is PlayerCommand.SeekTo -> "SeekTo"
        is PlayerCommand.SkipBy -> "SkipBy"
        is PlayerCommand.SetVolume -> "SetVolume"
        is PlayerCommand.SetPlaybackRateState -> "SetPlaybackRateState"
        is PlayerCommand.SetSessionPauseShorteningMode -> "SetSessionPauseShorteningMode"
        is PlayerCommand.ClearSessionPauseShorteningMode -> "ClearSessionPauseShorteningMode"
        is PlayerCommand.SetDeviceDefaultPauseShorteningMode ->
            "SetDeviceDefaultPauseShorteningMode"
        is PlayerCommand.InstallPodcastPlaybackSettings -> "InstallPodcastPlaybackSettings"
        is PlayerCommand.Drain -> "Drain"
        is PlayerCommand.AdoptListeningState -> "AdoptListeningState"
        is PlayerCommand.RetryPersistence -> "RetryPersistence"
        is PlayerCommand.Dismiss -> "Dismiss"
        is PlayerCommand.AcknowledgeNaturalEnd -> "AcknowledgeNaturalEnd"
    }

    @Suppress("unused")
    private fun kindOf(snapshot: PlayerSnapshot): String = when (snapshot) {
        is PlayerSnapshot.Absent -> "Absent"
        is PlayerSnapshot.Canonical -> "Canonical"
        is PlayerSnapshot.Preview -> "Preview"
    }

    @Suppress("unused")
    private fun kindOf(presence: Presence<*>): String = when (presence) {
        Presence.Absent -> "Absent"
        is Presence.Present -> "Present"
    }

    @Suppress("unused")
    private fun kindOf(origin: PlayerOrigin): String = when (origin) {
        PlayerOrigin.Direct -> "Direct"
        is PlayerOrigin.Lectern -> "Lectern"
    }

    @Suppress("unused")
    private fun kindOf(rateState: PlaybackRateState): String = when (rateState) {
        is PlaybackRateState.Canonical -> "Canonical"
        is PlaybackRateState.Preview -> "Preview"
    }

    @Suppress("unused")
    private fun kindOf(persistence: PlayerPersistence): String = when (persistence) {
        PlayerPersistence.Ready -> "Ready"
        is PlayerPersistence.Suspended -> "Suspended"
    }

    @Suppress("unused")
    private fun kindOf(capture: NativeActivityCapture): String = when (capture) {
        NativeActivityCapture.Recording -> "Recording"
        NativeActivityCapture.Idle -> "Idle"
        NativeActivityCapture.Paused -> "Paused"
        is NativeActivityCapture.Blocked -> "Blocked"
    }

    @Suppress("unused")
    private fun kindOf(sync: NativeActivitySync): String = when (sync) {
        NativeActivitySync.Synced -> "Synced"
        is NativeActivitySync.Pending -> "Pending"
        is NativeActivitySync.Failed -> "Failed"
    }
}
