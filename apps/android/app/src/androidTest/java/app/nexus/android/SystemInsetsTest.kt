package app.nexus.android

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.WindowInsets
import android.webkit.WebView
import androidx.core.graphics.Insets as CompatInsets
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class SystemInsetsTest {
    @Test
    fun nativeInsetsRemainExactAcrossPublicationClearingAndRotation() {
        launchWithoutInitialNavigation().use { scenario ->
            requireWebViewM144OrNewer()
            loadInsetProbePage(scenario)

            val initial = captureInsetProbe(scenario)
            assertCssInsetsMatchNative(initial, "initial viewport")
            assertSafeControlInsideCssSafeRectangle(initial.css)
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
                assertEquals(initial.native.top, protection.height)
                assertFalse(
                    WindowInsetsControllerCompat(activity.window, decor).isAppearanceLightStatusBars,
                )
                assertFalse(
                    WindowInsetsControllerCompat(activity.window, decor)
                        .isAppearanceLightNavigationBars,
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

            lateinit var originalWebView: WebView
            scenario.onActivity { activity -> originalWebView = activity.webView }
            for (insets in listOf(
                PhysicalInsets(left = 17, top = 29, right = 43, bottom = 59),
                PhysicalInsets(left = 0, top = 0, right = 0, bottom = 0),
            )) {
                val css = dispatchInsetsAndCaptureCss(scenario, originalWebView, insets)
                assertCssInsetsMatchNative(
                    InsetProbeSnapshot(native = insets, css = css),
                    "same-renderer dispatch $insets",
                )
                assertSafeControlInsideCssSafeRectangle(css)
            }

            val beforeRotation = captureInsetProbe(scenario)
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

            val afterRotation = captureInsetProbe(scenario)
            assertCssInsetsMatchNative(afterRotation, "post-rotation viewport")
            assertSafeControlInsideCssSafeRectangle(afterRotation.css)
            assertTrue(
                "Rotation did not change the real WebView viewport: " +
                    "before=${beforeRotation.css.viewportWidth}x${beforeRotation.css.viewportHeight}, " +
                    "after=${afterRotation.css.viewportWidth}x${afterRotation.css.viewportHeight}",
                beforeRotation.css.viewportWidth != afterRotation.css.viewportWidth ||
                    beforeRotation.css.viewportHeight != afterRotation.css.viewportHeight,
            )
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
        waitUntil("Expected the viewport-fit=cover probe to finish loading.") {
            var title: String? = null
            var progress = 0
            scenario.onActivity { activity ->
                title = activity.webView.title
                progress = activity.webView.progress
            }
            title == INSET_PROBE_TITLE && progress == 100
        }
    }

    private fun captureInsetProbe(scenario: ActivityScenario<MainActivity>): InsetProbeSnapshot {
        val css = captureCssInsetProbe(scenario, requestCurrentInsets = true)
        var nativeInsets: PhysicalInsets? = null
        scenario.onActivity { activity ->
            nativeInsets =
                checkNotNull((activity.webView.parent as View).rootWindowInsets)
                    .systemBarAndCutoutInsets()
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
            val original =
                checkNotNull(
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
            val combined =
                getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            return PhysicalInsets(combined.left, combined.top, combined.right, combined.bottom)
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
        assertEquals("$state left inset diverged", native.left.toDouble(), css.leftPhysical, 1.0)
        assertEquals("$state top inset diverged", native.top.toDouble(), css.topPhysical, 1.0)
        assertEquals("$state right inset diverged", native.right.toDouble(), css.rightPhysical, 1.0)
        assertEquals("$state bottom inset diverged", native.bottom.toDouble(), css.bottomPhysical, 1.0)
    }

    private fun assertSafeControlInsideCssSafeRectangle(css: CssInsetProbe) {
        val tolerance = 0.5
        assertTrue("Safe control crossed left inset", css.controlLeft >= css.left - tolerance)
        assertTrue("Safe control crossed top inset", css.controlTop >= css.top - tolerance)
        assertTrue(
            "Safe control crossed right inset",
            css.controlRight <= css.viewportWidth - css.right + tolerance,
        )
        assertTrue(
            "Safe control crossed bottom inset",
            css.controlBottom <= css.viewportHeight - css.bottom + tolerance,
        )
        assertTrue("Safe control has no width", css.controlRight > css.controlLeft)
        assertTrue("Safe control has no height", css.controlBottom > css.controlTop)
    }

    private fun launchWithoutInitialNavigation(): ActivityScenario<MainActivity> {
        val intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("about:blank")).apply {
                setClass(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            }
        return ActivityScenario.launch(intent)
    }

    private fun waitUntil(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5_000
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return
            SystemClock.sleep(20)
        }
        throw AssertionError(message)
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
