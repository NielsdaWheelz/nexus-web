package app.nexus.android.offline

import android.os.Looper
import android.net.Uri
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.DeviceSession
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import app.nexus.android.webkit.OwnedOrigin
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

private val KINDS = setOf(AUDIO, "pdf", "epub", "web_article")

/**
 * `window.nexusDownloads` on the hosted and shelf origins: json request/reply
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
        fun chooseWritingExport(complete: (Uri?) -> Unit): Boolean
    }

    private val context = webView.context.applicationContext
    private val framing = OwnedOriginWebMessage(
        webView,
        "nexusDownloads",
        setOf(BuildConfig.NEXUS_BASE_URL, SHELF_ORIGIN),
        ::onMessage,
    )
    private var subscriber: JavaScriptReplyProxy? = null
    private val leases = mutableListOf<UUID>()
    private val hostedOrigin = OwnedOrigin(BuildConfig.NEXUS_BASE_URL)
    private val writingExport = WritingExport(webView)
    private data class ExportSession(val id: UUID, val account: UUID, val generation: Long)
    private var exportSession: ExportSession? = null
    private var exportPendingReply: (() -> Unit)? = null

    // a change made by an op on the main thread is pushed before that op's reply
    private val unsubscribe = store.addListener {
        val changed = {
            if (exportSession?.account != null && exportSession?.account != store.account) cancelExport()
            push()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) changed() else webView.post { changed() }
    }

    fun install(): Boolean = framing.install()

    /** A new document: drop the subscriber and close every lease the old one opened. */
    fun onPageStarted() {
        framing.onDocumentStarted()
        subscriber = null
        leases.forEach(store::close)
        leases.clear()
        cancelExport()
    }

    fun close() {
        unsubscribe()
        onPageStarted()
        writingExport.close()
        framing.close()
    }

    private fun push() {
        subscriber?.postMessage(JSONObject().put("snapshot", store.snapshot()).toString())
    }

    private fun onMessage(message: OwnedWebMessage) {
        if (message.documentGeneration != framing.currentDocumentGeneration()) return
        var id: Any = JSONObject.NULL
        var exporting = false
        val reply = try {
            val request = JSONObject(message.data)
            id = request.opt("id") ?: JSONObject.NULL
            if (request.getString("op") in setOf("exportStart", "exportChunk", "exportFinish", "exportCancel")) {
                exporting = true
                export(request, message, id)
                return
            }
            dispatch(request, message.replyProxy)
        } catch (_: JSONException) {
            // justify-ignore-error: a malformed frame is answered, not acted on.
            if (exporting) cancelExport()
            failure("Invalid")
        } catch (_: IllegalArgumentException) {
            // justify-ignore-error: as above, for a bad id, kind, policy or choice.
            if (exporting) cancelExport()
            failure("Invalid")
        } catch (_: IOException) {
            // justify-ignore-error: the state file could not be written; the op is refused.
            if (exporting) cancelExport()
            failure("Storage")
        }
        message.replyProxy.postMessage(reply.put("id", id).toString())
    }

    private fun dispatch(request: JSONObject, replyProxy: JavaScriptReplyProxy): JSONObject {
        val session = DeviceSession.get(context)
        if (session.accountId() == null || session.accountId() != store.account) return failure("NotConnected")
        when (request.getString("op")) {
            "hello" -> {
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
                val error = store.save(mediaId(request), request.getJSONObject("locator"), request.getLong("baseRevision"),
                    request.getLong("expectedReaderGeneration"), request.getBoolean("adoptUnresolved"))
                if (error != null) return failure(error)
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

    private fun cancelExport() {
        val cancelled = exportPendingReply
        exportPendingReply = null
        exportSession = null
        writingExport.cancel()
        cancelled?.invoke()
    }

    private fun export(request: JSONObject, message: OwnedWebMessage, requestId: Any) {
        fun reply(value: JSONObject) = message.replyProxy.postMessage(value.put("id", requestId).toString())
        if (!hostedOrigin.matches(message.sourceOrigin)) {
            reply(failure("Unsupported"))
            return
        }
        val op = request.getString("op")
        if (op == "exportStart") {
            val account = UUID.fromString(request.getString("account_id"))
            if (account != store.account) {
                reply(failure("AuthorizationRequired"))
                return
            }
            if (exportSession != null) {
                reply(failure("Busy"))
                return
            }
            val session = ExportSession(UUID.randomUUID(), account, message.documentGeneration)
            exportSession = session
            exportPendingReply = {
                if (session.generation == framing.currentDocumentGeneration()) reply(failure("Cancelled"))
            }
            val accepted = host.chooseWritingExport { uri ->
                if (!currentExport(session)) return@chooseWritingExport
                if (uri == null) {
                    exportPendingReply = null
                    cancelExport()
                    reply(failure("Cancelled"))
                } else writingExport.open(uri) { error ->
                    if (currentExport(session)) {
                        exportPendingReply = null
                        if (error != null) {
                            cancelExport()
                            reply(failure(error))
                        } else reply(JSONObject().put("ok", true).put("export_id", session.id.toString()))
                    }
                }
            }
            if (!accepted) {
                exportPendingReply = null
                cancelExport()
                reply(failure("Busy"))
            }
            return
        }
        val session = exportSession
        if (session == null || !currentExport(session) || UUID.fromString(request.getString("export_id")) != session.id) {
            reply(failure("Cancelled"))
            return
        }
        if (op != "exportCancel" && exportPendingReply != null) {
            reply(failure("Busy"))
            return
        }
        val complete: (String?) -> Unit = { error ->
            if (currentExport(session)) {
                exportPendingReply = null
                if (error != null || op == "exportFinish") cancelExport()
                reply(if (error == null) JSONObject().put("ok", true) else failure(error))
            }
        }
        val cancelled: () -> Unit = {
            if (session.generation == framing.currentDocumentGeneration()) reply(failure("Cancelled"))
        }
        when (op) {
            "exportChunk" -> {
                val encoded = request.getString("data")
                require(encoded.length <= 32 * 1024 && encoded.matches(Regex("[A-Za-z0-9+/]*={0,2}")))
                val bytes = Base64.decode(encoded, Base64.NO_WRAP)
                require(bytes.size <= 24 * 1024)
                val index = request.getInt("index")
                exportPendingReply = cancelled
                writingExport.chunk(index, bytes, complete)
            }
            "exportFinish" -> {
                val chunks = request.getInt("chunk_count")
                exportPendingReply = cancelled
                writingExport.finish(chunks, complete)
            }
            "exportCancel" -> {
                cancelExport()
                reply(JSONObject().put("ok", true))
            }
        }
    }

    private fun currentExport(session: ExportSession): Boolean =
        exportSession === session && session.account == store.account &&
            session.generation == framing.currentDocumentGeneration()

    private fun failure(code: String): JSONObject = JSONObject().put("ok", false).put("error", code)
}
