package app.nexus.android.offline

import android.content.Context
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import androidx.core.util.AtomicFile
import app.nexus.android.DeviceSession
import app.nexus.android.LocalStateError
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

internal enum class Policy { UnmeteredOnly, AnyConnected }
internal const val AUDIO = "podcast_episode"
internal const val RESERVE_BYTES = 512L * 1024 * 1024
private const val MAX_RETRIES = 3
private const val MAX_INDEX_BYTES = 16 * 1024 * 1024
private const val MAX_ITEMS = 10_000
private const val PROGRESS_INTERVAL_MS = 500L

/** A package-specific operation; replacement, cancellation and account retirement invalidate it. */
internal class Transfer(
    val account: UUID,
    val mediaId: UUID,
    val kind: String,
    val packageId: UUID?,
    val capture: JSONObject?,
    val ready: Boolean,
    val staging: File,
)

internal class SyncItem(val mediaId: UUID, val generation: Long, val baseRevision: Long, val device: JSONObject?)
internal class LocalComponent(val input: InputStream, val mime: String)

/** Pins one immutable recording and its capture. Pause retains the lease; close is idempotent. */
internal class EpisodeLease(
    val packageId: UUID,
    val audioFile: File,
    val rendition: JSONObject,
    val playbackBaseline: JSONObject,
    val artworkFile: File?,
    val audioDurationMs: Long?,
    private val release: () -> Unit,
) : AutoCloseable {
    private var closed = false
    @Synchronized override fun close() {
        if (!closed) { release(); closed = true }
    }
}

private data class Item(
    val mediaId: UUID,
    val kind: String,
    var title: String,
    var state: String,
    var failure: String? = null,
    var attempts: Int = 0,
    var sizeBytes: Long = 0,
    var savedAt: String? = null,
    var generation: Long = 0,
    var baseline: JSONObject? = null,
    var device: JSONObject? = null,
    var position: String? = null,
    var packageId: UUID? = null,
    var capture: JSONObject? = null,
    var extras: JSONObject? = null,
    var received: Long = 0,
    var total: Long? = null,
)

private data class StoreState(
    var account: UUID? = null,
    var policy: Policy = Policy.UnmeteredOnly,
    var consumptionRevision: Long = 0,
    var processStartedAt: Long = 0,
    val items: LinkedHashMap<UUID, Item> = LinkedHashMap(),
) {
    fun detached() = copy(items = LinkedHashMap(items.mapValues { (_, item) ->
        item.copy(baseline = item.baseline?.detached(), device = item.device?.detached(),
            capture = item.capture?.detached(), extras = item.extras?.detached())
    }))
}

/**
 * Account-scoped content, acquisition intent and reading-copy positions. Required
 * audio is published once with its captured rendition; optional slots commit
 * independently. initialize() loads and recovers on IO before admission; leases
 * read only validated memory and file facts. Atomic state replacement precedes
 * memory publication. Retrying
 * acquisition reuses its package/capture; removal is idempotent and never owns
 * listening history. Invalid state preserves every byte for explicit repair.
 */
internal class OfflineStore private constructor(private val context: Context) {
    private val filesDir = context.filesDir
    companion object {
        @Volatile private var instance: OfflineStore? = null
        fun get(context: Context): OfflineStore = instance ?: synchronized(this) {
            instance ?: OfflineStore(context.applicationContext).also { instance = it }
        }
    }

    private val root = File(filesDir, "offline")
    private val lock = Any()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val leases = HashMap<UUID, Int>()
    private val streams = HashSet<InputStream>()
    private val writeFailures = HashSet<UUID>()
    private val audioFacts = HashMap<UUID, AudioMeta>()
    private var state = StoreState()
    private var loadError: LocalStateError? = null
    @Volatile private var loaded = false
    private var active: Transfer? = null
    private var namespace = 0L
    private var revisionValue = 1L
    private var lastProgressNotice = 0L
    private var authRequiredValue = false

    val account: UUID? get() = if (!loaded) null else synchronized(lock) { state.account }
    val authRequired: Boolean get() = loaded && synchronized(lock) { authRequiredValue }
    val revision: Long get() = if (!loaded) 1L else synchronized(lock) { revisionValue }

    suspend fun initialize() = withContext(Dispatchers.IO) { synchronized(lock) {
        if (loaded) return@synchronized
        try {
            val file = AtomicFile(stateFile())
            val raw = try { file.readFully() } catch (error: FileNotFoundException) {
                if (file.baseFile.exists()) throw error else null
            }
            if (raw != null) {
                val json = JSONObject(String(raw, Charsets.UTF_8))
                val version = json.integer("format_version", false)?.toInt()
                state = if (version == 2) migrate(json) else {
                    require(version == 3) { "unsupported downloaded-content format" }
                    decode(json)
                }
                if (version == 2) persist(state)
            }
            recover()
        } catch (error: Exception) {
            loadError = when (error) {
                is IOException -> LocalStateError("E_LOCAL_CONTENT_IO", "downloaded content could not be read; retry or remove downloaded content")
                is JSONException, is IllegalArgumentException -> LocalStateError("E_LOCAL_CONTENT_INVALID", "downloaded content needs repair; saved files have been kept")
                else -> throw error
            }
            // A damaged namespace must never be rebound to the next admitted account.
            state = StoreState()
        }
        loaded = true
    } }

    fun snapshot(): JSONObject {
        checkReadable()
        return synchronized(lock) {
        JSONObject().put("revision", revisionValue.toString()).put("account_id", state.account?.toString().orNull()).put("policy", state.policy.name)
            .put("auth_required", authRequiredValue).put("consumption_revision", state.consumptionRevision)
            .put("items", JSONArray(state.items.values.map { item -> view(item).apply {
                if (item.mediaId in writeFailures) {
                    if (item.state == "Ready" && item.extras != null) EXTRA_NAMES.forEach { name ->
                        if (getJSONObject("extras").getJSONObject(name).getString("kind") == "Pending") getJSONObject("extras").put(name, slot("Failed", "Storage"))
                    } else { put("state", "Failed"); put("failure", "Storage") }
                }
            } }))
        }
    }

    fun openDownloads(): InputStream = synchronized(lock) {
        checkAccount()
        val bytes = snapshot().toString().toByteArray(Charsets.UTF_8)
        if (state.items.size > MAX_ITEMS || bytes.size > MAX_INDEX_BYTES) {
            throw LocalStateError("E_LOCAL_CONTENT_LIMIT", "downloaded-content index exceeds this device’s limit")
        }
        register(ByteArrayInputStream(bytes))
    }

    /** The bridge's captured account and mutation share the store publication lock. */
    fun command(owner: UUID, action: () -> JSONObject): JSONObject = synchronized(lock) {
        checkAccount()
        if (state.account != owner) throw LocalStateError("E_LOCAL_CONTENT_UNBOUND", "account changed")
        action()
    }

    fun addListener(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /** Corrupt content remains inaccessible without preventing unrelated device startup. */
    fun bind(accountId: UUID) {
        synchronized(lock) {
            if (loadError != null) return
            require(state.account == null || state.account == accountId) { "sign out before changing downloaded content account" }
            if (state.account == null) update { it.account = accountId }
            authRequiredValue = false
            revisionValue += 1
        }
        changed()
    }

    /** Account retirement closes every local stream before explicit deletion. */
    fun purge() {
        synchronized(lock) {
            active = null
            namespace += 1
            streams.toList().forEach { it.close() }
            leases.clear()
            writeFailures.clear()
            audioFacts.clear()
            if (root.exists() && !root.deleteRecursively()) throw IOException("downloaded content could not be removed")
            state = StoreState()
            loadError = null
            loaded = true
            authRequiredValue = false
            persist(state)
            revisionValue += 1
        }
        changed()
    }

    fun requireAuth(account: UUID) {
        synchronized(lock) {
            if (state.account != account || authRequiredValue) return
            authRequiredValue = true
            revisionValue += 1
        }
        changed()
    }

    /** A client-minted package owns an episode capture; the renderer supplies no network authority. */
    fun enqueue(mediaId: UUID, kind: String, title: String): String? {
        synchronized(lock) {
            checkAccount()
            if (state.items.containsKey(mediaId)) return null
            if (state.items.size >= MAX_ITEMS) return "Limit"
            if (filesDir.usableSpace < RESERVE_BYTES) return "Storage"
            update { it.items[mediaId] = Item(mediaId, kind, title, "Queued", packageId = if (kind == AUDIO) UUID.randomUUID() else null) }
        }
        changed()
        return null
    }

    /** Removes visibility before files; an existing package lease defers deletion. */
    fun remove(mediaId: UUID): Boolean {
        val removed = synchronized(lock) {
            checkReadable()
            val item = state.items[mediaId] ?: return false
            update { next ->
                if ((leases[mediaId] ?: 0) > 0) next.items.getValue(mediaId).state = "Removing"
                else next.items.remove(mediaId)
            }
            if (active?.mediaId == mediaId) active = null
            writeFailures.remove(mediaId)
            if ((leases[mediaId] ?: 0) == 0) item else null
        }
        changed()
        removed?.let(::deleteFiles)
        return true
    }

    fun retry(mediaId: UUID): Boolean {
        synchronized(lock) {
            checkAccount()
            val item = state.items[mediaId] ?: return false
            if (item.state != "Failed" && mediaId !in writeFailures) return true
            val converting = item.failure == "NeedsDownload"
            val uncommitted = if (item.kind == AUDIO && item.packageId != null) packageDir(item) else itemDir(mediaId)
            if (!converting && uncommitted.exists() && !uncommitted.deleteRecursively()) throw IOException("unfinished download could not be removed; retry")
            update { next -> next.items.getValue(mediaId).apply {
                state = "Queued"; failure = null; attempts = 0
                if (converting) { packageId = UUID.randomUUID(); capture = null; extras = null; sizeBytes = 0; savedAt = null }
            } }
            writeFailures.remove(mediaId)
            if (converting) itemDir(mediaId).deleteRecursively()
        }
        changed()
        return true
    }

    fun retryExtras(mediaId: UUID, packageId: UUID): Boolean {
        synchronized(lock) {
            checkAccount()
            val item = state.items[mediaId]?.takeIf { it.kind == AUDIO && it.state == "Ready" && it.packageId == packageId } ?: return false
            update { next ->
                val target = next.items.getValue(mediaId)
                for (name in EXTRA_NAMES) {
                    val current = item.extras!!.getJSONObject(name)
                    val captured = name == "artwork" || item.capture!!.getJSONObject("transcript").getString("kind") == "Available"
                    if (captured && current.string("reason") != "Changed" &&
                        (current.getString("kind") == "Failed" || mediaId in writeFailures && current.getString("kind") == "Pending")) {
                        target.extras!!.put(name, slot("Pending"))
                    }
                }
            }
            writeFailures.remove(mediaId)
        }
        changed()
        return true
    }

    var policy: Policy
        get() = synchronized(lock) { state.policy }
        set(value) {
            synchronized(lock) { checkReadable(); update { it.policy = value } }
            changed()
        }

    fun hasQueued(): Boolean = loaded && synchronized(lock) {
        loadError == null && state.items.values.any { it.mediaId !in writeFailures && (it.state == "Queued" || it.state == "Ready" && hasPendingExtras(it)) }
    }

    /** A reading lease is pinned to this namespace even after purge and re-provisioning. */
    fun openReadingCopy(mediaId: UUID): AutoCloseable? = synchronized(lock) {
        checkAccount()
        if (state.items[mediaId]?.let { it.kind != AUDIO && it.state == "Ready" } != true) return null
        leases[mediaId] = (leases[mediaId] ?: 0) + 1
        val opened = namespace
        var held = true
        AutoCloseable {
            synchronized(lock) {
                if (held) {
                    if (opened == namespace) close(mediaId)
                    held = false
                }
            }
        }
    }

    private fun close(mediaId: UUID) {
        val removed = synchronized(lock) {
            val count = leases[mediaId] ?: return
            if (count > 1) { leases[mediaId] = count - 1; return }
            val item = state.items[mediaId]?.takeIf { it.state == "Removing" }
            if (item == null) { leases.remove(mediaId); return }
            update { it.items.remove(mediaId) }
            leases.remove(mediaId)
            item
        }
        changed()
        deleteFiles(removed)
    }

    /** Bytes, rendition and real baseline come from one committed immutable package. */
    fun openEpisode(mediaId: UUID): EpisodeLease? {
        checkReadable()
        return synchronized(lock) {
        checkAccount()
        val item = state.items[mediaId]?.takeIf { it.kind == AUDIO && it.state == "Ready" && it.packageId != null } ?: return null
        val audio = committedAudio(item)
        leases[mediaId] = (leases[mediaId] ?: 0) + 1
        val owner = state.account
        EpisodeLease(item.packageId!!, audio, item.capture!!.getJSONObject("rendition").detached(),
            item.capture!!.getJSONObject("playback_baseline").detached(),
            if (item.extras!!.getJSONObject("artwork").getString("kind") == "Ready") File(packageDir(item), "artwork").takeIf { it.isFile } else null, audioFacts.getValue(item.packageId!!).durationMs) {
                synchronized(lock) { if (state.account == owner && state.items[mediaId]?.packageId == item.packageId) close(mediaId) }
            }
        }
    }

    fun openEpisodeComponent(mediaId: UUID, packageId: UUID, name: String): LocalComponent? = synchronized(lock) {
        checkAccount()
        val item = state.items[mediaId]?.takeIf { it.kind == AUDIO && it.state == "Ready" && it.packageId == packageId } ?: return null
        if (name !in setOf("episode.json", "transcript.json", "artwork")) return null
        committedAudio(item)
        val mime = if (name == "episode.json") "application/json" else {
            val extra = item.extras!!.getJSONObject(if (name == "transcript.json") "transcript" else "artwork")
            if (extra.getString("kind") != "Ready") return null
            if (name == "transcript.json") "application/json" else extra.getString("mime")
        }
        val file = File(packageDir(item), name)
        if (!file.isFile) throw LocalStateError("E_LOCAL_CONTENT_INVALID", "downloaded content is incomplete; saved files have been kept")
        if (name != "episode.json") {
            val extra = item.extras!!.getJSONObject(if (name == "transcript.json") "transcript" else "artwork")
            if (file.length() != extra.getLong("byte_count") || digest(file) != extra.getString("sha256")) throw LocalStateError("E_LOCAL_CONTENT_INVALID", "downloaded component needs repair; audio has been kept")
        }
        try { LocalComponent(register(FileInputStream(file)), mime) }
        catch (error: IOException) { throw LocalStateError("E_LOCAL_CONTENT_IO", "downloaded content could not be opened") }
    }

    fun copyFile(mediaId: UUID, path: String): File? = synchronized(lock) {
        checkAccount()
        val item = state.items[mediaId] ?: return null
        if (item.kind == AUDIO || item.state !in LIVE) return null
        val dir = itemDir(mediaId).canonicalFile
        File(dir, path).canonicalFile.takeIf { it.path.startsWith(dir.path + File.separator) && it.isFile }
    }

    fun openCopy(mediaId: UUID, path: String): InputStream? = synchronized(lock) {
        copyFile(mediaId, path)?.let { register(FileInputStream(it)) }
    }

    fun isReadyCopy(mediaId: UUID): Boolean = synchronized(lock) {
        checkAccount()
        state.items[mediaId]?.let { it.kind != AUDIO && it.state == "Ready" } == true
    }

    fun save(mediaId: UUID, locator: JSONObject, baseRevision: Long, generation: Long, adoptUnresolved: Boolean): String? {
        synchronized(lock) {
            checkAccount()
            val item = state.items[mediaId]?.takeIf { it.kind != AUDIO && it.state == "Ready" } ?: return "NotFound"
            if (item.generation != generation) return "ContentChanged"
            if (item.baseline!!.getLong("revision") != baseRevision) return "Conflict"
            val adopting = adoptUnresolved || item.position == "Pending" && item.device?.getBoolean("adopt_unresolved") == true
            if (item.baseline!!.getString("state") == "Unresolved" && !adopting) return "Conflict"
            update { next -> next.items.getValue(mediaId).apply {
                device = JSONObject().put("locator", locator).put("adopt_unresolved", adopting)
                if (position == null || adoptUnresolved && position == "Conflict") position = "Pending"
            } }
        }
        changed()
        return null
    }

    fun resolve(mediaId: UUID, keepDevice: Boolean): Boolean {
        synchronized(lock) {
            checkAccount()
            val item = state.items[mediaId]?.takeIf { it.position == "Conflict" } ?: return false
            if (keepDevice && item.baseline!!.getString("state") == "Unresolved") return false
            update { next -> next.items.getValue(mediaId).apply {
                if (keepDevice) { device!!.put("adopt_unresolved", false); position = "Pending" }
                else { device = null; position = null }
            } }
        }
        changed()
        return true
    }

    /** A single owner drains required and optional work; package-specific paths make stale work inert. */
    fun startNext(skip: Set<UUID>): Transfer? {
        val transfer = synchronized(lock) {
            checkAccount()
            if (active != null) return null
            val item = state.items.values.firstOrNull { it.mediaId !in skip && it.mediaId !in writeFailures && (it.state == "Queued" || it.state == "Ready" && hasPendingExtras(it)) } ?: return null
            val staging = if (item.kind == AUDIO) stagingDir(item) else File(root, "staging/copy-${UUID.randomUUID()}")
            val ready = item.state == "Ready"
            try {
                if (!staging.isDirectory && !staging.mkdirs()) throw IOException("download staging could not be created")
                if (!ready) update { next -> next.items.getValue(item.mediaId).apply { state = "Downloading"; received = 0; total = null } }
            } catch (error: IOException) { writeFailures += item.mediaId; revisionValue += 1; changed(); throw error }
            Transfer(state.account!!, item.mediaId, item.kind, item.packageId, item.capture?.detached(), ready, staging).also { active = it }
        }
        changed()
        return transfer
    }

    fun progress(transfer: Transfer, received: Long, total: Long?): Boolean {
        val notice = synchronized(lock) {
            if (!owns(transfer)) return false
            state.items.getValue(transfer.mediaId).apply { this.received = received; this.total = total }
            val now = SystemClock.elapsedRealtime()
            revisionValue += 1
            (now - lastProgressNotice >= PROGRESS_INTERVAL_MS).also { if (it) lastProgressNotice = now }
        }
        if (notice) changed()
        return true
    }

    fun capture(transfer: Transfer, capture: JSONObject): Boolean {
        synchronized(lock) {
            if (!owns(transfer)) return false
            validateCapture(capture, transfer.mediaId)
            update { next -> next.items.getValue(transfer.mediaId).apply {
                this.capture = capture.detached()
                title = capture.getJSONObject("rendition").getString("title")
                extras = JSONObject().put("transcript", when (val kind = capture.getJSONObject("transcript").getString("kind")) {
                    "Absent" -> slot("Absent")
                    "Available" -> slot("Pending")
                    "Unavailable" -> slot("Failed", capture.getJSONObject("transcript").getString("reason"))
                    else -> throw IllegalArgumentException(kind)
                }).put("artwork", slot(if (capture.getJSONObject("rendition").isNull("artwork_url")) "Absent" else "Pending"))
            } }
        }
        changed()
        return true
    }

    fun publishEpisode(transfer: Transfer, capture: JSONObject, audio: AudioMeta): Boolean {
        synchronized(lock) {
            if (!owns(transfer)) return false
            val item = state.items.getValue(transfer.mediaId)
            val manifest = JSONObject().put("format_version", 1).put("account_id", transfer.account.toString())
                .put("media_id", transfer.mediaId.toString()).put("package_id", transfer.packageId.toString())
                .put("capture", capture).put("audio", JSONObject().put("byte_count", audio.byteCount).put("mime", audio.mime).put("duration_ms", audio.durationMs.orNull()))
            writeSynced(File(transfer.staging, "episode.json"), manifest.toString().toByteArray(Charsets.UTF_8))
            syncTree(transfer.staging)
            val destination = packageDir(item)
            destination.parentFile!!.mkdirs()
            if (destination.exists() || !transfer.staging.renameTo(destination)) throw IOException("episode package could not be published")
            syncDirectory(destination.parentFile!!)
            update { next -> next.items.getValue(transfer.mediaId).apply {
                state = "Ready"; failure = null; attempts = 0
                sizeBytes = audio.byteCount; savedAt = Instant.now().toString()
                received = audio.byteCount; total = audio.byteCount
            } }
            audioFacts[item.packageId!!] = audio
        }
        changed()
        return true
    }

    fun pendingExtras(transfer: Transfer): List<String> = synchronized(lock) {
        if (!owns(transfer)) return emptyList()
        val item = state.items.getValue(transfer.mediaId)
        EXTRA_NAMES.filter { item.extras!!.getJSONObject(it).getString("kind") == "Pending" }
    }

    fun publishExtra(transfer: Transfer, name: String, staged: File, mime: String, sha256: String): Boolean {
        synchronized(lock) {
            if (!owns(transfer)) { staged.delete(); return false }
            val item = state.items.getValue(transfer.mediaId)
            if (item.state != "Ready" || item.extras!!.getJSONObject(name).getString("kind") != "Pending") return false
            val target = File(packageDir(item), if (name == "transcript") "transcript.json" else "artwork")
            val length = staged.length()
            FileOutputStream(staged, true).use { it.fd.sync() }
            if (!staged.renameTo(target)) throw IOException("downloaded component could not be published")
            syncDirectory(target.parentFile!!)
            update { next -> next.items.getValue(transfer.mediaId).extras!!.put(name,
                slot("Ready").put("byte_count", length).put("sha256", sha256).put("mime", mime)) }
        }
        changed()
        return true
    }

    fun failExtra(transfer: Transfer, name: String, reason: String) {
        synchronized(lock) {
            if (!owns(transfer)) return
            update { next -> next.items.getValue(transfer.mediaId).extras!!.put(name, slot("Failed", reason)) }
        }
        changed()
    }

    fun finish(transfer: Transfer) {
        synchronized(lock) { if (owns(transfer)) active = null }
        transfer.staging.deleteRecursively()
    }

    fun publish(transfer: Transfer, generation: Long, baseline: JSONObject?) {
        synchronized(lock) {
            if (!owns(transfer)) return
            syncTree(transfer.staging)
            val dir = itemDir(transfer.mediaId)
            if (dir.exists()) throw IOException("reading-copy destination already exists")
            dir.parentFile!!.mkdirs()
            if (!transfer.staging.renameTo(dir)) throw IOException("reading copy could not be published")
            syncDirectory(dir.parentFile!!)
            update { next -> next.items.getValue(transfer.mediaId).apply {
                state = "Ready"; failure = null; attempts = 0
                sizeBytes = dir.walk().filter { it.isFile }.sumOf { it.length() }
                savedAt = Instant.now().toString(); this.generation = generation; this.baseline = baseline
            } }
            active = null
        }
        changed()
    }

    /** A failed schedule is durable and actionable rather than a fictitious running transfer. */
    fun scheduleRejected() {
        synchronized(lock) {
            checkReadable()
            update { next -> next.items.values.filter { it.state == "Queued" || it.state == "Ready" && hasPendingExtras(it) }.forEach { item ->
                if (item.state == "Ready") EXTRA_NAMES.forEach { name ->
                    if (item.extras!!.getJSONObject(name).getString("kind") == "Pending") item.extras!!.put(name, slot("Failed", "Scheduler"))
                } else { item.state = "Failed"; item.failure = "Scheduler" }
            } }
        }
        changed()
    }

    fun fail(transfer: Transfer, reason: String, retryable: Boolean): Boolean {
        val requeued = try { synchronized(lock) {
            if (!owns(transfer)) { if (transfer.kind != AUDIO) transfer.staging.deleteRecursively(); return false }
            val item = state.items.getValue(transfer.mediaId)
            if (item.state == "Ready") {
                update { next -> EXTRA_NAMES.forEach { name ->
                    if (next.items.getValue(item.mediaId).extras!!.getJSONObject(name).getString("kind") == "Pending") next.items.getValue(item.mediaId).extras!!.put(name, slot("Failed", reason))
                } }
                active = null
                return@synchronized false
            }
            val requeue = retryable && item.attempts < MAX_RETRIES
            update { next -> next.items.getValue(item.mediaId).apply {
                state = if (requeue) "Queued" else "Failed"
                failure = if (requeue) null else reason
                if (requeue) attempts += 1
            } }
            active = null
            if (reason == "AuthorizationRequired") authRequiredValue = true
            if (item.kind != AUDIO || reason == "Invalid") transfer.staging.deleteRecursively()
            // A renamed package whose state commit failed is uncommitted, never Ready.
            if (item.kind == AUDIO) packageDir(item).takeIf { it.exists() }?.deleteRecursively()
            requeue
        } } catch (error: IOException) {
            synchronized(lock) {
                if (owns(transfer)) { active = null; writeFailures += transfer.mediaId; revisionValue += 1 }
            }
            android.util.Log.e("NexusDownloads", "download failure could not be saved", error)
            false
        }
        changed()
        return requeued
    }

    /** System interruption preserves intent; explicit platform user stop is actionable. */
    fun stopActive(expected: Transfer?, byUser: Boolean) {
        if (!loaded) return
        synchronized(lock) {
            if (!loaded || loadError != null || active !== expected) return
            val affected = state.items.values.filter { item ->
                item.mediaId == expected?.mediaId || byUser && (item.state == "Queued" || item.state == "Ready" && hasPendingExtras(item))
            }.map { it.mediaId }
            try {
                update { next -> next.items.values.forEach { item ->
                    if (item.state == "Downloading" && item.mediaId == expected?.mediaId || byUser && item.state == "Queued") {
                        item.state = if (byUser) "Failed" else "Queued"
                        item.failure = if (byUser) "Stopped" else null
                    }
                    if (byUser && item.state == "Ready" && hasPendingExtras(item)) EXTRA_NAMES.forEach { name ->
                        if (item.extras!!.getJSONObject(name).getString("kind") == "Pending") item.extras!!.put(name, slot("Failed", "Stopped"))
                    }
                } }
            } catch (error: IOException) {
                active = null
                writeFailures.addAll(affected)
                revisionValue += 1
                changed()
                throw error
            }
            active = null
        }
        changed()
    }

    fun syncItems(): List<SyncItem> = synchronized(lock) {
        checkReadable()
        state.items.values.filter { it.kind != AUDIO && it.state == "Ready" && it.position in SYNCABLE }
            .map { SyncItem(it.mediaId, it.generation, it.baseline!!.getLong("revision"), it.device?.detached()) }
    }

    fun synced(mediaId: UUID, sent: JSONObject?, snapshot: JSONObject, accepted: Boolean = false) {
        synchronized(lock) {
            val item = state.items[mediaId]?.takeIf { it.state == "Ready" && it.kind != AUDIO } ?: return
            if (sent == null && (item.position != null || mediaId in leases || item.baseline.toString() == snapshot.toString())) return
            if (sent != null && item.device == null) return
            update { next -> next.items.getValue(mediaId).apply {
                if (sent != null) {
                    if (device.toString() == sent.toString()) { device = null; position = null }
                    else position = "Pending"
                }
                if (accepted || baseline.toString() != snapshot.toString()) next.consumptionRevision += 1
                baseline = snapshot.detached()
            } }
        }
        changed()
    }

    fun conflicted(mediaId: UUID, canonical: JSONObject) {
        synchronized(lock) {
            if (state.items[mediaId]?.let { it.state == "Ready" && it.device != null } != true) return
            update { next -> next.items.getValue(mediaId).apply { baseline = canonical.detached(); device!!.put("adopt_unresolved", false); position = "Conflict" } }
        }
        changed()
    }

    fun markPosition(mediaId: UUID, position: String, canonical: JSONObject? = null) {
        synchronized(lock) {
            if (state.items[mediaId]?.let { it.state == "Ready" && it.device != null } != true) return
            update { next -> next.items.getValue(mediaId).apply {
                this.position = position
                if (canonical != null) { baseline = canonical.detached(); device!!.put("adopt_unresolved", false) }
            } }
        }
        changed()
    }

    private fun checkReadable() {
        if (!loaded) throw LocalStateError("E_LOCAL_CONTENT_INITIALIZING", "downloaded content is initializing")
        loadError?.let { throw it }
    }
    private fun checkAccount() {
        checkReadable()
        if (state.account == null || DeviceSession.current()?.accountId() != state.account) throw LocalStateError("E_LOCAL_CONTENT_UNBOUND", "sign in first")
    }
    private fun stateFile() = File(root, "state.json")
    private fun itemDir(mediaId: UUID) = File(root, "items/$mediaId")
    private fun packageDir(item: Item) = File(root, "episodes/${item.packageId}")
    private fun stagingDir(item: Item) = File(root, "staging/${item.packageId ?: item.mediaId}")
    private fun owns(transfer: Transfer): Boolean = active === transfer && state.account == transfer.account &&
        state.items[transfer.mediaId]?.let { it.packageId == transfer.packageId && it.state != "Removing" } == true
    private fun hasPendingExtras(item: Item) = item.extras?.let { extras -> EXTRA_NAMES.any { extras.getJSONObject(it).getString("kind") == "Pending" } } == true

    private fun deleteFiles(item: Item) {
        synchronized(lock) { item.packageId?.let(audioFacts::remove) }
        val destination = if (item.kind == AUDIO && item.packageId != null) packageDir(item) else itemDir(item.mediaId)
        if (destination.exists() && !destination.deleteRecursively()) throw IOException("downloaded content could not be removed")
        stagingDir(item).deleteRecursively()
    }

    private fun register(input: InputStream): InputStream {
        val stream = object : FilterInputStream(input) {
            private var retired = false
            private fun checkOpen() { if (retired) throw IOException("downloaded-content stream retired") }
            override fun read(): Int = synchronized(lock) { checkOpen(); super.read() }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int = synchronized(lock) { checkOpen(); super.read(buffer, offset, length) }
            override fun skip(count: Long): Long = synchronized(lock) { checkOpen(); super.skip(count) }
            override fun close() = synchronized(lock) { retired = true; super.close(); streams.remove(this); Unit }
        }
        streams += stream
        return stream
    }

    private fun committedAudio(item: Item): File {
        val facts = audioFacts[item.packageId] ?: throw LocalStateError("E_LOCAL_CONTENT_INVALID", "downloaded episode needs repair; saved files have been kept")
        val file = File(packageDir(item), "audio")
        if (!file.isFile || file.length() != facts.byteCount) throw LocalStateError("E_LOCAL_CONTENT_INVALID", "downloaded audio is incomplete; saved files have been kept")
        return file
    }

    private fun manifest(item: Item): JSONObject {
        try {
            val value = JSONObject(File(packageDir(item), "episode.json").readText(Charsets.UTF_8))
            require(value.getInt("format_version") == 1)
            require(value.getString("account_id") == state.account.toString())
            require(value.getString("media_id") == item.mediaId.toString() && value.getString("package_id") == item.packageId.toString())
            validateCapture(value.getJSONObject("capture"), item.mediaId)
            require(value.getJSONObject("capture").toString() == item.capture.toString())
            val audio = value.getJSONObject("audio")
            require(audio.getLong("byte_count") > 0 && audio.getString("mime").startsWith("audio/"))
            require(File(packageDir(item), "audio").length() == audio.getLong("byte_count"))
            audioFacts[item.packageId!!] = AudioMeta(audio.getLong("byte_count"), audio.getString("mime"), if (audio.isNull("duration_ms")) null else audio.getLong("duration_ms"))
            return value
        } catch (error: Exception) {
            when (error) {
                is IOException -> throw LocalStateError("E_LOCAL_CONTENT_IO", "downloaded episode could not be read")
                is JSONException, is IllegalArgumentException -> throw LocalStateError("E_LOCAL_CONTENT_INVALID", "downloaded episode needs repair; saved files have been kept")
                else -> throw error
            }
        }
    }

    private fun recover() {
        val next = state.detached()
        // package history also includes webview renderers, which can die after the main process.
        val userStopped = if (android.os.Build.VERSION.SDK_INT >= 30) {
            context.getSystemService(android.app.ActivityManager::class.java)
                .getHistoricalProcessExitReasons(context.packageName, 0, 0)
                .firstOrNull { it.processName == context.packageName }
                ?.let { it.timestamp >= state.processStartedAt && it.reason == android.app.ApplicationExitInfo.REASON_USER_REQUESTED } == true
        } else false
        next.processStartedAt = System.currentTimeMillis()
        for (item in next.items.values.toList()) {
            when (item.state) {
                "Downloading" -> { item.state = "Queued"; item.received = 0; item.total = null }
                "Removing" -> next.items.remove(item.mediaId)
            }
            if (userStopped && item.state == "Queued") { item.state = "Failed"; item.failure = "Stopped" }
            if (userStopped && item.state == "Ready" && hasPendingExtras(item)) EXTRA_NAMES.forEach { name ->
                if (item.extras!!.getJSONObject(name).getString("kind") == "Pending") item.extras!!.put(name, slot("Failed", "Stopped"))
            }
            if (item.kind != AUDIO || item.state != "Ready") continue
            manifest(item)
            for (name in EXTRA_NAMES) {
                val component = File(packageDir(item), if (name == "transcript") "transcript.json" else "artwork")
                val current = item.extras!!.getJSONObject(name)
                if (current.getString("kind") != "Ready") {
                    // Rename-before-slot-commit bytes grant no component readiness.
                    component.delete()
                } else if (!component.isFile || component.length() != current.getLong("byte_count")) {
                    item.extras!!.put(name, slot("Failed", "Invalid"))
                }
            }
        }
        persist(next); state = next
        // Required rename-before-commit candidates have no committed readiness: discard.
        File(root, "episodes").listFiles()?.filter { directory -> state.items.values.none { it.packageId.toString() == directory.name && it.state == "Ready" } }?.forEach { it.deleteRecursively() }
        File(root, "items").listFiles()?.filter { directory -> state.items.values.none { it.mediaId.toString() == directory.name && (it.kind != AUDIO && it.state in LIVE || it.kind == AUDIO && it.failure == "NeedsDownload") } }?.forEach { it.deleteRecursively() }
        File(root, "staging").listFiles()?.filter { directory -> state.items.values.none { stagingDir(it).name == directory.name } }?.forEach { it.deleteRecursively() }
    }

    private fun update(change: (StoreState) -> Unit) {
        checkReadable()
        val next = state.detached()
        change(next)
        persist(next)
        state = next
        revisionValue += 1
    }

    private fun persist(next: StoreState) {
        if (!root.isDirectory && !root.mkdirs()) throw IOException("downloaded-content directory could not be created")
        val bytes = encode(next).toString().toByteArray(Charsets.UTF_8)
        val file = AtomicFile(stateFile())
        var out: FileOutputStream? = null
        try {
            out = file.startWrite(); out.write(bytes); out.fd.sync(); file.finishWrite(out)
            syncDirectory(root)
            if (!file.readFully().contentEquals(bytes)) throw IOException("downloaded-content state was not replaced")
        } catch (error: IOException) { out?.let(file::failWrite); throw error }
    }

    private fun encode(value: StoreState): JSONObject = JSONObject().put("format_version", 3)
        .put("account", value.account?.toString().orNull()).put("policy", value.policy.name)
        .put("consumption_revision", value.consumptionRevision).put("process_started_at_ms", value.processStartedAt).put("items", JSONArray(value.items.values.map { item ->
            view(item).put("generation", item.generation).put("baseline", item.baseline.orNull())
                .put("device", item.device.orNull()).put("position", item.position.orNull()).put("capture", item.capture.orNull()).put("extras", item.extras.orNull()).apply { remove("progress") }
        }))

    private fun decode(value: JSONObject): StoreState {
        value.closed("format_version", "account", "policy", "consumption_revision", "process_started_at_ms", "items")
        require(value.integer("format_version", false) == 3L)
        val next = StoreState(value.string("account")?.let(UUID::fromString), Policy.valueOf(value.text("policy")), value.integer("consumption_revision", false)!!, value.integer("process_started_at_ms", false)!!)
        val list = value.getJSONArray("items")
        require(list.length() <= MAX_ITEMS)
        for (index in 0 until list.length()) {
            val json = list.getJSONObject(index)
            json.closed("media_id", "kind", "title", "state", "failure", "attempts", "size_bytes", "saved_at", "generation", "baseline", "device", "position", "package_id", "capture", "extras", "received", "total")
            val item = Item(UUID.fromString(json.text("media_id")), json.text("kind"), json.text("title"), json.text("state"),
                json.string("failure"), json.integer("attempts", false, MAX_RETRIES.toLong())!!.toInt(), json.integer("size_bytes", false)!!, json.string("saved_at"), json.integer("generation", false)!!,
                json.objectOrNull("baseline"), json.objectOrNull("device"), json.string("position"), json.string("package_id")?.let(UUID::fromString),
                json.objectOrNull("capture"), json.objectOrNull("extras"), json.integer("received", false)!!, json.integer("total", true))
            require(item.kind in setOf(AUDIO, "pdf", "epub", "web_article") && item.state in setOf("Queued", "Downloading", "Ready", "Failed", "Removing"))
            require(next.items.put(item.mediaId, item) == null)
            require(item.position in setOf(null, "Pending", "Conflict", "ContentChanged", "SourceUnavailable"))
            require(item.state != "Failed" || item.failure != null)
            item.device?.let { it.getJSONObject("locator"); it.getBoolean("adopt_unresolved") }
            if (item.kind == AUDIO) {
                require(item.packageId != null || item.state == "Failed" && item.failure == "NeedsDownload")
                if (item.state in LIVE) require(item.packageId != null && item.capture != null && item.extras != null)
                item.capture?.let { validateCapture(it, item.mediaId) }
                item.extras?.let { extras -> EXTRA_NAMES.forEach { name ->
                    val slot = extras.getJSONObject(name)
                    require(slot.text("kind") in setOf("Absent", "Pending", "Ready", "Failed"))
                    if (slot.text("kind") == "Ready") {
                        slot.closed("kind", "reason", "byte_count", "sha256", "mime")
                        require(slot.integer("byte_count", false, 8L * 1024 * 1024)!! > 0)
                        require(slot.text("sha256").matches(Regex("[a-f0-9]{64}")))
                        slot.text("mime")
                    } else slot.closed("kind", "reason")
                    require((slot.string("reason") != null) == (slot.text("kind") == "Failed"))
                } }
                require((item.capture == null) == (item.extras == null))
            } else {
                require(item.packageId == null && item.capture == null && item.extras == null)
                if (item.state in LIVE) require(item.baseline != null)
            }
        }
        require(next.account != null || next.items.isEmpty())
        return next
    }

    /** Version two audio lacks capture/baseline authority; preserve reading copies and convert audio visibly. */
    private fun migrate(old: JSONObject): StoreState {
        val next = StoreState(old.string("account")?.let(UUID::fromString), Policy.valueOf(old.getString("policy")))
        val list = old.getJSONArray("items")
        require(list.length() <= MAX_ITEMS)
        for (index in 0 until list.length()) {
            val json = list.getJSONObject(index)
            val kind = json.getString("kind")
            val item = Item(UUID.fromString(json.getString("mediaId")), kind, json.getString("title"),
                if (kind == AUDIO) "Failed" else json.getString("state"), if (kind == AUDIO) "NeedsDownload" else json.string("failure"),
                if (kind == AUDIO) 0 else json.getInt("attempts"), json.getLong("sizeBytes"), json.string("savedAt"),
                json.getLong("generation"), json.optJSONObject("baseline"), json.optJSONObject("device"), json.string("position"))
            require(next.items.put(item.mediaId, item) == null)
        }
        return decode(encode(next))
    }

    private fun view(item: Item): JSONObject {
        val baseline = item.baseline
        val progress: Any = if (item.kind == AUDIO || item.state != "Ready" || baseline == null) JSONObject.NULL else when (item.position) {
            null -> JSONObject().put("kind", "Canonical").put("snapshot", baseline)
            "Conflict" -> JSONObject().put("kind", "Conflict").put("canonical", baseline).put("device", item.device!!.getJSONObject("locator")).put("adopt_unresolved", item.device!!.getBoolean("adopt_unresolved"))
            else -> JSONObject().put("kind", item.position).put("baseline", baseline).put("device", item.device!!.getJSONObject("locator")).put("adopt_unresolved", item.device!!.getBoolean("adopt_unresolved"))
        }
        val extras = item.extras?.let { value -> JSONObject().apply { EXTRA_NAMES.forEach { name ->
            val part = value.getJSONObject(name)
            put(name, slot(part.getString("kind"), part.string("reason")))
        } } }
        return JSONObject().put("media_id", item.mediaId.toString()).put("kind", item.kind).put("title", item.title)
            .put("state", item.state).put("failure", item.failure.orNull()).put("attempts", item.attempts)
            .put("received", item.received).put("total", item.total.orNull()).put("size_bytes", item.sizeBytes)
            .put("saved_at", item.savedAt.orNull()).put("progress", progress).put("package_id", item.packageId?.toString().orNull()).put("generation", item.generation)
            .put("extras", extras.orNull())
    }

    private fun changed() = listeners.forEach { it() }
}

private val LIVE = setOf("Ready", "Removing")
private val SYNCABLE = setOf(null, "Pending", "SourceUnavailable")
private val EXTRA_NAMES = listOf("artwork", "transcript")
private fun slot(kind: String, reason: String? = null) = JSONObject().put("kind", kind).put("reason", reason.orNull())
private fun Any?.orNull(): Any = this ?: JSONObject.NULL
private fun JSONObject.detached() = JSONObject(toString())
internal fun JSONObject.string(key: String): String? = get(key).let { if (it === JSONObject.NULL) null else { require(it is String); it } }

internal fun validateCapture(value: JSONObject, mediaId: UUID) {
    value.closed("format_version", "media_id", "captured_at", "source_key", "rendition", "playback_baseline", "show_notes", "transcript")
    require(value.integer("format_version", false) == 1L && UUID.fromString(value.text("media_id")) == mediaId)
    require(value.text("source_key").matches(Regex("[a-f0-9]{64}")))
    try { Instant.parse(value.text("captured_at")) } catch (error: java.time.format.DateTimeParseException) { throw IllegalArgumentException("invalid capture time", error) }
    val rendition = value.getJSONObject("rendition")
    rendition.closed("title", "subtitle", "podcast_id", "stream_url", "artwork_url", "duration_ms", "chapters")
    rendition.text("title"); rendition.string("subtitle"); rendition.string("podcast_id")?.let(UUID::fromString)
    require(rendition.text("stream_url").toHttpUrlOrNull()?.isHttps == true)
    rendition.string("artwork_url")
    rendition.integer("duration_ms", true)
    val chapters = rendition.getJSONArray("chapters")
    for (index in 0 until chapters.length()) {
        val chapter = chapters.getJSONObject(index)
        chapter.closed("title", "start_ms", "end_ms")
        require(chapter.text("title").length in 1..300)
        chapter.integer("start_ms", false, Int.MAX_VALUE.toLong()); chapter.integer("end_ms", true, Int.MAX_VALUE.toLong())
    }
    val baseline = value.getJSONObject("playback_baseline")
    baseline.closed("observation", "playback_rate", "pause_shortening_mode")
    require(baseline.get("playback_rate") is Number && baseline.getDouble("playback_rate") in 0.5..3.0)
    require(baseline.string("pause_shortening_mode") in setOf(null, "Off", "Natural"))
    val observation = baseline.getJSONObject("observation")
    observation.closed("media_id", "consumption_revision", "state")
    require(observation.text("media_id") == mediaId.toString())
    require(observation.text("consumption_revision").matches(Regex("[1-9][0-9]*")))
    val consumption = observation.getJSONObject("state")
    consumption.closed("reset_epoch", "consumption_override_revision", "consumption_override_status", "position_ms", "duration_ms", "lectern_member")
    consumption.integer("reset_epoch", false, Int.MAX_VALUE.toLong())
    consumption.integer("consumption_override_revision", true, Int.MAX_VALUE.toLong())
    require(consumption.string("consumption_override_status") in setOf(null, "finished", "unread"))
    consumption.integer("position_ms", true, Int.MAX_VALUE.toLong()); consumption.integer("duration_ms", true, Int.MAX_VALUE.toLong())
    require(consumption.get("lectern_member") is Boolean)
    for (name in listOf("show_notes", "transcript")) {
        val component = value.getJSONObject(name)
        when (component.text("kind")) {
            "Absent" -> component.closed("kind")
            "Unavailable" -> { component.closed("kind", "reason"); require(component.text("reason") in setOf("TooLarge", "E_MEDIA_NOT_READY")) }
            "Available" -> if (name == "show_notes") {
                component.closed("kind", "html")
                require(component.text("html").toByteArray(Charsets.UTF_8).size <= 512 * 1024)
            } else {
                component.closed("kind", "sha256", "byte_count", "coverage")
                require(component.text("sha256").matches(Regex("[a-f0-9]{64}")))
                require(component.integer("byte_count", false, 8L * 1024 * 1024)!! > 0)
                require(component.text("coverage") in setOf("partial", "full"))
            }
            else -> throw IllegalArgumentException("invalid captured component")
        }
    }
}

private fun JSONObject.closed(vararg keys: String) { require(this.keys().asSequence().toSet() == keys.toSet()) }
private fun JSONObject.text(key: String): String = get(key).also { require(it is String) } as String
private fun JSONObject.objectOrNull(key: String): JSONObject? = get(key).let { if (it === JSONObject.NULL) null else { require(it is JSONObject); it } }
private fun JSONObject.integer(key: String, nullable: Boolean, maximum: Long = Long.MAX_VALUE): Long? {
    val value = get(key)
    if (nullable && value === JSONObject.NULL) return null
    require(value is Int || value is Long)
    return (value as Number).toLong().also { require(it in 0L..maximum) }
}

internal fun writeSynced(file: File, bytes: ByteArray) {
    FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
}

private fun syncTree(directory: File) {
    directory.walkBottomUp().forEach { file ->
        if (file.isFile) FileOutputStream(file, true).use { it.fd.sync() } else syncDirectory(file)
    }
}

private fun syncDirectory(directory: File) {
    try {
        val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
        try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    } catch (error: android.system.ErrnoException) { throw IOException("download directory could not be synced", error) }
}
