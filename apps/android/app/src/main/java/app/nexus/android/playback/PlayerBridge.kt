package app.nexus.android.playback

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.webkit.JavaScriptReplyProxy
import app.nexus.android.BuildConfig
import app.nexus.android.webkit.OwnedOriginWebMessage
import app.nexus.android.webkit.OwnedWebMessage
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException

/**
 * `window.nexusPlayback` on the hosted origin: the web's json request frames go to
 * the playback service as one custom command, its replies come back with the
 * request's id, and its snapshot pushes reach the document that said hello. The
 * object name is the compatibility identity; frames are trusted and parsed by
 * the service, which owns every decision.
 */
@SuppressLint("RequiresFeature") // reply proxies exist only after install() found WEB_MESSAGE_LISTENER
internal class PlayerBridge(
    private val webView: WebView,
    private val controller: () -> MediaController?,
) {
    private val framing = OwnedOriginWebMessage(webView, "nexusPlayback", BuildConfig.NEXUS_BASE_URL, ::onMessage)
    private var subscriber: JavaScriptReplyProxy? = null
    private var hello: String? = null // the document's hello frame, re-sent to a restarted service
    private var latest: String? = null
    private var foreground = true

    fun install(): Boolean = framing.install()

    fun onPageStarted() {
        framing.onDocumentStarted()
        subscriber = null
        hello = null
        latest = null
    }

    /** While the app is behind, pushes wait (they would wake the page each second); the latest goes on return. */
    fun setForeground(value: Boolean) {
        foreground = value
        if (value) latest?.let(::onEvent)
    }

    /** A snapshot the service pushed. */
    fun onEvent(snapshot: String) {
        latest = snapshot
        if (foreground) subscriber?.postMessage("{\"snapshot\":$snapshot}")
    }

    /** A (re)connected service: bind it to the document's account again and push what it now holds. */
    fun onControllerConnected() {
        val frame = hello ?: return
        val generation = framing.currentDocumentGeneration()
        request(frame) { reply ->
            val snapshot = reply.optJSONObject("snapshot")
            if (snapshot != null && generation == framing.currentDocumentGeneration()) onEvent(snapshot.toString())
        }
    }

    fun close() {
        onPageStarted()
        framing.close()
    }

    private fun onMessage(message: OwnedWebMessage) {
        val generation = message.documentGeneration
        if (generation != framing.currentDocumentGeneration()) return
        val frame = try {
            JSONObject(message.data)
        } catch (_: JSONException) {
            // justify-ignore-error: a malformed frame is answered, not acted on.
            null
        }
        val answer = { reply: JSONObject ->
            if (generation == framing.currentDocumentGeneration()) {
                message.replyProxy.postMessage(reply.put("id", frame?.opt("id") ?: JSONObject.NULL).toString())
            }
        }
        when {
            frame == null || !frame.has("op") -> answer(failure("Invalid"))
            frame.getString("op") == "hello" -> {
                subscriber = message.replyProxy
                hello = message.data
                request(message.data, answer)
            }
            subscriber == null -> answer(failure("NotConnected"))
            else -> request(message.data, answer)
        }
    }

    private fun request(frame: String, onReply: (JSONObject) -> Unit) {
        val controller = controller() ?: return onReply(failure("Unavailable"))
        val args = Bundle().apply { putString(NexusPlaybackService.ARG_JSON, frame) }
        val command = SessionCommand(NexusPlaybackService.ACTION_REQUEST, Bundle.EMPTY)
        val future = controller.sendCustomCommand(command, args)
        future.addListener(
            {
                val reply = try {
                    future.get().takeIf { it.resultCode == SessionResult.RESULT_SUCCESS }
                        ?.extras?.getString(NexusPlaybackService.ARG_JSON)
                } catch (_: ExecutionException) {
                    // justify-ignore-error: the service went away mid-request; the page is told it is unavailable.
                    null
                } catch (_: CancellationException) {
                    // justify-ignore-error: as above, for a controller released during the request.
                    null
                }
                onReply(reply?.let(::JSONObject) ?: failure("Unavailable"))
            },
            ContextCompat.getMainExecutor(webView.context),
        )
    }

    private fun failure(code: String): JSONObject = JSONObject().put("ok", false).put("error", code)
}
