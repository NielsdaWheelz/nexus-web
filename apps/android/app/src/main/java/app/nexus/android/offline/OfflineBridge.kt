package app.nexus.android.offline

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.DeviceSession
import app.nexus.android.LocalStateError
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

/**
 * nexusLocalContent carries bounded commands and revision invalidations, never
 * documents or the download index. Intent/state commits run on IO. The exact
 * account/document owns each result; push precedes its causal receipt.
 */
internal class OfflineBridge(
    private val webView: WebView,
    private val store: OfflineStore,
    private val host: Host,
) {
    interface Host {
        fun openReader(mediaId: UUID)
        fun openHosted(path: String)
        fun requestNotificationPermission()
    }

    private val context = webView.context.applicationContext
    private val framing = OwnedOriginWebMessage(webView, "nexusLocalContent",
        setOf(BuildConfig.NEXUS_BASE_URL, SHELF_ORIGIN), ::onMessage)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val commands = Mutex()
    private var subscriber: JavaScriptReplyProxy? = null
    private var subscriberAccount: UUID? = null
    private val leases = java.util.concurrent.ConcurrentHashMap<Pair<Long, UUID>, AutoCloseable>()
    private val unsubscribe = store.addListener { webView.post {
        if (subscriberAccount != store.account || subscriberAccount != DeviceSession.current()?.accountId()) {
            subscriber = null; subscriberAccount = null
            leases.clear()
        } else push()
    } }
    private val unsubscribeDevice = DeviceSession.get(context).subscribe {
        if (subscriberAccount != DeviceSession.current()?.accountId()) {
            subscriber = null; subscriberAccount = null
            leases.clear()
        }
    }

    fun install(): Boolean = framing.install()

    fun onPageStarted() {
        framing.onDocumentStarted()
        subscriber = null; subscriberAccount = null
        val closed = leases.entries.toList()
        scope.launch { withContext(NonCancellable + Dispatchers.IO) { closed.forEach { closeRetiredLease(it.key, it.value) } } }
    }

    fun close() {
        unsubscribe(); unsubscribeDevice()
        onPageStarted()
        scope.cancel(); framing.close()
    }

    private fun push() {
        subscriber?.postMessage(JSONObject().put("revision", store.revision.toString()).toString())
    }

    private fun onMessage(message: OwnedWebMessage) {
        if (message.documentGeneration != framing.currentDocumentGeneration()) return
        var id: Any = JSONObject.NULL
        try {
            val request = JSONObject(message.data)
            id = request.get("id")
            require(id is String || id is Number)
            val op = request.text("op")
            validateFrame(request, op)
            val owner = DeviceSession.get(context).accountId()
            if (owner == null || op != "hello" && owner != store.account) {
                message.replyProxy.postMessage(failure("NotConnected").put("id", id).toString())
                return
            }
            val requestId = id
            scope.launch {
                commands.withLock {
                    if (!current(message, owner, op == "hello" || op == "purge")) return@withLock
                    val result = try {
                        if (op == "hello") {
                            subscriber = message.replyProxy; subscriberAccount = owner
                        }
                        withContext(Dispatchers.IO) { store.initialize(); dispatch(request, owner, message.documentGeneration) }
                    } catch (error: LocalStateError) { failure(error.code) }
                    catch (_: IOException) {
                        // justify-ignore-error: failed durable mutation grants no success receipt.
                        failure("Storage")
                    } catch (_: IllegalArgumentException) {
                        // justify-ignore-error: invalid semantic input is refused without mutation.
                        failure("Invalid")
                    } catch (_: JSONException) {
                        // justify-ignore-error: malformed command fields are refused.
                        failure("Invalid")
                    }
                    if (!current(message, owner, op == "hello" || op == "purge")) {
                        withContext(Dispatchers.IO) { retireLeases(message.documentGeneration) }
                        return@withLock
                    }
                    if (result.optBoolean("ok")) when (op) {
                        "enqueue" -> host.requestNotificationPermission()
                        "open_reader" -> host.openReader(mediaId(request))
                        "open_hosted" -> host.openHosted(request.text("path"))
                    }
                    push()
                    if (result.getBoolean("ok")) result.put("revision", store.revision.toString())
                    message.replyProxy.postMessage(result.put("id", requestId).toString())
                }
            }
        } catch (_: JSONException) {
            // justify-ignore-error: invalid framing never reaches a mutation.
            message.replyProxy.postMessage(failure("Invalid").put("id", id).toString())
        } catch (_: IllegalArgumentException) {
            // justify-ignore-error: as above, for a bad id, kind, policy or choice.
            message.replyProxy.postMessage(failure("Invalid").put("id", id).toString())
        }
    }

    private fun current(message: OwnedWebMessage, owner: UUID, detached: Boolean): Boolean =
        message.documentGeneration == framing.currentDocumentGeneration() &&
            (detached || owner == store.account) && owner == DeviceSession.current()?.accountId()

    private fun retireLeases(generation: Long) {
        leases.entries.filter { it.key.first == generation }.forEach { closeRetiredLease(it.key, it.value) }
    }

    private fun closeRetiredLease(key: Pair<Long, UUID>, lease: AutoCloseable) {
        try { lease.close(); leases.remove(key, lease) }
        catch (error: IOException) {
            // Keep the handle: the next document retirement can retry its durable close.
            android.util.Log.e("NexusDownloads", "reading-copy lease could not close", error)
        }
    }

    private fun dispatch(request: JSONObject, owner: UUID, generation: Long): JSONObject {
        val op = request.text("op")
        if (op == "hello") {
            if (owner == store.account) OfflineJobs.scheduleSync(context, 0)
            return JSONObject().put("ok", true)
        }
        val result = store.command(owner) {
            when (op) {
                "hello" -> Unit
                "enqueue" -> {
                    val subject = request.getJSONObject("subject")
                    val kind = if (subject.text("kind") == "Episode") AUDIO else subject.text("media_kind")
                    if (android.os.Build.VERSION.SDK_INT < 34) return@command failure("Unsupported")
                    store.enqueue(UUID.fromString(subject.text("media_id")), kind, subject.text("title"))?.let { return@command failure(it) }
                }
                "cancel", "remove" -> if (!store.remove(mediaId(request))) return@command failure("NotFound")
                "retry" -> if (!store.retry(mediaId(request))) return@command failure("NotFound")
                "retry_extras" -> if (!store.retryExtras(mediaId(request), UUID.fromString(request.text("package_id")))) return@command failure("NotFound")
                "policy" -> store.policy = Policy.valueOf(request.text("value"))
                "open_reader" -> if (!store.isReadyCopy(mediaId(request))) return@command failure("NotFound")
                "open" -> {
                    val mediaId = mediaId(request)
                    val key = generation to mediaId
                    if (!leases.containsKey(key)) leases[key] = store.openReadingCopy(mediaId) ?: return@command failure("NotFound")
                }
                "close" -> {
                    val key = generation to mediaId(request)
                    leases[key]?.let { lease -> lease.close(); leases.remove(key, lease) }
                }
                "save" -> {
                    val error = store.save(mediaId(request), request.getJSONObject("locator"), request.getLong("base_revision"),
                        request.getLong("expected_reader_generation"), request.getBoolean("adopt_unresolved"))
                    if (error != null) return@command failure(error)
                }
                "resolve" -> if (!store.resolve(mediaId(request), request.text("choice") == "Device")) return@command failure("NotFound")
                "open_hosted" -> Unit
                "purge" -> store.purge()
                else -> return@command failure("Invalid")
            }
            JSONObject().put("ok", true)
        }
        if (result.optBoolean("ok")) when (op) {
            "hello", "resolve" -> OfflineJobs.scheduleSync(context, 0)
            "save" -> OfflineJobs.scheduleSync(context, 10_000)
            "enqueue", "retry", "retry_extras", "policy" -> {
                if (!OfflineJobs.schedule(context, replace = op == "policy")) return failure("Scheduler")
            }
        }
        return result
    }

    private fun mediaId(request: JSONObject): UUID = UUID.fromString(request.text("media_id"))

    private fun validateFrame(request: JSONObject, op: String) {
        val fields = when (op) {
            "hello", "purge" -> emptySet()
            "enqueue" -> setOf("subject")
            "cancel", "retry", "remove", "open_reader", "open", "close" -> setOf("media_id")
            "retry_extras" -> setOf("media_id", "package_id")
            "policy" -> setOf("value")
            "save" -> setOf("media_id", "locator", "base_revision", "expected_reader_generation", "adopt_unresolved")
            "resolve" -> setOf("media_id", "choice")
            "open_hosted" -> setOf("path")
            else -> throw IllegalArgumentException("operation")
        }
        require(request.keys().asSequence().toSet() == fields + setOf("id", "op"))
        when (op) {
            "enqueue" -> {
                val subject = request.getJSONObject("subject")
                val kind = subject.text("kind")
                val keys = when (kind) {
                    "Episode" -> setOf("kind", "media_id", "title")
                    "ReadingCopy" -> setOf("kind", "media_id", "title", "media_kind")
                    else -> throw IllegalArgumentException("subject")
                }
                require(subject.keys().asSequence().toSet() == keys)
                UUID.fromString(subject.text("media_id")); subject.text("title")
                if (kind == "ReadingCopy") require(subject.text("media_kind") in setOf("pdf", "epub", "web_article"))
            }
            "open_hosted" -> require(request.text("path").startsWith("/") && !request.text("path").startsWith("//"))
            "policy" -> Policy.valueOf(request.text("value"))
            "resolve" -> require(request.text("choice") in setOf("Device", "Canonical"))
            "save" -> {
                require(request.get("adopt_unresolved") is Boolean)
                require(request.get("base_revision") is Number && request.get("expected_reader_generation") is Number)
            }
        }
    }

    private fun failure(code: String): JSONObject = JSONObject().put("ok", false).put("error", code)
}

private fun JSONObject.text(key: String): String = get(key).also { require(it is String) } as String
