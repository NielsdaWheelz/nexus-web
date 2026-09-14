package app.nexus.android.offline.reading

import com.squareup.moshi.JsonReader
import okio.Buffer

internal fun readerProgressViewJson(view: NativeReaderProgressView): StrictJson.ObjectValue {
    val fields = when (view) {
        is NativeReaderProgressView.Canonical -> mapOf("kind" to "Canonical", "snapshot" to view.baselineJson)
        is NativeReaderProgressView.Pending -> mapOf("kind" to "Pending", "baseline" to view.baselineJson,
            "device" to view.deviceLocatorJson, "source" to view.sourceJson)
        is NativeReaderProgressView.Conflict -> mapOf("kind" to "Conflict", "canonical" to view.canonicalJson,
            "device" to view.deviceLocatorJson, "source" to view.sourceJson)
        is NativeReaderProgressView.ContentChanged -> mapOf("kind" to "ContentChanged", "baseline" to view.baselineJson,
            "device" to view.deviceLocatorJson, "source" to view.sourceJson)
        is NativeReaderProgressView.SourceUnavailable -> mapOf("kind" to "SourceUnavailable", "baseline" to view.baselineJson,
            "device" to view.deviceLocatorJson, "source" to view.sourceJson)
    }
    return StrictJson.ObjectValue(fields.mapValues { (key, value) ->
        if (key == "kind") StrictJson.StringValue(value) else StrictJson.parse(value.toByteArray())
    })
}

internal fun requireReaderProgressViewJson(json: String): StrictJson.ObjectValue {
    val value = StrictJson.parse(json.toByteArray()) as? StrictJson.ObjectValue
        ?: error("reader progress view must be an object")
    // Every renderer-supplied key is absent until proven present: Map.getValue would
    // raise NoSuchElementException, which is not this module's malformed-input signal.
    val kind = value.fields["kind"]?.requireString() ?: error("reader progress view is missing kind")
    val snapshotKey = when (kind) {
        "Canonical" -> "snapshot"
        "Conflict" -> "canonical"
        "Pending", "ContentChanged", "SourceUnavailable" -> "baseline"
        else -> error("unknown reader progress view")
    }
    val fields = value.requireObject(if (kind == "Canonical") setOf("kind", snapshotKey)
        else setOf("kind", snapshotKey, "device", "source"))
    OfflineReaderStateValidator.requireCursorSnapshot(fields.getValue(snapshotKey).toJson())
    if (kind != "Canonical") {
        OfflineReaderStateValidator.requireLocator(fields.getValue("device").toJson())
        val source = fields.getValue("source") as? StrictJson.ObjectValue ?: error("invalid reader source")
        when (source.fields["kind"]?.requireString() ?: error("reader source is missing kind")) {
            "Publication" -> require(source.requireObject(setOf("kind", "reader_generation"))
                .getValue("reader_generation").requireLong() > 0)
            "Unresolved" -> {
                source.requireObject(setOf("kind"))
                require(kind == "ContentChanged" || kind == "SourceUnavailable")
            }
            else -> error("unsupported native reader source")
        }
    }
    return value
}

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
