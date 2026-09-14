package app.nexus.android.offline.reading

import android.net.Network
import android.os.StatFs
import app.nexus.android.BuildConfig
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.util.Base64
import java.util.UUID

internal class OfflineReadingOriginException(
    val reason: ReadingFailureReason,
    cause: Throwable? = null,
) : Exception(reason.name, cause)

/**
 * The owned origin refused this attempt for its own read capacity. It admitted no
 * work, so nothing about the transfer is wrong and nothing was consumed: the
 * transfer returns to the queue instead of failing.
 */
internal class OfflineReadingCapacityRefusedException : Exception("E_READ_CAPACITY")

internal sealed interface OfflineReadingDownloadResult {
    data object Preparing : OfflineReadingDownloadResult
    data class Downloaded(val artifact: OfflineReadingTransferArtifact) : OfflineReadingDownloadResult
}

/**
 * Package download (install steps 2-4) and reader-state baseline (install step 6) are
 * separate calls so the job can run package verification (install step 5) between them:
 * a package that fails verification never triggers an authenticated baseline round-trip.
 */
internal interface OfflineReadingOriginClient {
    fun selectLegacyGeneration(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        operation: OfflineReadingTransferOperation,
    ): Long

    fun downloadPackage(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        destination: File,
        operation: OfflineReadingTransferOperation,
        onProgress: (receivedBytes: Long, totalBytes: Long) -> Unit,
    ): OfflineReadingDownloadResult

    fun fetchBaseline(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        operation: OfflineReadingTransferOperation,
    ): AttestedOfflineReaderBaseline
}

internal class HttpOfflineReadingOriginClient(
    private val clock: Clock = Clock.systemUTC(),
    private val createSession: (Network) -> OfflineReadingHttpSession = { network ->
        OfflineReadingHttpSessionFactory.create(network)
    },
) : OfflineReadingOriginClient {
    override fun selectLegacyGeneration(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        operation: OfflineReadingTransferOperation,
    ): Long {
        try {
            require(transfer.readerGeneration == null)
            val session = createSession(network)
            val request = Request.Builder()
                .url(session.hostedOrigin.newBuilder().addPathSegments("api/media/${transfer.mediaId}/reader-publication").build())
                .header("Cookie", session.cookieStore.requireCookies(session.hostedOrigin))
                .header("X-Nexus-Expected-Account-Id", accountId.toString())
                .header("Accept-Encoding", "identity")
                .build()
            return operation.execute(session.client.newCall(request)) { response ->
                installOfflineReadingOwnedOriginCookies(response, session.hostedOrigin, session.cookieStore)
                requireSuccess(response)
                val body = response.body?.readBoundedJson(OFFLINE_READING_MAX_DESCRIPTOR_BYTES)
                    ?: error("publication descriptor is missing")
                val fields = (StrictJson.parse(body) as StrictJson.ObjectValue).fields
                require(fields.getValue("media_id").requireString() == transfer.mediaId.toString())
                require(
                    fields.getValue("reader_contract_version").requireLong() ==
                        OFFLINE_READING_READER_CONTRACT_VERSION.toLong()
                )
                fields.getValue("reader_generation").requireLong().also { require(it > 0) }
            }
        } catch (error: Exception) {
            throw error.asOfflineReadingOriginException()
        }
    }

    override fun downloadPackage(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        destination: File,
        operation: OfflineReadingTransferOperation,
        onProgress: (receivedBytes: Long, totalBytes: Long) -> Unit,
    ): OfflineReadingDownloadResult {
        try {
            val session = createSession(network)
            val generation = requireNotNull(transfer.readerGeneration)
            if (transfer.preparationStartedAt != null) {
                // justify-polling: archive preparation runs in a server worker and the native
                // transfer has no completion channel to subscribe to, so each job attempt reads
                // status once and returns Preparing. The cadence is not this client's: it is the
                // JobScheduler exponential backoff set in OfflineReadingScheduler.buildJob
                // (setBackoffCriteria(DEFAULT_INITIAL_BACKOFF_MILLIS, BACKOFF_POLICY_EXPONENTIAL)),
                // and OFFLINE_READING_PREPARATION_MAX_AGE below terminates the observation.
                // A stopped observation remains durable; an explicit Retry starts a new observation window.
                if (clock.instant().isAfter(transfer.preparationStartedAt.plus(OFFLINE_READING_PREPARATION_MAX_AGE))) {
                    throw OfflineReadingOriginException(ReadingFailureReason.Server)
                }
                if (!packageIsReady(session, transfer.mediaId, accountId, generation, operation)) {
                    return OfflineReadingDownloadResult.Preparing
                }
            }
            val token = mintToken(
                session.client,
                session.hostedOrigin,
                session.cookieStore,
                transfer.mediaId,
                accountId,
                generation,
                operation,
            ) ?: return OfflineReadingDownloadResult.Preparing
            return OfflineReadingDownloadResult.Downloaded(downloadPackage(
                offlineReadingPackageClient(session.client),
                token,
                accountId,
                transfer.mediaId,
                destination,
                operation,
                onProgress,
            ))
        } catch (error: Exception) {
            destination.delete()
            throw error.asOfflineReadingOriginException()
        }
    }

    override fun fetchBaseline(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        operation: OfflineReadingTransferOperation,
    ): AttestedOfflineReaderBaseline {
        try {
            val session = createSession(network)
            return fetchBaseline(
                session.client,
                session.hostedOrigin,
                session.cookieStore,
                transfer.mediaId,
                accountId,
                operation,
            )
        } catch (error: Exception) {
            throw error.asOfflineReadingOriginException()
        }
    }

    private fun Exception.asOfflineReadingOriginException(): OfflineReadingOriginException =
        when (this) {
            is OfflineReadingOriginException -> this
            // Not a transfer failure at all: it stays queued, so it must not be
            // laundered into one on its way out of this client.
            is OfflineReadingCapacityRefusedException -> throw this
            is OfflineReadingCookieUnavailableException ->
                OfflineReadingOriginException(ReadingFailureReason.AuthorizationRequired, this)
            is IllegalArgumentException, is IllegalStateException, is ClassCastException, is NoSuchElementException ->
                OfflineReadingOriginException(ReadingFailureReason.Integrity, this)
            is IOException -> OfflineReadingOriginException(ReadingFailureReason.Network, this)
            else -> OfflineReadingOriginException(ReadingFailureReason.RecoveryRequired, this)
        }

    private fun mintToken(
        client: OkHttpClient,
        hostedOrigin: HttpUrl,
        cookieStore: OfflineReadingOwnedOriginCookieStore,
        mediaId: UUID,
        accountId: UUID,
        generation: Long,
        operation: OfflineReadingTransferOperation,
    ): MintedPackageToken? {
        val request = Request.Builder()
            .url(hostedOrigin.newBuilder().addPathSegments("api/media/$mediaId/offline-reading-token").build())
            .post("{\"expected_reader_generation\":$generation}".toRequestBody("application/json".toMediaType()))
            .header("Cookie", cookieStore.requireCookies(hostedOrigin))
            .header("X-Nexus-Expected-Account-Id", accountId.toString())
            .header("Accept-Encoding", "identity")
            .offlineReadingOwnedOrigin(hostedOrigin)
            .build()
        return operation.execute(client.newCall(request)) { response ->
            installOfflineReadingOwnedOriginCookies(
                response,
                hostedOrigin,
                cookieStore,
            )
            requireSuccess(response)
            val body = response.body?.readBoundedJson() ?: error("offline reading token body is missing")
            val envelope = StrictJson.parse(body).requireObject(setOf("data"))
            if (response.code == 202) {
                val pending = envelope.getValue("data").requireObject(setOf("reader_generation", "status_path"))
                require(pending.getValue("reader_generation").requireLong() == generation)
                require(pending.getValue("status_path").requireString() ==
                    "/media/$mediaId/reader-publications/$generation/offline-package?schema=2")
                return@execute null
            }
            val data = envelope.getValue("data").requireObject(
                setOf(
                    "token",
                    "package_base_url",
                    "account_id",
                    "reader_generation",
                    "package_schema_version",
                    "expires_at",
                )
            )
            val attestedAccountText = data.getValue("account_id").requireString()
            val attestedAccount = UUID.fromString(attestedAccountText)
            require(attestedAccount.toString() == attestedAccountText && attestedAccount == accountId)
            if (
                data.getValue("package_schema_version").requireLong() !=
                OFFLINE_READING_PACKAGE_SCHEMA_VERSION.toLong()
            ) {
                throw OfflineReadingOriginException(ReadingFailureReason.UnsupportedPackage)
            }
            require(data.getValue("reader_generation").requireLong() == generation)
            Instant.parse(data.getValue("expires_at").requireString())
            val packageOrigin = data.getValue("package_base_url").requireString().toHttpUrl()
                .requireOfflineReadingOrigin()
            require(
                packageOrigin == BuildConfig.NEXUS_API_ORIGIN.toHttpUrl()
                    .requireOfflineReadingOrigin()
            )
            MintedPackageToken(
                token = data.getValue("token").requireString().also { require(it.isNotBlank()) },
                packageOrigin = packageOrigin,
                readerGeneration = generation,
            )
        }
    }

    private fun packageIsReady(
        session: OfflineReadingHttpSession,
        mediaId: UUID,
        accountId: UUID,
        generation: Long,
        operation: OfflineReadingTransferOperation,
    ): Boolean {
        val request = Request.Builder()
            .url(session.hostedOrigin.newBuilder()
                .addPathSegments("api/media/$mediaId/reader-publications/$generation/offline-package")
                .addQueryParameter("schema", "2").build())
            .header("Cookie", session.cookieStore.requireCookies(session.hostedOrigin))
            .header("X-Nexus-Expected-Account-Id", accountId.toString())
            .header("Accept-Encoding", "identity")
            .build()
        return operation.execute(session.client.newCall(request)) { response ->
            installOfflineReadingOwnedOriginCookies(response, session.hostedOrigin, session.cookieStore)
            requireSuccess(response)
            val body = response.body?.readBoundedJson() ?: error("package preparation status is missing")
            val root = StrictJson.parse(body).requireObject(setOf("data"))
            val data = root.getValue("data").requireObject(setOf("reader_generation", "state"))
            require(data.getValue("reader_generation").requireLong() == generation)
            val stateValue = data.getValue("state")
            val state = (stateValue as StrictJson.ObjectValue).fields
            when (state.getValue("kind").requireString()) {
                "Preparing" -> { stateValue.requireObject(setOf("kind")); false }
                "Ready" -> { stateValue.requireObject(setOf("kind")); true }
                "Failed" -> {
                    stateValue.requireObject(setOf("kind", "reason"))
                    throw OfflineReadingOriginException(ReadingFailureReason.valueOf(state.getValue("reason").requireString()))
                }
                else -> error("unknown package preparation status")
            }
        }
    }

    private fun downloadPackage(
        client: OkHttpClient,
        token: MintedPackageToken,
        accountId: UUID,
        mediaId: UUID,
        destination: File,
        operation: OfflineReadingTransferOperation,
        onProgress: (Long, Long) -> Unit,
    ): OfflineReadingTransferArtifact {
        val request = Request.Builder()
            .url(token.packageOrigin.newBuilder().addPathSegments("offline-reading/packages/$mediaId").build())
            .get()
            .header("Authorization", "Bearer ${token.token}")
            .header("Accept-Encoding", "identity")
            .build()
        return operation.execute(client.newCall(request)) { response ->
            requireSuccess(response)
            require(response.priorResponse == null && !response.isRedirect)
            require(response.header("Content-Encoding") == null)
            require(response.header("Transfer-Encoding") == null)
            require(
                response.header("Content-Type")?.substringBefore(';') ==
                    "application/vnd.nexus.offline-reading+zip"
            )
            val contentLength = response.header("Content-Length")?.toLongOrNull()
                ?: error("offline reading package length is missing")
            if (contentLength !in 1..OFFLINE_READING_MAX_ARCHIVE_BYTES) {
                throw OfflineReadingOriginException(ReadingFailureReason.TooLarge)
            }
            val expandedLength = response.header("Nexus-Expanded-Length")?.toLongOrNull()
                ?: error("offline reading expanded length is missing")
            if (expandedLength !in 1..OFFLINE_READING_MAX_EXPANDED_BYTES) {
                throw OfflineReadingOriginException(ReadingFailureReason.TooLarge)
            }
            val responseAccountText = response.header("Nexus-Account-Id")
                ?: error("offline reading package account is missing")
            val responseAccount = UUID.fromString(responseAccountText)
            require(responseAccount.toString() == responseAccountText && responseAccount == accountId)
            val responseGeneration = response.header("Nexus-Reader-Generation")?.toLongOrNull()
                ?: error("offline reading package generation is missing")
            require(responseGeneration == token.readerGeneration)
            val expectedDigest = parseContentDigest(
                response.header("Content-Digest")
                    ?: error("offline reading package digest is missing")
            )
            if (
                !OfflineReadingStorageAdmission.canAdmit(
                    StatFs(destination.parentFile!!.absolutePath).availableBytes,
                    contentLength,
                    expandedLength,
                )
            ) {
                throw OfflineReadingOriginException(ReadingFailureReason.LowSpace)
            }
            // The store creates staging under its account monitor. A retired download
            // must not recreate that ancestry after account purge.
            val stagingParent = checkNotNull(destination.parentFile)
            if (!stagingParent.isDirectory) throw java.io.FileNotFoundException(stagingParent.path)
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            val body = response.body ?: error("offline reading package body is missing")
            body.byteStream().use { input ->
                FileOutputStream(destination).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        received = Math.addExact(received, read.toLong())
                        require(received <= contentLength)
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                        onProgress(received, contentLength)
                    }
                    output.fd.sync()
                }
            }
            require(received == contentLength)
            val actualDigest = digest.digest()
            require(MessageDigest.isEqual(actualDigest, expectedDigest))
            OfflineReadingTransferArtifact(
                destination,
                accountId,
                responseGeneration,
                contentLength,
                expandedLength,
                actualDigest.toHex(),
            )
        }
    }

    private fun fetchBaseline(
        client: OkHttpClient,
        hostedOrigin: HttpUrl,
        cookieStore: OfflineReadingOwnedOriginCookieStore,
        mediaId: UUID,
        accountId: UUID,
        operation: OfflineReadingTransferOperation,
    ): AttestedOfflineReaderBaseline {
        val request = Request.Builder()
            .url(hostedOrigin.newBuilder().addPathSegments("api/media/$mediaId/offline-reader-state").build())
            .get()
            .header("Cookie", cookieStore.requireCookies(hostedOrigin))
            .header("X-Nexus-Expected-Account-Id", accountId.toString())
            .header("Accept-Encoding", "identity")
            .build()
        return operation.execute(client.newCall(request)) { response ->
            installOfflineReadingOwnedOriginCookies(response, hostedOrigin, cookieStore)
            requireSuccess(response)
            val headerAccount = response.header("Nexus-Account-Id")
                ?: error("offline reader-state account header is missing")
            require(UUID.fromString(headerAccount).toString() == headerAccount)
            require(UUID.fromString(headerAccount) == accountId)
            val attestedGeneration = response.header("Nexus-Reader-Generation")?.toLongOrNull()
                ?: error("offline reader-state generation header is missing")
            require(attestedGeneration > 0)
            val body = response.body?.readBoundedJson() ?: error("offline reader-state body is missing")
            val envelope = StrictJson.parse(body).requireObject(setOf("data"))
            val data = envelope.getValue("data").requireObject(
                setOf("accountId", "readerGeneration", "cursor")
            )
            require(data.getValue("accountId").requireString() == accountId.toString())
            require(data.getValue("readerGeneration").requireLong() == attestedGeneration)
            AttestedOfflineReaderBaseline(
                accountId,
                attestedGeneration,
                data.getValue("cursor").toJson(),
            )
        }
    }

    private fun requireSuccess(response: Response) {
        if (response.isSuccessful) return
        val body = response.body?.readBoundedJson() ?: byteArrayOf()
        val errorCode = runCatching {
            val root = StrictJson.parse(body).requireObject(setOf("error"))
            val error = root.getValue("error") as StrictJson.ObjectValue
            require(error.fields.keys.containsAll(setOf("code", "message")))
            require(error.fields.keys.all { it in setOf("code", "message", "request_id", "details") })
            error.fields.getValue("code").requireString()
        }.getOrNull()
        throw when (val refusal = offlineReadingRefusal(response.code, errorCode)) {
            is ReadingRefusal.Fail -> OfflineReadingOriginException(refusal.reason)
            ReadingRefusal.Capacity -> OfflineReadingCapacityRefusedException()
        }
    }

    private fun parseContentDigest(header: String): ByteArray {
        val match = Regex("sha-256=:([A-Za-z0-9+/]{43}=):").matchEntire(header)
            ?: error("offline reading package Content-Digest is invalid")
        return Base64.getDecoder().decode(match.groupValues[1]).also { require(it.size == 32) }
    }

    private data class MintedPackageToken(
        val token: String,
        val packageOrigin: HttpUrl,
        val readerGeneration: Long,
    )

}

/** How one refused owned-origin response settles the transfer that made it. */
internal sealed interface ReadingRefusal {
    /** The transfer stops here and the shelf shows [reason]. */
    data class Fail(val reason: ReadingFailureReason) : ReadingRefusal

    /**
     * The route admitted no work for its own read capacity. The transfer is still
     * runnable and stays queued; it must never become a terminal failure.
     */
    data object Capacity : ReadingRefusal
}

internal fun offlineReadingRefusal(status: Int, errorCode: String?): ReadingRefusal =
    when (errorCode) {
        "E_READ_CAPACITY" -> ReadingRefusal.Capacity
        "E_UNAUTHENTICATED", "E_FORBIDDEN" -> ReadingRefusal.Fail(ReadingFailureReason.AuthorizationRequired)
        "E_MEDIA_NOT_FOUND", "E_NOT_FOUND" -> ReadingRefusal.Fail(ReadingFailureReason.SourceUnavailable)
        "E_READER_CONTENT_CHANGED" -> ReadingRefusal.Fail(ReadingFailureReason.ContentChanged)
        "E_FILE_TOO_LARGE", "E_SOURCE_TOO_LARGE" -> ReadingRefusal.Fail(ReadingFailureReason.TooLarge)
        "E_READER_PUBLICATION_BUSY" -> ReadingRefusal.Fail(ReadingFailureReason.Server)
        else -> ReadingRefusal.Fail(
            when (status) {
                401, 403 -> ReadingFailureReason.AuthorizationRequired
                404, 410 -> ReadingFailureReason.SourceUnavailable
                409 -> ReadingFailureReason.ContentChanged
                413 -> ReadingFailureReason.TooLarge
                in 500..599 -> ReadingFailureReason.Server
                else -> ReadingFailureReason.Network
            }
        )
    }
