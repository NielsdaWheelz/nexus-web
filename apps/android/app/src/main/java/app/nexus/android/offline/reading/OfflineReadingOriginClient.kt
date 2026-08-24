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
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID

internal class OfflineReadingOriginException(
    val reason: ReadingFailureReason,
    cause: Throwable? = null,
) : Exception(reason.name, cause)

/**
 * Package download (install steps 2-4) and reader-state baseline (install step 6) are
 * separate calls so the job can run package verification (install step 5) between them:
 * a package that fails verification never triggers an authenticated baseline round-trip.
 */
internal interface OfflineReadingOriginClient {
    fun downloadPackage(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        destination: File,
        operation: OfflineReadingTransferOperation,
        onProgress: (receivedBytes: Long, totalBytes: Long) -> Unit,
    ): OfflineReadingTransferArtifact

    fun fetchBaseline(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        readerGeneration: Long,
        operation: OfflineReadingTransferOperation,
    ): AttestedOfflineReaderBaseline
}

internal class HttpOfflineReadingOriginClient(
    private val createSession: (Network) -> OfflineReadingHttpSession = { network ->
        OfflineReadingHttpSessionFactory.create(network)
    },
) : OfflineReadingOriginClient {
    override fun downloadPackage(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        destination: File,
        operation: OfflineReadingTransferOperation,
        onProgress: (receivedBytes: Long, totalBytes: Long) -> Unit,
    ): OfflineReadingTransferArtifact {
        try {
            val session = createSession(network)
            val token = mintToken(
                session.client,
                session.hostedOrigin,
                session.cookieStore,
                transfer.mediaId,
                accountId,
                operation,
            )
            return downloadPackage(
                offlineReadingPackageClient(session.client),
                token,
                accountId,
                transfer.mediaId,
                destination,
                operation,
                onProgress,
            )
        } catch (error: Exception) {
            destination.delete()
            throw error.asOfflineReadingOriginException()
        }
    }

    override fun fetchBaseline(
        transfer: OfflineReadingTransfer,
        accountId: UUID,
        network: Network,
        readerGeneration: Long,
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
                readerGeneration,
                operation,
            )
        } catch (error: Exception) {
            throw error.asOfflineReadingOriginException()
        }
    }

    private fun Exception.asOfflineReadingOriginException(): OfflineReadingOriginException =
        when (this) {
            is OfflineReadingOriginException -> this
            is OfflineReadingCookieUnavailableException ->
                OfflineReadingOriginException(ReadingFailureReason.AuthorizationRequired, this)
            is IllegalArgumentException ->
                OfflineReadingOriginException(ReadingFailureReason.Integrity, this)
            else -> OfflineReadingOriginException(ReadingFailureReason.Network, this)
        }

    private fun mintToken(
        client: OkHttpClient,
        hostedOrigin: HttpUrl,
        cookieStore: OfflineReadingOwnedOriginCookieStore,
        mediaId: UUID,
        accountId: UUID,
        operation: OfflineReadingTransferOperation,
    ): MintedPackageToken {
        val request = Request.Builder()
            .url(hostedOrigin.newBuilder().addPathSegments("api/media/$mediaId/offline-reading-token").build())
            .post(ByteArray(0).toRequestBody("application/json".toMediaType()))
            .header("Cookie", cookieStore.requireCookies(hostedOrigin))
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
            val body = response.body?.bytes() ?: error("offline reading token body is missing")
            require(body.size <= JSON_RESPONSE_LIMIT_BYTES)
            val envelope = StrictJson.parse(body).requireObject(setOf("data"))
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
            if (data.getValue("package_schema_version").requireLong() != 1L) {
                throw OfflineReadingOriginException(ReadingFailureReason.UnsupportedPackage)
            }
            val generation = data.getValue("reader_generation").requireLong()
            require(generation > 0)
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
            // mkdirs() returns false when the directory already exists; only assert the
            // parent is a directory after ensuring it, never assert the mkdirs() result.
            val stagingParent = checkNotNull(destination.parentFile)
            stagingParent.mkdirs()
            check(stagingParent.isDirectory)
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
        generation: Long,
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
            if (attestedGeneration != generation) {
                // The publication generation moved between token mint and baseline fetch:
                // this is the typed update-during-download conflict, not corruption.
                throw OfflineReadingOriginException(ReadingFailureReason.ContentChanged)
            }
            val body = response.body?.bytes() ?: error("offline reader-state body is missing")
            require(body.size <= JSON_RESPONSE_LIMIT_BYTES)
            val envelope = StrictJson.parse(body).requireObject(setOf("data"))
            val data = envelope.getValue("data").requireObject(
                setOf("accountId", "readerGeneration", "cursor")
            )
            require(data.getValue("accountId").requireString() == accountId.toString())
            require(data.getValue("readerGeneration").requireLong() == generation)
            AttestedOfflineReaderBaseline(
                accountId,
                generation,
                data.getValue("cursor").toJson(),
            )
        }
    }

    private fun requireSuccess(response: Response) {
        if (response.isSuccessful) return
        val body = response.body?.bytes() ?: byteArrayOf()
        require(body.size <= JSON_RESPONSE_LIMIT_BYTES)
        val errorCode = runCatching {
            val root = StrictJson.parse(body).requireObject(setOf("error"))
            val error = root.getValue("error") as StrictJson.ObjectValue
            require(error.fields.keys.containsAll(setOf("code", "message")))
            require(error.fields.keys.all { it in setOf("code", "message", "request_id", "details") })
            error.fields.getValue("code").requireString()
        }.getOrNull()
        throw OfflineReadingOriginException(
            offlineReadingFailureReason(response.code, errorCode)
        )
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

    private companion object {
        const val JSON_RESPONSE_LIMIT_BYTES = OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES
    }
}

internal fun offlineReadingFailureReason(status: Int, errorCode: String?): ReadingFailureReason =
    when (errorCode) {
        "E_UNAUTHENTICATED", "E_FORBIDDEN" -> ReadingFailureReason.AuthorizationRequired
        "E_MEDIA_NOT_FOUND", "E_NOT_FOUND" -> ReadingFailureReason.SourceUnavailable
        "E_READER_CONTENT_CHANGED" -> ReadingFailureReason.ContentChanged
        "E_FILE_TOO_LARGE", "E_SOURCE_TOO_LARGE" -> ReadingFailureReason.TooLarge
        "E_READER_PUBLICATION_BUSY", "E_OFFLINE_READING_PACKAGE_TIMEOUT" ->
            ReadingFailureReason.Server
        else -> when (status) {
            401, 403 -> ReadingFailureReason.AuthorizationRequired
            404, 410 -> ReadingFailureReason.SourceUnavailable
            409 -> ReadingFailureReason.ContentChanged
            413 -> ReadingFailureReason.TooLarge
            in 500..599 -> ReadingFailureReason.Server
            else -> ReadingFailureReason.Network
        }
    }
