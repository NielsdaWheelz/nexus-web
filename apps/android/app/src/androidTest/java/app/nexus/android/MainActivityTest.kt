package app.nexus.android

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import androidx.lifecycle.Lifecycle
import androidx.core.view.WindowInsetsControllerCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.Description
import org.hamcrest.Matcher
import org.hamcrest.Matchers.allOf
import org.hamcrest.TypeSafeMatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @After
    fun tearDownIntents() {
        try {
            Intents.release()
        } catch (_: IllegalStateException) {
        }
    }

    @Test
    fun ownedNexusUrlLoadsInsideTheWebView() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val ownedUrl = "${BuildConfig.NEXUS_BASE_URL}/settings"

            scenario.onActivity { activity ->
                activity.routeUrl(Uri.parse(ownedUrl))
            }

            waitUntil("Expected WebView to load owned Nexus URL.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == ownedUrl
            }
        }
    }

    @Test
    fun webViewUsesShellSecuritySettings() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val settings = activity.webView.settings

                assertTrue(settings.javaScriptEnabled)
                assertTrue(settings.domStorageEnabled)
                assertFalse(settings.allowFileAccess)
                assertFalse(settings.allowContentAccess)
                assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.mixedContentMode)
                assertTrue(settings.safeBrowsingEnabled)
                assertFalse(settings.javaScriptCanOpenWindowsAutomatically)
                assertTrue(settings.userAgentString.contains("NexusAndroidShell"))
                assertFalse(CookieManager.getInstance().acceptThirdPartyCookies(activity.webView))
            }
        }
    }

    @Test
    fun statusBarHasDarkNativeProtectionWithLightIcons() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitUntil("Expected native status-bar protection to receive its inset height.") {
                var height = 0
                scenario.onActivity { activity ->
                    height = activity.findViewById<View>(R.id.status_bar_protection).height
                }
                height > 0
            }

            scenario.onActivity { activity ->
                val protection = activity.findViewById<View>(R.id.status_bar_protection)

                assertEquals(Color.BLACK, (protection.background as ColorDrawable).color)
                assertFalse(
                    WindowInsetsControllerCompat(
                        activity.window,
                        activity.window.decorView
                    ).isAppearanceLightStatusBars
                )
            }
        }
    }

    @Test
    fun offOriginUrlOpensACustomTabIntent() {
        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val externalUri = Uri.parse("https://external.example.com/privacy")

            Intents.intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(externalUri)))
                .respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.routeUrl(externalUri)
            }

            assertIntentRecorded(
                allOf(hasAction(Intent.ACTION_VIEW), hasData(externalUri)),
                "Expected off-origin URL to launch an ACTION_VIEW intent."
            )
        }
    }

    @Test
    fun sameHostDifferentPortOpensACustomTabIntent() {
        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val supabaseAuthorizeUri =
                Uri.parse("http://${BuildConfig.NEXUS_OWNED_HOST}:54321/auth/v1/authorize")

            Intents.intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(supabaseAuthorizeUri)))
                .respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.routeUrl(supabaseAuthorizeUri)
            }

            assertIntentRecorded(
                allOf(hasAction(Intent.ACTION_VIEW), hasData(supabaseAuthorizeUri)),
                "Expected the different-port URL to launch an ACTION_VIEW intent."
            )
        }
    }

    @Test
    fun ownedCallbackIntentLoadsThatExactUrl() {
        val callbackUrl =
            "${BuildConfig.NEXUS_BASE_URL}/auth/callback?code=test-code&next=%2Flibraries"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(callbackUrl)).apply {
            setClass(
                ApplicationProvider.getApplicationContext(),
                MainActivity::class.java
            )
        }

        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            waitUntil("Expected app link callback URL to load in the WebView.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == callbackUrl
            }
        }
    }

    @Test
    fun coldLauncherIntentLoadsTheBaseRoot() {
        val baseUri = Uri.parse(BuildConfig.NEXUS_BASE_URL)
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
            setClass(
                ApplicationProvider.getApplicationContext(),
                MainActivity::class.java
            )
        }

        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            waitUntil("Expected cold launcher intent to load the base root.") {
                var currentUri: Uri? = null
                scenario.onActivity { activity ->
                    currentUri = activity.webView.url?.let(Uri::parse)
                }
                currentUri?.scheme == baseUri.scheme &&
                    currentUri?.host == baseUri.host &&
                    currentUri?.port == baseUri.port &&
                    (currentUri?.path.isNullOrEmpty() || currentUri?.path == "/") &&
                    currentUri?.query == null &&
                    currentUri?.fragment == null
            }
        }
    }

    @Test
    fun unsupportedExplicitIntentDoesNotReloadTheWebView() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val ownedUrl = "${BuildConfig.NEXUS_BASE_URL}/settings"
            val unsupportedUri = Uri.parse("https://external.example.com/ignored")

            scenario.onActivity { activity ->
                activity.routeUrl(Uri.parse(ownedUrl))
            }
            waitUntil("Expected WebView to load owned Nexus URL.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == ownedUrl
            }

            scenario.onActivity { activity ->
                activity.loadUrlFromIntent(Intent(Intent.ACTION_VIEW, unsupportedUri))
                assertEquals(ownedUrl, activity.webView.url)
            }
        }
    }

    @Test
    fun ownedCallbackIntentWhileRunningLoadsThatExactUrl() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val callbackUrl =
                "${BuildConfig.NEXUS_BASE_URL}/auth/callback?code=test-code&next=%2Flibraries"

            scenario.onActivity { activity ->
                activity.loadUrlFromIntent(Intent(Intent.ACTION_VIEW, Uri.parse(callbackUrl)))
            }

            waitUntil("Expected app link callback new intent to load in the WebView.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == callbackUrl
            }
        }
    }

    @Test
    fun nexusAuthStartLaunchesCustomTabAtAuthOauthUrl() {
        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val oauthPrefix = "${BuildConfig.NEXUS_BASE_URL}/auth/oauth"

            Intents.intending(
                allOf(hasAction(Intent.ACTION_VIEW), hasData(hasUriStringStartingWith(oauthPrefix)))
            ).respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.startAuthFlow(
                    Uri.parse("nexus://auth/start?provider=github&mode=signin&next=%2Fbrowse")
                )
            }

            assertIntentRecorded(
                allOf(
                    hasAction(Intent.ACTION_VIEW),
                    hasData(
                        hasOauthHandoffUriParts(
                            prefix = oauthPrefix,
                            requiredParams = mapOf(
                                "provider" to "github",
                                "mode" to "signin",
                                "flow" to "handoff",
                                "next" to "/browse"
                            ),
                            hexParam = "hc"
                        )
                    )
                ),
                "Expected the auth start route to launch its OAuth handoff intent."
            )
        }
    }

    @Test
    fun nexusAuthStartDefaultsMissingNextToLectern() {
        assertEquals("/lectern", DEFAULT_AUTH_RETURN_TARGET)

        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val oauthPrefix = "${BuildConfig.NEXUS_BASE_URL}/auth/oauth"

            Intents.intending(
                allOf(hasAction(Intent.ACTION_VIEW), hasData(hasUriStringStartingWith(oauthPrefix)))
            ).respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.startAuthFlow(Uri.parse("nexus://auth/start?provider=github&mode=signin"))
            }

            assertIntentRecorded(
                allOf(
                    hasAction(Intent.ACTION_VIEW),
                    hasData(
                        hasOauthHandoffUriParts(
                            prefix = oauthPrefix,
                            requiredParams = mapOf(
                                "provider" to "github",
                                "mode" to "signin",
                                "flow" to "handoff"
                            ),
                            absentParams = setOf("next"),
                            hexParam = "hc"
                        )
                    )
                ),
                "Expected the auth start route to launch its default-return OAuth handoff intent."
            )
        }
    }

    @Test
    fun nexusAuthHandoffIntentLoadsWebHandoffUrlWithVerifier() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val expectedUrl =
                "${BuildConfig.NEXUS_BASE_URL}/auth/handoff" +
                    "?code=test-code-xyz&next=%2Flibraries&hv=test-verifier-abc123"

            scenario.onActivity { activity ->
                activity.pendingHandoffVerifier = "test-verifier-abc123"
                activity.loadUrlFromIntent(
                    Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse("nexus://auth/handoff?code=test-code-xyz&next=%2Flibraries")
                    ).apply {
                        setClass(activity, MainActivity::class.java)
                    }
                )
            }

            waitUntil("Expected nexus://auth/handoff intent to load /auth/handoff with hv in the WebView.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == expectedUrl
            }

            scenario.onActivity { activity ->
                assertNull(
                    "Expected pendingHandoffVerifier to be consumed (cleared) after the handoff load.",
                    activity.pendingHandoffVerifier
                )
            }
        }
    }

    @Test
    fun startAuthFlowRejectsUnknownProviderSilently() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.startAuthFlow(Uri.parse("nexus://auth/start?provider=facebook&next=/"))
                assertNull(
                    "Expected unknown provider to be rejected without persisting a verifier.",
                    activity.pendingHandoffVerifier
                )
            }
        }
    }

    @Test
    fun warmLauncherIntentPreservesWebViewHistoryAndBackNavigation() {
        val firstUrl = "${BuildConfig.NEXUS_BASE_URL}/first"
        val secondUrl = "${BuildConfig.NEXUS_BASE_URL}/second"

        launchWithoutInitialNavigation().use { scenario ->
            scenario.onActivity { activity ->
                activity.webView.loadDataWithBaseURL(
                    firstUrl,
                    "<!doctype html><title>Nexus first</title>",
                    "text/html",
                    "utf-8",
                    firstUrl
                )
            }

            waitUntil("Expected WebView to load the first test page.") {
                var currentUrl: String? = null
                var progress = 0
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                    progress = activity.webView.progress
                }
                currentUrl == firstUrl && progress == 100
            }

            scenario.onActivity { activity ->
                activity.webView.loadDataWithBaseURL(
                    secondUrl,
                    "<!doctype html><title>Nexus second</title>",
                    "text/html",
                    "utf-8",
                    secondUrl
                )
            }

            waitUntil("Expected WebView test page to create back history.") {
                var currentUrl: String? = null
                var progress = 0
                var canGoBack = false
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                    progress = activity.webView.progress
                    canGoBack = activity.webView.canGoBack()
                }
                currentUrl == secondUrl && progress == 100 && canGoBack
            }

            scenario.onActivity { activity ->
                val activityInfo = activity.packageManager.getActivityInfo(
                    ComponentName(activity, MainActivity::class.java),
                    0
                )
                assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK, activityInfo.launchMode)

                activity.routeNewIntent(
                    Intent(Intent.ACTION_MAIN).apply {
                        setClass(activity, MainActivity::class.java)
                        addCategory(Intent.CATEGORY_LAUNCHER)
                    }
                )
            }
            scenario.onActivity { activity ->
                assertEquals(secondUrl, activity.webView.url)
                assertTrue(activity.webView.canGoBack())
            }

            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
            }

            waitUntil("Expected Android back to return to the previous WebView entry first.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == firstUrl
            }
        }
    }

    @Test
    fun hardwareBackPopsNestedWebHistoryInOrder() {
        launchWithoutInitialNavigation().use { scenario ->
            loadNestedWebHistory(scenario)

            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
            }
            waitForNestedWebHistoryPage(
                scenario,
                page = "Find",
                fragment = "#find",
                message = "Expected Android back to pop Workflow to Find."
            )

            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
            }
            waitForNestedWebHistoryPage(
                scenario,
                page = "Root",
                fragment = "#root",
                message = "Expected Android back to pop Find to Root."
            )
        }
    }

    @Test
    fun orientationRecreationPreservesNestedWebHistory() {
        launchWithoutInitialNavigation().use { scenario ->
            loadNestedWebHistory(scenario)

            // ActivityScenario recreation exercises the saved-instance path used
            // by an orientation configuration change without relying on a
            // device/emulator rotation lock.
            scenario.recreate()

            waitForNestedWebHistoryPage(
                scenario,
                page = "Workflow",
                fragment = "#workflow",
                message = "Expected orientation recreation to keep the active nested history entry."
            )
            scenario.onActivity { activity ->
                assertTrue(
                    "Expected restored WebView to retain nested back history.",
                    activity.webView.canGoBack()
                )
                activity.onBackPressedDispatcher.onBackPressed()
            }
            waitForNestedWebHistoryPage(
                scenario,
                page = "Find",
                fragment = "#find",
                message = "Expected restored nested history to pop Workflow to Find."
            )
        }
    }

    @Test
    fun backgroundingAndResumingKeepsTheWebViewLoaded() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val ownedUrl = "${BuildConfig.NEXUS_BASE_URL}/settings"

            scenario.onActivity { activity ->
                activity.routeUrl(Uri.parse(ownedUrl))
            }
            waitUntil("Expected WebView to load owned Nexus URL.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == ownedUrl
            }

            scenario.moveToState(Lifecycle.State.STARTED)
            scenario.moveToState(Lifecycle.State.RESUMED)

            waitUntil("Expected WebView to survive pause and resume.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == ownedUrl
            }
        }
    }

    @Test
    fun scriptOpenedPopupsAreRejected() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertFalse(
                    activity.shellChromeClient.onCreateWindow(
                        activity.webView,
                        false,
                        false,
                        null
                    )
                )
            }
        }
    }

    @Test
    fun userOpenedPopupWebViewsUseShellSecuritySettings() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val message = Message.obtain(Handler(Looper.getMainLooper()) { true })
                val transport = activity.webView.WebViewTransport()
                message.obj = transport

                assertTrue(
                    activity.shellChromeClient.onCreateWindow(
                        activity.webView,
                        false,
                        true,
                        message
                    )
                )

                val popupWebView = checkNotNull(transport.webView)
                val settings = popupWebView.settings
                assertTrue(settings.javaScriptEnabled)
                assertTrue(settings.domStorageEnabled)
                assertFalse(settings.allowFileAccess)
                assertFalse(settings.allowContentAccess)
                assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.mixedContentMode)
                assertTrue(settings.safeBrowsingEnabled)
                assertFalse(settings.javaScriptCanOpenWindowsAutomatically)
                assertTrue(settings.userAgentString.contains("NexusAndroidShell"))
                assertFalse(CookieManager.getInstance().acceptThirdPartyCookies(popupWebView))
                popupWebView.destroy()
            }
        }
    }

    @Test
    fun missingFileInputCallbackDoesNotLaunchChooser() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertFalse(
                    activity.shellChromeClient.onShowFileChooser(
                        activity.webView,
                        null,
                        FakeFileChooserParams()
                    )
                )
            }
        }
    }

    @Test
    fun fileInputLaunchesTheSystemChooserAndReturnsTheSelectedUri() {
        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val selectedUri = Uri.parse("content://nexus/tests/file.pdf")
            val callback = RecordingValueCallback()

            Intents.intending(hasAction(Intent.ACTION_GET_CONTENT))
                .respondWith(
                    ActivityResult(
                        Activity.RESULT_OK,
                        Intent().setData(selectedUri)
                    )
                )

            scenario.onActivity { activity ->
                val handled = activity.shellChromeClient.onShowFileChooser(
                    activity.webView,
                    callback,
                    FakeFileChooserParams()
                )
                assertTrue(handled)
            }

            assertIntentRecorded(
                hasAction(Intent.ACTION_GET_CONTENT),
                "Expected the file input to launch the system content chooser."
            )

            waitUntil("Expected file chooser callback to receive the selected URI.") {
                callback.called
            }

            assertEquals(selectedUri, callback.value?.single())
        }
    }

    @Test
    fun cancelledFileInputReturnsNull() {
        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val callback = RecordingValueCallback()

            Intents.intending(hasAction(Intent.ACTION_GET_CONTENT))
                .respondWith(ActivityResult(Activity.RESULT_CANCELED, null))

            scenario.onActivity { activity ->
                val handled = activity.shellChromeClient.onShowFileChooser(
                    activity.webView,
                    callback,
                    FakeFileChooserParams()
                )
                assertTrue(handled)
            }

            waitUntil("Expected file chooser cancellation to notify the callback.") {
                callback.called
            }

            assertNull(callback.value)
        }
    }

    // Shell-level fixture only: this proves WebView Back/recreation plumbing,
    // while real Nexus controller/task behavior is covered in browser E2E.
    private fun loadNestedWebHistory(
        scenario: ActivityScenario<MainActivity>
    ) {
        val nestedHistoryUrl = "${BuildConfig.NEXUS_BASE_URL}/android-test-nested-history"
        listOf(
            "Root" to "#root",
            "Find" to "#find",
            "Workflow" to "#workflow"
        ).forEach { (page, fragment) ->
            val pageUrl = "$nestedHistoryUrl$fragment"
            scenario.onActivity { activity ->
                activity.webView.loadDataWithBaseURL(
                    nestedHistoryUrl,
                    "<!doctype html><meta charset=\"utf-8\">" +
                        "<title>Nested history $page</title><body>$page</body>",
                    "text/html",
                    "utf-8",
                    pageUrl
                )
            }
            waitForNestedWebHistoryPage(
                scenario,
                page = page,
                fragment = fragment,
                message = "Expected nested WebView test history to reach $page."
            )
        }
    }

    // Local WebView documents must not race the default debug-server navigation.
    // An unsupported explicit URI exercises MainActivity's existing no-op intent contract.
    private fun launchWithoutInitialNavigation(): ActivityScenario<MainActivity> {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("about:blank")).apply {
            setClass(
                ApplicationProvider.getApplicationContext(),
                MainActivity::class.java
            )
        }
        return ActivityScenario.launch(intent)
    }

    private fun waitForNestedWebHistoryPage(
        scenario: ActivityScenario<MainActivity>,
        page: String,
        fragment: String,
        message: String
    ) {
        waitUntil(message) {
            var title: String? = null
            var currentUrl: String? = null
            scenario.onActivity { activity ->
                title = activity.webView.title
                currentUrl = activity.webView.url
            }
            title == "Nested history $page" && currentUrl?.endsWith(fragment) == true
        }
    }

    private fun waitUntil(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5_000
        while (SystemClock.elapsedRealtime() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (condition()) {
                return
            }
            Thread.sleep(50)
        }
        throw AssertionError(message)
    }

    private fun assertIntentRecorded(matcher: Matcher<Intent>, message: String) {
        waitUntil(message) {
            Intents.getIntents().any(matcher::matches)
        }
    }

    private fun hasUriStringStartingWith(prefix: String): Matcher<Uri> =
        object : TypeSafeMatcher<Uri>() {
            override fun matchesSafely(item: Uri): Boolean = item.toString().startsWith(prefix)
            override fun describeTo(description: Description) {
                description.appendText("Uri whose string starts with ").appendValue(prefix)
            }
        }

    private fun hasOauthHandoffUriParts(
        prefix: String,
        requiredParams: Map<String, String>,
        absentParams: Set<String> = emptySet(),
        hexParam: String
    ): Matcher<Uri> = object : TypeSafeMatcher<Uri>() {
        private val hexPattern = Regex("^[0-9a-f]{64}$")

        override fun matchesSafely(item: Uri): Boolean {
            if (!item.toString().startsWith(prefix)) return false
            for ((name, value) in requiredParams) {
                if (item.getQueryParameter(name) != value) return false
            }
            for (name in absentParams) {
                if (item.getQueryParameter(name) != null) return false
            }
            val hex = item.getQueryParameter(hexParam) ?: return false
            return hexPattern.matches(hex)
        }

        override fun describeTo(description: Description) {
            description
                .appendText("Uri starting with ").appendValue(prefix)
                .appendText(", params ").appendValue(requiredParams)
                .appendText(", absent params ").appendValue(absentParams)
                .appendText(", and ").appendText(hexParam).appendText(" matching 64-char hex")
        }
    }

    private class RecordingValueCallback : ValueCallback<Array<Uri>> {
        var called = false
        var value: Array<Uri>? = null

        override fun onReceiveValue(value: Array<Uri>?) {
            called = true
            this.value = value
        }
    }

    private class FakeFileChooserParams : WebChromeClient.FileChooserParams() {
        override fun createIntent(): Intent {
            return Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }
        }

        override fun getAcceptTypes(): Array<String> {
            return arrayOf("application/pdf", "application/epub+zip")
        }

        override fun getFilenameHint(): String? {
            return null
        }

        override fun getMode(): Int {
            return MODE_OPEN
        }

        override fun getTitle(): CharSequence? {
            return null
        }

        override fun isCaptureEnabled(): Boolean {
            return false
        }
    }
}
