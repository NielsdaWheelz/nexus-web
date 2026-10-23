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
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
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
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject
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
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException

@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {
    internal lateinit var webView: WebView
    internal lateinit var shellChromeClient: WebChromeClient
    private lateinit var root: FrameLayout
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var writingExportPicker: ((Uri?) -> Unit)? = null
    private val nexusBaseUri = Uri.parse(BuildConfig.NEXUS_BASE_URL)
    private val deviceSession by lazy { DeviceSession.get(this) }
    private val appRouter by lazy { AppRouter(this, deviceSession) }
    private lateinit var appBridge: AppBridge
    private var authAttempt: DeviceSession.Attempt? = null
    private var browserWasPaused = false
    private var pendingAppLink: Uri? = null
    private var pendingShelfExit: Uri? = null
    private var appDocumentGeneration = 0L
    private val googleSignInController by lazy { GoogleSignInController(this) }
    // offline (android 14+): the bridge and the shelf router exist only there
    private var offline: OfflineBridge? = null
    private var shelfRouter: ShelfRouter? = null
    // the shelf is the main document: set at each main-frame request and at its commit
    @Volatile private var shelfActive = false

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

    private val writingExportLauncher =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
            val complete = writingExportPicker
            writingExportPicker = null
            complete?.invoke(uri)
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
        appBridge = AppBridge(webView, deviceSession, ::signIn, ::flushAppLink)
        val bridgeAvailable = appBridge.install()
        if (Build.VERSION.SDK_INT >= 34) {
            val store = OfflineStore.get(this)
            shelfRouter = ShelfRouter(this, store)
            offline = OfflineBridge(
                webView,
                store,
                object : OfflineBridge.Host {
                    override fun showDownloads() = webView.loadUrl(SHELF_URL)

                    override fun openHosted(path: String) {
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

                    override fun chooseWritingExport(complete: (Uri?) -> Unit): Boolean {
                        if (writingExportPicker != null || fileChooserCallback != null) return false
                        writingExportPicker = complete
                        try {
                            writingExportLauncher.launch("nexus-writing-${System.currentTimeMillis()}.json")
                        } catch (_: ActivityNotFoundException) {
                            writingExportPicker = null
                            return false
                        }
                        return true
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
                    if (uri.host == SHELF_HOST) return false
                    openFromShelf(uri, Intent(Intent.ACTION_VIEW, uri))
                    return true
                }
                if (isNativeAuthUri(uri)) {
                    handleAuthUri(uri)
                    return true
                }
                if (appRouter.isAppRoute(uri) && request.method == "GET") return false
                if (isOwnedUrl(uri) && request.method != "GET") return false
                openBrowser(uri)
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                appDocumentGeneration += 1
                shelfActive = url?.let { Uri.parse(it).host } == SHELF_HOST
                appBridge.onPageStarted()
                offline?.onPageStarted()
                playerBridge.onPageStarted()
                if (url?.let { appRouter.isAppRoute(Uri.parse(it)) } == true) {
                    val target = pendingShelfExit
                    pendingShelfExit = null
                    target?.let(::routeUrl)
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?,
            ) {
                if (request == null || !appRouter.isOwned(request.url) ||
                    request.url.path?.startsWith("/_nexus/") == true) return
                if (errorResponse?.statusCode in setOf(401, 426) &&
                    deviceSession.remoteAdmission in setOf("Ready", "Unavailable")) deviceSession.requestCheck()
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): WebResourceResponse? {
                val ownedRequest = request ?: return null
                return shelfRouter?.intercept(ownedRequest, shelfActive) ?: appRouter.intercept(ownedRequest)
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
                    try {
                        webView.evaluateJavascript(
                            "(function(){try{var event=new KeyboardEvent('keydown'," +
                                "{key:'Escape',bubbles:true,cancelable:true});" +
                                "document.dispatchEvent(event);return event.defaultPrevented;" +
                                "}catch(error){return null;}})()",
                        ) { handled ->
                            if (isFinishing || isDestroyed || handled == "true") return@evaluateJavascript
                            if (handled != "false") { showExitFailure(); return@evaluateJavascript }
                            if (webView.canGoBack()) { webView.goBack(); return@evaluateJavascript }
                            val owned = webView.url?.let { isOwnedUrl(Uri.parse(it)) } == true
                            if (!owned) {
                                isEnabled = false
                                onBackPressedDispatcher.onBackPressed()
                                return@evaluateJavascript
                            }
                            try {
                                webView.evaluateJavascript(
                                    "(function(){try{var event=new Event('nexus:request-exit',{cancelable:true});" +
                                        "document.dispatchEvent(event);return event.defaultPrevented;}catch(error){return null;}})()",
                                ) exitReply@ { blocked ->
                                    if (isFinishing || isDestroyed || blocked == "true") return@exitReply
                                    if (blocked == "false") {
                                        isEnabled = false
                                        onBackPressedDispatcher.onBackPressed()
                                    } else showExitFailure()
                                }
                            } catch (error: RuntimeException) {
                                Log.e("Nexus", "Could not check unsaved work before exit", error)
                                showExitFailure()
                            }
                        }
                    } catch (error: RuntimeException) {
                        Log.e("Nexus", "Could not check renderer before back", error)
                        showExitFailure()
                    }
                }
            }
        )

        if (!bridgeAvailable) {
            root.removeView(webView)
            root.addView(TextView(this).apply {
                text = "update android system webview to open nexus"
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.BLACK)
                gravity = Gravity.CENTER
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            return
        }
        lifecycleScope.launch {
            try { deviceSession.initialize() } catch (_: LocalStateError) { /* entry owns visible repair state */ }
            loadUrlFromIntent(intent)
            deviceSession.setForeground(true)
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
        AlertDialog.Builder(this)
            .setTitle("leave downloaded reading?")
            .setMessage("return to your workspace to open this link.")
            .setNegativeButton("stay here", null)
            .setPositiveButton("open workspace") { _, _ ->
                if (appRouter.isAppRoute(uri)) loadUrlFromIntent(intent)
                else {
                    pendingShelfExit = uri
                    webView.loadUrl(BuildConfig.NEXUS_BASE_URL)
                }
            }.show()
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
        if (authAttempt != null) browserWasPaused = true
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
        deviceSession.setForeground(false)
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
        if (::appBridge.isInitialized) deviceSession.setForeground(true)
        if (browserWasPaused) {
            browserWasPaused = false
            // onNewIntent runs before onResume for an actual handoff; it retires authAttempt.
            authAttempt?.let { current ->
                webView.post {
                    if (authAttempt === current) {
                        deviceSession.cancelAttempt(current)
                        authAttempt = null
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        playerLifecycleClosing = true
        authAttempt?.let(deviceSession::cancelAttempt)
        authAttempt = null
        appBridge.close()
        playerBridge.close()
        playerController?.release()
        playerController = null
        playerControllerFuture?.cancel(true)
        playerControllerFuture = null
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        writingExportPicker = null
        offline?.close()
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
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
        if (isNativeAuthUri(uri)) { handleAuthUri(uri); return }
        if (!appRouter.isAppRoute(uri)) { openBrowser(uri); return }
        val current = webView.url?.let(Uri::parse)
        if (current != null && appRouter.isAppRoute(current)) {
            pendingAppLink = uri
            flushAppLink()
        } else {
            pendingAppLink = null
            webView.loadUrl(uri.toString())
        }
    }

    /** The command owner acknowledges delivery; a boot or unbound document retains the latest link. */
    private fun flushAppLink() {
        val uri = pendingAppLink ?: return
        if (isFinishing || isDestroyed || webView.url?.let { appRouter.isAppRoute(Uri.parse(it)) } != true) return
        val generation = appDocumentGeneration
        val href = (uri.encodedPath ?: "/") + (uri.encodedQuery?.let { "?$it" } ?: "") +
            (uri.encodedFragment?.let { "#$it" } ?: "")
        webView.evaluateJavascript(
            "(function(){var event=new CustomEvent('nexus:navigate',{cancelable:true,detail:{href:" +
                JSONObject.quote(href) + "}});window.dispatchEvent(event);return event.defaultPrevented;})()",
        ) { handled ->
            if (handled == "true" && generation == appDocumentGeneration && pendingAppLink == uri) pendingAppLink = null
        }
    }

    private fun openBrowser(uri: Uri) {
        val target = if (isOwnedUrl(uri) && (uri.path?.startsWith("/account/") == true)) {
            uri.buildUpon().clearQuery().apply {
                for (name in uri.queryParameterNames) {
                    if (name != "expected_account_id") for (value in uri.getQueryParameters(name)) appendQueryParameter(name, value)
                }
                deviceSession.accountId()?.let { appendQueryParameter("expected_account_id", it.toString()) }
            }.build()
        } else uri
        openExternalUrl(target)
    }

    private suspend fun signIn(): String {
        val current = try { deviceSession.newAttempt() }
        catch (error: NexusOriginError) {
            if (error.code == "E_DIFFERENT_ACCOUNT") return "DifferentAccount"
            throw error
        }
        authAttempt = current
        val uri = nexusBaseUri.buildUpon().path("/login")
            .appendQueryParameter("flow", "handoff").appendQueryParameter("hc", current.challenge).build()
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri)
        } catch (_: ActivityNotFoundException) {
            deviceSession.cancelAttempt(current)
            authAttempt = null
            return "Failed"
        }
        return current.result.await()
    }

    internal fun startAuthFlow(triggerUri: Uri) {
        lifecycleScope.launch { signIn() }
    }

    private fun handleAuthUri(uri: Uri) {
        // An intent return is not a user closing the current custom tab.
        if (uri.path in setOf("/native", "/handoff")) browserWasPaused = false
        when (uri.path) {
            "/start" -> startAuthFlow(uri)
            "/native" -> {
                if (uri.getQueryParameter("provider") != "google" ||
                    deviceSession.currentAttempt(uri.getQueryParameter("hc")) == null) return
                authAttempt = null
                googleSignInController.signIn(uri)
            }
            "/handoff" -> {
                val challenge = uri.getQueryParameter("hc")
                val current = deviceSession.currentAttempt(challenge) ?: return
                authAttempt = null
                if (uri.getQueryParameter("error") == "oauth_user_cancelled") deviceSession.cancelAttempt(current)
                else lifecycleScope.launch { deviceSession.redeem(challenge, uri.getQueryParameter("code")) }
            }
        }
    }

    internal fun loadUrlFromIntent(intent: Intent?) {
        val uri = intent?.data
        if (uri == null) {
            if (webView.url == null) webView.loadUrl(BuildConfig.NEXUS_BASE_URL)
        } else {
            if (webView.url == null && !appRouter.isAppRoute(uri)) webView.loadUrl(BuildConfig.NEXUS_BASE_URL)
            routeUrl(uri)
        }
    }

    private fun isOwnedUrl(uri: Uri): Boolean = appRouter.isOwned(uri)

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
