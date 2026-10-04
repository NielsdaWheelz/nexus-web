package app.nexus.android.offline

import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

private val KINDS = setOf(AUDIO, "pdf", "epub", "web_article")

/**
 * `window.nexusOffline` on the hosted and shelf origins: json request/reply
 * frames plus a snapshot push to the document that last said hello. The object
 * name is the compatibility identity; there is no protocol version.
 */
internal class OfflineBridge(
    private val webView: WebView,
    private val store: OfflineStore,
    private val host: Host,
) {
    interface Host {
        fun showDownloads()
        fun openHosted(path: String)
        fun requestNotificationPermission()
    }

    private val context = webView.context.applicationContext
    private val framing = OwnedOriginWebMessage(
        webView,
        "nexusOffline",
        setOf(BuildConfig.NEXUS_BASE_URL, SHELF_ORIGIN),
        ::onMessage,
    )
    private var subscriber: JavaScriptReplyProxy? = null
    private val leases = mutableListOf<UUID>()

    // a change made by an op on the main thread is pushed before that op's reply
    private val unsubscribe = store.addListener {
        if (Looper.myLooper() == Looper.getMainLooper()) push() else webView.post { push() }
    }

    fun install(): Boolean = framing.install()

    /** A new document: drop the subscriber and close every lease the old one opened. */
    fun onPageStarted() {
        framing.onDocumentStarted()
        subscriber = null
        leases.forEach(store::close)
        leases.clear()
    }

    fun close() {
        unsubscribe()
        onPageStarted()
        framing.close()
    }

    private fun push() {
        subscriber?.postMessage(JSONObject().put("snapshot", store.snapshot()).toString())
    }

    private fun onMessage(message: OwnedWebMessage) {
        if (message.documentGeneration != framing.currentDocumentGeneration()) return
        var id: Any = JSONObject.NULL
        val reply = try {
            val request = JSONObject(message.data)
            id = request.opt("id") ?: JSONObject.NULL
            dispatch(request, message.replyProxy)
        } catch (_: JSONException) {
            // justify-ignore-error: a malformed frame is answered, not acted on.
            failure("Invalid")
        } catch (_: IllegalArgumentException) {
            // justify-ignore-error: as above, for a bad id, kind, policy or choice.
            failure("Invalid")
        } catch (_: IOException) {
            // justify-ignore-error: the state file could not be written; the op is refused.
            failure("Storage")
        }
        message.replyProxy.postMessage(reply.put("id", id).toString())
    }

    private fun dispatch(request: JSONObject, replyProxy: JavaScriptReplyProxy): JSONObject {
        when (request.getString("op")) {
            "hello" -> {
                request.string("accountId")?.let { store.bind(UUID.fromString(it)) }
                subscriber = replyProxy
                OfflineJobs.scheduleSync(context, 0)
                return JSONObject().put("ok", true).put("snapshot", store.snapshot())
            }
            "enqueue" -> {
                val kind = request.getString("kind")
                require(kind in KINDS)
                store.enqueue(mediaId(request), kind, request.getString("title"), request.string("url"))
                    ?.let { return failure(it) }
                host.requestNotificationPermission()
                OfflineJobs.schedule(context)
            }
            "cancel", "remove" -> if (!store.remove(mediaId(request))) return failure("NotFound")
            "retry" -> {
                if (!store.retry(mediaId(request))) return failure("NotFound")
                OfflineJobs.schedule(context)
            }
            "policy" -> {
                store.policy = Policy.valueOf(request.getString("value"))
                OfflineJobs.schedule(context, replace = true)
            }
            "open" -> {
                val mediaId = mediaId(request)
                if (!store.open(mediaId)) return failure("NotFound")
                leases += mediaId
            }
            "close" -> {
                val mediaId = mediaId(request)
                if (leases.remove(mediaId)) store.close(mediaId)
            }
            "save" -> {
                if (!store.save(mediaId(request), request.getJSONObject("locator"))) return failure("NotFound")
                OfflineJobs.scheduleSync(context, 10_000)
            }
            "resolve" -> {
                val keepDevice = when (request.getString("choice")) {
                    "Device" -> true
                    "Canonical" -> false
                    else -> throw IllegalArgumentException("choice")
                }
                if (!store.resolve(mediaId(request), keepDevice)) return failure("NotFound")
                if (keepDevice) OfflineJobs.scheduleSync(context, 0)
            }
            "showDownloads" -> host.showDownloads()
            "openHosted" -> {
                val path = request.getString("path")
                require(path.startsWith("/") && !path.startsWith("//"))
                host.openHosted(path)
            }
            "purge" -> store.purge()
            else -> return failure("Invalid")
        }
        return JSONObject().put("ok", true)
    }

    private fun mediaId(request: JSONObject): UUID = UUID.fromString(request.getString("mediaId"))

    private fun failure(code: String): JSONObject = JSONObject().put("ok", false).put("error", code)
}
