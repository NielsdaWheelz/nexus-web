package app.nexus.android.offline.readingweb

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
            ?: return callback(Result.failure(IOException("hosted session is unavailable")))
        val request = Request.Builder()
            .url(origin.newBuilder().addPathSegments("api/offline-reading/account-binding").build())
            .header("Cookie", cookie)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .get()
            .build()
        client.newCall(request).enqueue(
            object : Callback {
                override fun onFailure(call: Call, error: IOException) = callback(Result.failure(error))

                override fun onResponse(call: Call, response: Response) {
                    callback(
                        attestation {
                            response.use {
                                installOfflineReadingOwnedOriginCookies(it, origin, cookieStore)
                                require(it.isSuccessful && !it.isRedirect && it.priorResponse == null)
                                val bytes = it.body?.bytes() ?: error("account binding body is missing")
                                require(bytes.size <= 64 * 1024)
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
                                require(data.getValue("protocol_version").requireLong() == 1L)
                                require(data.getValue("package_schema_version").requireLong() ==
                                    OFFLINE_READING_PACKAGE_SCHEMA_VERSION.toLong())
                                require(data.getValue("reader_contract_version").requireLong() ==
                                    OFFLINE_READING_READER_CONTRACT_VERSION.toLong())
                                require(data.getValue("minimum_reader_bundle_version").requireLong() ==
                                    OFFLINE_READING_READER_BUNDLE_VERSION.toLong())
                                val raw = data.getValue("account_id").requireString()
                                UUID.fromString(raw).also { account -> require(account.toString() == raw) }
                            }
                        }
                    )
                }
            }
        )
    }
}
