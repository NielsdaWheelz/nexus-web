package app.nexus.android.playback

import app.nexus.android.webkit.requireArray
import app.nexus.android.webkit.requireBoolean
import app.nexus.android.webkit.requireBoundedString
import app.nexus.android.webkit.requireCanonicalUuid
import app.nexus.android.webkit.requireExactKeys
import app.nexus.android.webkit.requireFiniteDouble
import app.nexus.android.webkit.requireLong
import app.nexus.android.webkit.requireObject
import app.nexus.android.webkit.strictJsonObject
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

internal const val PLAYER_PROTOCOL_VERSION = 1
private const val MAX_SOURCE_TIME_MS = Int.MAX_VALUE.toLong()
private const val MAX_CHAPTERS = 100

internal sealed interface Presence<out T> {
    data object Absent : Presence<Nothing>

    data class Present<T>(val value: T) : Presence<T>
}

internal enum class PauseShorteningMode {
    Off,
    Natural,
}

internal enum class PauseShorteningProvenance {
    Session,
    Podcast,
    Device,
}

internal enum class PlaybackPhase {
    Buffering,
    Playing,
    Paused,
    Ended,
}

internal enum class PersistenceSuspension {
    Network,
    AuthExpired,
}

internal sealed interface PlayerPersistence {
    data object Ready : PlayerPersistence

    data class Suspended(
        val reason: PersistenceSuspension,
        val message: String,
    ) : PlayerPersistence
}

internal data class PlayerFailure(
    val code: String,
    val message: String,
)

internal sealed interface PlayerOrigin {
    data object Direct : PlayerOrigin

    data class Lectern(val itemId: UUID) : PlayerOrigin
}

internal data class Chapter(
    val title: String,
    val startMs: Long,
    val endMs: Presence<Long>,
)

internal data class PlaybackRateResolution(
    val value: Double,
    val source: Source,
    val podcastPreference: Presence<PodcastRatePreference>,
) {
    enum class Source {
        Episode,
        Podcast,
        Product,
    }
}

internal data class PodcastRatePreference(
    val podcastId: UUID,
    val value: Presence<Double>,
)

internal data class CanonicalDescriptor(
    val mediaId: UUID,
    val title: String,
    val subtitle: Presence<String>,
    val streamUrl: String,
    val sourceUrl: String,
    val positionMs: Long,
    val writeRevision: Long,
    val resetEpoch: Long,
    val playbackRate: PlaybackRateResolution,
    val pauseShorteningMode: Presence<PauseShorteningMode>,
    val consumptionOverrideRevision: Presence<Long>,
    val durationMs: Presence<Long>,
    val artworkUrl: Presence<String>,
    val chapters: List<Chapter>,
)

internal data class AudioSession(
    val descriptor: CanonicalDescriptor,
    val origin: PlayerOrigin,
)

internal data class PreviewDescriptor(
    val target: String,
    val previewHref: String,
    val title: String,
    val source: String,
    val sourceHref: String,
    val audioUrl: String,
    val imageUrl: Presence<String>,
    val durationMs: Presence<Long>,
)

internal sealed interface PlaybackRateState {
    val preferred: Double
    val temporaryNormal: Boolean
    val base: Double

    data class Canonical(
        val episodeRate: Presence<Double>,
        val podcastPreference: Presence<PodcastRatePreference>,
        override val preferred: Double,
        override val temporaryNormal: Boolean,
        override val base: Double,
    ) : PlaybackRateState

    data class Preview(
        override val preferred: Double = 1.0,
        override val temporaryNormal: Boolean = false,
        override val base: Double = 1.0,
    ) : PlaybackRateState
}

internal data class PodcastPlaybackSettings(
    val defaultPlaybackSpeed: Presence<Double>,
    val pauseShorteningMode: Presence<PauseShorteningMode>,
)

internal data class ListeningState(
    val positionMs: Long,
    val durationMs: Presence<Long>,
    val episodePlaybackRate: Presence<Double>,
    val writeRevision: Long,
    val resetEpoch: Long,
)

internal data class TerminalListening(
    val positionMs: Long,
    val durationMs: Presence<Long>,
    val episodePlaybackRate: Presence<Double>,
    val expectedWriteRevision: Long,
    val expectedResetEpoch: Long,
)

internal data class PendingNaturalEnd(
    val accountId: UUID,
    val sessionKey: UUID,
    val mediaId: UUID,
    val origin: PlayerOrigin,
    val clientMutationId: UUID,
    val terminalListening: TerminalListening,
    val expectedConsumptionOverrideRevision: Presence<Long>,
)

internal data class PauseShorteningSnapshot(
    val deviceDefaultMode: PauseShorteningMode,
    val podcastOverride: Presence<PauseShorteningMode>,
    val sessionOverride: Presence<PauseShorteningMode>,
    val effectiveMode: PauseShorteningMode,
    val provenance: PauseShorteningProvenance,
    val savedOnDeviceMs: Long,
)

internal sealed interface PlayerSnapshot {
    data class Absent(
        val deviceDefaultPauseShorteningMode: PauseShorteningMode,
        val pauseShorteningSavedOnDeviceMs: Long,
    ) : PlayerSnapshot

    data class Canonical(
        val sessionKey: UUID,
        val session: AudioSession,
        val phase: PlaybackPhase,
        val positionMs: Long,
        val durationMs: Long,
        val bufferedMs: Long,
        val volume: Double,
        val observedBaseRate: Double,
        val rateState: PlaybackRateState.Canonical,
        val persistence: PlayerPersistence,
        val playbackFailure: Presence<PlayerFailure>,
        val pauseShortening: PauseShorteningSnapshot,
    ) : PlayerSnapshot

    data class Preview(
        val sessionKey: UUID,
        val descriptor: PreviewDescriptor,
        val phase: PlaybackPhase,
        val positionMs: Long,
        val durationMs: Long,
        val bufferedMs: Long,
        val volume: Double,
        val observedBaseRate: Double,
        val rateState: PlaybackRateState.Preview,
        val persistence: PlayerPersistence,
        val playbackFailure: Presence<PlayerFailure>,
        val pauseShortening: PauseShorteningSnapshot,
    ) : PlayerSnapshot
}

internal sealed interface PlayerCommand {
    val requestId: UUID

    data class Connect(
        override val requestId: UUID,
        val accountId: UUID,
    ) : PlayerCommand

    data class GetSnapshot(override val requestId: UUID) : PlayerCommand

    data class LoadCanonical(
        override val requestId: UUID,
        val sessionKey: UUID,
        val session: AudioSession,
        val rateState: PlaybackRateState.Canonical,
    ) : PlayerCommand

    data class LoadPreview(
        override val requestId: UUID,
        val sessionKey: UUID,
        val descriptor: PreviewDescriptor,
    ) : PlayerCommand

    sealed interface SessionCommand : PlayerCommand {
        val sessionKey: UUID
    }

    data class Play(
        override val requestId: UUID,
        override val sessionKey: UUID,
    ) : SessionCommand

    data class Pause(
        override val requestId: UUID,
        override val sessionKey: UUID,
    ) : SessionCommand

    data class SeekTo(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val positionMs: Long,
    ) : SessionCommand

    data class SkipBy(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val deltaMs: Long,
    ) : SessionCommand

    data class SetVolume(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val volume: Double,
    ) : SessionCommand

    data class SetPlaybackRateState(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val rateState: PlaybackRateState,
    ) : SessionCommand

    data class SetSessionPauseShorteningMode(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val mode: PauseShorteningMode,
    ) : SessionCommand

    data class ClearSessionPauseShorteningMode(
        override val requestId: UUID,
        override val sessionKey: UUID,
    ) : SessionCommand

    data class SetDeviceDefaultPauseShorteningMode(
        override val requestId: UUID,
        val mode: PauseShorteningMode,
    ) : PlayerCommand

    data class InstallPodcastPlaybackSettings(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val podcastId: UUID,
        val subscription: Presence<PodcastPlaybackSettings>,
        val rateState: PlaybackRateState.Canonical,
    ) : SessionCommand

    data class Drain(
        override val requestId: UUID,
        override val sessionKey: UUID,
    ) : SessionCommand

    data class AdoptListeningState(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val listeningState: ListeningState,
    ) : SessionCommand

    data class RetryPersistence(
        override val requestId: UUID,
        override val sessionKey: UUID,
    ) : SessionCommand

    data class Dismiss(
        override val requestId: UUID,
        override val sessionKey: UUID,
    ) : SessionCommand

    data class AcknowledgeNaturalEnd(
        override val requestId: UUID,
        override val sessionKey: UUID,
        val clientMutationId: UUID,
    ) : SessionCommand
}

internal enum class PlayerRejectionCode {
    InvalidRequest,
    AccountMismatch,
    StaleSession,
    NaturalEndPending,
    PlayerUnavailable,
}

internal sealed interface PlayerCommandParseResult {
    data class Accepted(val command: PlayerCommand) : PlayerCommandParseResult

    data class Rejected(val requestId: UUID) : PlayerCommandParseResult

    data object Unreplyable : PlayerCommandParseResult
}

internal object PlayerWire {
    fun parseCommand(raw: String): PlayerCommandParseResult {
        val json = try {
            strictJsonObject(raw)
        } catch (_: RuntimeException) {
            return PlayerCommandParseResult.Unreplyable
        }
        val requestId = try {
            json.requireCanonicalUuid("requestId")
        } catch (_: RuntimeException) {
            return PlayerCommandParseResult.Unreplyable
        }
        return try {
            require(
                json.requireLong("protocolVersion", 1, 1) ==
                    PLAYER_PROTOCOL_VERSION.toLong()
            )
            PlayerCommandParseResult.Accepted(parseCommand(json, requestId))
        } catch (_: RuntimeException) {
            PlayerCommandParseResult.Rejected(requestId)
        }
    }

    fun connected(
        requestId: UUID,
        snapshot: PlayerSnapshot,
        pendingNaturalEnd: Presence<PendingNaturalEnd>,
    ): String = reply(
        requestId,
        JSONObject()
            .put("kind", "Connected")
            .put("snapshot", snapshot.toJson())
            .put("pendingNaturalEnd", pendingNaturalEnd.toJson(::pendingNaturalEndToJson)),
    )

    fun snapshot(
        requestId: UUID,
        snapshot: PlayerSnapshot,
        pendingNaturalEnd: Presence<PendingNaturalEnd>,
    ): String = reply(
        requestId,
        JSONObject()
            .put("kind", "Snapshot")
            .put("snapshot", snapshot.toJson())
            .put("pendingNaturalEnd", pendingNaturalEnd.toJson(::pendingNaturalEndToJson)),
    )

    fun accepted(requestId: UUID): String =
        reply(requestId, JSONObject().put("kind", "Accepted"))

    fun rejected(requestId: UUID, code: PlayerRejectionCode): String =
        reply(
            requestId,
            JSONObject()
                .put("kind", "Rejected")
                .put("code", code.name),
        )

    fun snapshotChanged(snapshot: PlayerSnapshot): String =
        JSONObject()
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("kind", "SnapshotChanged")
            .put("snapshot", snapshot.toJson())
            .toString()

    fun naturalEndPending(receipt: PendingNaturalEnd): String =
        JSONObject()
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("kind", "NaturalEndPending")
            .put("receipt", pendingNaturalEndToJson(receipt))
            .toString()

    fun controllerReconnected(
        snapshot: JSONObject,
        pendingNaturalEnd: PendingNaturalEnd?,
    ): String {
        val pending: Presence<PendingNaturalEnd> =
            if (pendingNaturalEnd == null) {
                Presence.Absent
            } else {
                Presence.Present(pendingNaturalEnd)
            }
        return JSONObject()
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .put("kind", "ControllerReconnected")
            .put("snapshot", snapshot)
            .put(
                "pendingNaturalEnd",
                pending.toJson(::pendingNaturalEndToJson),
            )
            .toString()
    }

    fun encodePendingNaturalEnd(receipt: PendingNaturalEnd): String =
        pendingNaturalEndToJson(receipt).toString()

    fun decodePendingNaturalEnd(raw: String): PendingNaturalEnd =
        decodePendingNaturalEnd(strictJsonObject(raw))

    private fun parseCommand(json: JSONObject, requestId: UUID): PlayerCommand {
        return when (json.requireBoundedString("kind", 1, 64)) {
            "Connect" -> {
                json.requireExactKeys("kind", "requestId", "protocolVersion", "accountId")
                PlayerCommand.Connect(requestId, json.requireCanonicalUuid("accountId"))
            }
            "GetSnapshot" -> {
                json.requireExactKeys("kind", "requestId", "protocolVersion")
                PlayerCommand.GetSnapshot(requestId)
            }
            "LoadCanonical" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "session",
                    "rateState",
                )
                PlayerCommand.LoadCanonical(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    decodeAudioSession(json.requireObject("session")),
                    decodeCanonicalRateState(json.requireObject("rateState")),
                )
            }
            "LoadPreview" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "descriptor",
                )
                PlayerCommand.LoadPreview(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    decodePreviewDescriptor(json.requireObject("descriptor")),
                )
            }
            "Play" ->
                noPayloadSessionCommand(json, requestId) { request, session ->
                    PlayerCommand.Play(request, session)
                }
            "Pause" ->
                noPayloadSessionCommand(json, requestId) { request, session ->
                    PlayerCommand.Pause(request, session)
                }
            "SeekTo" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "positionMs",
                )
                PlayerCommand.SeekTo(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    json.requireSourceTime("positionMs"),
                )
            }
            "SkipBy" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "deltaMs",
                )
                PlayerCommand.SkipBy(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    json.requireLong(
                        "deltaMs",
                        -MAX_SOURCE_TIME_MS,
                        MAX_SOURCE_TIME_MS,
                    ),
                )
            }
            "SetVolume" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "volume",
                )
                PlayerCommand.SetVolume(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    json.requireFiniteDouble("volume", 0.0, 1.0),
                )
            }
            "SetPlaybackRateState" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "rateState",
                )
                PlayerCommand.SetPlaybackRateState(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    decodeRateState(json.requireObject("rateState")),
                )
            }
            "SetSessionPauseShorteningMode" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "mode",
                )
                PlayerCommand.SetSessionPauseShorteningMode(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    json.requireEnum("mode"),
                )
            }
            "ClearSessionPauseShorteningMode" ->
                noPayloadSessionCommand(
                    json,
                    requestId,
                ) { request, session ->
                    PlayerCommand.ClearSessionPauseShorteningMode(request, session)
                }
            "SetDeviceDefaultPauseShorteningMode" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "mode",
                )
                PlayerCommand.SetDeviceDefaultPauseShorteningMode(
                    requestId,
                    json.requireEnum("mode"),
                )
            }
            "InstallPodcastPlaybackSettings" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "podcastId",
                    "subscription",
                    "rateState",
                )
                PlayerCommand.InstallPodcastPlaybackSettings(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    json.requireCanonicalUuid("podcastId"),
                    decodePodcastPlaybackSettingsPresence(
                        json.requireObject("subscription")
                    ),
                    decodeCanonicalRateState(json.requireObject("rateState")),
                )
            }
            "Drain" ->
                noPayloadSessionCommand(json, requestId) { request, session ->
                    PlayerCommand.Drain(request, session)
                }
            "AdoptListeningState" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "listeningState",
                )
                PlayerCommand.AdoptListeningState(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    decodeListeningState(json.requireObject("listeningState")),
                )
            }
            "RetryPersistence" ->
                noPayloadSessionCommand(
                    json,
                    requestId,
                ) { request, session ->
                    PlayerCommand.RetryPersistence(request, session)
                }
            "Dismiss" ->
                noPayloadSessionCommand(json, requestId) { request, session ->
                    PlayerCommand.Dismiss(request, session)
                }
            "AcknowledgeNaturalEnd" -> {
                json.requireExactKeys(
                    "kind",
                    "requestId",
                    "protocolVersion",
                    "sessionKey",
                    "clientMutationId",
                )
                PlayerCommand.AcknowledgeNaturalEnd(
                    requestId,
                    json.requireCanonicalUuid("sessionKey"),
                    json.requireCanonicalUuid("clientMutationId"),
                )
            }
            else -> error("unknown player command")
        }
    }

    private fun noPayloadSessionCommand(
        json: JSONObject,
        requestId: UUID,
        build: (UUID, UUID) -> PlayerCommand,
    ): PlayerCommand {
        json.requireExactKeys("kind", "requestId", "protocolVersion", "sessionKey")
        return build(requestId, json.requireCanonicalUuid("sessionKey"))
    }

    private fun reply(requestId: UUID, outcome: JSONObject): String =
        JSONObject()
            .put("requestId", requestId.toString())
            .put("protocolVersion", PLAYER_PROTOCOL_VERSION)
            .apply {
                outcome.keys().forEach { key ->
                    check(!has(key))
                    put(key, outcome.get(key))
                }
            }
            .toString()
}

private inline fun <reified T : Enum<T>> JSONObject.requireEnum(key: String): T =
    enumValueOf(requireBoundedString(key, 1, 64))

private fun JSONObject.requireSourceTime(key: String): Long =
    requireLong(key, 0, MAX_SOURCE_TIME_MS)

private fun decodeRateState(json: JSONObject): PlaybackRateState {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Canonical" -> decodeCanonicalRateState(json)
        "Preview" -> decodePreviewRateState(json)
        else -> error("unknown playback-rate state")
    }
}

private fun decodeCanonicalRateState(
    json: JSONObject,
): PlaybackRateState.Canonical {
    json.requireExactKeys(
        "kind",
        "episodeRate",
        "podcastPreference",
        "preferred",
        "temporaryNormal",
        "base",
    )
    require(json.requireBoundedString("kind", 1, 16) == "Canonical")
    val episodeRate = decodeDoublePresence(
        json.requireObject("episodeRate"),
        0.5,
        3.0,
    )
    val podcastPreference = decodePresence(
        json.requireObject("podcastPreference")
    ) { preference ->
        preference.requireExactKeys("podcastId", "value")
        PodcastRatePreference(
            podcastId = preference.requireCanonicalUuid("podcastId"),
            value = decodeDoublePresence(
                preference.requireObject("value"),
                0.5,
                3.0,
            ),
        )
    }
    val preferred = json.requireFiniteDouble("preferred", 0.5, 3.0)
    val temporaryNormal = json.requireBoolean("temporaryNormal")
    val base = json.requireFiniteDouble("base", 0.5, 3.0)
    val derivedPreferred = when (episodeRate) {
        is Presence.Present -> episodeRate.value
        Presence.Absent -> when (podcastPreference) {
            is Presence.Present ->
                (podcastPreference.value.value as? Presence.Present)?.value ?: 1.0
            Presence.Absent -> 1.0
        }
    }
    require(kotlin.math.abs(preferred - derivedPreferred) < 0.000_001)
    require(kotlin.math.abs(base - if (temporaryNormal) 1.0 else preferred) < 0.000_001)
    return PlaybackRateState.Canonical(
        episodeRate,
        podcastPreference,
        preferred,
        temporaryNormal,
        base,
    )
}

private fun decodePreviewRateState(
    json: JSONObject,
): PlaybackRateState.Preview {
    json.requireExactKeys("kind", "preferred", "temporaryNormal", "base")
    require(json.requireBoundedString("kind", 1, 16) == "Preview")
    val preferred = json.requireFiniteDouble("preferred", 0.5, 3.0)
    val temporaryNormal = json.requireBoolean("temporaryNormal")
    val base = json.requireFiniteDouble("base", 0.5, 3.0)
    require(
        kotlin.math.abs(
            base - if (temporaryNormal) 1.0 else preferred
        ) < 0.000_001
    )
    return PlaybackRateState.Preview(preferred, temporaryNormal, base)
}

private fun decodePodcastPlaybackSettingsPresence(
    json: JSONObject,
): Presence<PodcastPlaybackSettings> =
    decodePresence(json) { settings ->
        settings.requireExactKeys("defaultPlaybackSpeed", "pauseShorteningMode")
        PodcastPlaybackSettings(
            defaultPlaybackSpeed = decodeDoublePresence(
                settings.requireObject("defaultPlaybackSpeed"),
                0.5,
                3.0,
            ),
            pauseShorteningMode = decodeEnumPresence(
                settings.requireObject("pauseShorteningMode")
            ),
        )
    }

private fun decodeAudioSession(json: JSONObject): AudioSession {
    json.requireExactKeys("descriptor", "origin")
    return AudioSession(
        descriptor = decodeCanonicalDescriptor(json.requireObject("descriptor")),
        origin = decodeOrigin(json.requireObject("origin")),
    )
}

private fun decodeOrigin(json: JSONObject): PlayerOrigin {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Direct" -> {
            json.requireExactKeys("kind")
            PlayerOrigin.Direct
        }
        "Lectern" -> {
            json.requireExactKeys("kind", "itemId")
            PlayerOrigin.Lectern(json.requireCanonicalUuid("itemId"))
        }
        else -> error("unknown player origin")
    }
}

private fun decodeCanonicalDescriptor(json: JSONObject): CanonicalDescriptor {
    json.requireExactKeys("mediaId", "title", "subtitle", "activation")
    val activation = json.requireObject("activation")
    activation.requireExactKeys(
        "kind",
        "streamUrl",
        "sourceUrl",
        "positionMs",
        "writeRevision",
        "resetEpoch",
        "playbackRate",
        "pauseShorteningMode",
        "consumptionOverrideRevision",
        "durationMs",
        "artworkUrl",
        "chapters",
    )
    require(activation.requireBoundedString("kind", 1, 32) == "FooterAudio")
    val chaptersJson = activation.requireArray("chapters", MAX_CHAPTERS)
    return CanonicalDescriptor(
        mediaId = json.requireCanonicalUuid("mediaId"),
        title = json.requireBoundedString("title", 1, 512),
        subtitle = decodeStringPresence(json.requireObject("subtitle"), 0, 512),
        streamUrl = requirePublicMediaHttpsUrl(
            activation.requireBoundedString("streamUrl", 1, 8192)
        ),
        sourceUrl = activation.requireBoundedString("sourceUrl", 1, 8192),
        positionMs = activation.requireSourceTime("positionMs"),
        writeRevision = activation.requireLong("writeRevision", 0, MAX_SOURCE_TIME_MS),
        resetEpoch = activation.requireLong("resetEpoch", 0, MAX_SOURCE_TIME_MS),
        playbackRate = decodePlaybackRate(activation.requireObject("playbackRate")),
        pauseShorteningMode = decodeEnumPresence(
            activation.requireObject("pauseShorteningMode")
        ),
        consumptionOverrideRevision = decodeLongPresence(
            activation.requireObject("consumptionOverrideRevision")
        ),
        durationMs = decodeSourceTimePresence(activation.requireObject("durationMs")),
        artworkUrl = decodeStringPresence(activation.requireObject("artworkUrl"), 1, 8192),
        chapters = List(chaptersJson.length()) {
            decodeChapter(chaptersJson.get(it) as? JSONObject ?: error("chapter must be an object"))
        },
    )
}

private fun decodePlaybackRate(json: JSONObject): PlaybackRateResolution {
    json.requireExactKeys("value", "source", "podcastPreference")
    val value = json.requireFiniteDouble("value", 0.5, 3.0)
    val source = json.requireEnum<PlaybackRateResolution.Source>("source")
    val podcastPreference = decodePresence(
        json.requireObject("podcastPreference")
    ) { preference ->
        preference.requireExactKeys("podcastId", "value")
        PodcastRatePreference(
            preference.requireCanonicalUuid("podcastId"),
            decodeDoublePresence(preference.requireObject("value"), 0.5, 3.0),
        )
    }
    when (source) {
        PlaybackRateResolution.Source.Episode -> Unit
        PlaybackRateResolution.Source.Podcast -> {
            val preference = podcastPreference as? Presence.Present<PodcastRatePreference>
                ?: error("Podcast source requires a subscription preference")
            val inherited = preference.value.value as? Presence.Present<Double>
                ?: error("Podcast source requires a present rate")
            require(kotlin.math.abs(inherited.value - value) < 0.000_001)
        }
        PlaybackRateResolution.Source.Product -> {
            require(kotlin.math.abs(value - 1.0) < 0.000_001)
        }
    }
    return PlaybackRateResolution(value, source, podcastPreference)
}

private fun decodeChapter(json: JSONObject): Chapter {
    json.requireExactKeys("title", "startMs", "endMs")
    val startMs = json.requireSourceTime("startMs")
    val endMs = decodeSourceTimePresence(json.requireObject("endMs"))
    if (endMs is Presence.Present) {
        require(endMs.value > startMs)
    }
    return Chapter(
        title = json.requireBoundedString("title", 1, 300),
        startMs = startMs,
        endMs = endMs,
    )
}

private fun decodePreviewDescriptor(json: JSONObject): PreviewDescriptor {
    json.requireExactKeys(
        "target",
        "previewHref",
        "title",
        "source",
        "sourceHref",
        "audioUrl",
        "imageUrl",
        "durationMs",
    )
    return PreviewDescriptor(
        target = json.requireBoundedString("target", 1, 8192),
        previewHref = json.requireBoundedString("previewHref", 1, 8192),
        title = json.requireBoundedString("title", 1, 512),
        source = json.requireBoundedString("source", 1, 512),
        sourceHref = json.requireBoundedString("sourceHref", 1, 8192),
        audioUrl = requirePublicMediaHttpsUrl(
            json.requireBoundedString("audioUrl", 1, 8192)
        ),
        imageUrl = decodeStringPresence(json.requireObject("imageUrl"), 1, 8192),
        durationMs = decodeSourceTimePresence(json.requireObject("durationMs")),
    )
}

private fun requirePublicMediaHttpsUrl(raw: String): String {
    val uri = URI(raw)
    val host = uri.host ?: error("public media URL requires a host")
    require(
        uri.scheme == "https" &&
            uri.rawUserInfo == null &&
            uri.rawFragment == null &&
            !host.contains(':') &&
            !IPV4_LITERAL.matches(host)
    ) {
        "public media URL must be public HTTPS"
    }
    return raw
}

private val IPV4_LITERAL = Regex("""\d{1,3}(?:\.\d{1,3}){3}""")

private fun decodeListeningState(json: JSONObject): ListeningState {
    json.requireExactKeys(
        "positionMs",
        "durationMs",
        "episodePlaybackRate",
        "writeRevision",
        "resetEpoch",
    )
    return ListeningState(
        positionMs = json.requireSourceTime("positionMs"),
        durationMs = decodeSourceTimePresence(json.requireObject("durationMs")),
        episodePlaybackRate = decodeDoublePresence(
            json.requireObject("episodePlaybackRate"),
            0.5,
            3.0,
        ),
        writeRevision = json.requireLong("writeRevision", 0, MAX_SOURCE_TIME_MS),
        resetEpoch = json.requireLong("resetEpoch", 0, MAX_SOURCE_TIME_MS),
    )
}

private fun decodePendingNaturalEnd(json: JSONObject): PendingNaturalEnd {
    json.requireExactKeys(
        "accountId",
        "sessionKey",
        "mediaId",
        "origin",
        "clientMutationId",
        "terminalListening",
        "expectedConsumptionOverrideRevision",
    )
    val terminal = json.requireObject("terminalListening")
    terminal.requireExactKeys(
        "positionMs",
        "durationMs",
        "episodePlaybackRate",
        "expectedWriteRevision",
        "expectedResetEpoch",
    )
    return PendingNaturalEnd(
        accountId = json.requireCanonicalUuid("accountId"),
        sessionKey = json.requireCanonicalUuid("sessionKey"),
        mediaId = json.requireCanonicalUuid("mediaId"),
        origin = decodeOrigin(json.requireObject("origin")),
        clientMutationId = json.requireCanonicalUuid("clientMutationId"),
        terminalListening = TerminalListening(
            positionMs = terminal.requireSourceTime("positionMs"),
            durationMs = decodeSourceTimePresence(terminal.requireObject("durationMs")),
            episodePlaybackRate = decodeDoublePresence(
                terminal.requireObject("episodePlaybackRate"),
                0.5,
                3.0,
            ),
            expectedWriteRevision = terminal.requireLong(
                "expectedWriteRevision",
                0,
                MAX_SOURCE_TIME_MS,
            ),
            expectedResetEpoch = terminal.requireLong(
                "expectedResetEpoch",
                0,
                MAX_SOURCE_TIME_MS,
            ),
        ),
        expectedConsumptionOverrideRevision = decodeLongPresence(
            json.requireObject("expectedConsumptionOverrideRevision")
        ),
    )
}

private fun <T> decodePresence(
    json: JSONObject,
    decode: (JSONObject) -> T,
): Presence<T> {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Absent" -> {
            json.requireExactKeys("kind")
            Presence.Absent
        }
        "Present" -> {
            json.requireExactKeys("kind", "value")
            Presence.Present(
                decode(json.get("value") as? JSONObject ?: error("value must be an object"))
            )
        }
        else -> error("unknown Presence kind")
    }
}

private fun decodeStringPresence(
    json: JSONObject,
    minimum: Int,
    maximum: Int,
): Presence<String> {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Absent" -> {
            json.requireExactKeys("kind")
            Presence.Absent
        }
        "Present" -> {
            json.requireExactKeys("kind", "value")
            Presence.Present(json.requireBoundedString("value", minimum, maximum))
        }
        else -> error("unknown Presence kind")
    }
}

private fun decodeLongPresence(json: JSONObject): Presence<Long> {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Absent" -> {
            json.requireExactKeys("kind")
            Presence.Absent
        }
        "Present" -> {
            json.requireExactKeys("kind", "value")
            Presence.Present(json.requireLong("value", 0, MAX_SOURCE_TIME_MS))
        }
        else -> error("unknown Presence kind")
    }
}

private fun decodeSourceTimePresence(json: JSONObject): Presence<Long> =
    decodeLongPresence(json)

private fun decodeDoublePresence(
    json: JSONObject,
    minimum: Double,
    maximum: Double,
): Presence<Double> {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Absent" -> {
            json.requireExactKeys("kind")
            Presence.Absent
        }
        "Present" -> {
            json.requireExactKeys("kind", "value")
            Presence.Present(json.requireFiniteDouble("value", minimum, maximum))
        }
        else -> error("unknown Presence kind")
    }
}

private inline fun <reified T : Enum<T>> decodeEnumPresence(json: JSONObject): Presence<T> {
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Absent" -> {
            json.requireExactKeys("kind")
            Presence.Absent
        }
        "Present" -> {
            json.requireExactKeys("kind", "value")
            Presence.Present(json.requireEnum("value"))
        }
        else -> error("unknown Presence kind")
    }
}

private fun PlayerSnapshot.toJson(): JSONObject {
    return when (this) {
        is PlayerSnapshot.Absent ->
            JSONObject()
                .put("kind", "Absent")
                .put(
                    "deviceDefaultPauseShorteningMode",
                    deviceDefaultPauseShorteningMode.name,
                )
                .put(
                    "pauseShorteningSavedOnDeviceMs",
                    pauseShorteningSavedOnDeviceMs,
                )
        is PlayerSnapshot.Canonical ->
            commonSnapshotJson(
                kind = "Canonical",
                sessionKey = sessionKey,
                phase = phase,
                positionMs = positionMs,
                durationMs = durationMs,
                bufferedMs = bufferedMs,
                volume = volume,
                observedBaseRate = observedBaseRate,
                rateState = rateState,
                persistence = persistence,
                playbackFailure = playbackFailure,
                pauseShortening = pauseShortening,
            ).put("session", session.toJson())
        is PlayerSnapshot.Preview ->
            commonSnapshotJson(
                kind = "Preview",
                sessionKey = sessionKey,
                phase = phase,
                positionMs = positionMs,
                durationMs = durationMs,
                bufferedMs = bufferedMs,
                volume = volume,
                observedBaseRate = observedBaseRate,
                rateState = rateState,
                persistence = persistence,
                playbackFailure = playbackFailure,
                pauseShortening = pauseShortening,
            ).put("descriptor", descriptor.toJson())
    }
}

private fun commonSnapshotJson(
    kind: String,
    sessionKey: UUID,
    phase: PlaybackPhase,
    positionMs: Long,
    durationMs: Long,
    bufferedMs: Long,
    volume: Double,
    observedBaseRate: Double,
    rateState: PlaybackRateState,
    persistence: PlayerPersistence,
    playbackFailure: Presence<PlayerFailure>,
    pauseShortening: PauseShorteningSnapshot,
): JSONObject =
    JSONObject()
        .put("kind", kind)
        .put("sessionKey", sessionKey.toString())
        .put("phase", phase.name)
        .put("positionMs", positionMs)
        .put("durationMs", durationMs)
        .put("bufferedMs", bufferedMs)
        .put("volume", volume)
        .put("observedBaseRate", observedBaseRate)
        .put("rateState", rateState.toJson())
        .put("persistence", persistence.toJson())
        .put("playbackFailure", playbackFailure.toJson { it.toJson() })
        .put("pauseShortening", pauseShortening.toJson())

private fun PlayerPersistence.toJson(): JSONObject {
    return when (this) {
        PlayerPersistence.Ready -> JSONObject().put("kind", "Ready")
        is PlayerPersistence.Suspended ->
            JSONObject()
                .put("kind", "Suspended")
                .put("reason", reason.name)
                .put("message", message)
    }
}

private fun PlayerFailure.toJson(): JSONObject =
    JSONObject().put("code", code).put("message", message)

private fun PlaybackRateState.toJson(): JSONObject {
    val json = JSONObject()
        .put(
            "kind",
            when (this) {
                is PlaybackRateState.Canonical -> "Canonical"
                is PlaybackRateState.Preview -> "Preview"
            },
        )
        .put("preferred", preferred)
        .put("temporaryNormal", temporaryNormal)
        .put("base", base)
    if (this is PlaybackRateState.Canonical) {
        json
            .put("episodeRate", episodeRate.toJson { it })
            .put(
                "podcastPreference",
                podcastPreference.toJson { preference ->
                    JSONObject()
                        .put("podcastId", preference.podcastId.toString())
                        .put("value", preference.value.toJson { it })
                },
            )
    }
    return json
}

private fun PauseShorteningSnapshot.toJson(): JSONObject =
    JSONObject()
        .put("deviceDefaultMode", deviceDefaultMode.name)
        .put("podcastOverride", podcastOverride.toJson { it.name })
        .put("sessionOverride", sessionOverride.toJson { it.name })
        .put("effectiveMode", effectiveMode.name)
        .put("provenance", provenance.name)
        .put("savedOnDeviceMs", savedOnDeviceMs)

private fun AudioSession.toJson(): JSONObject =
    JSONObject()
        .put("descriptor", descriptor.toJson())
        .put("origin", origin.toJson())

private fun CanonicalDescriptor.toJson(): JSONObject =
    JSONObject()
        .put("mediaId", mediaId.toString())
        .put("title", title)
        .put("subtitle", subtitle.toJson { it })
        .put(
            "activation",
            JSONObject()
                .put("kind", "FooterAudio")
                .put("streamUrl", streamUrl)
                .put("sourceUrl", sourceUrl)
                .put("positionMs", positionMs)
                .put("writeRevision", writeRevision)
                .put("resetEpoch", resetEpoch)
                .put("playbackRate", playbackRate.toJson())
                .put("pauseShorteningMode", pauseShorteningMode.toJson { it.name })
                .put(
                    "consumptionOverrideRevision",
                    consumptionOverrideRevision.toJson { it },
                )
                .put("durationMs", durationMs.toJson { it })
                .put("artworkUrl", artworkUrl.toJson { it })
                .put("chapters", chapters.toJsonArray { it.toJson() }),
        )

private fun PlaybackRateResolution.toJson(): JSONObject =
    JSONObject()
        .put("value", value)
        .put("source", source.name)
        .put(
            "podcastPreference",
            podcastPreference.toJson { preference ->
                JSONObject()
                    .put("podcastId", preference.podcastId.toString())
                    .put("value", preference.value.toJson { it })
            },
        )

private fun Chapter.toJson(): JSONObject =
    JSONObject()
        .put("title", title)
        .put("startMs", startMs)
        .put("endMs", endMs.toJson { it })

private fun PreviewDescriptor.toJson(): JSONObject =
    JSONObject()
        .put("target", target)
        .put("previewHref", previewHref)
        .put("title", title)
        .put("source", source)
        .put("sourceHref", sourceHref)
        .put("audioUrl", audioUrl)
        .put("imageUrl", imageUrl.toJson { it })
        .put("durationMs", durationMs.toJson { it })

private fun PlayerOrigin.toJson(): JSONObject {
    return when (this) {
        PlayerOrigin.Direct -> JSONObject().put("kind", "Direct")
        is PlayerOrigin.Lectern ->
            JSONObject()
                .put("kind", "Lectern")
                .put("itemId", itemId.toString())
    }
}

private fun pendingNaturalEndToJson(receipt: PendingNaturalEnd): JSONObject =
    JSONObject()
        .put("accountId", receipt.accountId.toString())
        .put("sessionKey", receipt.sessionKey.toString())
        .put("mediaId", receipt.mediaId.toString())
        .put("origin", receipt.origin.toJson())
        .put("clientMutationId", receipt.clientMutationId.toString())
        .put("terminalListening", receipt.terminalListening.toJson())
        .put(
            "expectedConsumptionOverrideRevision",
            receipt.expectedConsumptionOverrideRevision.toJson { it },
        )

private fun TerminalListening.toJson(): JSONObject =
    JSONObject()
        .put("positionMs", positionMs)
        .put("durationMs", durationMs.toJson { it })
        .put("episodePlaybackRate", episodePlaybackRate.toJson { it })
        .put("expectedWriteRevision", expectedWriteRevision)
        .put("expectedResetEpoch", expectedResetEpoch)

private fun <T> Presence<T>.toJson(encode: (T) -> Any): JSONObject {
    return when (this) {
        Presence.Absent -> JSONObject().put("kind", "Absent")
        is Presence.Present ->
            JSONObject()
                .put("kind", "Present")
                .put("value", encode(value))
    }
}

private fun <T> List<T>.toJsonArray(encode: (T) -> Any): JSONArray {
    val result = JSONArray()
    forEach { result.put(encode(it)) }
    return result
}
