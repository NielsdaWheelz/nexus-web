package app.nexus.android

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.io.IOException
import java.util.UUID

internal fun isHandledShareCallback(uri: Uri): Boolean =
    uri.scheme == "nexus-share" && uri.host in setOf("open", "done", "dismiss")

/**
 * Packaged capture after local account admission. The cached document belongs to one
 * local binding and survives transport/auth changes within that binding. Entry
 * checks never replay capture commands, renew browser documents or own Main's
 * foreground renewal flag; fixed credential effects belong to DeviceSession.
 */
class ShareActivity : AppCompatActivity() {
    private val device by lazy { DeviceSession.get(this) }
    private val router by lazy { AppRouter(this, device) }
    private lateinit var root: FrameLayout
    private lateinit var shareUrl: Uri
    private var webView: WebView? = null
    private var authored: app.nexus.android.authored.AuthoredBridge? = null
    private var documentAccount: UUID? = null
    private var resumeGeneration = 0L
    private var releaseDevice: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent?.takeIf { it.action == Intent.ACTION_SEND }
            ?.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
        if (text.isNullOrEmpty()) { finish(); return }
        shareUrl = Uri.parse(BuildConfig.NEXUS_BASE_URL).buildUpon().appendEncodedPath("share")
            .appendQueryParameter("text", text).build()
        root = FrameLayout(this)
        setContentView(root)
        releaseDevice = device.subscribe {
            if (webView != null && documentAccount != device.accountId()) {
                discardDocument()
                finish()
            }
        }
        showStatus("connecting…", "", checking = true)
    }

    override fun onResume() {
        super.onResume()
        if (!::root.isInitialized) return
        authored?.setForeground(true)
        webView?.visibility = View.INVISIBLE
        admit()
    }

    private fun admit() {
        val generation = ++resumeGeneration
        if (webView == null) showStatus("connecting…", "", checking = true)
        lifecycleScope.launch {
            try {
                device.initialize()
                if (generation != resumeGeneration || isFinishing || isDestroyed) return@launch
                if (webView != null && documentAccount != device.accountId()) {
                    discardDocument()
                    finish()
                    return@launch
                }
                val account = device.accountId()
                if (account == null) { showAdmission("SignInRequired"); return@launch }
                if (webView == null) {
                    documentAccount = account
                    val view = createWebView(); webView = view
                    showDocument(); view.loadUrl(shareUrl.toString())
                } else showDocument()
                // Credential refresh may suspend remote work, never local capture.
                device.checkSession()
            } catch (error: IOException) {
                if (generation != resumeGeneration || isFinishing || isDestroyed) return@launch
                if (webView != null) return@launch
                val cleanup = error !is LocalStateError || error.code == "E_LOCAL_CLEANUP"
                showStatus(if (cleanup) "sign out not completed" else "saved workspace couldn’t be opened", error.message ?: "try again")
            }
        }
    }

    private fun isCapture(uri: Uri): Boolean = router.isOwned(uri) && uri.path == "/share" && uri.encodedQuery == shareUrl.encodedQuery

    private fun createWebView(): WebView = WebView(this).apply {
        NexusWebView.configure(this)
        authored = app.nexus.android.authored.AuthoredBridge(this, device).also { check(it.install()); it.setForeground(true) }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                if (view !== webView || request?.isForMainFrame != true) return false
                val uri = request.url
                if (isHandledShareCallback(uri)) {
                    if (uri.host == "open") {
                        uri.getQueryParameter("path")?.takeIf { it.startsWith("/") && !it.startsWith("//") }
                            ?.let { openMain(Uri.parse(BuildConfig.NEXUS_BASE_URL.trimEnd('/') + it)) }
                    }
                    finish()
                    return true
                }
                if (request.method == "GET" && isCapture(uri)) return false
                openMain(uri)
                return true
            }

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                if (request == null) return null
                if (request.isForMainFrame && !(request.method == "GET" && isCapture(request.url))) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
                return router.intercept(request)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                authored?.onPageStarted()
                if (view !== webView || url == null || isCapture(Uri.parse(url))) return
                view?.stopLoading()
                openMain(Uri.parse(url))
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, response: WebResourceResponse?) {
                if (view === webView && request != null && router.isOwned(request.url) && response?.statusCode in setOf(401, 426) &&
                    device.remoteAdmission in setOf("Ready", "Unavailable")) device.requestCheck()
            }
        }
    }

    private fun openMain(uri: Uri) {
        val target = if (router.isOwned(uri) && uri.path == "/login") Uri.parse("nexus://auth/start") else uri
        startActivity(Intent(this, MainActivity::class.java).apply {
            data = target
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        })
    }

    private fun showDocument() {
        val view = webView ?: return
        if (view.parent !== root) { root.removeAllViews(); root.addView(view) }
        view.visibility = View.VISIBLE
        view.onResume()
        view.resumeTimers()
    }

    private fun discardDocument() {
        authored?.close(); authored = null
        webView?.let { view ->
            view.stopLoading()
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
        }
        webView = null
        documentAccount = null
    }

    private fun showAdmission(admission: String) {
        when (admission) {
            "SignInRequired" -> showStatus("sign in to save this", "open nexus, sign in, then return to this share.")
            "UpdateRequired" -> showStatus("update nexus to reconnect", "install the current nexus apk, then reopen the app.")
            else -> showStatus("this capture needs a connection", "connect and try again.")
        }
    }

    private fun showStatus(title: String, message: String, checking: Boolean = false) {
        root.removeAllViews()
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.BLACK)
            for (value in listOf(title, message).filter(String::isNotEmpty)) addView(TextView(this@ShareActivity).apply {
                text = value
                setTextColor(Color.WHITE)
                textSize = 18f
            })
            if (!checking) {
                addView(Button(this@ShareActivity).apply { text = "try again"; setOnClickListener { admit() } })
                addView(Button(this@ShareActivity).apply {
                    text = "open nexus"
                    setOnClickListener { openMain(Uri.parse(BuildConfig.NEXUS_BASE_URL)) }
                })
            }
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    override fun onPause() {
        resumeGeneration += 1
        authored?.setForeground(false)
        webView?.let { it.onPause(); it.pauseTimers() }
        super.onPause()
    }

    override fun onDestroy() {
        resumeGeneration += 1
        releaseDevice?.invoke()
        discardDocument()
        super.onDestroy()
    }
}
