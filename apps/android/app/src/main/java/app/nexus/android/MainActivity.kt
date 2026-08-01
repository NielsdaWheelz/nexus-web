package app.nexus.android

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import app.nexus.android.offline.OfflineMediaStore
import app.nexus.android.offline.OfflineMediaWebCapability
import androidx.lifecycle.Lifecycle
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import app.nexus.android.playback.NexusPlaybackService
import app.nexus.android.playback.NexusPlayerBridge
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.security.MessageDigest
import java.security.SecureRandom

@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {
    internal lateinit var webView: WebView
    internal lateinit var shellChromeClient: WebChromeClient
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val nexusBaseUri = Uri.parse(BuildConfig.NEXUS_BASE_URL)
    internal var pendingHandoffVerifier: String? = null
    private val googleSignInController by lazy { GoogleSignInController(this) }
    private lateinit var offlineMediaCapability: OfflineMediaWebCapability

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // A denied notification permission hides the drawer notification but does
            // not invalidate the user-started foreground download.
        }
    private var playerController: MediaController? = null
    private var playerControllerFuture: ListenableFuture<MediaController>? = null
    private var playerLifecycleClosing = false
    private lateinit var playerBridge: NexusPlayerBridge

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
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(
                lightScrim = Color.BLACK,
                darkScrim = Color.BLACK,
                detectDarkMode = { true },
            ),
        )
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        NexusWebView.configure(webView)
        offlineMediaCapability = OfflineMediaWebCapability(
            webView,
            ::requestOfflineDownloadNotificationPermission,
        )
        offlineMediaCapability.install()
        playerBridge = NexusPlayerBridge(webView) {
            if (playerController == null) {
                connectPlayerController()
            }
            playerController
        }
        playerBridge.install()
        connectPlayerController()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                if (!request.isForMainFrame) {
                    return false
                }
                if (uri.scheme == "nexus" && uri.host == "auth") {
                    when (uri.path) {
                        "/start" -> { startAuthFlow(uri); return true }
                        "/native" -> { googleSignInController.signIn(uri); return true }
                    }
                }
                if (isOwnedUrl(uri)) {
                    return false
                }
                openExternalUrl(uri)
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                CookieManager.getInstance().flush()
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                offlineMediaCapability.onPageStarted()
                playerBridge.onPageStarted()
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
                NexusWebView.configure(popupWebView)

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
                if (filePathCallback == null) {
                    return false
                }
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
        val statusBarProtection = View(this).apply {
            id = R.id.status_bar_protection
            setBackgroundColor(Color.BLACK)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val root = FrameLayout(this).apply {
            addView(
                webView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            addView(
                statusBarProtection,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    Gravity.TOP
                )
            )
        }
        root.setOnApplyWindowInsetsListener { _, insets ->
            statusBarProtection.layoutParams.height = insets.systemBarAndDisplayCutoutTop()
            statusBarProtection.requestLayout()
            insets
        }
        setContentView(root)
        root.requestApplyInsets()

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

        val restoredWebViewState =
            savedInstanceState?.let { webView.restoreState(it) } != null
        if (!restoredWebViewState) {
            loadUrlFromIntent(intent)
        }
    }

    @Suppress("DEPRECATION")
    private fun WindowInsets.systemBarAndDisplayCutoutTop(): Int =
        if (Build.VERSION.SDK_INT >= 30) {
            getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
            ).top
        } else {
            maxOf(
                systemWindowInsetTop,
                if (Build.VERSION.SDK_INT >= 28) displayCutout?.safeInsetTop ?: 0 else 0,
            )
        }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        routeNewIntent(intent)
    }

    internal fun routeNewIntent(intent: Intent) {
        if (intent.data == null) {
            return
        }
        loadUrlFromIntent(intent)
    }

    override fun onPause() {
        OfflineMediaStore.get(this).onAppBackground()
        playerBridge.onPause()
        CookieManager.getInstance().flush()
        webView.onPause()
        webView.pauseTimers()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        OfflineMediaStore.get(this).onAppForeground()
        webView.onResume()
        webView.resumeTimers()
        playerBridge.onResume()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        playerLifecycleClosing = true
        playerBridge.close()
        playerController?.release()
        playerController = null
        playerControllerFuture?.cancel(true)
        playerControllerFuture = null
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        offlineMediaCapability.close()
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun requestOfflineDownloadNotificationPermission() {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun connectPlayerController() {
        if (
            isDestroyed ||
            playerLifecycleClosing ||
            playerController != null ||
            playerControllerFuture != null
        ) {
            return
        }
        val token = SessionToken(
            this,
            ComponentName(this, NexusPlaybackService::class.java),
        )
        val future = MediaController.Builder(this, token)
            .setListener(
                object : MediaController.Listener {
                    override fun onCustomCommand(
                        controller: MediaController,
                        command: SessionCommand,
                        args: Bundle,
                    ): ListenableFuture<SessionResult> {
                        if (command.customAction == NexusPlaybackService.ACTION_EVENT) {
                            args.getString(NexusPlaybackService.ARG_REPLY_JSON)
                                ?.let(playerBridge::onControllerEvent)
                            return Futures.immediateFuture(
                                SessionResult(SessionResult.RESULT_SUCCESS)
                            )
                        }
                        return Futures.immediateFuture(
                            SessionResult(SessionError.ERROR_NOT_SUPPORTED)
                        )
                    }

                    override fun onDisconnected(controller: MediaController) {
                        runOnUiThread {
                            if (
                                playerController !== controller ||
                                isDestroyed ||
                                playerLifecycleClosing
                            ) {
                                return@runOnUiThread
                            }
                            playerBridge.onControllerDisconnected()
                            playerController = null
                            connectPlayerController()
                        }
                    }
                }
            )
            .buildAsync()
        playerControllerFuture = future
        future.addListener(
            {
                val connected = runCatching { future.get() }.getOrNull()
                runOnUiThread {
                    if (playerControllerFuture !== future || isDestroyed) {
                        connected?.release()
                        return@runOnUiThread
                    }
                    playerControllerFuture = null
                    if (connected == null) {
                        return@runOnUiThread
                    }
                    playerController = connected
                    playerBridge.onControllerConnected(connected)
                    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                        playerBridge.onResume()
                    }
                }
            },
            MoreExecutors.directExecutor(),
        )
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

    internal fun startAuthFlow(triggerUri: Uri) {
        val provider = triggerUri.getQueryParameter("provider")
        val mode = triggerUri.getQueryParameter("mode") ?: "signin"
        val next = triggerUri.getQueryParameter("next") ?: DEFAULT_AUTH_RETURN_TARGET
        if (provider !in setOf("google", "github") || mode !in setOf("signin", "link")) {
            return
        }
        val verifierBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val verifier = Base64.encodeToString(verifierBytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        val challenge = MessageDigest.getInstance("SHA-256")
            .digest(verifier.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        pendingHandoffVerifier = verifier
        val uri = nexusBaseUri.buildUpon()
            .appendEncodedPath("auth/oauth")
            .appendQueryParameter("provider", provider)
            .appendQueryParameter("mode", mode)
            .appendQueryParameter("flow", "handoff")
            .appendQueryParameter("hc", challenge)
            .appendNonDefaultAuthReturnTarget(next)
            .build()
        try {
            CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
                .launchUrl(this, uri)
        } catch (_: ActivityNotFoundException) {
            // justify-ignore-error: fall back to the platform URL handler below.
        }
    }

    internal fun loadUrlFromIntent(intent: Intent?) {
        val uri = intent?.data ?: run {
            if (webView.url != BuildConfig.NEXUS_BASE_URL) {
                webView.loadUrl(BuildConfig.NEXUS_BASE_URL)
            }
            return
        }
        val launchUrl =
            if (
                uri.scheme == "nexus" &&
                uri.host == "auth" &&
                uri.path == "/handoff"
            ) {
                val callbackUri = nexusBaseUri.buildUpon()
                    .path("/auth/handoff")
                    .encodedQuery(uri.encodedQuery)
                    .appendQueryParameter("hv", pendingHandoffVerifier ?: "")
                    .build()
                pendingHandoffVerifier = null
                callbackUri.takeIf(::isOwnedUrl)?.toString()
            } else {
                uri.takeIf(::isOwnedUrl)?.toString()
            } ?: return
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

        val uriHost = uri.host ?: return false
        return scheme == baseScheme &&
            uriHost.equals(baseHost, ignoreCase = true) &&
            uriPort == basePort
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
