package app.nexus.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.webkit.CookieManager
import androidx.core.util.AtomicFile
import app.nexus.android.offline.OfflineStore
import app.nexus.android.offline.OfflineJobService
import app.nexus.android.playback.ActivityOutbox
import app.nexus.android.playback.PlaybackStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume

internal class LocalStateError(val code: String, message: String) : IOException(message)

/**
 * The device's account authority and durable navigation record. File operations
 * serialize on IO; credential operations serialize separately, including cookie
 * callbacks. Neither lock spans the other's network or auth UI. A lifetime is
 * retired before sign-out drains effects; callbacks recheck it on the UI thread.
 * Workspace retries compare the committed revision, not a replay ledger.
 */
internal class DeviceSession private constructor(private val context: Context) {
    companion object {
        @Volatile private var instance: DeviceSession? = null
        fun current(): DeviceSession? = instance
        fun get(context: Context): DeviceSession = instance ?: synchronized(this) {
            instance ?: DeviceSession(context.applicationContext).also { instance = it }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val files = Mutex()
    private val credentials = Mutex()
    private val file = AtomicFile(File(context.filesDir, "device-startup.json"))
    private val lifetime = AtomicLong(0)
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val origin = NexusOriginClient()
    private var loaded = false
    private var cleanupCompleted = false
    private var envelope: JSONObject? = null
    private var loadError: LocalStateError? = null
    @Volatile private var signingOut = false
    private var signOutJob: kotlinx.coroutines.Deferred<Unit>? = null
    @Volatile private var account: UUID? = null
    @Volatile var remoteAdmission = "Checking"
        private set
    private var check: kotlinx.coroutines.Deferred<String>? = null
    private var refreshAt: Long? = null
    @Volatile private var foreground = false
    @Volatile private var playbackActive = false
    @Volatile private var attempt: Attempt? = null
    private var upload: Upload? = null
    private var playbackStop: (suspend () -> Unit)? = null
    private val renew = Runnable { scope.launch { checkSession() } }

    internal class Attempt(val verifier: String, val challenge: String, val generation: Long) {
        val result = CompletableDeferred<String>()
    }
    private class Upload(val id: String, val document: String, val account: UUID,
                         val revision: String, val bytes: Int) {
        val body = ByteArrayOutputStream()
    }

    init {
        context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                        scope.launch { checkSession() }
                    }
                }
            },
        )
    }

    fun accountId(): UUID? = if (signingOut) null else account
    fun remotelyAdmitted(): Boolean = !signingOut && remoteAdmission == "Ready" && account != null
    fun requestCheck() { scope.launch { checkSession() } }
    fun subscribe(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }
    private fun publish() { main.post { listeners.forEach { it() } } }
    private fun admission(value: String) {
        remoteAdmission = value
        publish()
    }

    /** A null binding is a durable cleanup obligation, completed before any account is exposed. */
    suspend fun initialize() = withContext(Dispatchers.IO) {
        files.withLock {
            if (!loaded) {
                loadError = null
                try {
                    val raw = try { file.readFully() } catch (error: FileNotFoundException) {
                        if (file.baseFile.exists()) throw error else null
                    }
                    envelope = raw?.let { validate(parseObject(it)) }
                    if (envelope?.isNull("binding") == true) signingOut = true
                    account = envelope?.optJSONObject("binding")?.getJSONObject("account")
                        ?.getString("account_id")?.let(UUID::fromString)
                } catch (error: Exception) {
                    loadError = when (error) {
                        is java.nio.charset.CharacterCodingException -> LocalStateError("E_LOCAL_STATE_INVALID", "saved workspace is invalid")
                        is IOException -> LocalStateError("E_LOCAL_STATE_IO", "saved workspace could not be read")
                        else -> LocalStateError("E_LOCAL_STATE_INVALID", "saved workspace is invalid")
                    }
                }
                loaded = loadError == null
            }
            loadError?.let { throw it }
        }
        if (!cleanupCompleted && envelope?.isNull("binding") == true) {
            credentials.withLock {
                if (!cleanupCompleted && files.withLock { envelope?.isNull("binding") == true }) {
                    admission("SignInRequired")
                    try {
                        withContext(Dispatchers.Main.immediate) { playbackStop?.invoke() }
                        cleanup(stopJobs = false)
                    }
                    catch (error: IOException) { throw LocalStateError("E_LOCAL_CLEANUP", error.message ?: "sign out cleanup failed") }
                    cleanupCompleted = true
                    signingOut = false
                }
            }
        }
    }

    suspend fun startup(): JSONObject? {
        initialize()
        if (signingOut) throw LocalStateError("E_LOCAL_CLEANUP", "sign out not completed; retry sign out")
        return files.withLock { envelope?.let { JSONObject(it.toString()) } }
    }

    private fun validate(value: JSONObject): JSONObject {
        require(value.get("format_version") == 1)
        require(value.has("binding"))
        if (!value.isNull("binding")) {
            val binding = value.getJSONObject("binding")
            UUID.fromString(binding.getJSONObject("account").getString("account_id"))
            require(binding.getJSONObject("account").getString("calendar_time_zone").isNotEmpty())
            binding.getJSONObject("reader_profile")
            binding.getJSONObject("workspace")
            require(binding.get("workspace_revision") is String)
            require(Regex("0|[1-9][0-9]*").matches(binding.getString("workspace_revision")))
        }
        return value
    }

    private fun parseObject(bytes: ByteArray): JSONObject {
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        val json = JSONTokener(text)
        val value = json.nextValue() as? JSONObject ?: throw JSONException("expected object")
        require(json.nextClean() == '\u0000')
        return value
    }

    private fun persist(value: JSONObject) {
        val bytes = value.toString().toByteArray(Charsets.UTF_8)
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(bytes)
            stream.fd.sync()
            file.finishWrite(stream)
            if (!file.readFully().contentEquals(bytes)) throw IOException("workspace publication failed")
            envelope = value
        } catch (error: IOException) {
            stream?.let(file::failWrite)
            throw LocalStateError("E_LOCAL_STATE_IO", "workspace could not be saved")
        }
    }

    suspend fun workspaceBegin(document: String, revision: String, bytes: Int, currentDocument: () -> Boolean): String = withContext(Dispatchers.IO) {
        initialize()
        files.withLock {
            require(currentDocument())
            require(bytes >= 0 && Regex("0|[1-9][0-9]*").matches(revision))
            val owner = account ?: throw LocalStateError("E_LOCAL_STATE_UNBOUND", "sign in first")
            val id = UUID.randomUUID().toString()
            upload = Upload(id, document, owner, revision, bytes)
            id
        }
    }

    suspend fun workspaceChunk(document: String, id: String, offset: Int, encoded: String): Int = withContext(Dispatchers.IO) {
        files.withLock {
            val current = upload ?: throw IllegalArgumentException("no workspace upload")
            require(current.id == id && current.document == document && current.account == account)
            val bytes = Base64.decode(encoded, Base64.DEFAULT)
            require(bytes.size <= 24 * 1024 && offset == current.body.size())
            require(bytes.size <= current.bytes - offset)
            current.body.write(bytes)
            current.body.size()
        }
    }

    suspend fun workspaceCommit(document: String, id: String, currentDocument: () -> Boolean): String = withContext(Dispatchers.IO) {
        files.withLock {
            val transfer = upload ?: throw IllegalArgumentException("no workspace upload")
            require(transfer.id == id && transfer.document == document && currentDocument())
            require(transfer.account == account && transfer.body.size() == transfer.bytes)
            val workspace = parseObject(transfer.body.toByteArray())
            val current = envelope?.getJSONObject("binding") ?: throw IllegalArgumentException("no binding")
            if (current.getString("workspace_revision") != transfer.revision) {
                throw LocalStateError("E_LOCAL_STATE_CONFLICT", "workspace revision changed")
            }
            val changed = current.getJSONObject("workspace").toString() != workspace.toString()
            val revision = if (changed) BigInteger(transfer.revision).add(BigInteger.ONE).toString() else transfer.revision
            if (changed) {
                val next = JSONObject(envelope.toString())
                next.getJSONObject("binding").put("workspace", workspace).put("workspace_revision", revision)
                persist(next)
            }
            upload = null
            revision
        }
    }

    fun documentExited(document: String) { scope.launch { files.withLock { if (upload?.document == document) upload = null } } }

    fun setForeground(value: Boolean) {
        foreground = value
        if (value) requestCheck() else if (!playbackActive) main.removeCallbacks(renew)
    }

    fun setPlaybackActive(value: Boolean) {
        playbackActive = value
        if (value) requestCheck() else if (!foreground) main.removeCallbacks(renew)
    }

    /** Concurrent foreground, network and 401 checks join one bootstrap. */
    suspend fun checkSession(): String {
        if (signingOut) return "SignInRequired"
        val running = synchronized(this) {
            check?.takeIf { !it.isCompleted } ?: scope.async { refresh() }.also { check = it }
        }
        return running.await()
    }

    private suspend fun refresh(): String {
        val generation = lifetime.get()
        try {
            initialize()
            return credentials.withLock {
                if (signingOut || lifetime.get() != generation) return@withLock remoteAdmission
                admission("Checking")
                bootstrap(generation)
                remoteAdmission
            }
        } catch (error: NexusOriginError) {
            if (lifetime.get() != generation) return remoteAdmission
            admission(when (error.status) { 401 -> "SignInRequired"; 426 -> "UpdateRequired"; else -> "Unavailable" })
        } catch (_: IOException) {
            if (lifetime.get() != generation) return remoteAdmission
            admission("Unavailable")
        } catch (_: JSONException) {
            if (lifetime.get() != generation) return remoteAdmission
            admission("Unavailable")
        } catch (_: IllegalArgumentException) {
            if (lifetime.get() != generation) return remoteAdmission
            admission("Unavailable")
        }
        return remoteAdmission
    }

    private suspend fun bootstrap(generation: Long, current: () -> Boolean = { lifetime.get() == generation }) {
        files.withLock { expectedAccount() }
        val started = SystemClock.elapsedRealtime()
        val data = origin.bootstrap(current)
        if (signingOut || !current()) throw IOException("retired session")
        val remoteAccount = UUID.fromString(data.getJSONObject("account").getString("account_id"))
        val refresh = data.getLong("refresh_after_ms")
        require(refresh >= 0)
        files.withLock {
            if (signingOut || !current()) throw IOException("retired session")
            val expected = expectedAccount()
            if (expected != null && expected != remoteAccount) throw NexusOriginError(409, "E_DIFFERENT_ACCOUNT")
            val previous = envelope?.optJSONObject("binding")
            val binding = JSONObject().put("account", data.getJSONObject("account"))
                .put("reader_profile", data.getJSONObject("reader_profile"))
                .put("workspace", previous?.getJSONObject("workspace") ?: data.getJSONObject("workspace"))
                .put("workspace_revision", previous?.getString("workspace_revision") ?: "0")
            persist(validate(JSONObject().put("format_version", 1).put("binding", binding)))
            OfflineStore.get(context).bind(remoteAccount)
            account = remoteAccount
        }
        synchronized(this) {
            if (signingOut || !current()) throw IOException("retired session")
            refreshAt = started + refresh.coerceAtMost(Long.MAX_VALUE - started)
            admission("Ready")
            main.post {
                if (!signingOut && current()) {
                    main.removeCallbacks(renew)
                    if (foreground || playbackActive) main.postDelayed(renew, maxOf(0, (refreshAt ?: 0) - SystemClock.elapsedRealtime()))
                }
            }
        }
    }

    /** Cached namespaces preserve data during first provisioning; only the verified root grants authority. */
    private fun expectedAccount(): UUID? {
        account?.let { return it }
        val cached = PlaybackStore.cachedAccounts(context).toMutableSet()
        OfflineStore.get(context).account?.let(cached::add)
        cached += ActivityOutbox(File(context.filesDir, "player/spans.json")).cachedAccounts()
        if (cached.size > 1) throw NexusOriginError(409, "E_DIFFERENT_ACCOUNT")
        return cached.singleOrNull()
    }

    suspend fun newAttempt(): Attempt = withContext(Dispatchers.IO) {
        initialize()
        credentials.withLock {
            if (signingOut) throw LocalStateError("E_LOCAL_CLEANUP", "finish signing out before signing in")
            expectedAccount()
            attempt?.result?.complete("Cancelled")
            val verifier = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) },
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            val challenge = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            Attempt(verifier, challenge, lifetime.get()).also { attempt = it }
        }
    }

    fun currentAttempt(challenge: String?): Attempt? = attempt?.takeIf { it.challenge == challenge && it.generation == lifetime.get() }

    fun cancelAttempt(current: Attempt) {
        if (attempt !== current) return
        attempt = null
        current.result.complete("Cancelled")
    }

    suspend fun redeem(challenge: String?, code: String?): String = withContext(NonCancellable + Dispatchers.IO) {
        credentials.withLock {
            val current = currentAttempt(challenge) ?: return@withLock "Cancelled"
            val ownsAttempt = { attempt === current && lifetime.get() == current.generation }
            var result = if (code.isNullOrEmpty()) "Failed" else try {
                val expected = expectedAccount()
                origin.handoff(code, current.verifier, expected?.toString(), ownsAttempt)
                bootstrap(current.generation, ownsAttempt)
                "Restored"
            } catch (error: NexusOriginError) {
                if (error.code == "E_DIFFERENT_ACCOUNT") "DifferentAccount" else "Failed"
            } catch (_: IOException) { "Failed" }
            catch (_: JSONException) { "Failed" }
            catch (_: IllegalArgumentException) { "Failed" }
            if (!ownsAttempt()) result = "Cancelled"
            if (attempt === current) attempt = null
            current.result.complete(result)
            result
        }
    }

    suspend fun google(current: Attempt, token: String, nonce: String): String {
        if (currentAttempt(current.challenge) !== current) return "Cancelled"
        return try {
            val code = origin.google(token, nonce, current.challenge)
            redeem(current.challenge, code)
        } catch (_: Exception) {
            if (attempt === current) attempt = null
            current.result.complete("Failed")
            "Failed"
        }
    }

    /** Email is never retried here. Identity deletion is idempotent at its fixed BFF endpoint. */
    suspend fun accountOperation(op: String, value: String?): JSONObject = withContext(NonCancellable + Dispatchers.IO) {
        credentials.withLock {
            if (!remotelyAdmitted()) throw NexusOriginError(401, "E_SESSION_REQUIRED")
            val generation = lifetime.get()
            val current = { lifetime.get() == generation }
            when (op) {
                "account_email_change" -> origin.emailChange(value!!, current)
                "account_identities_get" -> origin.identities(current)
                "account_identity_delete" -> origin.deleteIdentity(value!!, current)
                else -> throw IllegalArgumentException("account operation")
            }
        }
    }

    fun ownPlaybackStop(stop: suspend () -> Unit): () -> Unit {
        playbackStop = stop
        return { if (playbackStop === stop) playbackStop = null }
    }

    /** Tombstone first; a crash repeats cleanup. Revocation is captured once and never retried. */
    suspend fun signOut() = withContext(NonCancellable + Dispatchers.IO) {
        val running = synchronized(this@DeviceSession) {
            signOutJob?.takeIf { !it.isCompleted } ?: run {
                signingOut = true
                lifetime.incrementAndGet()
                admission("SignInRequired")
                scope.async { performSignOut() }.also { signOutJob = it }
            }
        }
        try { running.await() }
        catch (error: IOException) { throw LocalStateError("E_LOCAL_CLEANUP", error.message ?: "sign out cleanup failed") }
    }

    private suspend fun performSignOut() {
        main.removeCallbacks(renew)
        attempt?.let(::cancelAttempt)
        withContext(Dispatchers.Main.immediate) { playbackStop?.invoke() }
        credentials.withLock {
            val cookie = origin.capturedCookies()
            files.withLock {
                persist(JSONObject().put("format_version", 1).put("binding", JSONObject.NULL))
                account = null
                upload = null
                cleanupCompleted = false
            }
            cleanup(stopJobs = true)
            cleanupCompleted = true
            signingOut = false
            publish()
            scope.launch { try { origin.signOut(cookie) } catch (_: Exception) { /* bounded best effort */ } }
        }
    }

    private suspend fun cleanup(stopJobs: Boolean) = withContext(NonCancellable) {
        account = null
        if (stopJobs) OfflineJobService.stopForSignOut(context)
        OfflineStore.get(context).purge()
        val player = File(context.filesDir, "player")
        if (player.exists() && !player.deleteRecursively()) throw LocalStateError("E_LOCAL_CLEANUP", "pending playback progress could not be removed")
        withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine { continuation ->
                CookieManager.getInstance().removeAllCookies {
                    CookieManager.getInstance().flush()
                    if (continuation.isActive) continuation.resume(Unit)
                }
            }
            android.webkit.WebStorage.getInstance().deleteAllData()
        }
    }
}
