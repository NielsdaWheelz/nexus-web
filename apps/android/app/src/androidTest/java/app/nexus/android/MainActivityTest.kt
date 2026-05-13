package app.nexus.android

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.Matchers.allOf
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
    fun ownedCallbackNewIntentLoadsThatExactUrl() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val callbackUrl =
                "${BuildConfig.NEXUS_BASE_URL}/auth/callback?code=test-code&next=%2Flibraries"

            scenario.onActivity { activity ->
                activity.startActivity(
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
    fun debugDevCallbackIntentLoadsTheWebCallbackUrl() {
        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("nexus-dev://auth/callback?code=test-code&next=%2Flibraries")
        ).apply {
            setClass(
                ApplicationProvider.getApplicationContext(),
                MainActivity::class.java
            )
        }
        val expectedUrl =
            "${BuildConfig.NEXUS_BASE_URL}/auth/callback?code=test-code&next=%2Flibraries"

        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            waitUntil("Expected debug dev callback URL to load in the WebView.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == expectedUrl
            }
        }
    }

    @Test
    fun backNavigationUsesWebViewHistoryFirst() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val settingsUrl = "${BuildConfig.NEXUS_BASE_URL}/settings"

            scenario.onActivity { activity ->
                activity.routeUrl(Uri.parse(settingsUrl))
            }

            waitUntil("Expected WebView to load the settings URL.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == settingsUrl
            }

            scenario.onActivity { activity ->
                activity.onBackPressedDispatcher.onBackPressed()
            }

            waitUntil("Expected Android back to return to the launch URL first.") {
                var currentUrl: String? = null
                scenario.onActivity { activity ->
                    currentUrl = activity.webView.url
                }
                currentUrl == BuildConfig.NEXUS_BASE_URL
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
