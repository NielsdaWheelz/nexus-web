package app.nexus.android.offline

import org.json.JSONException
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.UUID

internal const val OFFLINE_MEDIA_PROTOCOL_VERSION = 1
internal const val OFFLINE_MEDIA_MESSAGE_LIMIT_BYTES = 64 * 1024

internal enum class NetworkPolicy {
    UnmeteredOnly,
    AnyConnected,
}

internal enum class QueueReason {
    Capacity,
    WaitingForNetwork,
    WaitingForUnmetered,
    SystemLimit,
}

internal sealed interface NativeLocalAvailability {
    data class Queued(val reason: QueueReason) : NativeLocalAvailability

    data class Downloading(
        val bytesDownloaded: Long,
        val totalBytes: Presence<Long>,
    ) : NativeLocalAvailability

    data object Restarting : NativeLocalAvailability

    data class Ready(
        val sizeBytes: Long,
        val contentType: String,
        val updatedAt: Instant,
    ) : NativeLocalAvailability

    data object Failed : NativeLocalAvailability

    data object Removing : NativeLocalAvailability
}

internal sealed interface Presence<out T> {
    data object Absent : Presence<Nothing>

    data class Present<T>(val value: T) : Presence<T>
}

internal data class OfflineMediaItem(
    val mediaId: UUID,
    val title: String,
    val state: NativeLocalAvailability,
)

internal data class OfflineDownloadSpec(
    val mediaId: UUID,
    val title: String,
    val sourceUrl: String,
)

internal sealed interface OfflineMediaCommand {
    val requestId: UUID

    data class Connect(
        override val requestId: UUID,
        val accountId: UUID,
    ) : OfflineMediaCommand

    data class GetSnapshot(override val requestId: UUID) : OfflineMediaCommand

    data class Enqueue(
        override val requestId: UUID,
        val spec: OfflineDownloadSpec,
    ) : OfflineMediaCommand

    data class Cancel(
        override val requestId: UUID,
        val mediaId: UUID,
    ) : OfflineMediaCommand

    data class Retry(
        override val requestId: UUID,
        val mediaId: UUID,
    ) : OfflineMediaCommand

    data class Remove(
        override val requestId: UUID,
        val mediaId: UUID,
    ) : OfflineMediaCommand

    data class SetNetworkPolicy(
        override val requestId: UUID,
        val policy: NetworkPolicy,
    ) : OfflineMediaCommand
}

internal enum class RejectionCode {
    InvalidRequest,
    AccountMismatch,
    NetworkUnavailable,
    SourceForbidden,
    SourceMissing,
    SourceUnavailable,
    UnsupportedAudio,
    StorageInsufficient,
}

internal sealed interface CommandParseResult {
    data class Accepted(val command: OfflineMediaCommand) : CommandParseResult

    data class Rejected(val requestId: UUID) : CommandParseResult

    data object Unreplyable : CommandParseResult
}

internal data class OfflineMediaMetadata(
    val accountId: UUID,
    val mediaId: UUID,
    val title: String,
    val contentType: String,
    val contentLength: Presence<Long>,
) {
    fun encode(): ByteArray {
        return JSONObject()
            .put("schemaVersion", 1)
            .put("accountId", accountId.toString())
            .put("mediaId", mediaId.toString())
            .put("title", title)
            .put("contentType", contentType)
            .put("contentLength", contentLength.toJson { it })
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
    }

    companion object {
        fun decode(data: ByteArray): OfflineMediaMetadata {
            val json = JSONObject(data.toString(StandardCharsets.UTF_8))
            json.requireExactKeys(
                "schemaVersion",
                "accountId",
                "mediaId",
                "title",
                "contentType",
                "contentLength",
            )
            require(json.requireLong("schemaVersion", 1, 1) == 1L)
            return OfflineMediaMetadata(
                accountId = json.requireCanonicalUuid("accountId"),
                mediaId = json.requireCanonicalUuid("mediaId"),
                title = json.requireBoundedString("title", 1, 512),
                contentType = json.requireBoundedString("contentType", 1, 127),
                contentLength = json.requireLongPresence("contentLength"),
            )
        }
    }
}

internal object OfflineMediaWire {
    fun parseCommand(raw: String): CommandParseResult {
        if (raw.toByteArray(StandardCharsets.UTF_8).size > OFFLINE_MEDIA_MESSAGE_LIMIT_BYTES) {
            return CommandParseResult.Unreplyable
        }
        val json = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            return CommandParseResult.Unreplyable
        }
        val requestId = try {
            json.requireCanonicalUuid("requestId")
        } catch (_: RuntimeException) {
            return CommandParseResult.Unreplyable
        }
        return try {
            if (json.requireLong("protocolVersion", 1, 1) != OFFLINE_MEDIA_PROTOCOL_VERSION.toLong()) {
                return CommandParseResult.Rejected(requestId)
            }
            val command = when (json.requireBoundedString("kind", 1, 32)) {
                "Connect" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion", "accountId")
                    OfflineMediaCommand.Connect(requestId, json.requireCanonicalUuid("accountId"))
                }
                "GetSnapshot" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion")
                    OfflineMediaCommand.GetSnapshot(requestId)
                }
                "Enqueue" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion", "spec")
                    OfflineMediaCommand.Enqueue(requestId, json.requireOfflineDownloadSpec())
                }
                "Cancel" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion", "mediaId")
                    OfflineMediaCommand.Cancel(requestId, json.requireCanonicalUuid("mediaId"))
                }
                "Retry" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion", "mediaId")
                    OfflineMediaCommand.Retry(requestId, json.requireCanonicalUuid("mediaId"))
                }
                "Remove" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion", "mediaId")
                    OfflineMediaCommand.Remove(requestId, json.requireCanonicalUuid("mediaId"))
                }
                "SetNetworkPolicy" -> {
                    json.requireExactKeys("kind", "requestId", "protocolVersion", "policy")
                    OfflineMediaCommand.SetNetworkPolicy(
                        requestId,
                        NetworkPolicy.valueOf(json.requireBoundedString("policy", 1, 32)),
                    )
                }
                else -> return CommandParseResult.Rejected(requestId)
            }
            CommandParseResult.Accepted(command)
        } catch (_: RuntimeException) {
            CommandParseResult.Rejected(requestId)
        }
    }

    fun connected(
        requestId: UUID,
        items: List<OfflineMediaItem>,
        networkPolicy: NetworkPolicy,
    ): String = reply(
        requestId,
        JSONObject()
            .put("kind", "Connected")
            .put("items", items.toJsonArray())
            .put("networkPolicy", networkPolicy.name),
    )

    fun snapshot(
        requestId: UUID,
        items: List<OfflineMediaItem>,
        networkPolicy: NetworkPolicy,
    ): String = reply(
        requestId,
        JSONObject()
            .put("kind", "Snapshot")
            .put("items", items.toJsonArray())
            .put("networkPolicy", networkPolicy.name),
    )

    fun accepted(requestId: UUID): String =
        reply(requestId, JSONObject().put("kind", "Accepted"))

    fun rejected(requestId: UUID, code: RejectionCode): String =
        reply(
            requestId,
            JSONObject()
                .put("kind", "Rejected")
                .put("code", code.name),
        )

    fun stateChanged(
        mediaId: UUID,
        state: Presence<NativeLocalAvailability>,
    ): String {
        return JSONObject()
            .put("protocolVersion", OFFLINE_MEDIA_PROTOCOL_VERSION)
            .put("kind", "StateChanged")
            .put("mediaId", mediaId.toString())
            .put("state", state.toJson(::availabilityToJson))
            .toString()
    }

    fun networkPolicyChanged(policy: NetworkPolicy): String {
        return JSONObject()
            .put("protocolVersion", OFFLINE_MEDIA_PROTOCOL_VERSION)
            .put("kind", "NetworkPolicyChanged")
            .put("policy", policy.name)
            .toString()
    }

    private fun reply(requestId: UUID, outcome: JSONObject): String {
        return JSONObject()
            .put("requestId", requestId.toString())
            .put("protocolVersion", OFFLINE_MEDIA_PROTOCOL_VERSION)
            .put("outcome", outcome)
            .toString()
    }
}

private fun JSONObject.requireOfflineDownloadSpec(): OfflineDownloadSpec {
    val spec = get("spec") as? JSONObject ?: error("spec must be an object")
    spec.requireExactKeys("kind", "mediaId", "title", "sourceUrl")
    require(spec.requireBoundedString("kind", 1, 32) == "ProgressiveAudio")
    return OfflineDownloadSpec(
        mediaId = spec.requireCanonicalUuid("mediaId"),
        title = spec.requireBoundedString("title", 1, 512),
        sourceUrl = spec.requireBoundedString("sourceUrl", 1, 8192),
    )
}

private fun List<OfflineMediaItem>.toJsonArray(): org.json.JSONArray {
    val result = org.json.JSONArray()
    forEach { item ->
        result.put(
            JSONObject()
                .put("mediaId", item.mediaId.toString())
                .put("title", item.title)
                .put("state", Presence.Present(item.state).toJson(::availabilityToJson))
        )
    }
    return result
}

private fun availabilityToJson(state: NativeLocalAvailability): JSONObject {
    return when (state) {
        is NativeLocalAvailability.Queued ->
            JSONObject().put("kind", "Queued").put("reason", state.reason.name)
        is NativeLocalAvailability.Downloading ->
            JSONObject()
                .put("kind", "Downloading")
                .put("bytesDownloaded", state.bytesDownloaded)
                .put("totalBytes", state.totalBytes.toJson { it })
        NativeLocalAvailability.Restarting ->
            JSONObject().put("kind", "Restarting")
        is NativeLocalAvailability.Ready ->
            JSONObject()
                .put("kind", "Ready")
                .put("sizeBytes", state.sizeBytes)
                .put("contentType", state.contentType)
                .put("updatedAt", state.updatedAt.toString())
        NativeLocalAvailability.Failed ->
            JSONObject().put("kind", "Failed").put("code", "DownloadFailed")
        NativeLocalAvailability.Removing ->
            JSONObject().put("kind", "Removing")
    }
}

private fun <T> Presence<T>.toJson(encode: (T) -> Any): JSONObject {
    return when (this) {
        Presence.Absent -> JSONObject().put("kind", "Absent")
        is Presence.Present ->
            JSONObject()
                .put("kind", "Present")
                .put("value", encode(value))
    }
}

private fun JSONObject.requireExactKeys(vararg expected: String) {
    val actual = keys().asSequence().toSet()
    require(actual == expected.toSet()) {
        "expected keys ${expected.toSet()}, found $actual"
    }
}

private fun JSONObject.requireCanonicalUuid(key: String): UUID {
    val raw = requireBoundedString(key, 36, 36)
    val parsed = UUID.fromString(raw)
    require(
        parsed.toString() == raw &&
            parsed.version() in 1..8 &&
            parsed.variant() == 2
    )
    return parsed
}

private fun JSONObject.requireBoundedString(key: String, minimum: Int, maximum: Int): String {
    val value = get(key) as? String ?: error("$key must be a string")
    require(value.codePointCount(0, value.length) in minimum..maximum)
    return value
}

private fun JSONObject.requireLong(key: String, minimum: Long, maximum: Long): Long {
    val value = when (val raw = get(key)) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> error("$key must be an integer")
    }
    require(value in minimum..maximum)
    return value
}

private fun JSONObject.requireLongPresence(key: String): Presence<Long> {
    val json = get(key) as? JSONObject ?: error("$key must be an object")
    return when (json.requireBoundedString("kind", 1, 16)) {
        "Absent" -> {
            json.requireExactKeys("kind")
            Presence.Absent
        }
        "Present" -> {
            json.requireExactKeys("kind", "value")
            Presence.Present(json.requireLong("value", 0, Long.MAX_VALUE))
        }
        else -> error("$key has an unknown presence kind")
    }
}
