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
import android.webkit.WebResourceError
import android.webkit.WebStorage
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
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import app.nexus.android.offline.OfflineMediaStore
import app.nexus.android.offline.OfflineMediaWebCapability
import app.nexus.android.offline.reading.OfflineReadingStore
import app.nexus.android.offline.readingweb.OFFLINE_READING_ASSET_HOST
import app.nexus.android.offline.readingweb.OFFLINE_READING_MAIN_URL
import app.nexus.android.offline.readingweb.OfflineReadingAccountAttestor
import app.nexus.android.offline.readingweb.OfflineReadingLeaseRegistry
import app.nexus.android.offline.readingweb.OfflineReadingRequestRouter
import app.nexus.android.offline.readingweb.OfflineReadingWebCapability
import app.nexus.android.offline.readingweb.isOfflineReadingMainFrameUrl
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
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException

internal sealed interface RedirectLoopAction {
    data class Recover(val url: String) : RedirectLoopAction
    data object Terminal : RedirectLoopAction
}

internal class RedirectLoopCircuit {
    private var recoveryEntered = false
    private var recoverySurfaceLoaded = false
    private var failedUrl: String? = null

    fun onRedirectLoop(failedUrl: String?, baseUrl: String): RedirectLoopAction {
        if (recoveryEntered) {
            return RedirectLoopAction.Terminal
        }
        recoveryEntered = true
        this.failedUrl = failedUrl
        recoverySurfaceLoaded = false
        val failed = failedUrl?.let(::parseUri)
        val requestedNext = if (failed?.path?.startsWith("/auth/") == true) {
            failed.queryParameter("next")
        } else {
            failed?.rawPath?.let { path ->
                path + (failed.rawQuery?.let { "?$it" } ?: "")
            }
        }
        val next = requestedNext?.takeIf {
            it.startsWith("/") && !it.startsWith("//") && !it.startsWith("/auth/")
        } ?: DEFAULT_AUTH_RETURN_TARGET
        val recoveryUrl = URI(baseUrl).resolve("/auth/session/recover")
        return RedirectLoopAction.Recover(
            "$recoveryUrl?next=${URLEncoder.encode(next, StandardCharsets.UTF_8.name())}",
        )
    }

    fun onSuccessfulNavigation(url: String?) {
        val parsed = url?.let(::parseUri) ?: return
        if (parsed.path == "/auth/session/recover") {
            recoverySurfaceLoaded = true
            return
        }
        if (parsed.path?.startsWith("/auth/") == true) {
            return
        }
        if (!recoverySurfaceLoaded && url == failedUrl) {
            return
        }
        recoveryEntered = false
        recoverySurfaceLoaded = false
        failedUrl = null
    }

    fun reset() {
        recoveryEntered = false
        recoverySurfaceLoaded = false
        failedUrl = null
    }

    private fun parseUri(value: String): URI? =
        try {
            URI(value)
        } catch (_: URISyntaxException) {
            // justify-ignore-error: a URL the platform will not parse cannot
            // name a recovery target; the caller falls back to the default one.
            null
        }

    private fun URI.queryParameter(name: String): String? =
        rawQuery
            ?.split('&')
            ?.asSequence()
            ?.mapNotNull { part ->
                val separator = part.indexOf('=')
                val key = if (separator >= 0) part.substring(0, separator) else part
                if (decode(key) != name) {
                    return@mapNotNull null
                }
                decode(if (separator >= 0) part.substring(separator + 1) else "")
            }
            ?.firstOrNull()

    private fun decode(value: String): String? =
        try {
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())
        } catch (_: IllegalArgumentException) {
            // justify-ignore-error: a malformed percent escape carries no
            // return target; the caller falls back to the default one.
            null
        }
}

internal fun hostedFailureBelongsToCurrentDocument(
    requestUrl: String?,
    currentUrl: String?,
    offlineReadingShellActive: Boolean,
): Boolean =
    !offlineReadingShellActive && requestUrl != null && requestUrl == currentUrl

@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {
    internal lateinit var webView: WebView
    internal lateinit var shellChromeClient: WebChromeClient
    private lateinit var root: FrameLayout
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val nexusBaseUri = Uri.parse(BuildConfig.NEXUS_BASE_URL)
    internal var pendingHandoffVerifier: String? = null
    private val googleSignInController by lazy { GoogleSignInController(this) }
    private lateinit var offlineMediaCapability: OfflineMediaWebCapability
    private lateinit var offlineReadingCapability: OfflineReadingWebCapability
    private lateinit var offlineReadingRouter: OfflineReadingRequestRouter
    private var offlineReadingShellActive = false
    private var currentMainFrameUrl: String? = null
    private val redirectLoopCircuit = RedirectLoopCircuit()
    private var redirectLoopTerminal: View? = null
    private var hostedLoadTerminal: View? = null
    private var redirectLoopRetryUrl: String? = null
    private var deferredShelfIntent: Intent? = null

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
        val offlineReadingStore = OfflineReadingStore.get(this)
        val offlineReadingLeases = OfflineReadingLeaseRegistry(offlineReadingStore::closeLease)
        offlineReadingRouter = OfflineReadingRequestRouter(this, offlineReadingLeases)
        val accountAttestor = OfflineReadingAccountAttestor()
        offlineReadingCapability = OfflineReadingWebCapability(
            webView = webView,
            store = offlineReadingStore,
            leases = offlineReadingLeases,
            attestHostedAccount = accountAttestor::attest,
            audioStore = OfflineMediaStore.get(this),
            openHosted = { webView.loadUrl(BuildConfig.NEXUS_BASE_URL) },
            openOffline = { webView.loadUrl(OFFLINE_READING_MAIN_URL) },
            onLogout = {
                CookieManager.getInstance().removeAllCookies {
                    WebStorage.getInstance().deleteAllData()
                    webView.clearCache(true)
                    webView.loadUrl(OFFLINE_READING_MAIN_URL)
                }
            },
            onHostedConnectUnavailable = ::showOfflineReadingBindingTerminal,
        )
        if (Build.VERSION.SDK_INT >= 34) {
            offlineReadingCapability.install()
        }
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
                if (offlineReadingShellActive) {
                    if (request.isForMainFrame && isOfflineReadingMainFrameUrl(uri)) {
                        return false
                    }
                    if (!request.isForMainFrame) return false
                    showLeaveOfflineReadingConfirmation(uri) { webView.loadUrl(uri.toString()) }
                    return true
                }
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
                if (url != null && isOwnedUrl(Uri.parse(url))) {
                    hostedLoadTerminal?.let(root::removeView)
                    hostedLoadTerminal = null
                }
                CookieManager.getInstance().flush()
                redirectLoopCircuit.onSuccessfulNavigation(url)
                if (url == OFFLINE_READING_MAIN_URL) {
                    deferredShelfIntent?.let { pending ->
                        deferredShelfIntent = null
                        showLeaveOfflineReadingConfirmation(pending)
                    }
                }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                currentMainFrameUrl = url
                offlineReadingShellActive = url == OFFLINE_READING_MAIN_URL
                offlineMediaCapability.onPageStarted()
                offlineReadingCapability.onPageStarted(url)
                playerBridge.onPageStarted()
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): android.webkit.WebResourceResponse? {
                if (Build.VERSION.SDK_INT < 34) return null
                val ownedRequest = request ?: return null
                return if (offlineReadingShellActive) {
                    offlineReadingRouter.interceptOfflineDocument(ownedRequest)
                } else {
                    offlineReadingRouter.intercept(ownedRequest)
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (
                    request?.isForMainFrame == true &&
                    Build.VERSION.SDK_INT >= 34 &&
                    request.url?.let(::isOwnedUrl) == true &&
                    hostedFailureBelongsToCurrentDocument(
                        request.url?.toString(),
                        currentMainFrameUrl,
                        offlineReadingShellActive,
                    ) &&
                    error?.errorCode != WebViewClient.ERROR_REDIRECT_LOOP
                ) {
                    showHostedLoadTerminal()
                    return
                }
                if (
                    request?.isForMainFrame != true ||
                    error?.errorCode != WebViewClient.ERROR_REDIRECT_LOOP
                ) {
                    return
                }
                view?.stopLoading()
                when (
                    val action = redirectLoopCircuit.onRedirectLoop(
                        request?.url?.toString() ?: view?.url,
                        BuildConfig.NEXUS_BASE_URL,
                    )
                ) {
                    is RedirectLoopAction.Recover -> {
                        redirectLoopRetryUrl = action.url
                        removeRedirectLoopTerminal()
                        webView.loadUrl(action.url)
                    }
                    RedirectLoopAction.Terminal -> showRedirectLoopTerminal()
                }
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
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        )

        val restoredWebViewState =
            savedInstanceState?.let { webView.restoreState(it) } != null
        if (Build.VERSION.SDK_INT >= 34 && !hasValidatedNetwork()) {
            startOfflineReadingShell(intent)
        } else if (!restoredWebViewState) {
            loadUrlFromIntent(intent)
        }
    }

    /**
     * Cold start without a validated network keeps the shelf, and keeps the
     * launch link: an installed media ID opens locally, anything else is held
     * and offered explicitly once the shelf is up. The link is never dropped.
     */
    private fun startOfflineReadingShell(launchIntent: Intent?) {
        val held = launchIntent?.takeIf { it.data != null }
        val mediaId = held?.data?.let(::offlineReadingMediaId)
        val openedLocally = mediaId != null &&
            offlineReadingCapability.requestLocalOpen(mediaId) {
                held?.let(::showLeaveOfflineReadingConfirmation)
            }
        deferredShelfIntent = if (openedLocally) null else held
        webView.loadUrl(OFFLINE_READING_MAIN_URL)
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
        if (offlineReadingShellActive) {
            val mediaId = offlineReadingMediaId(uri)
            val openedLocally = mediaId != null &&
                offlineReadingCapability.requestLocalOpen(mediaId) {
                    showLeaveOfflineReadingConfirmation(intent)
                }
            if (openedLocally) return
            showLeaveOfflineReadingConfirmation(intent)
            return
        }
        loadUrlFromIntent(intent)
    }

    private fun offlineReadingMediaId(uri: Uri): UUID? {
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

    /** Asks before leaving the shelf for an owned link the shelf cannot serve. */
    private fun showLeaveOfflineReadingConfirmation(intent: Intent) {
        val uri = intent.data ?: return
        showLeaveOfflineReadingConfirmation(uri) { loadUrlFromIntent(intent) }
    }

    private fun showLeaveOfflineReadingConfirmation(
        uri: Uri,
        openHosted: () -> Unit,
    ) {
        if (!isOwnedUrl(uri) && !isNativeAuthUri(uri)) {
            if (uri.scheme == "http" || uri.scheme == "https") openExternalUrl(uri)
            return
        }
        val online = hasValidatedNetwork()
        val builder = androidx.appcompat.app.AlertDialog.Builder(this)
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
            builder.setPositiveButton("Open Nexus") { _, _ -> openHosted() }
        }
        builder.show()
    }

    private fun isNativeAuthUri(uri: Uri): Boolean =
        uri.scheme == "nexus" && uri.host == "auth"

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

    private fun showRedirectLoopTerminal() {
        if (redirectLoopTerminal != null) {
            return
        }
        val terminal = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.BLACK)
            addView(TextView(this@MainActivity).apply {
                text = "Nexus could not restore this session."
                setTextColor(Color.WHITE)
                textSize = 18f
            })
            addView(Button(this@MainActivity).apply {
                text = "Retry"
                setOnClickListener {
                    val retryUrl = redirectLoopRetryUrl ?: return@setOnClickListener
                    redirectLoopCircuit.reset()
                    removeRedirectLoopTerminal()
                    webView.loadUrl(retryUrl)
                }
            })
        }
        redirectLoopTerminal = terminal
        root.addView(
            terminal,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    private fun showHostedLoadTerminal() =
        showDownloadedCopiesTerminal("Nexus could not connect.")

    /**
     * Hosted Nexus loaded but its account-binding endpoint is unavailable, so the
     * hosted renderer cannot be trusted with package inventory. Android offers
     * the shelf itself.
     */
    internal fun showOfflineReadingBindingTerminal() =
        showDownloadedCopiesTerminal("Nexus could not confirm this account for downloads.")

    private fun showDownloadedCopiesTerminal(message: String) {
        if (hostedLoadTerminal != null) return
        val terminal = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setBackgroundColor(Color.BLACK)
            addView(TextView(this@MainActivity).apply {
                text = message
                setTextColor(Color.WHITE)
                textSize = 18f
            })
            addView(Button(this@MainActivity).apply {
                text = "Open downloaded copies"
                setOnClickListener {
                    hostedLoadTerminal?.let(root::removeView)
                    hostedLoadTerminal = null
                    webView.loadUrl(OFFLINE_READING_MAIN_URL)
                }
            })
            addView(Button(this@MainActivity).apply {
                text = "Retry"
                setOnClickListener {
                    hostedLoadTerminal?.let(root::removeView)
                    hostedLoadTerminal = null
                    webView.reload()
                }
            })
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

    private fun removeRedirectLoopTerminal() {
        redirectLoopTerminal?.let(root::removeView)
        redirectLoopTerminal = null
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
        offlineReadingCapability.close()
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
