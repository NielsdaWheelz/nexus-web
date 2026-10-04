package app.nexus.android.offline

import android.content.Context
import android.os.SystemClock
import androidx.core.util.AtomicFile
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

internal enum class Policy { UnmeteredOnly, AnyConnected }

/** One run of one item's transfer. A cancel, stop or wipe makes it stale. */
internal class Transfer(val mediaId: UUID, val kind: String, val url: String?, val staging: File)

/** A Ready copy's position to carry to nexus; `device == null` only refreshes the baseline. */
internal class SyncItem(val mediaId: UUID, val generation: Long, val baseRevision: Long, val device: JSONObject?)

internal const val AUDIO = "podcast_episode"
internal const val RESERVE_BYTES = 512L * 1024 * 1024
private const val MAX_RETRIES = 3
private const val PROGRESS_INTERVAL_MS = 500L

private class Item(
    val mediaId: UUID,
    val kind: String,
    val title: String,
    val url: String?,
    var state: String,
    var failure: String? = null,
    var attempts: Int = 0,
    var sizeBytes: Long = 0,
    var savedAt: String? = null,
    var generation: Long = 0,
    var baseline: JSONObject? = null,
    var device: JSONObject? = null,
    // null = synced, else Pending | Conflict | ContentChanged | SourceUnavailable
    var position: String? = null,
) {
    var received = 0L
    var total: Long? = null
}

/**
 * The single owner of offline state on this device: one account, one policy and
 * the download list, persisted whole in `files/offline/state.json` on every
 * mutation, with content under `files/offline/items/{mediaId}/`.
 */
internal class OfflineStore private constructor(private val filesDir: File) {
    companion object {
        @Volatile private var instance: OfflineStore? = null

        fun get(context: Context): OfflineStore =
            instance ?: synchronized(this) {
                instance ?: OfflineStore(context.applicationContext.filesDir).also { instance = it }
            }
    }

    private val root = File(filesDir, "offline")
    private val lock = Any()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val items = LinkedHashMap<UUID, Item>()
    private val leases = HashMap<UUID, Int>()
    private var active: Transfer? = null
    private var lastProgressNotice = 0L
    private var policyValue = Policy.UnmeteredOnly

    @Volatile var account: UUID? = null
        private set

    @Volatile var authRequired = false
        private set

    init {
        filesDir.listFiles { file -> file.name.startsWith("offline-trash-") }?.forEach(::deleteInBackground)
        val text = try {
            String(AtomicFile(stateFile()).readFully())
        } catch (_: FileNotFoundException) {
            // justify-ignore-error: no state file is the empty store.
            null
        }
        if (text != null) {
            try {
                load(JSONObject(text))
            } catch (_: JSONException) {
                // justify-ignore-error: an unreadable state file is the hard
                // cutover's one rule: everything offline is wiped.
                wipe()
            } catch (_: IllegalArgumentException) {
                // justify-ignore-error: as above, for an unreadable id or policy.
                wipe()
            }
        }
        recover()
    }

    // observation

    fun snapshot(): JSONObject = synchronized(lock) {
        JSONObject()
            .put("policy", policyValue.name)
            .put("authRequired", authRequired)
            .put("items", JSONArray(items.values.map { view(it) }))
    }

    fun addListener(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    // identity

    fun bind(accountId: UUID) {
        synchronized(lock) {
            authRequired = false
            if (account != accountId) {
                wipe()
                account = accountId
                persist()
            }
        }
        changed()
    }

    fun purge() {
        synchronized(lock) {
            wipe()
            persist()
        }
        changed()
    }

    /** I12 for `account`; a conclusion about an account that is no longer bound is dropped. */
    fun requireAuth(account: UUID) {
        synchronized(lock) {
            if (this.account != account || authRequired) return
            authRequired = true
        }
        changed()
    }

    // user commands

    /** null when queued or already present, else "Storage" | "Unsupported". */
    fun enqueue(mediaId: UUID, kind: String, title: String, url: String?): String? {
        synchronized(lock) {
            if (items.containsKey(mediaId)) return null
            // the transfer's own parser decides: an enclosure OkHttp cannot parse is never queued
            if (kind == AUDIO && url?.toHttpUrlOrNull()?.isHttps != true) return "Unsupported"
            if (filesDir.usableSpace < RESERVE_BYTES) return "Storage"
            items[mediaId] = Item(mediaId, kind, title, url, "Queued")
            persist()
        }
        changed()
        return null
    }

    /** Cancel and remove: a leased copy waits in Removing for its last close. */
    fun remove(mediaId: UUID): Boolean {
        synchronized(lock) {
            val item = items[mediaId] ?: return false
            if (active?.mediaId == mediaId) active = null
            if ((leases[mediaId] ?: 0) > 0) item.state = "Removing" else delete(item)
            persist()
        }
        changed()
        return true
    }

    fun retry(mediaId: UUID): Boolean {
        synchronized(lock) {
            val item = items[mediaId] ?: return false
            if (item.state != "Failed") return true
            item.state = "Queued"
            item.failure = null
            item.attempts = 0
            persist()
        }
        changed()
        return true
    }

    var policy: Policy
        get() = synchronized(lock) { policyValue }
        set(value) {
            synchronized(lock) {
                policyValue = value
                persist()
            }
            changed()
        }

    fun hasQueued(): Boolean = synchronized(lock) { items.values.any { it.state == "Queued" } }

    // readers and player

    fun open(mediaId: UUID): Boolean {
        synchronized(lock) {
            if (items[mediaId]?.state != "Ready") return false
            leases[mediaId] = (leases[mediaId] ?: 0) + 1
            return true
        }
    }

    fun close(mediaId: UUID) {
        synchronized(lock) {
            val count = leases[mediaId] ?: return
            if (count > 1) {
                leases[mediaId] = count - 1
                return
            }
            leases.remove(mediaId)
            val item = items[mediaId]?.takeIf { it.state == "Removing" } ?: return
            delete(item)
            try {
                persist()
            } catch (_: IOException) {
                // justify-ignore-error: the files are gone; startup recovery
                // finishes a Removing item that the state file still lists.
            }
        }
        changed()
    }

    fun audioFile(mediaId: UUID): File? {
        synchronized(lock) {
            val item = items[mediaId] ?: return null
            return File(itemDir(mediaId), "audio").takeIf { item.kind == AUDIO && item.state in LIVE }
        }
    }

    /** A file of a Ready or Removing reading copy, confined to the copy's directory. */
    fun copyFile(mediaId: UUID, path: String): File? {
        synchronized(lock) {
            val item = items[mediaId] ?: return null
            if (item.kind == AUDIO || item.state !in LIVE) return null
        }
        val dir = itemDir(mediaId).canonicalFile
        return File(dir, path).canonicalFile.takeIf { it.path.startsWith(dir.path + File.separator) && it.isFile }
    }

    fun isReadyCopy(mediaId: UUID): Boolean =
        synchronized(lock) { items[mediaId]?.let { it.kind != AUDIO && it.state == "Ready" } == true }

    /** Durable before it returns; false unless a Ready reading copy. */
    fun save(mediaId: UUID, locator: JSONObject): Boolean {
        synchronized(lock) {
            val item = items[mediaId]?.takeIf { it.kind != AUDIO && it.state == "Ready" } ?: return false
            item.device = locator
            if (item.position == null) item.position = "Pending"
            persist()
        }
        changed()
        return true
    }

    fun resolve(mediaId: UUID, keepDevice: Boolean): Boolean {
        synchronized(lock) {
            val item = items[mediaId]?.takeIf { it.position == "Conflict" } ?: return false
            if (keepDevice) {
                item.position = "Pending"
            } else {
                item.device = null
                item.position = null
            }
            persist()
        }
        changed()
        return true
    }

    // job-facing

    /**
     * The first Queued item not in `skip` → Downloading. A reading copy restarts
     * clean; an audio partial is kept to resume.
     */
    fun startNext(skip: Set<UUID>): Transfer? {
        val transfer = synchronized(lock) {
            val item = items.values.firstOrNull { it.state == "Queued" && it.mediaId !in skip } ?: return null
            val staging = File(root, "staging/${item.mediaId}")
            if (item.kind != AUDIO) staging.deleteRecursively()
            staging.mkdirs()
            item.state = "Downloading"
            item.received = 0
            item.total = null
            persist()
            Transfer(item.mediaId, item.kind, item.url, staging).also { active = it }
        }
        changed()
        return transfer
    }

    /** Memory only; false once the transfer is stale. Listeners hear at most every 500 ms. */
    fun progress(transfer: Transfer, received: Long, total: Long?): Boolean {
        val notice = synchronized(lock) {
            if (active !== transfer) return false
            val item = items.getValue(transfer.mediaId)
            item.received = received
            item.total = total
            val now = SystemClock.elapsedRealtime()
            (now - lastProgressNotice >= PROGRESS_INTERVAL_MS).also { if (it) lastProgressNotice = now }
        }
        if (notice) changed()
        return true
    }

    fun publish(transfer: Transfer, generation: Long, baseline: JSONObject?) {
        synchronized(lock) {
            if (!settleStale(transfer)) return
            val item = items.getValue(transfer.mediaId)
            val dir = itemDir(transfer.mediaId)
            dir.deleteRecursively()
            dir.parentFile?.mkdirs()
            if (transfer.staging.renameTo(dir)) {
                item.state = "Ready"
                item.failure = null
                item.attempts = 0
                item.sizeBytes = dir.walk().filter { it.isFile }.sumOf { it.length() }
                item.savedAt = Instant.now().toString()
                item.generation = generation
                item.baseline = baseline
            } else {
                item.state = "Failed"
                item.failure = "Storage"
            }
            persist()
        }
        changed()
    }

    /** true when the item went back to Queued for a later attempt. */
    fun fail(transfer: Transfer, reason: String, retryable: Boolean): Boolean {
        val requeued = synchronized(lock) {
            if (!settleStale(transfer)) return false
            if (reason == "AuthorizationRequired") authRequired = true
            val item = items.getValue(transfer.mediaId)
            val requeue = retryable && item.attempts < MAX_RETRIES
            if (requeue) {
                item.attempts += 1
                item.state = "Queued"
            } else {
                item.state = "Failed"
                item.failure = reason
                // an audio partial outlives a failure so Retry resumes it; bytes known to be wrong do not
                if (item.kind != AUDIO || reason == "Invalid") transfer.staging.deleteRecursively()
            }
            persist()
            requeue
        }
        changed()
        return requeued
    }

    /** onStopJob: the system requeues the active transfer; the user stops every pending one. */
    fun stopActive(byUser: Boolean) {
        synchronized(lock) {
            val transfer = active ?: return
            active = null
            if (byUser) {
                for (item in items.values) {
                    if (item.state != "Queued" && item.mediaId != transfer.mediaId) continue
                    item.state = "Failed"
                    item.failure = "Stopped"
                }
            } else {
                items[transfer.mediaId]?.state = "Queued"
            }
            persist()
        }
        changed()
    }

    fun syncItems(): List<SyncItem> = synchronized(lock) {
        items.values
            .filter { it.kind != AUDIO && it.state == "Ready" && it.position in SYNCABLE }
            .map { SyncItem(it.mediaId, it.generation, it.baseline!!.getLong("revision"), it.device) }
    }

    /**
     * baseline := snapshot; the device position clears only if it is still what was sent.
     * A refresh (`sent == null`) never moves the baseline under an open copy: its reader
     * started from that revision, so its next save must CAS against it (I10).
     */
    fun synced(mediaId: UUID, sent: JSONObject?, snapshot: JSONObject) {
        synchronized(lock) {
            val item = items[mediaId]?.takeIf { it.state == "Ready" } ?: return
            if (sent == null) {
                if (item.position != null || mediaId in leases || item.baseline.toString() == snapshot.toString()) return
            } else if (item.device == null) {
                return
            } else if (item.device.toString() == sent.toString()) {
                item.device = null
                item.position = null
            } else {
                item.position = "Pending"
            }
            item.baseline = snapshot
            persist()
        }
        changed()
    }

    fun conflicted(mediaId: UUID, canonical: JSONObject) {
        synchronized(lock) {
            val item = items[mediaId]?.takeIf { it.state == "Ready" && it.device != null } ?: return
            item.baseline = canonical
            item.position = "Conflict"
            persist()
        }
        changed()
    }

    /** "ContentChanged" | "SourceUnavailable" */
    fun markPosition(mediaId: UUID, state: String) {
        synchronized(lock) {
            val item = items[mediaId]?.takeIf { it.state == "Ready" && it.device != null } ?: return
            item.position = state
            persist()
        }
        changed()
    }

    // hidden

    private fun stateFile() = File(root, "state.json")

    private fun itemDir(mediaId: UUID) = File(root, "items/$mediaId")

    /** Clears the active token; a stale transfer only drops its staging when its item is gone. */
    private fun settleStale(transfer: Transfer): Boolean {
        if (active === transfer) {
            active = null
            return true
        }
        if (!items.containsKey(transfer.mediaId)) transfer.staging.deleteRecursively()
        return false
    }

    private fun delete(item: Item) {
        items.remove(item.mediaId)
        itemDir(item.mediaId).deleteRecursively()
        File(root, "staging/${item.mediaId}").deleteRecursively()
    }

    /** O(1): rename the tree away, delete it in the background; startup sweeps leftovers. */
    private fun wipe() {
        items.clear()
        leases.clear()
        active = null
        account = null
        if (!root.exists()) return
        val trash = File(filesDir, "offline-trash-${System.nanoTime()}")
        if (root.renameTo(trash)) deleteInBackground(trash) else root.deleteRecursively()
    }

    private fun deleteInBackground(dir: File) {
        thread(name = "nexus-offline-trash", isDaemon = true) { dir.deleteRecursively() }
    }

    /** Crash leftovers: Downloading → Queued, Removing finished, orphan files deleted; audio partials kept. */
    private fun recover() {
        var dirty = false
        for (item in items.values.toList()) {
            when (item.state) {
                "Downloading" -> item.state = "Queued"
                "Removing" -> delete(item)
                else -> continue
            }
            dirty = true
        }
        File(root, "items").listFiles()
            ?.filter { dir -> items.values.none { it.mediaId.toString() == dir.name && it.state in LIVE } }
            ?.forEach { it.deleteRecursively() }
        File(root, "staging").listFiles()
            ?.filter { dir ->
                items.values.none {
                    it.mediaId.toString() == dir.name && it.kind == AUDIO && (it.state == "Queued" || it.state == "Failed")
                }
            }
            ?.forEach { it.deleteRecursively() }
        if (dirty) persist()
    }

    private fun load(state: JSONObject) {
        account = state.string("account")?.let(UUID::fromString)
        policyValue = Policy.valueOf(state.getString("policy"))
        val list = state.getJSONArray("items")
        for (index in 0 until list.length()) {
            val json = list.getJSONObject(index)
            val item = Item(
                mediaId = UUID.fromString(json.getString("mediaId")),
                kind = json.getString("kind"),
                title = json.getString("title"),
                url = json.string("url"),
                state = json.getString("state"),
                failure = json.string("failure"),
                attempts = json.getInt("attempts"),
                sizeBytes = json.getLong("sizeBytes"),
                savedAt = json.string("savedAt"),
                generation = json.getLong("generation"),
                baseline = json.optJSONObject("baseline"),
                device = json.optJSONObject("device"),
                position = json.string("position"),
            )
            items[item.mediaId] = item
        }
    }

    private fun persist() {
        val state = JSONObject()
            .put("account", account?.toString().orNull())
            .put("policy", policyValue.name)
            .put(
                "items",
                JSONArray(
                    items.values.map {
                        JSONObject()
                            .put("mediaId", it.mediaId.toString())
                            .put("kind", it.kind)
                            .put("title", it.title)
                            .put("url", it.url.orNull())
                            .put("state", it.state)
                            .put("failure", it.failure.orNull())
                            .put("attempts", it.attempts)
                            .put("sizeBytes", it.sizeBytes)
                            .put("savedAt", it.savedAt.orNull())
                            .put("generation", it.generation)
                            .put("baseline", it.baseline.orNull())
                            .put("device", it.device.orNull())
                            .put("position", it.position.orNull())
                    },
                ),
            )
        root.mkdirs()
        val file = AtomicFile(stateFile())
        val out = file.startWrite()
        try {
            out.write(state.toString().toByteArray())
            file.finishWrite(out)
        } catch (error: IOException) {
            file.failWrite(out)
            throw error
        }
    }

    private fun view(item: Item): JSONObject {
        val baseline = item.baseline
        val progress = if (item.kind == AUDIO || item.state != "Ready" || baseline == null) {
            JSONObject.NULL
        } else {
            when (item.position) {
                null -> JSONObject().put("kind", "Canonical").put("snapshot", baseline)
                "Conflict" -> JSONObject().put("kind", "Conflict").put("canonical", baseline).put("device", item.device)
                else -> JSONObject().put("kind", item.position).put("baseline", baseline).put("device", item.device)
            }
        }
        return JSONObject()
            .put("mediaId", item.mediaId.toString())
            .put("kind", item.kind)
            .put("title", item.title)
            .put("state", item.state)
            .put("failure", item.failure.orNull())
            .put("attempts", item.attempts)
            .put("received", item.received)
            .put("total", item.total.orNull())
            .put("sizeBytes", item.sizeBytes)
            .put("savedAt", item.savedAt.orNull())
            .put("progress", progress)
    }

    private fun changed() = listeners.forEach { it() }
}

private val LIVE = setOf("Ready", "Removing")
private val SYNCABLE = setOf(null, "Pending", "SourceUnavailable")

private fun Any?.orNull(): Any = this ?: JSONObject.NULL

internal fun JSONObject.string(key: String): String? = if (isNull(key)) null else getString(key)
