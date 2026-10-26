package app.nexus.android

import android.annotation.SuppressLint
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONException
import org.json.JSONObject

/** Fixed local/session operations. A reply or upload belongs to its current document, never to a renderer account id. */
@SuppressLint("RequiresFeature")
internal class AppBridge(
    private val webView: WebView,
    private val session: DeviceSession,
    private val signIn: suspend () -> String,
    private val onHello: () -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val framing = OwnedOriginWebMessage(webView, "nexusApp", BuildConfig.NEXUS_BASE_URL, ::onMessage)
    private val documentOwner = java.util.UUID.randomUUID().toString()
    private var subscriber: JavaScriptReplyProxy? = null
    private var keyboardVisible = false
    private val unsubscribe = session.subscribe {
        subscriber?.postMessage(JSONObject().put("kind", "session_changed")
            .put("remote_admission", session.remoteAdmission).toString())
    }
    private val unsubscribeCatalog = session.catalog.subscribe { status ->
        subscriber?.postMessage(JSONObject().put("kind", "catalog_changed").put("catalog", status).toString())
    }

    fun install(): Boolean = framing.install()
    fun setKeyboardVisible(visible: Boolean) {
        if (visible == keyboardVisible) return
        keyboardVisible = visible
        subscriber?.postMessage(JSONObject().put("kind", "keyboard_changed")
            .put("visible", visible).toString())
    }
    fun onPageStarted() {
        session.documentExited("$documentOwner:${framing.currentDocumentGeneration()}")
        framing.onDocumentStarted()
        subscriber = null
    }
    fun close() {
        onPageStarted()
        unsubscribe()
        unsubscribeCatalog()
        framing.close()
        scope.cancel()
    }

    private fun onMessage(message: OwnedWebMessage) {
        if (message.documentGeneration != framing.currentDocumentGeneration()) return
        scope.launch {
            var id: Any = JSONObject.NULL
            val result = try {
                val frame = JSONObject(message.data)
                id = frame.opt("id") ?: JSONObject.NULL
                val document = "$documentOwner:${message.documentGeneration}"
                val value = when (val op = frame.getString("op")) {
                    "hello" -> {
                        session.initialize()
                        require(message.documentGeneration == framing.currentDocumentGeneration())
                        subscriber = message.replyProxy
                        onHello()
                        JSONObject().put("remote_admission", session.remoteAdmission)
                            .put("keyboard_visible", keyboardVisible)
                    }
                    "workspace_begin" -> JSONObject().put("write_id", session.workspaceBegin(document,
                        frame.getString("expected_revision"), frame.getInt("byte_count")) { message.documentGeneration == framing.currentDocumentGeneration() })
                    "workspace_chunk" -> JSONObject().put("next_offset", session.workspaceChunk(document,
                        frame.getString("write_id"), frame.getInt("offset"), frame.getString("base64")))
                    "workspace_commit" -> JSONObject().put("workspace_revision", session.workspaceCommit(document,
                        frame.getString("write_id")) { message.documentGeneration == framing.currentDocumentGeneration() })
                    "session_check" -> JSONObject().put("remote_admission", session.checkSession())
                    "catalog_status" -> JSONObject().put("catalog", session.catalog.status())
                    "catalog_refresh" -> JSONObject().put("catalog", session.catalog.refresh())
                    "session_sign_in" -> JSONObject().put("result", signIn())
                    "session_sign_out" -> { session.signOut(frame.optBoolean("discard_authored", false)); JSONObject() }
                    "account_email_change" -> session.accountOperation(op, frame.getString("email"))
                    "account_identities_get" -> session.accountOperation(op, null)
                    "account_identity_delete" -> session.accountOperation(op, frame.getString("identity_id"))
                    else -> throw IllegalArgumentException("unknown app operation")
                }
                value.put("ok", true)
            } catch (error: LocalStateError) {
                failure(error.code, error.message, 500)
            } catch (error: NexusOriginError) {
                failure(error.code ?: "E_REMOTE", error.message, error.status)
            } catch (_: JSONException) {
                failure("E_INVALID_REQUEST", "invalid app request", 400)
            } catch (_: IllegalArgumentException) {
                failure("E_INVALID_REQUEST", "invalid app request", 400)
            } catch (_: java.io.IOException) {
                failure("E_UNAVAILABLE", "could not connect", 503)
            }
            if (message.documentGeneration == framing.currentDocumentGeneration()) {
                message.replyProxy.postMessage(result.put("id", id).toString())
            }
        }
    }

    private fun failure(code: String, message: String?, status: Int) = JSONObject().put("ok", false)
        .put("error", JSONObject().put("code", code).put("message", message ?: code).put("status", status))
}
