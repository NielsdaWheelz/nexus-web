package app.nexus.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

internal fun isHandledShareCallback(uri: Uri): Boolean {
    if (uri.scheme != "nexus-share") {
        return false
    }
    return when (uri.host) {
        "open", "done", "dismiss" -> true
        else -> false
    }
}

class ShareActivity : AppCompatActivity() {
    // Set only once a non-empty share arrives; an empty share finishes the
    // activity in onCreate before any WebView is created.
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val sharedText = intent
            ?.takeIf { it.action == Intent.ACTION_SEND }
            ?.getCharSequenceExtra(Intent.EXTRA_TEXT)
            ?.toString()
            ?.trim()
        if (sharedText.isNullOrEmpty()) {
            finish()
            return
        }

        webView = WebView(this)
        NexusWebView.configure(webView)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                if (!isHandledShareCallback(uri)) {
                    return false
                }
                if (uri.host == "open") {
                    val path = uri.getQueryParameter("path")
                    if (path != null && path.startsWith("/") && !path.startsWith("//")) {
                        startActivity(
                            Intent(this@ShareActivity, MainActivity::class.java).apply {
                                data = Uri.parse("${BuildConfig.NEXUS_BASE_URL}$path")
                                addFlags(
                                    Intent.FLAG_ACTIVITY_NEW_TASK or
                                        Intent.FLAG_ACTIVITY_CLEAR_TOP
                                )
                            }
                        )
                    }
                }
                finish()
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                CookieManager.getInstance().flush()
            }
        }

        setContentView(webView)

        val shareUrl = Uri.parse(BuildConfig.NEXUS_BASE_URL).buildUpon()
            .appendEncodedPath("share")
            .appendQueryParameter("text", sharedText)
            .build()
        webView.loadUrl(shareUrl.toString())
    }

    override fun onPause() {
        if (::webView.isInitialized) {
            CookieManager.getInstance().flush()
            webView.onPause()
            webView.pauseTimers()
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.resumeTimers()
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }
}
