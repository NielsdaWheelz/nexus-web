package app.nexus.android

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import app.nexus.android.offline.OfflineBridge
import app.nexus.android.offline.OfflineJobs
import app.nexus.android.offline.OfflineStore
import app.nexus.android.offline.SHELF_HOST
import app.nexus.android.offline.SHELF_URL
import app.nexus.android.offline.ShelfRouter
import app.nexus.android.playback.NexusPlaybackService
import app.nexus.android.playback.PlayerBridge
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException

private enum class HostedLoadFailure {
    Connection,
    RedirectLoop,
}

@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {
    internal lateinit var webView: WebView
    internal lateinit var shellChromeClient: WebChromeClient
    private lateinit var root: FrameLayout
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val nexusBaseUri = Uri.parse(BuildConfig.NEXUS_BASE_URL)
    internal var pendingHandoffVerifier: String? = null
    private val googleSignInController by lazy { GoogleSignInController(this) }
    // offline (android 14+): the bridge and the shelf router exist only there
    private var offline: OfflineBridge? = null
    private var shelfRouter: ShelfRouter? = null
    // the shelf is the main document: set at each main-frame request and at its commit
    @Volatile private var shelfActive = false
    private var hostedLoadTerminal: View? = null
    private var failedMainFrameUrl: String? = null

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // A denied notification permission hides the drawer notification but does
            // not stop the user-started download job.
        }
    private var playerController: MediaController? = null
    private var playerControllerFuture: ListenableFuture<MediaController>? = null
    private var playerLifecycleClosing = false
    private lateinit var playerBridge: PlayerBridge

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
        if (Build.VERSION.SDK_INT >= 34) {
            val store = OfflineStore.get(this)
            shelfRouter = ShelfRouter(this, store)
            offline = OfflineBridge(
                webView,
                store,
                object : OfflineBridge.Host {
                    override fun showDownloads() = webView.loadUrl(SHELF_URL)

                    override fun openHosted(path: String) {
                        shelfActive = false
                        webView.loadUrl(BuildConfig.NEXUS_BASE_URL.trimEnd('/') + path)
                    }

                    override fun requestNotificationPermission() {
                        if (
                            ContextCompat.checkSelfPermission(
                                this@MainActivity,
                                Manifest.permission.POST_NOTIFICATIONS,
                            ) != PackageManager.PERMISSION_GRANTED
                        ) {
                            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    }
                },
            ).also { it.install() }
        }
        playerBridge = PlayerBridge(webView) {
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
                if (shelfActive) {
                    // the shelf's own loads, and redirects of a navigation already let through
                    if (request.isRedirect || uri.host == SHELF_HOST) return false
                    openFromShelf(uri, Intent(Intent.ACTION_VIEW, uri))
                    return true
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
                // a failed main frame also finishes; only another page clears its terminal
                if (url != null && url != failedMainFrameUrl && isOwnedUrl(Uri.parse(url))) {
                    hostedLoadTerminal?.let(root::removeView)
                    hostedLoadTerminal = null
                }
                CookieManager.getInstance().flush()
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                shelfActive = url?.let { Uri.parse(it).host } == SHELF_HOST
                offline?.onPageStarted()
                playerBridge.onPageStarted()
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): WebResourceResponse? {
                val router = shelfRouter ?: return null
                val ownedRequest = request ?: return null
                // ahead of onPageStarted, so the next document's subresources see its own mode
                if (ownedRequest.isForMainFrame) shelfActive = ownedRequest.url.host == SHELF_HOST
                return router.intercept(ownedRequest, shelfActive)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true || !isOwnedUrl(request.url)) {
                    return
                }
                if (error?.errorCode != WebViewClient.ERROR_REDIRECT_LOOP) {
                    if (Build.VERSION.SDK_INT >= 34) {
                        failedMainFrameUrl = request.url.toString()
                        showHostedLoadTerminal(HostedLoadFailure.Connection)
                    }
                    return
                }
                failedMainFrameUrl = request.url.toString()
                view?.stopLoading()
                // justify-defect: an owned redirect loop is a routing defect, not a connection failure.
                Log.e("Nexus", "Hosted navigation ended in a redirect loop")
                showHostedLoadTerminal(HostedLoadFailure.RedirectLoop)
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
        root = FrameLayout(this).apply {
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
                    val owned = webView.url?.let { isOwnedUrl(Uri.parse(it)) } == true
                    val exit = if (owned) {
                        "var exit=new Event('nexus:request-exit',{cancelable:true});" +
                            "document.dispatchEvent(exit);return exit.defaultPrevented;"
                    } else {
                        "return false;"
                    }
                    try {
                        webView.evaluateJavascript(
                            "(function(){try{var event=new KeyboardEvent('keydown'," +
                                "{key:'Escape',bubbles:true,cancelable:true});" +
                                "document.dispatchEvent(event);if(event.defaultPrevented)return true;" +
                                exit + "}catch(error){return null;}})()",
                        ) { handledByRenderer ->
                            if (this@MainActivity.isFinishing || this@MainActivity.isDestroyed) {
                                return@evaluateJavascript
                            }
                            when (handledByRenderer) {
                                "true" -> return@evaluateJavascript
                                "false" -> {
                                    if (webView.canGoBack()) {
                                        webView.goBack()
                                        return@evaluateJavascript
                                    }
                                    isEnabled = false
                                    onBackPressedDispatcher.onBackPressed()
                                }
                                else -> showExitFailure()
                            }
                        }
                    } catch (error: RuntimeException) {
                        // justify-defect: a renderer evaluation failure cannot authorize exit.
                        Log.e("Nexus", "Could not check unsaved work before exit", error)
                        showExitFailure()
                    }
                }
            }
        )

        val restoredWebViewState =
            savedInstanceState?.let { webView.restoreState(it) } != null
        if (Build.VERSION.SDK_INT >= 34 && !hasValidatedNetwork()) {
            // cold start offline is the shelf; the launch link is opened locally or offered
            webView.loadUrl(SHELF_URL)
            intent?.data?.let { openFromShelf(it, intent) }
        } else if (!restoredWebViewState) {
            loadUrlFromIntent(intent)
        }
    }

    private fun showExitFailure() {
        AlertDialog.Builder(this)
            .setTitle("couldn’t leave")
            .setMessage("the app couldn’t check unsaved work. return to your work and try again.")
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        webView.invalidate()
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
        val uri = intent.data ?: return
        if (shelfActive) {
            openFromShelf(uri, intent)
            return
        }
        loadUrlFromIntent(intent)
    }

    /**
     * A link or intent while the shelf is the document: an owned `/media/{id}`
     * whose copy is ready opens in the shelf; another owned or sign-in link asks
     * before leaving; anything else goes to the browser.
     */
    private fun openFromShelf(uri: Uri, intent: Intent) {
        val mediaId = mediaIdOf(uri)
        if (mediaId != null && OfflineStore.get(this).isReadyCopy(mediaId)) {
            webView.loadUrl("$SHELF_URL#open=$mediaId")
            return
        }
        if (!isOwnedUrl(uri) && !isNativeAuthUri(uri)) {
            if (uri.scheme == "http" || uri.scheme == "https") openExternalUrl(uri)
            return
        }
        val online = hasValidatedNetwork()
        val builder = AlertDialog.Builder(this)
            .setTitle("Leave downloaded reading?")
            .setMessage(
                when {
                    !online -> "This link is not downloaded. Reconnect before opening it."
                    isNativeAuthUri(uri) -> "Finishing sign-in needs Nexus online. Open Nexus?"
                    else ->
                        "This link is not available in your downloaded copies. Open Nexus online?"
                },
            )
            .setNegativeButton("Stay offline", null)
        if (online) {
            builder.setPositiveButton("Open Nexus") { _, _ ->
                shelfActive = false
                loadUrlFromIntent(intent)
            }
        }
        builder.show()
    }

    private fun mediaIdOf(uri: Uri): UUID? {
        if (!isOwnedUrl(uri)) return null
        val segments = uri.pathSegments
        if (segments.size != 2 || segments[0] != "media") return null
        return try {
            UUID.fromString(segments[1]).takeIf { it.toString() == segments[1] }
        } catch (_: IllegalArgumentException) {
            // justify-ignore-error: a path segment that is not a canonical UUID
            // simply is not a local media link.
            null
        }
    }

    private fun isNativeAuthUri(uri: Uri): Boolean =
        uri.scheme == "nexus" && uri.host == "auth"

    override fun onPause() {
        CookieManager.getInstance().flush()
        webView.onPause()
        webView.pauseTimers()
        super.onPause()
    }

    override fun onStart() {
        super.onStart()
        playerBridge.setForeground(true)
    }

    override fun onStop() {
        playerBridge.setForeground(false)
        // leaving the app: a sync pass adopts what was read online here as the
        // copies' baseline before the device can go offline (A2)
        if (Build.VERSION.SDK_INT >= 34) OfflineJobs.scheduleSync(this, 0)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        if (Build.VERSION.SDK_INT >= 34) {
            OfflineJobs.schedule(this)
            OfflineJobs.scheduleSync(this, 0)
        }
        webView.onResume()
        webView.resumeTimers()
    }

    /** Expected connection failures can reload; redirect defects cannot. */
    private fun showHostedLoadTerminal(reason: HostedLoadFailure) {
        if (hostedLoadTerminal != null && reason == HostedLoadFailure.Connection) return
        hostedLoadTerminal?.let(root::removeView)
        val terminal = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.BLACK)
            addView(TextView(this@MainActivity).apply {
                text = when (reason) {
                    HostedLoadFailure.Connection -> "Nexus could not connect."
                    HostedLoadFailure.RedirectLoop -> "something went wrong."
                }
                setTextColor(Color.WHITE)
                textSize = 18f
            })
            if (reason == HostedLoadFailure.RedirectLoop) {
                addView(TextView(this@MainActivity).apply {
                    text = "nexus couldn’t open this page."
                    setTextColor(Color.WHITE)
                    textSize = 16f
                })
            }
            if (shelfRouter != null) {
                addView(Button(this@MainActivity).apply {
                    text = "Open downloaded copies"
                    setOnClickListener {
                        hostedLoadTerminal?.let(root::removeView)
                        hostedLoadTerminal = null
                        webView.loadUrl(SHELF_URL)
                    }
                })
            }
            if (reason == HostedLoadFailure.Connection) {
                addView(Button(this@MainActivity).apply {
                    text = "Retry"
                    setOnClickListener {
                        hostedLoadTerminal?.let(root::removeView)
                        hostedLoadTerminal = null
                        webView.reload()
                    }
                })
            }
        }
        hostedLoadTerminal = terminal
        root.addView(
            terminal,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
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
        offline?.close()
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    private fun hasValidatedNetwork(): Boolean {
        val manager = getSystemService(android.net.ConnectivityManager::class.java)
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
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
                        if (controller === playerController && command.customAction == NexusPlaybackService.ACTION_EVENT) {
                            args.getString(NexusPlaybackService.ARG_JSON)
                                ?.let(playerBridge::onEvent)
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
                val connected = try {
                    future.get()
                } catch (_: ExecutionException) {
                    // justify-ignore-error: a media session that will not bind
                    // leaves the shell without a player; the next command
                    // reconnects it.
                    null
                } catch (_: CancellationException) {
                    // justify-ignore-error: the shell cancelled this connection
                    // during teardown.
                    null
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    null
                }
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
                    playerBridge.onControllerConnected()
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
