package app.nexus.android.offline.readingweb

import android.util.Log
import app.nexus.android.BuildConfig
import app.nexus.android.offline.reading.OFFLINE_READING_PACKAGE_SCHEMA_VERSION
import app.nexus.android.offline.reading.OFFLINE_READING_READER_BUNDLE_VERSION
import app.nexus.android.offline.reading.OFFLINE_READING_READER_CONTRACT_VERSION
import app.nexus.android.offline.reading.OfflineReadingOwnedOriginCookieStore
import app.nexus.android.offline.reading.StrictJson
import app.nexus.android.offline.reading.WebViewOfflineReadingOwnedOriginCookieStore
import app.nexus.android.offline.reading.installOfflineReadingOwnedOriginCookies
import app.nexus.android.offline.reading.requireOfflineReadingOrigin
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

internal class OfflineReadingUpdateRequiredException(message: String) : IOException(message)

private class InvalidAccountBindingResponse(message: String) : IOException(message)

private const val ACCOUNT_BINDING_BODY_LIMIT_BYTES = 64 * 1024L

private fun logAttestationFailure(error: Throwable) {
    // Only these locally constructed messages contain safe diagnostic fields.
    // Parser/network errors can contain payloads or URLs; log their type alone.
    val detail = when (error) {
        is OfflineReadingUpdateRequiredException, is InvalidAccountBindingResponse -> error.message
        else -> error.javaClass.simpleName
    }
    Log.w("NexusOfflineReading", "Account attestation failed: $detail")
}

/**
 * The account-binding endpoint being unreachable, refusing, or answering an
 * unusable envelope is the modelled failure of this attestation. Anything else
 * stays a defect.
 */
private fun <T> attestation(read: () -> T): Result<T> =
    try {
        Result.success(read())
    } catch (error: IOException) {
        Result.failure(error)
    } catch (error: IllegalArgumentException) {
        Result.failure(error)
    } catch (error: IllegalStateException) {
        Result.failure(error)
    }

internal class OfflineReadingAccountAttestor(
    private val cookieStore: OfflineReadingOwnedOriginCookieStore =
        WebViewOfflineReadingOwnedOriginCookieStore(),
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build(),
) {
    private val origin = BuildConfig.NEXUS_BASE_URL.toHttpUrl().requireOfflineReadingOrigin()

    fun attest(callback: (Result<UUID>) -> Unit) {
        val cookie = cookieStore.cookiesFor(origin.toString())?.takeIf(String::isNotBlank)
            ?: return callback(Result.failure(
                InvalidAccountBindingResponse("hosted session is unavailable").also(::logAttestationFailure),
            ))
        val request = Request.Builder()
            .url(origin.newBuilder().addPathSegments("api/offline-reading/account-binding").build())
            .header("Cookie", cookie)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .get()
            .build()
        client.newCall(request).enqueue(
            object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    logAttestationFailure(error)
                    callback(Result.failure(error))
                }

                override fun onResponse(call: Call, response: Response) {
                    callback(
                        attestation {
                            response.use {
                                installOfflineReadingOwnedOriginCookies(it, origin, cookieStore)
                                if (!it.isSuccessful || it.isRedirect || it.priorResponse != null) {
                                    throw InvalidAccountBindingResponse("HTTP ${it.code}")
                                }
                                val body = it.body
                                    ?: throw InvalidAccountBindingResponse("account binding body is missing")
                                val source = body.source()
                                if (source.request(ACCOUNT_BINDING_BODY_LIMIT_BYTES + 1)) {
                                    throw InvalidAccountBindingResponse("account binding body exceeds 64 KiB")
                                }
                                val bytes = source.readByteArray()
                                val envelope = StrictJson.parse(bytes).requireObject(setOf("data"))
                                val data = envelope.getValue("data").requireObject(
                                    setOf(
                                        "account_id",
                                        "protocol_version",
                                        "package_schema_version",
                                        "reader_contract_version",
                                        "minimum_reader_bundle_version",
                                    )
                                )
                                val protocolVersion = data.getValue("protocol_version").requireLong()
                                val packageVersion = data.getValue("package_schema_version").requireLong()
                                val readerVersion = data.getValue("reader_contract_version").requireLong()
                                val minimumBundleVersion = data.getValue("minimum_reader_bundle_version").requireLong()
                                val versions = "server protocol=$protocolVersion package=$packageVersion " +
                                    "reader=$readerVersion minimumBundle=$minimumBundleVersion; " +
                                    "client protocol=1 package=$OFFLINE_READING_PACKAGE_SCHEMA_VERSION " +
                                    "reader=$OFFLINE_READING_READER_CONTRACT_VERSION " +
                                    "bundle=$OFFLINE_READING_READER_BUNDLE_VERSION"
                                if (protocolVersion > 1 ||
                                    packageVersion > OFFLINE_READING_PACKAGE_SCHEMA_VERSION ||
                                    readerVersion > OFFLINE_READING_READER_CONTRACT_VERSION ||
                                    minimumBundleVersion > OFFLINE_READING_READER_BUNDLE_VERSION
                                ) {
                                    throw OfflineReadingUpdateRequiredException(versions)
                                }
                                if (protocolVersion != 1L ||
                                    packageVersion != OFFLINE_READING_PACKAGE_SCHEMA_VERSION.toLong() ||
                                    readerVersion != OFFLINE_READING_READER_CONTRACT_VERSION.toLong() ||
                                    minimumBundleVersion != OFFLINE_READING_READER_BUNDLE_VERSION.toLong()
                                ) {
                                    throw InvalidAccountBindingResponse("unsupported account binding: $versions")
                                }
                                val raw = data.getValue("account_id").requireString()
                                UUID.fromString(raw).also { account -> require(account.toString() == raw) }
                            }
                        }.onFailure(::logAttestationFailure)
                    )
                }
            }
        )
    }
}
