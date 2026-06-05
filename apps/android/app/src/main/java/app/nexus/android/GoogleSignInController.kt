package app.nexus.android

import android.net.Uri
import android.util.Base64
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject

internal class GoogleSignInController(private val activity: MainActivity) {
    fun signIn(triggerUri: Uri) {
        if (triggerUri.getQueryParameter("provider") != "google") {
            return
        }
        val next = triggerUri.getQueryParameter("next") ?: DEFAULT_AUTH_RETURN_TARGET

        activity.lifecycleScope.launch {
            val rawNonceBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val rawNonce = Base64.encodeToString(
                rawNonceBytes,
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
            )
            val hashedNonce = sha256Hex(rawNonce.toByteArray(Charsets.UTF_8))

            val rawVerifierBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val rawVerifier = Base64.encodeToString(
                rawVerifierBytes,
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
            )
            val challenge = sha256Hex(rawVerifier.toByteArray(Charsets.UTF_8))

            val request = GetCredentialRequest.Builder()
                .addCredentialOption(
                    GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID)
                        .setNonce(hashedNonce)
                        .build()
                )
                .build()

            val idToken = try {
                val response = CredentialManager.create(activity).getCredential(activity, request)
                val credential = response.credential
                if (credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    loadHandoffError(next)
                    return@launch
                }
                GoogleIdTokenCredential.createFrom(credential.data).idToken
            } catch (_: GetCredentialCancellationException) {
                // justify-ignore-error: the user dismissed the account picker;
                // by spec §7.4 this leaves the WebView on /login with no error.
                return@launch
            } catch (_: GetCredentialException) {
                loadHandoffError(next)
                return@launch
            }

            val requestBody = JSONObject()
                .put("idToken", idToken)
                .put("nonce", rawNonce)
                .put("hc", challenge)
                .toString()

            val code = try {
                withContext(Dispatchers.IO) {
                    val connection =
                        (URL("${BuildConfig.NEXUS_BASE_URL}/auth/native/google").openConnection()
                            as HttpURLConnection).apply {
                            requestMethod = "POST"
                            connectTimeout = 5_000
                            readTimeout = 5_000
                            doOutput = true
                            setRequestProperty("Content-Type", "application/json")
                        }
                    try {
                        connection.outputStream.use { it.write(requestBody.toByteArray(Charsets.UTF_8)) }
                        val status = connection.responseCode
                        if (status !in 200..299) {
                            return@withContext null
                        }
                        val payload = connection.inputStream.use { it.readBytes() }
                            .toString(Charsets.UTF_8)
                        val parsed = JSONObject(payload)
                            .optJSONObject("data")
                            ?.optString("code")
                            ?.takeIf { it.isNotEmpty() }
                        parsed
                    } finally {
                        connection.disconnect()
                    }
                }
            } catch (_: SocketTimeoutException) {
                // justify-ignore-error: network deadline maps to the single
                // public failure code; the user sees the whitelisted message.
                null
            } catch (_: IOException) {
                // justify-ignore-error: network/parse failures funnel to the
                // same public failure code per spec §7.4.
                null
            } catch (_: JSONException) {
                // justify-ignore-error: a malformed response collapses into
                // the same public failure code.
                null
            }

            if (code == null) {
                loadHandoffError(next)
                return@launch
            }

            val successUrl = Uri.parse(BuildConfig.NEXUS_BASE_URL).buildUpon()
                .appendEncodedPath("auth/handoff")
                .appendQueryParameter("code", code)
                .appendQueryParameter("hv", rawVerifier)
                .appendNonDefaultAuthReturnTarget(next)
                .build()
                .toString()
            activity.runOnUiThread { activity.webView.loadUrl(successUrl) }
        }
    }

    private fun loadHandoffError(next: String) {
        val url = Uri.parse(BuildConfig.NEXUS_BASE_URL).buildUpon()
            .appendEncodedPath("auth/handoff")
            .appendQueryParameter("error", "native_google_signin_failed")
            .appendNonDefaultAuthReturnTarget(next)
            .build()
            .toString()
        activity.runOnUiThread { activity.webView.loadUrl(url) }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
