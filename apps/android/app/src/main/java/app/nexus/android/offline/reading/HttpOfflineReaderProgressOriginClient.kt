package app.nexus.android.offline.reading

import android.net.Network
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.util.UUID

internal class HttpOfflineReaderProgressOriginClient(
    network: Network,
) : OfflineReaderProgressOriginClient {
    private val session = try {
        OfflineReadingHttpSessionFactory.create(network)
    } catch (error: OfflineReadingCookieUnavailableException) {
        throw OfflineReaderProgressOriginException(
            ReaderProgressOriginFailure.AuthorizationRequired,
            error,
        )
    } catch (error: Exception) {
        throw OfflineReaderProgressOriginException(ReaderProgressOriginFailure.Network, error)
    }

    override fun fetch(
        mediaId: UUID,
        expectedAccountId: UUID,
    ): AttestedRemoteReaderState {
        val request = Request.Builder()
            .url(session.hostedOrigin.newBuilder().addPathSegments("api/media/$mediaId/offline-reader-state").build())
            .get()
            .header("Cookie", session.cookieStore.requireCookies(session.hostedOrigin))
            .header("X-Nexus-Expected-Account-Id", expectedAccountId.toString())
            .header("Accept-Encoding", "identity")
            .build()
        return try {
            executeState(request, expectedAccountId)
        } catch (error: OfflineReaderProgressHttpException) {
            throw error.toOriginException()
        }
    }

    override fun compareAndSwap(
        candidate: ReaderProgressSyncCandidate,
    ): RemoteReaderWriteResult {
        val locator = StrictJson.parse(candidate.locatorJson.toByteArray())
        val body = buildString {
            append("{\"expectedReaderGeneration\":")
            append(candidate.readerGeneration)
            append(",\"baseRevision\":")
            append(candidate.baseServerRevision)
            append(",\"locator\":")
            append(locator.toJson())
            append('}')
        }
        val request = Request.Builder()
            .url(session.hostedOrigin.newBuilder().addPathSegments("api/media/${candidate.mediaId}/offline-reader-state").build())
            .put(body.toRequestBody("application/json".toMediaType()))
            .header("Cookie", session.cookieStore.requireCookies(session.hostedOrigin))
            .header("X-Nexus-Expected-Account-Id", candidate.accountId.toString())
            .header("Accept-Encoding", "identity")
            .offlineReadingOwnedOrigin(session.hostedOrigin)
            .build()
        try {
            return RemoteReaderWriteResult.Accepted(executeState(request, candidate.accountId))
        } catch (error: OfflineReaderProgressHttpException) {
            return when (error.code) {
                "E_READER_STATE_CONFLICT" -> RemoteReaderWriteResult.Conflict
                "E_READER_CONTENT_CHANGED" -> RemoteReaderWriteResult.ContentChanged
                "E_MEDIA_NOT_FOUND", "E_NOT_FOUND" -> RemoteReaderWriteResult.SourceUnavailable
                else -> throw error.toOriginException()
            }
        }
    }

    private fun executeState(request: Request, expectedAccountId: UUID): AttestedRemoteReaderState {
        try {
            session.client.newCall(request).execute().use { response ->
                installOfflineReadingOwnedOriginCookies(
                    response,
                    session.hostedOrigin,
                    session.cookieStore,
                )
                if (!response.isSuccessful) throw response.readProgressError()
                require(response.priorResponse == null && !response.isRedirect)
                require(response.header("Content-Encoding") == null)
                val headerAccountText = response.header("Nexus-Account-Id")
                    ?: error("offline reader-state account header is missing")
                val headerAccount = UUID.fromString(headerAccountText)
                require(headerAccount.toString() == headerAccountText && headerAccount == expectedAccountId)
                val headerGeneration = response.header("Nexus-Reader-Generation")?.toLongOrNull()
                    ?: error("offline reader-state generation header is missing")
                require(headerGeneration > 0)
                val bytes = response.body?.bytes() ?: error("offline reader-state body is missing")
                require(bytes.size <= OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES)
                val data = StrictJson.parse(bytes).requireObject(setOf("data")).getValue("data")
                    .requireObject(setOf("accountId", "readerGeneration", "cursor"))
                require(data.getValue("accountId").requireString() == expectedAccountId.toString())
                require(data.getValue("readerGeneration").requireLong() == headerGeneration)
                return AttestedRemoteReaderState(
                    expectedAccountId,
                    headerGeneration,
                    data.getValue("cursor").toJson(),
                )
            }
        } catch (error: OfflineReaderProgressHttpException) {
            throw error
        } catch (error: IllegalArgumentException) {
            throw OfflineReaderProgressOriginException(ReaderProgressOriginFailure.Server, error)
        } catch (error: Exception) {
            throw OfflineReaderProgressOriginException(ReaderProgressOriginFailure.Network, error)
        }
    }

    private fun Response.readProgressError(): OfflineReaderProgressHttpException {
        val bytes = body?.bytes() ?: byteArrayOf()
        require(bytes.size <= OFFLINE_READING_JSON_RESPONSE_LIMIT_BYTES)
        val errorCode = runCatching {
            val error = StrictJson.parse(bytes).requireObject(setOf("error")).getValue("error")
            val errorFields = (error as? StrictJson.ObjectValue)?.fields
                ?: error("offline reader-state error must be an object")
            require(errorFields.keys.containsAll(setOf("code", "message")))
            require(errorFields.keys.all { it in setOf("code", "message", "request_id", "details") })
            errorFields.getValue("code").requireString()
        }.getOrNull()
        return OfflineReaderProgressHttpException(
            errorCode ?: when (code) {
                401 -> "E_UNAUTHENTICATED"
                403 -> "E_FORBIDDEN"
                404, 410 -> "E_NOT_FOUND"
                else -> "E_NETWORK"
            }
        )
    }
}

private class OfflineReaderProgressHttpException(
    val code: String,
) : RuntimeException(code) {
    fun toOriginException(): OfflineReaderProgressOriginException =
        OfflineReaderProgressOriginException(
            readerProgressOriginFailure(code),
            this,
        )
}

internal fun readerProgressOriginFailure(code: String): ReaderProgressOriginFailure =
    when (code) {
        "E_UNAUTHENTICATED", "E_FORBIDDEN" ->
            ReaderProgressOriginFailure.AuthorizationRequired
        "E_MEDIA_NOT_FOUND", "E_NOT_FOUND" ->
            ReaderProgressOriginFailure.SourceUnavailable
        "E_INTERNAL", "E_UPSTREAM", "E_SERVER" -> ReaderProgressOriginFailure.Server
        else -> ReaderProgressOriginFailure.Network
    }
