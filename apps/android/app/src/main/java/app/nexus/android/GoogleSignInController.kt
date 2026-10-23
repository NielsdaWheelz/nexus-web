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
import kotlinx.coroutines.launch
import java.security.MessageDigest
import java.security.SecureRandom

/** Native Google joins the existing custom-tab attempt; it never owns another verifier or loads a document. */
internal class GoogleSignInController(private val activity: MainActivity) {
    fun signIn(triggerUri: Uri) {
        if (triggerUri.getQueryParameter("provider") != "google") return
        val session = DeviceSession.get(activity)
        val attempt = session.currentAttempt(triggerUri.getQueryParameter("hc")) ?: return
        activity.lifecycleScope.launch {
            val nonce = Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) },
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            val hash = MessageDigest.getInstance("SHA-256").digest(nonce.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            val request = GetCredentialRequest.Builder().addCredentialOption(
                GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).setNonce(hash).build(),
            ).build()
            val token = try {
                val credential = CredentialManager.create(activity).getCredential(activity, request).credential
                if (credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    session.redeem(attempt.challenge, null)
                    return@launch
                }
                GoogleIdTokenCredential.createFrom(credential.data).idToken
            } catch (_: GetCredentialCancellationException) {
                session.cancelAttempt(attempt)
                return@launch
            } catch (_: GetCredentialException) {
                session.redeem(attempt.challenge, null)
                return@launch
            }
            session.google(attempt, token, nonce)
        }
    }
}
