package app.nexus.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.JsonReader
import android.util.JsonToken
import androidx.core.util.AtomicFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FilterInputStream
import java.io.FilterOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.CodingErrorAction
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

internal const val MAX_CATALOG_BYTES = 64L * 1024 * 1024

/**
 * Rebuildable browse metadata, isolated from account authority and authored data.
 * Refresh retries replace the complete file. One acquisition runs at a time;
 * publication, stream registration and account retirement share one lock. Network
 * and JSON validation never hold that lock. A retired acquisition cannot publish.
 * Binding starts local validation without awaiting it, overlapping bundled startup;
 * status and file reads await the same validation before exposing saved metadata.
 */
internal class CatalogStore(context: Context, private val session: DeviceSession) {
    private val root = File(context.filesDir, "catalog")
    private val file = AtomicFile(File(root, "catalog.json"))
    private val lock = Any()
    private val validation = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val origin = NexusOriginClient()
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<(JSONObject) -> Unit>()
    private val streams = HashSet<Closeable>()
    private var account: UUID? = null
    private var generation = 0L
    private var loaded = false
    private var snapshot: JSONObject? = null
    private var error: JSONObject? = null
    private var active: Job? = null
    private var retirementFailure: IOException? = null

    fun bind(value: UUID) = synchronized(lock) {
        if (account != value) {
            require(account == null) { "sign out before changing the catalog namespace" }
            account = value
            generation++
            loaded = false
            scope.launch { load() }
        }
    }

    /** A cached namespace constrains provisioning but never grants local access. */
    fun cachedAccount(): UUID? = synchronized(lock) {
        try {
            UUID.fromString(header("account_id") ?: throw IllegalArgumentException("catalog account missing"))
        } catch (failure: FileNotFoundException) {
            if (file.baseFile.exists()) throw LocalStateError("E_CATALOG_IO", "saved catalog namespace could not be read")
            null
        } catch (failure: IOException) {
            throw LocalStateError("E_CATALOG_IO", "saved catalog namespace could not be read")
        } catch (failure: IllegalArgumentException) {
            throw LocalStateError("E_CATALOG_INVALID", "sign out to remove the unreadable catalog namespace")
        } catch (failure: IllegalStateException) {
            throw LocalStateError("E_CATALOG_INVALID", "sign out to remove the unreadable catalog namespace")
        }
    }

    fun subscribe(listener: (JSONObject) -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    private fun statusLocked(): JSONObject = JSONObject()
        .put("snapshot", snapshot ?: JSONObject.NULL)
        .put("refreshing", active != null)
        .put("last_error", error ?: JSONObject.NULL)

    private fun publishLocked() {
        val current = generation
        val status = statusLocked()
        main.post {
            if (synchronized(lock) { generation == current }) listeners.forEach { it(status) }
        }
    }

    suspend fun status(): JSONObject = withContext(Dispatchers.IO) {
        load()
        synchronized(lock) { statusLocked() }
    }

    /** Only a validated, durably published catalog can retire acknowledged overlays. */
    fun consumptionRevision(): String? = synchronized(lock) {
        if (account == null || session.accountId() != account) null
        else snapshot?.getString("consumption_revision")
    }

    /** Acknowledges acquisition, not completion; no network or validation in this call. */
    suspend fun refresh(): JSONObject = withContext(Dispatchers.IO) {
        try { synchronized(lock) {
            if (!session.remotelyAdmitted() || account == null || session.accountId() != account) {
                throw NexusOriginError(503, "E_REMOTE_UNAVAILABLE")
            }
            if (active == null) {
                if (!root.isDirectory && !root.mkdirs()) throw LocalStateError("E_CATALOG_IO", "catalog could not be saved")
                root.listFiles { candidate -> candidate.name.startsWith("candidate-") }?.forEach {
                    if (!it.delete()) throw LocalStateError("E_CATALOG_IO", "interrupted catalog save could not be removed")
                }
                val candidate = File.createTempFile("candidate-", ".json", root)
                val output = object : FilterOutputStream(candidate.outputStream()) {
                    override fun write(bytes: ByteArray, offset: Int, count: Int) {
                        try { out.write(bytes, offset, count) }
                        catch (failure: IOException) { throw LocalStateError("E_CATALOG_IO", "catalog could not be saved") }
                    }
                    override fun close() = synchronized(lock) {
                        super.close()
                        streams.remove(this)
                        Unit
                    }
                }
                streams += output
                val owner = account!!
                val current = generation
                active = scope.launch(start = CoroutineStart.LAZY) { acquire(candidate, output, owner, current) }
                error = null
                publishLocked()
                active!!.start()
            }
            statusLocked()
        } } catch (failure: LocalStateError) { throw failure }
        catch (failure: IOException) { throw LocalStateError("E_CATALOG_IO", "catalog could not be saved") }
    }

    private suspend fun acquire(candidate: File, output: java.io.OutputStream, owner: UUID, current: Long) {
        try {
            load()
            output.use {
                try { origin.catalog(it) }
                catch (failure: LocalStateError) { throw failure }
                catch (failure: IOException) { throw LocalStateError("E_UNAVAILABLE", "catalog could not be updated") }
            }
            val next = candidate.inputStream().use { validate(it, owner, candidate.length()) }
            synchronized(lock) {
                if (generation != current || account != owner || session.accountId() != owner) return
                var output: java.io.FileOutputStream? = null
                try {
                    output = file.startWrite()
                    candidate.inputStream().use { it.copyTo(output) }
                    output.fd.sync()
                    file.finishWrite(output)
                    // AtomicFile logs rename failures rather than throwing them.
                    if (file.baseFile.length() != candidate.length() || header("snapshot_id") != next.getString("snapshot_id")) {
                        throw IOException("catalog publication failed")
                    }
                } catch (failure: IOException) {
                    output?.let(file::failWrite)
                    loaded = false
                    snapshot = null
                    throw failure
                }
                snapshot = next
                loaded = true
                error = null
            }
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            load()
            synchronized(lock) {
                if (generation == current && account == owner) error = errorView(failure)
            }
        } finally {
            var cleanupError: IOException? = null
            try { output.close() } catch (failure: IOException) { cleanupError = failure }
            if (candidate.exists() && !candidate.delete()) cleanupError = IOException("catalog candidate could not be removed")
            synchronized(lock) {
                if (generation == current && account == owner) {
                    cleanupError?.let { error = errorView(it) }
                    active = null
                    publishLocked()
                }
            }
        }
    }

    private suspend fun load() = validation.withLock {
        var problem: JSONObject? = null
        val captured = synchronized(lock) {
            if (loaded || account == null || session.accountId() != account) return@withLock
            val input = try { register(file.openRead()) } catch (failure: IOException) {
                if (failure !is FileNotFoundException || file.baseFile.exists()) problem = errorView(failure)
                null
            }
            Triple(account!!, generation, input)
        }
        var next: JSONObject? = null
        try {
            captured.third?.use { next = validate(it, captured.first, file.baseFile.length()) }
        } catch (failure: Exception) {
            problem = errorView(failure)
        }
        synchronized(lock) {
            if (generation == captured.second && account == captured.first && session.accountId() == account) {
                snapshot = next
                error = problem
                loaded = true
            }
        }
    }

    suspend fun open(): InputStream? = withContext(Dispatchers.IO) {
        load()
        synchronized(lock) {
            if (account == null || session.accountId() != account) throw LocalStateError("E_LOCAL_STATE_UNBOUND", "sign in first")
            if (snapshot == null) {
                error?.let { throw LocalStateError(it.getString("code"), it.getString("message")) }
                null
            } else register(file.openRead())
        }
    }

    private fun register(input: InputStream): InputStream {
        val stream = object : FilterInputStream(input) {
            override fun close() = synchronized(lock) {
                super.close()
                streams.remove(this)
                Unit
            }
        }
        streams += stream
        return stream
    }

    fun retire() = synchronized(lock) {
        generation++
        account = null
        active?.cancel()
        active = null
        snapshot = null
        error = null
        loaded = false
        streams.toList().forEach {
            try { it.close() } catch (problem: IOException) { retirementFailure = problem }
        }
        publishLocked()
    }

    suspend fun purge() = withContext(Dispatchers.IO) {
        retire()
        synchronized(lock) {
            if (retirementFailure != null) {
                retirementFailure = null
                throw LocalStateError("E_LOCAL_CLEANUP", "catalog streams could not be closed")
            }
            if (root.exists() && !root.deleteRecursively()) throw LocalStateError("E_LOCAL_CLEANUP", "saved catalog could not be removed")
        }
    }

    private fun reader(input: InputStream) = JsonReader(InputStreamReader(input,
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)))

    private fun header(name: String): String? = reader(file.openRead()).use { json ->
        json.beginObject()
        while (json.hasNext()) {
            if (json.nextName() != "data") { json.skipValue(); continue }
            json.beginObject()
            while (json.hasNext()) {
                if (json.nextName() == name) return@use json.nextString()
                json.skipValue()
            }
            json.endObject()
        }
        null
    }

    private fun validate(input: InputStream, owner: UUID, bytes: Long): JSONObject {
        if (bytes > MAX_CATALOG_BYTES) throw LocalStateError("E_CATALOG_TOO_LARGE", "catalog exceeds this device’s size limit")
        try {
            reader(input).use { json ->
                var found = false
                var identity: UUID? = null
                var id: String? = null
                var captured: String? = null
                var format: Int? = null
                var wire: Int? = null
                var consumptionRevision: String? = null
                json.beginObject()
                while (json.hasNext()) {
                    require(json.nextName() == "data" && !found)
                    found = true
                    json.beginObject()
                    val keys = HashSet<String>()
                    while (json.hasNext()) {
                        val key = json.nextName()
                        require(keys.add(key))
                        when (key) {
                            "format_version" -> format = json.nextInt()
                            "wire_revision" -> wire = json.nextInt()
                            "consumption_revision" -> {
                                require(json.peek() == JsonToken.STRING)
                                consumptionRevision = json.nextString()
                                require(consumptionRevision.matches(Regex("[1-9][0-9]{0,18}")))
                                require(consumptionRevision.toLongOrNull()?.let { it > 0 } == true)
                            }
                            "account_id" -> identity = UUID.fromString(json.nextString())
                            "snapshot_id" -> id = UUID.fromString(json.nextString()).toString()
                            "captured_at" -> {
                                captured = json.nextString()
                                require(OffsetDateTime.parse(captured).offset == ZoneOffset.UTC)
                            }
                            else -> json.skipValue()
                        }
                    }
                    json.endObject()
                }
                json.endObject()
                require(json.peek() == JsonToken.END_DOCUMENT && found && identity == owner && id != null && captured != null && format != null && wire != null)
                if (format != 2 || wire != BuildConfig.NEXUS_WIRE) throw LocalStateError("E_CATALOG_INCOMPATIBLE", "connect to rebuild this device’s catalog")
                require(consumptionRevision != null)
                return JSONObject().put("snapshot_id", id).put("captured_at", captured).put("consumption_revision", consumptionRevision)
            }
        } catch (failure: LocalStateError) { throw failure }
        catch (failure: Exception) { throw LocalStateError("E_CATALOG_INVALID", "saved catalog is invalid") }
    }

    private fun errorView(value: Exception): JSONObject = JSONObject()
        .put("code", when (value) {
            is LocalStateError -> value.code
            is NexusOriginError -> value.code ?: "E_REMOTE"
            else -> "E_CATALOG_IO"
        })
        .put("message", when (value) {
            is LocalStateError -> value.message
            is NexusOriginError -> "catalog could not be updated"
            else -> "catalog could not be read or saved"
        })
}
