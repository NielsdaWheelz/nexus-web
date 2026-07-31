package app.nexus.android.webkit

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.squareup.moshi.JsonReader
import okio.Buffer
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

internal const val OWNED_WEB_MESSAGE_LIMIT_BYTES = 64 * 1024
private const val MAX_JSON_DEPTH = 16

internal data class OwnedWebMessage(
    val data: String,
    val replyProxy: JavaScriptReplyProxy,
    val documentGeneration: Long,
)

internal class OwnedOrigin(baseUrl: String) {
    private val origin = Uri.parse(baseUrl)

    val rule: String = URI(
        origin.scheme,
        null,
        origin.host,
        origin.port,
        null,
        null,
        null,
    ).toString()

    init {
        require(origin.scheme == "http" || origin.scheme == "https")
        require(origin.host != null)
        require(origin.userInfo == null)
        require(origin.path.isNullOrEmpty() || origin.path == "/")
        require(origin.query == null)
        require(origin.fragment == null)
    }

    fun matches(candidate: Uri): Boolean {
        val scheme = candidate.scheme ?: return false
        val host = candidate.host ?: return false
        return scheme == origin.scheme &&
            host.equals(origin.host, ignoreCase = true) &&
            effectivePort(candidate) == effectivePort(origin) &&
            candidate.userInfo == null
    }

    private fun effectivePort(uri: Uri): Int {
        return when {
            uri.port != -1 -> uri.port
            uri.scheme == "https" -> 443
            else -> 80
        }
    }
}

/**
 * Exact AndroidX WebKit framing for one semantic protocol. Domain decoding,
 * account state, and command dispatch remain with the protocol owner.
 */
internal class OwnedOriginWebMessage(
    private val webView: WebView,
    private val objectName: String,
    baseUrl: String,
    private val onMessage: (OwnedWebMessage) -> Unit,
) {
    private val ownedOrigin = OwnedOrigin(baseUrl)
    private val documentGeneration = AtomicLong(0)
    private var installed = false

    fun install(): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return false
        }
        WebViewCompat.addWebMessageListener(
            webView,
            objectName,
            setOf(ownedOrigin.rule),
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            if (
                !isMainFrame ||
                !ownedOrigin.matches(sourceOrigin) ||
                message.type != WebMessageCompat.TYPE_STRING
            ) {
                return@addWebMessageListener
            }
            val data = message.data ?: return@addWebMessageListener
            if (data.toByteArray(StandardCharsets.UTF_8).size > OWNED_WEB_MESSAGE_LIMIT_BYTES) {
                return@addWebMessageListener
            }
            onMessage(
                OwnedWebMessage(
                    data = data,
                    replyProxy = replyProxy,
                    documentGeneration = documentGeneration.get(),
                )
            )
        }
        installed = true
        return true
    }

    fun onDocumentStarted(): Long = documentGeneration.incrementAndGet()

    fun currentDocumentGeneration(): Long = documentGeneration.get()

    fun close() {
        documentGeneration.incrementAndGet()
        if (
            installed &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) {
            WebViewCompat.removeWebMessageListener(webView, objectName)
        }
        installed = false
    }
}

internal fun strictJsonObject(raw: String): JSONObject {
    require(raw.toByteArray(StandardCharsets.UTF_8).size <= OWNED_WEB_MESSAGE_LIMIT_BYTES)
    try {
        JsonReader.of(Buffer().writeUtf8(raw)).use { reader ->
            reader.isLenient = false
            require(reader.peek() == JsonReader.Token.BEGIN_OBJECT)
            validateStrictJsonValue(reader, 0)
            require(reader.peek() == JsonReader.Token.END_DOCUMENT)
        }
    } catch (error: Exception) {
        throw IllegalArgumentException("invalid strict JSON", error)
    }
    return try {
        JSONObject(raw)
    } catch (error: JSONException) {
        throw IllegalArgumentException("invalid JSON object", error)
    }
}

private fun validateStrictJsonValue(reader: JsonReader, depth: Int) {
    require(depth <= MAX_JSON_DEPTH)
    when (reader.peek()) {
        JsonReader.Token.BEGIN_OBJECT -> {
            reader.beginObject()
            val keys = mutableSetOf<String>()
            while (reader.hasNext()) {
                require(keys.add(reader.nextName()))
                validateStrictJsonValue(reader, depth + 1)
            }
            reader.endObject()
        }
        JsonReader.Token.BEGIN_ARRAY -> {
            reader.beginArray()
            while (reader.hasNext()) {
                validateStrictJsonValue(reader, depth + 1)
            }
            reader.endArray()
        }
        JsonReader.Token.STRING, JsonReader.Token.NUMBER -> reader.nextString()
        JsonReader.Token.BOOLEAN -> reader.nextBoolean()
        JsonReader.Token.NULL -> reader.nextNull<Unit>()
        JsonReader.Token.END_ARRAY,
        JsonReader.Token.END_OBJECT,
        JsonReader.Token.NAME,
        JsonReader.Token.END_DOCUMENT,
        -> error("invalid JSON value")
    }
}

internal fun JSONObject.requireExactKeys(vararg expected: String) {
    val actual = keys().asSequence().toSet()
    require(actual == expected.toSet()) {
        "expected keys ${expected.toSet()}, found $actual"
    }
}

internal fun JSONObject.requireObject(key: String): JSONObject =
    get(key) as? JSONObject ?: error("$key must be an object")

internal fun JSONObject.requireArray(key: String, maximum: Int): JSONArray {
    val value = get(key) as? JSONArray ?: error("$key must be an array")
    require(value.length() <= maximum)
    return value
}

internal fun JSONObject.requireBoundedString(
    key: String,
    minimum: Int,
    maximum: Int,
): String {
    val value = get(key) as? String ?: error("$key must be a string")
    require(value.codePointCount(0, value.length) in minimum..maximum)
    return value
}

internal fun JSONObject.requireCanonicalUuid(key: String): UUID {
    val raw = requireBoundedString(key, 36, 36)
    val parsed = UUID.fromString(raw)
    require(
        parsed.toString() == raw &&
            parsed.variant() == 2 &&
            parsed.version() in 1..8
    )
    return parsed
}

internal fun JSONObject.requireLong(key: String, minimum: Long, maximum: Long): Long {
    val value = when (val raw = get(key)) {
        is Int -> raw.toLong()
        is Long -> raw
        else -> error("$key must be an integer")
    }
    require(value in minimum..maximum)
    return value
}

internal fun JSONObject.requireFiniteDouble(
    key: String,
    minimum: Double,
    maximum: Double,
): Double {
    val value = when (val raw = get(key)) {
        is Number -> raw.toDouble()
        else -> error("$key must be a number")
    }
    require(value.isFinite() && value in minimum..maximum)
    return value
}

internal fun JSONObject.requireBoolean(key: String): Boolean =
    get(key) as? Boolean ?: error("$key must be a boolean")
