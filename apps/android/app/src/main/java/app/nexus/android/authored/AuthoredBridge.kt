package app.nexus.android.authored

import android.net.Uri
import android.util.Base64
import android.webkit.WebView
import app.nexus.android.AppRouter
import app.nexus.android.BuildConfig
import app.nexus.android.DeviceSession
import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import app.nexus.android.NexusNetworkError
import app.nexus.android.offline.SHELF_ORIGIN
import app.nexus.android.offline.SHELF_URL
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** Closed authored operations only. Frames reuse 24-kib raw chunks; renderer
 * inputs never select an account, file, URL or SQL. Source mainframes and all
 * subframes are excluded. The native account authority fences every callback.
 * The process-wide preparation mutex spans the JS preparation and exact local
 * settlement. Retirement releases its document lease; an already admitted SQL
 * operation still finishes under the commands mutex before a new owner can read
 * its source clock. Main-thread adoption rechecks document generation. */
private class AuthoredStorageError(cause: java.io.IOException) : java.io.IOException("couldn’t prepare notes on this device", cause)

internal class AuthoredBridge(private val webView: WebView, private val session: DeviceSession) {
    private val context = webView.context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val framing = OwnedOriginWebMessage(webView, "nexusAuthored", setOf(BuildConfig.NEXUS_BASE_URL, SHELF_ORIGIN), ::message)
    private val router = AppRouter(context, session)
    private val origin = NexusOriginClient()
    private val requests = mutableMapOf<Long, Job>()
    private val uploads = mutableMapOf<String, Pair<Int, ByteArrayOutputStream>>()
    private val outputs = mutableMapOf<String, ByteArray>()
    private var snapshot: File? = null
    private var lease: String? = null
    private var hintJob: Job? = null
    private var hintOwner: Pair<OwnedWebMessage, UUID>? = null
    private var closed = false
    private var boundAccount: UUID? = null
    private val unsubscribeAccount = session.subscribe {
        if (!closed && boundAccount != null && boundAccount != session.accountId()) {
            onPageStarted()
            webView.loadUrl(BuildConfig.NEXUS_BASE_URL)
        }
    }
    private var foreground = false
    private var foregroundRevision = 0L
    fun setForeground(active: Boolean) {
        if (active) { foregroundOwner?.takeIf { it !== this }?.publishForeground(false); foregroundOwner = this }
        else if (foregroundOwner === this) foregroundOwner = null
        publishForeground(active)
    }
    private fun publishForeground(active: Boolean) {
        foreground = active; foregroundRevision++
        hintOwner?.first?.replyProxy?.postMessage(JSONObject().put("kind", "authored_foreground").put("active", active).put("revision", foregroundRevision.toString()).toString())
        if (active) startHints() else { hintJob?.cancel(); hintJob = null }
    }
    private fun startHints() {
        if (!foreground || hintJob?.isActive == true) return
        val (message, account) = hintOwner ?: return
        hintJob = scope.launch {
            var failures = 0
            while (isActive && current(message, account)) {
                try {
                    withContext(Dispatchers.IO) { origin.authoredHints(account) { webView.post { if (current(message, account)) message.replyProxy.postMessage(JSONObject().put("kind", "authored_hint").toString()) } } }
                    failures = 0
                } catch (error: kotlinx.coroutines.CancellationException) { throw error }
                catch (error: Exception) {
                    if (error is NexusOriginError && error.status in setOf(401, 403, 426)) return@launch
                    failures++
                }
                delay(if (failures == 0) 250 else minOf(30_000L, 1000L shl minOf(5, failures)) * (75..100).random() / 100)
            }
        }
    }
    fun install() = framing.install()
    fun onPageStarted() {
        for (request in requests.values.toList()) request.cancel()
        requests.clear()
        boundAccount = null
        hintJob?.cancel(); hintJob = null; hintOwner = null
        framing.onDocumentStarted(); uploads.clear(); outputs.clear()
        snapshot?.delete(); snapshot = null
        lease?.let { if (preparations.holdsLock(it)) preparations.unlock(it) }; lease = null
    }
    fun close() { setForeground(false); closed = true; unsubscribeAccount(); onPageStarted(); framing.close(); scope.cancel() }
    private fun admitted(): Boolean {
        val uri = Uri.parse(webView.url ?: return false)
        return router.isAppRoute(uri) || uri.buildUpon().fragment(null).build().toString() == SHELF_URL
    }
    private fun current(message: OwnedWebMessage, account: UUID): Boolean = message.documentGeneration == framing.currentDocumentGeneration() && session.accountId() == account
    private fun message(message: OwnedWebMessage) {
        if (!admitted() || message.documentGeneration != framing.currentDocumentGeneration()) return
        val account = session.accountId() ?: return
        if (boundAccount != null && boundAccount != account) return
        val frame = try { JSONObject(message.data) } catch (_: Exception) { return }
        val id = try { frame.getLong("id") } catch (_: Exception) { return }
        if (frame.optString("op") in setOf("cancel", "discard_transfer", "snapshot_cancel")) {
            when (frame.getString("op")) {
                "cancel" -> requests.remove(frame.getLong("target_id"))?.cancel()
                "discard_transfer" -> { val transfer = frame.getString("transfer_id"); uploads.remove(transfer); outputs.remove(transfer) }
                "snapshot_cancel" -> { snapshot?.delete(); snapshot = null }
            }
            message.replyProxy.postMessage(JSONObject().put("id", id).put("ok", true).put("result", JSONObject()).toString())
            return
        }
        lateinit var job: Job
        job = scope.launch(start = CoroutineStart.LAZY) {
            try {
            var remoteOperation = false
            val reply = try {
                val result = when (frame.getString("op")) {
                    "begin" -> {
                        val size = frame.getInt("byte_count"); require(size in 0..(16 * 1024 * 1024))
                        require(uploads.size < 8 && uploads.values.sumOf { it.first } + size <= 16 * 1024 * 1024)
                        uploads[frame.getString("transfer_id")] = size to ByteArrayOutputStream(); JSONObject()
                    }
                    "chunk" -> {
                        val bytes = Base64.decode(frame.getString("base64"), Base64.NO_WRAP)
                        require(bytes.size <= 24 * 1024)
                        val transfer = uploads[frame.getString("transfer_id")] ?: error("no authored upload")
                        val pending = transfer.second
                        require(frame.getInt("offset") == pending.size() && pending.size() + bytes.size <= transfer.first)
                        pending.write(bytes); JSONObject().put("next_offset", pending.size())
                    }
                    "invoke" -> {
                        val transfer = uploads[frame.getString("transfer_id")] ?: error("no authored upload")
                        val pending = transfer.second
                        require(pending.size() == transfer.first); uploads.remove(frame.getString("transfer_id"))
                        val request = JSONObject(pending.toString("UTF-8"))
                        val operation = request.getString("op")
                        remoteOperation = operation in setOf("register", "push", "pull", "snapshot")
                        val result = when (operation) {
                            "command_begin" -> {
                                val token = UUID.randomUUID().toString()
                                preparations.lock(token)
                                if (!current(message, account)) { preparations.unlock(token); error("retired authored document") }
                                lease = token
                                JSONObject().put("lease", token)
                            }
                            "command_end" -> { if (lease == request.getString("lease")) { lease?.let { if (preparations.holdsLock(it)) preparations.unlock(it) }; lease = null }; JSONObject() }
                            "snapshot" -> {
                                val file = withContext(Dispatchers.IO) {
                                    val staged = try { File.createTempFile("authored-snapshot-", ".ndjson", context.cacheDir) } catch (error: java.io.IOException) { throw AuthoredStorageError(error) }
                                    try {
                                        val fileOutput = try { staged.outputStream() } catch (error: java.io.IOException) { throw AuthoredStorageError(error) }
                                        val destination = object : java.io.OutputStream() {
                                            override fun write(value: Int) { try { fileOutput.write(value) } catch (error: java.io.IOException) { throw AuthoredStorageError(error) } }
                                            override fun write(bytes: ByteArray, offset: Int, count: Int) { try { fileOutput.write(bytes, offset, count) } catch (error: java.io.IOException) { throw AuthoredStorageError(error) } }
                                            override fun close() { try { fileOutput.close() } catch (error: java.io.IOException) { throw AuthoredStorageError(error) } }
                                        }
                                        destination.use { origin.authoredSnapshot(account, it) }; staged
                                    } catch (error: Exception) { staged.delete(); throw error }
                                }
                                if (!current(message, account)) { file.delete(); error("retired authored snapshot") }
                                snapshot?.delete(); snapshot = file
                                JSONObject().put("byte_count", file.length())
                            }
                            "register", "push", "pull" -> withContext(Dispatchers.IO) { dispatch(null, request, message, account) }
                            else -> commands.withLock {
                                require(current(message, account))
                                withContext(Dispatchers.IO) { dispatch(bound(context, account), request, message, account) }
                            }
                        }
                        require(current(message, account))
                        if (operation == "hello") { boundAccount = account; hintOwner = message to account; result.put("foreground", foreground).put("foreground_revision", foregroundRevision.toString()); startHints() }
                        val bytes = result.toString().toByteArray(Charsets.UTF_8)
                        require(bytes.size <= 16 * 1024 * 1024 && outputs.size < 8)
                        outputs[frame.getString("transfer_id")] = bytes
                        JSONObject().put("byte_count", bytes.size)
                    }
                    "read" -> {
                        val transferId = frame.getString("transfer_id")
                        val bytes = outputs[transferId] ?: error("no authored result")
                        val offset = frame.getInt("offset"); require(offset in 0..bytes.size)
                        val end = minOf(bytes.size, offset + 24 * 1024)
                        JSONObject().put("base64", Base64.encodeToString(bytes.copyOfRange(offset, end), Base64.NO_WRAP)).put("next_offset", end).also { if (end == bytes.size) outputs.remove(transferId) }
                    }
                    "snapshot_chunk" -> {
                        val file = snapshot ?: error("no authored snapshot")
                        val offset = frame.getLong("offset"); require(offset in 0..file.length())
                        val bytes = withContext(Dispatchers.IO) {
                            java.io.RandomAccessFile(file, "r").use { input -> input.seek(offset); ByteArray(minOf(24 * 1024L, file.length() - offset).toInt()).also { input.readFully(it) } }
                        }
                        require(current(message, account))
                        val done = offset + bytes.size == file.length()
                        JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("next_offset", offset + bytes.size).put("done", done).also { if (done && snapshot === file) { file.delete(); snapshot = null } }
                    }
                    else -> error("unknown authored frame")
                }
                JSONObject().put("ok", true).put("result", result)
            } catch (error: Exception) {
                JSONObject().put("ok", false).put("error", JSONObject().put("message", error.message ?: "couldn’t save on this device").put("code", if (error is AuthoredStorageError || error is androidx.sqlite.SQLiteException || error is java.io.IOException && !remoteOperation) "E_AUTHORED_LOCAL" else "E_AUTHORED").put("status", if (error is NexusOriginError) error.status else if (error is NexusNetworkError) { if (error.cause is java.io.InterruptedIOException) 504 else 0 } else 500))
            }
            if (current(message, account)) message.replyProxy.postMessage(reply.put("id", id).toString())
            } finally { if (requests[id] === job) requests.remove(id) }
        }
        requests[id] = job; job.start()
    }
    private suspend fun dispatch(store: AuthoredStore?, request: JSONObject, message: OwnedWebMessage, account: UUID): JSONObject {
        require(current(message, account))
        return when (request.getString("op")) {
            "hello", "replica" -> store!!.replica()
            "read_snapshot" -> store!!.readSnapshot(request.getJSONObject("selection"))
            "states" -> store!!.states(request.getJSONObject("selection"))
            "query" -> store!!.query(request.getJSONObject("query"), request.getJSONArray("params"), request.getString("plan_key"))
            "commit" -> { require(lease != null && lease == request.getString("lease") && preparations.holdsLock(lease!!)); store!!.commit(request.getJSONObject("frame")) }
            "uploaded" -> JSONObject().put("uploaded", store!!.uploaded(request.getString("command_seq")))
            "pending" -> JSONObject().put("changes", store!!.pending())
            "acknowledge" -> { store!!.acknowledge(request.getString("sequence")); JSONObject() }
            "apply_remote" -> store!!.applyRemote(request)
            "reset_provisioning" -> { store!!.resetProvisioning(); JSONObject() }
            "stage" -> { store!!.stage(request.getJSONObject("states")); JSONObject() }
            "finish_provisioning" -> { store!!.finishProvisioning(request.getString("cursor"), request.getJSONObject("counts"), request.getString("lamport")); JSONObject() }
            "register" -> JSONObject().put("data", origin.authoredRegister(account, request.getJSONObject("body")))
            "push" -> JSONObject().put("data", origin.authoredPush(account, request.getJSONObject("body")))
            "pull" -> JSONObject().put("data", origin.authoredPull(account, request.getString("after")))
            else -> error("unknown authored operation")
        }
    }
    companion object {
        private var foregroundOwner: AuthoredBridge? = null
        private val preparations = Mutex()
        private val commands = Mutex()
        private var store: AuthoredStore? = null
        private fun bound(context: android.content.Context, account: UUID): AuthoredStore {
            val current = store
            if (current?.account == account) return current
            current?.close()
            return AuthoredStore(context, account).also { store = it }
        }
        suspend fun requireDrained(context: android.content.Context, account: UUID) = commands.withLock {
            withContext(Dispatchers.IO) {
                if (context.filesDir.resolve("authored/$account.sqlite3").exists() && bound(context, account).pending().length() > 0) throw app.nexus.android.LocalStateError("E_AUTHORED_PENDING", "sync your notes or deliberately discard them before signing out")
            }
        }
        suspend fun purge(context: android.content.Context) = commands.withLock {
            withContext(Dispatchers.IO) {
                store?.close(); store = null
                context.cacheDir.listFiles { file -> file.name.startsWith("authored-snapshot-") }?.forEach { file -> if (!file.delete()) throw java.io.IOException("authored snapshot staging data could not be removed") }
                val directory = context.filesDir.resolve("authored")
                if (directory.exists() && !directory.deleteRecursively()) throw java.io.IOException("authored account data could not be removed")
            }
        }
    }
}
