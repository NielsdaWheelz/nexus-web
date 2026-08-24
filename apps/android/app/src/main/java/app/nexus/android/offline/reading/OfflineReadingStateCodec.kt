package app.nexus.android.offline.reading

import com.squareup.moshi.JsonReader
import okio.Buffer

internal object OfflineReadingStateCodec {
    fun encode(state: ReadingTransferState): String = when (state) {
        ReadingTransferState.Preparing -> "{\"kind\":\"Preparing\"}"
        is ReadingTransferState.Queued ->
            "{\"kind\":\"Queued\",\"reason\":\"${state.reason.name}\"}"
        ReadingTransferState.Authorizing -> "{\"kind\":\"Authorizing\"}"
        is ReadingTransferState.Downloading ->
            "{\"kind\":\"Downloading\",\"receivedBytes\":${state.receivedBytes}," +
                "\"totalBytes\":${state.totalBytes}}"
        ReadingTransferState.Verifying -> "{\"kind\":\"Verifying\"}"
        is ReadingTransferState.Restarting ->
            "{\"kind\":\"Restarting\",\"attempt\":${state.attempt}," +
                "\"reason\":\"${state.reason.name}\"}"
        is ReadingTransferState.Failed ->
            "{\"kind\":\"Failed\",\"reason\":\"${state.reason.name}\"}"
    }

    fun decode(json: String): ReadingTransferState {
        val reader = JsonReader.of(Buffer().writeUtf8(json)).apply { isLenient = false }
        val fields = linkedMapOf<String, Any>()
        reader.beginObject()
        while (reader.hasNext()) {
            val name = reader.nextName()
            check(fields.put(name, readField(reader, name)) == null) {
                "duplicate offline reading transfer-state key $name"
            }
        }
        reader.endObject()
        check(reader.peek() == JsonReader.Token.END_DOCUMENT) {
            "offline reading transfer state has trailing JSON"
        }
        return decodeFields(fields)
    }

    private fun readField(reader: JsonReader, name: String): Any = when (name) {
        "kind", "reason" -> reader.nextString()
        "attempt" -> reader.nextInt()
        "receivedBytes", "totalBytes" -> reader.nextLong()
        else -> error("unknown offline reading transfer-state key $name")
    }

    private fun decodeFields(fields: Map<String, Any>): ReadingTransferState {
        val kind = fields["kind"] as? String
            ?: error("offline reading transfer state is missing kind")
        return when (kind) {
            "Preparing" -> {
                requireExactKeys(fields, setOf("kind"))
                ReadingTransferState.Preparing
            }
            "Queued" -> {
                requireExactKeys(fields, setOf("kind", "reason"))
                ReadingTransferState.Queued(
                    enumValue<ReadingQueueReason>(fields.getValue("reason") as String)
                )
            }
            "Authorizing" -> {
                requireExactKeys(fields, setOf("kind"))
                ReadingTransferState.Authorizing
            }
            "Downloading" -> {
                requireExactKeys(fields, setOf("kind", "receivedBytes", "totalBytes"))
                ReadingTransferState.Downloading(
                    fields.getValue("receivedBytes") as Long,
                    fields.getValue("totalBytes") as Long,
                )
            }
            "Verifying" -> {
                requireExactKeys(fields, setOf("kind"))
                ReadingTransferState.Verifying
            }
            "Restarting" -> {
                requireExactKeys(fields, setOf("kind", "attempt", "reason"))
                ReadingTransferState.Restarting(
                    fields.getValue("attempt") as Int,
                    enumValue<ReadingRestartReason>(fields.getValue("reason") as String),
                )
            }
            "Failed" -> {
                requireExactKeys(fields, setOf("kind", "reason"))
                ReadingTransferState.Failed(
                    enumValue<ReadingFailureReason>(fields.getValue("reason") as String)
                )
            }
            else -> error("unknown offline reading transfer-state kind $kind")
        }
    }

    private inline fun <reified T : Enum<T>> enumValue(value: String): T =
        enumValues<T>().singleOrNull { it.name == value }
            ?: error("unknown ${T::class.java.simpleName} value $value")

    private fun requireExactKeys(fields: Map<String, Any>, expected: Set<String>) {
        check(fields.keys == expected) {
            "offline reading transfer-state keys ${fields.keys} do not match $expected"
        }
    }
}
