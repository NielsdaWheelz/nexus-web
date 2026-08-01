package app.nexus.android

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.core.graphics.Insets as CompatInsets
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

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
    fun viewportFitCoverWebViewReceivesNativeInsetsWithoutLeavingFullWindowBounds() {
        launchWithoutInitialNavigation().use { scenario ->
            requireWebViewM144OrNewer()
            loadInsetProbePage(scenario)

            val snapshot = captureInsetProbe(scenario)
            assertCssInsetsMatchNative(snapshot, "initial viewport")
            assertSafeControlInsideCssSafeRectangle(snapshot.css)

            scenario.onActivity { activity ->
                val protection = activity.findViewById<View>(R.id.status_bar_protection)
                val contentRoot = activity.webView.parent as View
                val decor = activity.window.decorView
                val rootLocation = IntArray(2)
                val webViewLocation = IntArray(2)
                contentRoot.getLocationInWindow(rootLocation)
                activity.webView.getLocationInWindow(webViewLocation)
                val originalInsets = checkNotNull(contentRoot.rootWindowInsets)

                assertEquals(Color.BLACK, (protection.background as ColorDrawable).color)
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, protection.importantForAccessibility)
                assertEquals(snapshot.native.top, protection.height)
                assertFalse(
                    WindowInsetsControllerCompat(
                        activity.window,
                        decor,
                    ).isAppearanceLightStatusBars,
                )
                assertFalse(
                    WindowInsetsControllerCompat(
                        activity.window,
                        decor,
                    ).isAppearanceLightNavigationBars,
                )
                assertEquals(0, rootLocation[0])
                assertEquals(0, rootLocation[1])
                assertEquals(decor.width, contentRoot.width)
                assertEquals(decor.height, contentRoot.height)
                assertEquals(rootLocation[0], webViewLocation[0])
                assertEquals(rootLocation[1], webViewLocation[1])
                assertEquals(contentRoot.width, activity.webView.width)
                assertEquals(contentRoot.height, activity.webView.height)
                assertSame(originalInsets, contentRoot.dispatchApplyWindowInsets(originalInsets))
                assertSame(originalInsets, activity.webView.dispatchApplyWindowInsets(originalInsets))
            }
        }
    }

    @Test
    fun webViewClearsPreviouslyPublishedInsetsOnTheSameRenderer() {
        launchWithoutInitialNavigation().use { scenario ->
            requireWebViewM144OrNewer()
            loadInsetProbePage(scenario)
            lateinit var originalWebView: WebView
            scenario.onActivity { activity ->
                originalWebView = activity.webView
            }

            val nonzero = PhysicalInsets(left = 17, top = 29, right = 43, bottom = 59)
            val published = dispatchInsetsAndCaptureCss(scenario, originalWebView, nonzero)
            assertCssInsetsMatchNative(
                InsetProbeSnapshot(native = nonzero, css = published),
                "nonzero same-renderer dispatch",
            )
            assertSafeControlInsideCssSafeRectangle(published)

            val cleared = PhysicalInsets(left = 0, top = 0, right = 0, bottom = 0)
            val clearedCss = dispatchInsetsAndCaptureCss(scenario, originalWebView, cleared)
            assertCssInsetsMatchNative(
                InsetProbeSnapshot(native = cleared, css = clearedCss),
                "cleared same-renderer dispatch",
            )
            assertSafeControlInsideCssSafeRectangle(clearedCss)
        }
    }

    @Test
    fun rotationRecreatesViewportFitCoverWebViewWithCurrentInsets() {
        launchWithoutInitialNavigation().use { scenario ->
            requireWebViewM144OrNewer()
            loadInsetProbePage(scenario)
            val before = captureInsetProbe(scenario)
            assertCssInsetsMatchNative(before, "pre-rotation viewport")

            var targetOrientation = Configuration.ORIENTATION_LANDSCAPE
            scenario.onActivity { activity ->
                targetOrientation =
                    if (activity.resources.configuration.orientation ==
                        Configuration.ORIENTATION_LANDSCAPE
                    ) {
                        Configuration.ORIENTATION_PORTRAIT
                    } else {
                        Configuration.ORIENTATION_LANDSCAPE
                    }
                activity.requestedOrientation =
                    if (targetOrientation == Configuration.ORIENTATION_LANDSCAPE) {
                        ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                    } else {
                        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    }
            }
            waitUntil("Expected the inset probe Activity to finish rotating.") {
                var currentOrientation = Configuration.ORIENTATION_UNDEFINED
                scenario.onActivity { activity ->
                    currentOrientation = activity.resources.configuration.orientation
                }
                currentOrientation == targetOrientation
            }
            waitForInsetProbePage(scenario)

            val after = captureInsetProbe(scenario)
            assertCssInsetsMatchNative(after, "post-rotation viewport")
            assertSafeControlInsideCssSafeRectangle(after.css)
            assertTrue(
                "Expected rotation to change the real WebView layout viewport; " +
                    "before=${before.css.viewportWidth}x${before.css.viewportHeight}, " +
                    "after=${after.css.viewportWidth}x${after.css.viewportHeight}.",
                before.css.viewportWidth != after.css.viewportWidth ||
                    before.css.viewportHeight != after.css.viewportHeight,
            )
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

    private fun requireWebViewM144OrNewer() {
        val versionName = WebView.getCurrentWebViewPackage()?.versionName
        val majorVersion = versionName?.substringBefore('.')?.toIntOrNull()
        assertTrue(
            "Android system-inset proof requires System WebView M144+; found $versionName.",
            majorVersion != null && majorVersion >= 144,
        )
    }

    private fun loadInsetProbePage(scenario: ActivityScenario<MainActivity>) {
        val probeUrl = "${BuildConfig.NEXUS_BASE_URL}/android-test-system-insets"
        scenario.onActivity { activity ->
            activity.webView.loadDataWithBaseURL(
                probeUrl,
                INSET_PROBE_HTML,
                "text/html",
                "utf-8",
                probeUrl,
            )
        }
        waitForInsetProbePage(scenario)
    }

    private fun waitForInsetProbePage(scenario: ActivityScenario<MainActivity>) {
        waitUntil("Expected the inline viewport-fit=cover probe to finish loading.") {
            var title: String? = null
            var progress = 0
            scenario.onActivity { activity ->
                title = activity.webView.title
                progress = activity.webView.progress
            }
            title == INSET_PROBE_TITLE && progress == 100
        }
    }

    private fun captureInsetProbe(
        scenario: ActivityScenario<MainActivity>,
    ): InsetProbeSnapshot {
        val css = captureCssInsetProbe(scenario, requestCurrentInsets = true)
        var nativeInsets: PhysicalInsets? = null
        scenario.onActivity { activity ->
            val contentRoot = activity.webView.parent as View
            nativeInsets = checkNotNull(contentRoot.rootWindowInsets).systemBarAndCutoutInsets()
        }
        return InsetProbeSnapshot(native = checkNotNull(nativeInsets), css = css)
    }

    private fun dispatchInsetsAndCaptureCss(
        scenario: ActivityScenario<MainActivity>,
        expectedWebView: WebView,
        insets: PhysicalInsets,
    ): CssInsetProbe {
        scenario.onActivity { activity ->
            assertSame(expectedWebView, activity.webView)
            val insetTypes =
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout()
            val original = checkNotNull(
                WindowInsetsCompat.Builder()
                    .setInsets(
                        insetTypes,
                        CompatInsets.of(insets.left, insets.top, insets.right, insets.bottom),
                    )
                    .setVisible(insetTypes, true)
                    .build()
                    .toWindowInsets(),
            )
            assertSame(original, activity.webView.dispatchApplyWindowInsets(original))
        }
        return captureCssInsetProbe(scenario, requestCurrentInsets = false)
    }

    private fun captureCssInsetProbe(
        scenario: ActivityScenario<MainActivity>,
        requestCurrentInsets: Boolean,
    ): CssInsetProbe {
        val frame = CountDownLatch(1)
        scenario.onActivity { activity ->
            if (requestCurrentInsets) {
                (activity.webView.parent as View).requestApplyInsets()
            }
            activity.webView.postOnAnimation(frame::countDown)
        }
        assertTrue(
            "Expected a WebView frame after applying current window insets.",
            frame.await(5, TimeUnit.SECONDS),
        )

        val rawResult = AtomicReference<String?>()
        val evaluated = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.webView.evaluateJavascript("window.nexusReadInsetProbe()") { result ->
                rawResult.set(result)
                evaluated.countDown()
            }
        }
        assertTrue(
            "Expected the real WebView to return its CSS safe-area probe.",
            evaluated.await(5, TimeUnit.SECONDS),
        )
        val decodedResult = JSONTokener(checkNotNull(rawResult.get())).nextValue()
        assertTrue(
            "Expected the WebView inset probe to return a JSON string, got $decodedResult.",
            decodedResult is String,
        )
        val result = JSONObject(decodedResult as String)
        val safe = result.getJSONObject("safe")
        val control = result.getJSONObject("control")
        return CssInsetProbe(
            devicePixelRatio = result.getDouble("devicePixelRatio"),
            viewportWidth = result.getDouble("viewportWidth"),
            viewportHeight = result.getDouble("viewportHeight"),
            left = safe.getDouble("left"),
            top = safe.getDouble("top"),
            right = safe.getDouble("right"),
            bottom = safe.getDouble("bottom"),
            controlLeft = control.getDouble("left"),
            controlTop = control.getDouble("top"),
            controlRight = control.getDouble("right"),
            controlBottom = control.getDouble("bottom"),
        )
    }

    @Suppress("DEPRECATION")
    private fun WindowInsets.systemBarAndCutoutInsets(): PhysicalInsets {
        if (Build.VERSION.SDK_INT >= 30) {
            val combined = getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            return PhysicalInsets(
                left = combined.left,
                top = combined.top,
                right = combined.right,
                bottom = combined.bottom,
            )
        }
        val cutoutLeft = if (Build.VERSION.SDK_INT >= 28) displayCutout?.safeInsetLeft ?: 0 else 0
        val cutoutTop = if (Build.VERSION.SDK_INT >= 28) displayCutout?.safeInsetTop ?: 0 else 0
        val cutoutRight = if (Build.VERSION.SDK_INT >= 28) displayCutout?.safeInsetRight ?: 0 else 0
        val cutoutBottom =
            if (Build.VERSION.SDK_INT >= 28) displayCutout?.safeInsetBottom ?: 0 else 0
        return PhysicalInsets(
            left = maxOf(systemWindowInsetLeft, cutoutLeft),
            top = maxOf(systemWindowInsetTop, cutoutTop),
            right = maxOf(systemWindowInsetRight, cutoutRight),
            bottom = maxOf(systemWindowInsetBottom, cutoutBottom),
        )
    }

    private fun assertCssInsetsMatchNative(snapshot: InsetProbeSnapshot, state: String) {
        val native = snapshot.native
        val css = snapshot.css
        assertEquals(
            "$state left CSS safe inset did not match native systemBars | displayCutout.",
            native.left.toDouble(),
            css.leftPhysical,
            1.0,
        )
        assertEquals(
            "$state top CSS safe inset did not match native systemBars | displayCutout.",
            native.top.toDouble(),
            css.topPhysical,
            1.0,
        )
        assertEquals(
            "$state right CSS safe inset did not match native systemBars | displayCutout.",
            native.right.toDouble(),
            css.rightPhysical,
            1.0,
        )
        assertEquals(
            "$state bottom CSS safe inset did not match native systemBars | displayCutout.",
            native.bottom.toDouble(),
            css.bottomPhysical,
            1.0,
        )
    }

    private fun assertSafeControlInsideCssSafeRectangle(css: CssInsetProbe) {
        val tolerance = 0.5
        assertTrue(
            "Safe control left ${css.controlLeft} crossed safe left ${css.left}.",
            css.controlLeft >= css.left - tolerance,
        )
        assertTrue(
            "Safe control top ${css.controlTop} crossed safe top ${css.top}.",
            css.controlTop >= css.top - tolerance,
        )
        assertTrue(
            "Safe control right ${css.controlRight} crossed safe right " +
                "${css.viewportWidth - css.right}.",
            css.controlRight <= css.viewportWidth - css.right + tolerance,
        )
        assertTrue(
            "Safe control bottom ${css.controlBottom} crossed safe bottom " +
                "${css.viewportHeight - css.bottom}.",
            css.controlBottom <= css.viewportHeight - css.bottom + tolerance,
        )
        assertTrue("Expected the fixed safe control to have positive width.", css.controlRight > css.controlLeft)
        assertTrue("Expected the fixed safe control to have positive height.", css.controlBottom > css.controlTop)
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

    private data class PhysicalInsets(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
    )

    private data class CssInsetProbe(
        val devicePixelRatio: Double,
        val viewportWidth: Double,
        val viewportHeight: Double,
        val left: Double,
        val top: Double,
        val right: Double,
        val bottom: Double,
        val controlLeft: Double,
        val controlTop: Double,
        val controlRight: Double,
        val controlBottom: Double,
    ) {
        val leftPhysical: Double get() = left * devicePixelRatio
        val topPhysical: Double get() = top * devicePixelRatio
        val rightPhysical: Double get() = right * devicePixelRatio
        val bottomPhysical: Double get() = bottom * devicePixelRatio
    }

    private data class InsetProbeSnapshot(
        val native: PhysicalInsets,
        val css: CssInsetProbe,
    )

    private companion object {
        const val INSET_PROBE_TITLE = "Nexus system inset probe"
        val INSET_PROBE_HTML =
            """
            <!doctype html>
            <html>
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
                <title>$INSET_PROBE_TITLE</title>
                <style>
                  * { box-sizing: border-box; }
                  html, body { width: 100%; height: 100%; margin: 0; }
                  #safe-values {
                    position: fixed;
                    visibility: hidden;
                    padding-top: env(safe-area-inset-top);
                    padding-right: env(safe-area-inset-right);
                    padding-bottom: env(safe-area-inset-bottom);
                    padding-left: env(safe-area-inset-left);
                  }
                  #safe-control {
                    position: fixed;
                    width: 48px;
                    height: 48px;
                    right: calc(env(safe-area-inset-right) + 1px);
                    bottom: calc(env(safe-area-inset-bottom) + 1px);
                  }
                </style>
              </head>
              <body>
                <div id="safe-values"></div>
                <button id="safe-control" type="button">Safe</button>
                <script>
                  window.nexusReadInsetProbe = () => {
                    const px = (value) => Number.parseFloat(value) || 0;
                    const safe = getComputedStyle(document.getElementById('safe-values'));
                    const control = document.getElementById('safe-control').getBoundingClientRect();
                    return JSON.stringify({
                      devicePixelRatio: window.devicePixelRatio,
                      viewportWidth: document.documentElement.clientWidth,
                      viewportHeight: document.documentElement.clientHeight,
                      safe: {
                        left: px(safe.paddingLeft),
                        top: px(safe.paddingTop),
                        right: px(safe.paddingRight),
                        bottom: px(safe.paddingBottom),
                      },
                      control: {
                        left: control.left,
                        top: control.top,
                        right: control.right,
                        bottom: control.bottom,
                      },
                    });
                  };
                </script>
              </body>
            </html>
            """.trimIndent()
    }
}
