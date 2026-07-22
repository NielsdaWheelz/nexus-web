package app.nexus.android

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import androidx.lifecycle.Lifecycle
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
    fun offOriginUrlOpensACustomTabIntent() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val externalUri = Uri.parse("https://external.example.com/privacy")

            Intents.init()
            Intents.intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(externalUri)))
                .respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.routeUrl(externalUri)
            }

            Intents.intended(allOf(hasAction(Intent.ACTION_VIEW), hasData(externalUri)))
        }
    }

    @Test
    fun sameHostDifferentPortOpensACustomTabIntent() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val supabaseAuthorizeUri =
                Uri.parse("http://${BuildConfig.NEXUS_OWNED_HOST}:54321/auth/v1/authorize")

            Intents.init()
            Intents.intending(allOf(hasAction(Intent.ACTION_VIEW), hasData(supabaseAuthorizeUri)))
                .respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.routeUrl(supabaseAuthorizeUri)
            }

            Intents.intended(allOf(hasAction(Intent.ACTION_VIEW), hasData(supabaseAuthorizeUri)))
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
    fun ownedCallbackIntentWhileRunningLoadsThatExactUrl() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val callbackUrl =
                "${BuildConfig.NEXUS_BASE_URL}/auth/callback?code=test-code&next=%2Flibraries"

            scenario.onActivity { activity ->
                activity.loadUrlFromIntent(
                    Intent(Intent.ACTION_VIEW, Uri.parse(callbackUrl)).apply {
                        setClass(activity, MainActivity::class.java)
                    }
                )
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
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val oauthPrefix = "${BuildConfig.NEXUS_BASE_URL}/auth/oauth"

            Intents.init()
            Intents.intending(
                allOf(hasAction(Intent.ACTION_VIEW), hasData(hasUriStringStartingWith(oauthPrefix)))
            ).respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.startAuthFlow(
                    Uri.parse("nexus://auth/start?provider=github&mode=signin&next=%2Fbrowse")
                )
            }

            Intents.intended(
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
                )
            )
        }
    }

    @Test
    fun nexusAuthStartDefaultsMissingNextToLectern() {
        assertEquals("/lectern", DEFAULT_AUTH_RETURN_TARGET)

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val oauthPrefix = "${BuildConfig.NEXUS_BASE_URL}/auth/oauth"

            Intents.init()
            Intents.intending(
                allOf(hasAction(Intent.ACTION_VIEW), hasData(hasUriStringStartingWith(oauthPrefix)))
            ).respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.startAuthFlow(Uri.parse("nexus://auth/start?provider=github&mode=signin"))
            }

            Intents.intended(
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
                )
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
    fun backNavigationUsesWebViewHistoryFirst() {
        val firstUrl = "${BuildConfig.NEXUS_BASE_URL}/first"
        val secondUrl = "${BuildConfig.NEXUS_BASE_URL}/second"

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
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
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val selectedUri = Uri.parse("content://nexus/tests/file.pdf")
            val callback = RecordingValueCallback()

            Intents.init()
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

            Intents.intended(hasAction(Intent.ACTION_GET_CONTENT))

            waitUntil("Expected file chooser callback to receive the selected URI.") {
                callback.called
            }

            assertEquals(selectedUri, callback.value?.single())
        }
    }

    @Test
    fun cancelledFileInputReturnsNull() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val callback = RecordingValueCallback()

            Intents.init()
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
