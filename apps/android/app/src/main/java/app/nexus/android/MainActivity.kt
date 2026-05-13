package app.nexus.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent

class MainActivity : AppCompatActivity() {
    internal lateinit var webView: WebView
    internal lateinit var shellChromeClient: WebChromeClient
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val nexusBaseUri = Uri.parse(BuildConfig.NEXUS_BASE_URL)

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = fileChooserCallback ?: return@registerForActivityResult
            fileChooserCallback = null
            callback.onReceiveValue(
                if (result.resultCode == Activity.RESULT_OK) {
                    WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
                } else {
                    null
                }
            )
        }

    @Suppress("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView = WebView(this)
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.safeBrowsingEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(true)
        settings.userAgentString = "${settings.userAgentString} NexusAndroidShell"

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, false)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                if (!request.isForMainFrame) {
                    return false
                }
                if (isOwnedUrl(uri)) {
                    return false
                }
                openExternalUrl(uri)
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                cookieManager.flush()
            }
        }

        shellChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                if (!isUserGesture) {
                    return false
                }
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                val popupWebView = WebView(this@MainActivity)
                popupWebView.settings.javaScriptEnabled = true

                var handled = false
                popupWebView.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): Boolean {
                        val uri = request?.url ?: return true
                        if (handled) {
                            return true
                        }
                        handled = true
                        routeUrl(uri)
                        popupWebView.destroy()
                        return true
                    }

                    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                        if (handled || url == null) {
                            return
                        }
                        handled = true
                        routeUrl(Uri.parse(url))
                        view?.stopLoading()
                        popupWebView.destroy()
                    }
                }

                transport.webView = popupWebView
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.fileChooserCallback?.onReceiveValue(null)
                this@MainActivity.fileChooserCallback = filePathCallback

                val chooserIntent =
                    fileChooserParams?.createIntent()
                        ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                        }

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (_: ActivityNotFoundException) {
                    this@MainActivity.fileChooserCallback?.onReceiveValue(null)
                    this@MainActivity.fileChooserCallback = null
                    false
                }
            }
        }

        webView.webChromeClient = shellChromeClient
        setContentView(webView)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                        return
                    }
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        )

        loadUrlFromIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadUrlFromIntent(intent)
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        webView.destroy()
        super.onDestroy()
    }

    internal fun routeUrl(uri: Uri) {
        if (isOwnedUrl(uri)) {
            if (webView.url != uri.toString()) {
                webView.loadUrl(uri.toString())
            }
            return
        }
        openExternalUrl(uri)
    }

    private fun loadUrlFromIntent(intent: Intent?) {
        val launchUrl =
            intent?.data?.let { uri ->
                if (
                    BuildConfig.DEBUG &&
                    uri.scheme == "nexus-dev" &&
                    uri.host == "auth" &&
                    uri.path == "/callback"
                ) {
                    val callbackUri = nexusBaseUri.buildUpon()
                        .path("/auth/callback")
                        .encodedQuery(uri.encodedQuery)
                        .build()
                    if (isOwnedUrl(callbackUri)) callbackUri.toString() else null
                } else {
                    uri.takeIf(::isOwnedUrl)?.toString()
                }
            } ?: BuildConfig.NEXUS_BASE_URL
        if (webView.url == launchUrl) {
            return
        }
        webView.loadUrl(launchUrl)
    }

    private fun isOwnedUrl(uri: Uri): Boolean {
        val scheme = uri.scheme ?: return false
        if (scheme != "http" && scheme != "https") {
            return false
        }

        val baseScheme = nexusBaseUri.scheme ?: return false
        val baseHost = nexusBaseUri.host ?: return false
        val uriPort = if (uri.port == -1) {
            if (scheme == "https") 443 else 80
        } else {
            uri.port
        }
        val basePort = if (nexusBaseUri.port == -1) {
            if (baseScheme == "https") 443 else 80
        } else {
            nexusBaseUri.port
        }

        return scheme == baseScheme && uri.host == baseHost && uriPort == basePort
    }

    private fun openExternalUrl(uri: Uri) {
        if (uri.scheme == "http" || uri.scheme == "https") {
            try {
                CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .build()
                    .launchUrl(this, uri)
                return
            } catch (_: ActivityNotFoundException) {
                // justify-ignore-error: fall back to the platform URL handler below.
            }
        }

        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            // justify-ignore-error: unsupported external schemes should not crash the shell.
        }
    }
}
