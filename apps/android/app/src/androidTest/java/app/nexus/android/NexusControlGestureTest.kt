package app.nexus.android

import android.app.Instrumentation
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class NexusControlGestureTest {
    @Test
    fun nexusControlReceivesHorizontalTouchFromOuterAndInnerHalves() {
        launchWithoutInitialNavigation().use { scenario ->
            val webViewVersion = requireWebViewM144OrNewer()
            val environment = readSystemGestureEnvironment(scenario, webViewVersion)
            loadGestureProbePage(scenario)
            val fixture = readGestureFixture(scenario)
            val diagnostics = diagnostics(environment, fixture)

            assertEquals(
                "$diagnostics; the physical gate requires fully gestural navigation mode",
                GESTURAL_NAVIGATION_MODE,
                environment.navigationMode,
            )
            for ((band, extent) in listOf(
                "system right" to environment.systemGestures.right,
                "system bottom" to environment.systemGestures.bottom,
                "mandatory bottom" to environment.mandatorySystemGestures.bottom,
            )) {
                assertTrue(
                    "$diagnostics; the device reported no $band gesture inset",
                    extent > 0,
                )
            }
            assertProductionEnvelope(fixture, diagnostics)
            val overlapTolerance = Math.ulp(
                maxOf(environment.window.width, environment.window.height),
            )
            for ((band, overlap) in listOf(
                "system right" to rightOverlap(environment, fixture, environment.systemGestures),
                "system bottom" to bottomOverlap(environment, fixture, environment.systemGestures),
                "mandatory right" to rightOverlap(
                    environment,
                    fixture,
                    environment.mandatorySystemGestures,
                ),
                "mandatory bottom" to bottomOverlap(
                    environment,
                    fixture,
                    environment.mandatorySystemGestures,
                ),
            )) {
                assertEquals(
                    "$diagnostics; target overlaps the $band gesture band",
                    0.0,
                    overlap,
                    overlapTolerance,
                )
            }

            for ((half, position) in listOf("outer" to 0.75, "inner" to 0.25)) {
                evaluateJavascript(
                    scenario,
                    "window.nexusResetPointerObservations()",
                    "$diagnostics; failed to reset the WebView pointer observer",
                )
                val startX = fixture.targetScreen.left + fixture.targetScreen.width * position
                val startY = fixture.targetScreen.top + fixture.targetScreen.height / 2.0
                val endX = startX - TOUCH_TRAVEL_CSS_PX * fixture.devicePixelRatio
                assertTrue(
                    "$diagnostics; $half-half stream would leave the Activity window",
                    endX >= environment.window.left && startX <= environment.window.right,
                )

                sendTouchStream(startX.toFloat(), startY.toFloat(), endX.toFloat())
                waitForPointerTerminal(scenario, "$diagnostics; $half-half stream")
                assertDeliveredTouchStream(
                    half,
                    readPointerObservations(scenario, diagnostics),
                    diagnostics,
                )
            }
            reportSuccessfulDiagnostics(diagnostics)
        }
    }

    private fun reportSuccessfulDiagnostics(diagnostics: String) {
        InstrumentationRegistry.getInstrumentation().sendStatus(
            0,
            Bundle().apply {
                putString(
                    Instrumentation.REPORT_KEY_STREAMRESULT,
                    "\n$SUCCESS_DIAGNOSTIC_MARKER $diagnostics\n",
                )
            },
        )
    }

    private fun requireWebViewM144OrNewer(): String {
        val versionName = WebView.getCurrentWebViewPackage()?.versionName
        val majorVersion = versionName?.substringBefore('.')?.toIntOrNull()
        assertTrue(
            "Android Nexus-control gesture proof requires System WebView M144+; " +
                "found $versionName.",
            majorVersion != null && majorVersion >= 144,
        )
        return checkNotNull(versionName)
    }

    private fun readSystemGestureEnvironment(
        scenario: ActivityScenario<MainActivity>,
        webViewVersion: String,
    ): SystemGestureEnvironment {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            throw AssertionError(
                "Android Nexus-control gesture proof requires Android 11+ for " +
                    "WindowInsets.Type diagnostics; found API ${Build.VERSION.SDK_INT}.",
            )
        }
        return readSystemGestureEnvironmentAtLeastR(scenario, webViewVersion)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun readSystemGestureEnvironmentAtLeastR(
        scenario: ActivityScenario<MainActivity>,
        webViewVersion: String,
    ): SystemGestureEnvironment {
        waitForActivity(
            scenario,
            "Expected real MainActivity window gesture insets.",
        ) { activity ->
            val root = activity.webView.parent as View
            root.requestApplyInsets()
            root.rootWindowInsets != null
        }

        var result: SystemGestureEnvironment? = null
        scenario.onActivity { activity ->
            val decor = activity.window.decorView
            val windowLocation = IntArray(2)
            decor.getLocationOnScreen(windowLocation)
            val insets = checkNotNull((activity.webView.parent as View).rootWindowInsets)
            result = SystemGestureEnvironment(
                webViewVersion = webViewVersion,
                navigationMode = Settings.Secure.getString(
                    activity.contentResolver,
                    NAVIGATION_MODE_SETTING,
                ),
                backGestureScaleLeft = Settings.Secure.getString(
                    activity.contentResolver,
                    BACK_GESTURE_SCALE_LEFT_SETTING,
                ),
                backGestureScaleRight = Settings.Secure.getString(
                    activity.contentResolver,
                    BACK_GESTURE_SCALE_RIGHT_SETTING,
                ),
                systemGestures = insets.physicalInsets(WindowInsets.Type.systemGestures()),
                mandatorySystemGestures = insets.physicalInsets(
                    WindowInsets.Type.mandatorySystemGestures(),
                ),
                window = Rect(
                    left = windowLocation[0].toDouble(),
                    top = windowLocation[1].toDouble(),
                    right = (windowLocation[0] + decor.width).toDouble(),
                    bottom = (windowLocation[1] + decor.height).toDouble(),
                ),
            )
        }
        return checkNotNull(result)
    }

    private fun loadGestureProbePage(scenario: ActivityScenario<MainActivity>) {
        val probeUrl = "${BuildConfig.NEXUS_BASE_URL}/android-test-nexus-gesture"
        scenario.onActivity { activity ->
            activity.webView.loadDataWithBaseURL(
                probeUrl,
                GESTURE_PROBE_HTML,
                "text/html",
                "utf-8",
                probeUrl,
            )
        }
        waitForActivity(
            scenario,
            "Expected the owned-origin Nexus gesture fixture to finish loading.",
        ) { activity ->
            activity.webView.title == GESTURE_PROBE_TITLE && activity.webView.progress == 100
        }
    }

    private fun readGestureFixture(scenario: ActivityScenario<MainActivity>): GestureFixture {
        val value = JSONObject(
            decodeJsonString(
                evaluateJavascript(
                    scenario,
                    "window.nexusReadGestureFixture()",
                    "Expected the real WebView to return the Nexus gesture fixture geometry",
                ),
                "Expected the Nexus gesture fixture geometry as a JSON string",
            ),
        )
        val wrapper = value.getJSONObject("wrapper").rect()
        val target = value.getJSONObject("target").rect()
        var webViewFrame: Rect? = null
        scenario.onActivity { activity ->
            val location = IntArray(2)
            activity.webView.getLocationOnScreen(location)
            webViewFrame = Rect(
                left = location[0].toDouble(),
                top = location[1].toDouble(),
                right = (location[0] + activity.webView.width).toDouble(),
                bottom = (location[1] + activity.webView.height).toDouble(),
            )
        }
        val frame = checkNotNull(webViewFrame)
        val devicePixelRatio = value.getDouble("devicePixelRatio")
        return GestureFixture(
            devicePixelRatio = devicePixelRatio,
            viewportWidth = value.getDouble("viewportWidth"),
            viewportHeight = value.getDouble("viewportHeight"),
            safeRight = value.getDouble("safeRight"),
            safeBottom = value.getDouble("safeBottom"),
            wrapper = wrapper,
            target = target,
            targetScreen = Rect(
                left = frame.left + target.left * devicePixelRatio,
                top = frame.top + target.top * devicePixelRatio,
                right = frame.left + target.right * devicePixelRatio,
                bottom = frame.top + target.bottom * devicePixelRatio,
            ),
            webViewFrame = frame,
            wrapperPosition = value.getString("wrapperPosition"),
            wrapperPointerEvents = value.getString("wrapperPointerEvents"),
            targetPointerEvents = value.getString("targetPointerEvents"),
            targetTouchAction = value.getString("targetTouchAction"),
            targetWillChange = value.getString("targetWillChange"),
        )
    }

    private fun assertProductionEnvelope(fixture: GestureFixture, diagnostics: String) {
        assertEquals("$diagnostics; wrapper position drifted", "fixed", fixture.wrapperPosition)
        assertEquals(
            "$diagnostics; wrapper pointer-events drifted",
            "none",
            fixture.wrapperPointerEvents,
        )
        assertEquals(
            "$diagnostics; target pointer-events drifted",
            "auto",
            fixture.targetPointerEvents,
        )
        assertEquals(
            "$diagnostics; target touch-action drifted",
            "pan-y pinch-zoom",
            fixture.targetTouchAction,
        )
        assertEquals(
            "$diagnostics; target will-change drifted",
            "transform",
            fixture.targetWillChange,
        )
        for ((name, size) in listOf(
            "wrapper width" to fixture.wrapper.width,
            "wrapper height" to fixture.wrapper.height,
            "target width" to fixture.target.width,
            "target height" to fixture.target.height,
        )) {
            assertEquals("$diagnostics; $name drifted", 48.0, size, CSS_PX_TOLERANCE)
        }
        assertEquals(
            "$diagnostics; wrapper and target left edges diverged",
            fixture.wrapper.left,
            fixture.target.left,
            CSS_PX_TOLERANCE,
        )
        assertEquals(
            "$diagnostics; wrapper and target top edges diverged",
            fixture.wrapper.top,
            fixture.target.top,
            CSS_PX_TOLERANCE,
        )
        assertEquals(
            "$diagnostics; right geometry diverged from the production envelope",
            maxOf(SYSTEM_GESTURE_CLEARANCE_CSS_PX, fixture.safeRight),
            fixture.viewportWidth - fixture.wrapper.right,
            CSS_PX_TOLERANCE,
        )
        assertEquals(
            "$diagnostics; Player-absent bottom geometry diverged from production",
            maxOf(
                fixture.safeBottom + NEXUS_BOTTOM_GAP_CSS_PX,
                SYSTEM_GESTURE_CLEARANCE_CSS_PX,
            ),
            fixture.viewportHeight - fixture.wrapper.bottom,
            CSS_PX_TOLERANCE,
        )
        assertEquals(
            "$diagnostics; CSS-to-screen width diverged from the real WebView",
            fixture.webViewFrame.width,
            fixture.viewportWidth * fixture.devicePixelRatio,
            fixture.devicePixelRatio,
        )
        assertEquals(
            "$diagnostics; CSS-to-screen height diverged from the real WebView",
            fixture.webViewFrame.height,
            fixture.viewportHeight * fixture.devicePixelRatio,
            fixture.devicePixelRatio,
        )
    }

    private fun sendTouchStream(startX: Float, startY: Float, endX: Float) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val downTime = SystemClock.uptimeMillis()

        fun send(action: Int, x: Float) {
            val properties = arrayOf(
                MotionEvent.PointerProperties().apply {
                    id = 0
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                },
            )
            val coordinates = arrayOf(
                MotionEvent.PointerCoords().apply {
                    this.x = x
                    y = startY
                    pressure = 1f
                    size = 1f
                },
            )
            val event = MotionEvent.obtain(
                downTime,
                SystemClock.uptimeMillis(),
                action,
                1,
                properties,
                coordinates,
                0,
                0,
                1f,
                1f,
                0,
                0,
                InputDevice.SOURCE_TOUCHSCREEN,
                0,
            )
            try {
                instrumentation.sendPointerSync(event)
            } finally {
                event.recycle()
            }
        }

        send(MotionEvent.ACTION_DOWN, startX)
        for (step in 1..TOUCH_MOVE_COUNT) {
            send(MotionEvent.ACTION_MOVE, startX + (endX - startX) * step / TOUCH_MOVE_COUNT)
        }
        send(MotionEvent.ACTION_UP, endX)
    }

    private fun waitForPointerTerminal(
        scenario: ActivityScenario<MainActivity>,
        message: String,
    ) {
        val observed = AtomicReference(false)
        val lastResult = AtomicReference<String?>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            val deadline = SystemClock.uptimeMillis() + WAIT_TIMEOUT_MILLIS
            activity.webView.postOnAnimation(
                object : Runnable {
                    override fun run() {
                        activity.webView.evaluateJavascript(
                            "window.nexusPointerObservationIsTerminal()",
                        ) { result ->
                            lastResult.set(result)
                            if (result == "true") {
                                observed.set(true)
                                completed.countDown()
                            } else if (SystemClock.uptimeMillis() >= deadline) {
                                completed.countDown()
                            } else {
                                activity.webView.postOnAnimation(this)
                            }
                        }
                    }
                },
            )
        }
        val completedInTime = completed.await(
            WAIT_TIMEOUT_MILLIS + 1_000,
            TimeUnit.MILLISECONDS,
        )
        assertTrue(
            "$message; pointerup/pointercancel was not observed; lastResult=${lastResult.get()}",
            completedInTime && observed.get(),
        )
    }

    private fun readPointerObservations(
        scenario: ActivityScenario<MainActivity>,
        diagnostics: String,
    ): List<PointerObservation> {
        val value = JSONArray(
            decodeJsonString(
                evaluateJavascript(
                    scenario,
                    "window.nexusReadPointerObservations()",
                    "$diagnostics; failed to read WebView pointer observations",
                ),
                "$diagnostics; expected pointer observations as a JSON string",
            ),
        )
        return List(value.length()) { index ->
            value.getJSONObject(index).let { observation ->
                PointerObservation(
                    type = observation.getString("type"),
                    pointerType = observation.getString("pointerType"),
                    dx = observation.getDouble("dx"),
                )
            }
        }
    }

    private fun assertDeliveredTouchStream(
        half: String,
        observations: List<PointerObservation>,
        diagnostics: String,
    ) {
        val message = "$diagnostics; $half-half observations=$observations"
        assertEquals(
            "$message; stream did not begin",
            "pointerdown",
            observations.firstOrNull()?.type,
        )
        assertTrue(
            "$message; every delivered pointer must be touch",
            observations.isNotEmpty() && observations.all { it.pointerType == "touch" },
        )
        assertTrue(
            "$message; no move crossed the 20 CSS px commit displacement",
            observations.any {
                it.type == "pointermove" && kotlin.math.abs(it.dx) > COMMIT_DISPLACEMENT_CSS_PX
            },
        )
        assertFalse(
            "$message; the WebView received pointercancel",
            observations.any { it.type == "pointercancel" },
        )
        assertEquals("$message; stream was truncated", "pointerup", observations.lastOrNull()?.type)
        assertTrue(
            "$message; final horizontal displacement was truncated",
            kotlin.math.abs(observations.last().dx) > COMMIT_DISPLACEMENT_CSS_PX,
        )
    }

    private fun waitForActivity(
        scenario: ActivityScenario<MainActivity>,
        message: String,
        condition: (MainActivity) -> Boolean,
    ) {
        val passed = AtomicReference(false)
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            val deadline = SystemClock.uptimeMillis() + WAIT_TIMEOUT_MILLIS
            activity.window.decorView.postOnAnimation(
                object : Runnable {
                    override fun run() {
                        if (condition(activity)) {
                            passed.set(true)
                            completed.countDown()
                        } else if (SystemClock.uptimeMillis() >= deadline) {
                            completed.countDown()
                        } else {
                            activity.window.decorView.postOnAnimation(this)
                        }
                    }
                },
            )
        }
        assertTrue(
            message,
            completed.await(WAIT_TIMEOUT_MILLIS + 1_000, TimeUnit.MILLISECONDS) && passed.get(),
        )
    }

    private fun evaluateJavascript(
        scenario: ActivityScenario<MainActivity>,
        script: String,
        message: String,
    ): String {
        val result = AtomicReference<String?>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.webView.evaluateJavascript(script) { value ->
                result.set(value)
                completed.countDown()
            }
        }
        assertTrue(message, completed.await(WAIT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS))
        return checkNotNull(result.get()) { "$message; JavaScript returned null" }
    }

    private fun decodeJsonString(raw: String, message: String): String {
        val decoded = JSONTokener(raw).nextValue()
        assertTrue("$message; got $decoded", decoded is String)
        return decoded as String
    }

    private fun diagnostics(
        environment: SystemGestureEnvironment,
        fixture: GestureFixture,
    ): String =
        "webView=${environment.webViewVersion}, " +
            "navigationMode=${environment.navigationMode ?: "unset"}, " +
            "backGestureScaleLeft=${environment.backGestureScaleLeft ?: "unset/unavailable"}, " +
            "backGestureScaleRight=${environment.backGestureScaleRight ?: "unset/unavailable"}, " +
            "systemGestures=${environment.systemGestures}, " +
            "mandatorySystemGestures=${environment.mandatorySystemGestures}, " +
            "safeRightCss=${fixture.safeRight}, safeBottomCss=${fixture.safeBottom}, " +
            "targetScreen=${fixture.targetScreen}, " +
            "systemRightOverlapPx=${rightOverlap(
                environment,
                fixture,
                environment.systemGestures,
            )}, systemBottomOverlapPx=${bottomOverlap(
                environment,
                fixture,
                environment.systemGestures,
            )}, mandatoryRightOverlapPx=${rightOverlap(
                environment,
                fixture,
                environment.mandatorySystemGestures,
            )}, mandatoryBottomOverlapPx=${bottomOverlap(
                environment,
                fixture,
                environment.mandatorySystemGestures,
            )}"

    private fun rightOverlap(
        environment: SystemGestureEnvironment,
        fixture: GestureFixture,
        insets: PhysicalInsets,
    ): Double = maxOf(
        0.0,
        minOf(fixture.targetScreen.right, environment.window.right) -
            maxOf(fixture.targetScreen.left, environment.window.right - insets.right),
    )

    private fun bottomOverlap(
        environment: SystemGestureEnvironment,
        fixture: GestureFixture,
        insets: PhysicalInsets,
    ): Double = maxOf(
        0.0,
        minOf(fixture.targetScreen.bottom, environment.window.bottom) -
            maxOf(fixture.targetScreen.top, environment.window.bottom - insets.bottom),
    )

    @RequiresApi(Build.VERSION_CODES.R)
    private fun WindowInsets.physicalInsets(type: Int): PhysicalInsets {
        val value = getInsets(type)
        return PhysicalInsets(value.left, value.top, value.right, value.bottom)
    }

    private fun JSONObject.rect(): Rect = Rect(
        left = getDouble("left"),
        top = getDouble("top"),
        right = getDouble("right"),
        bottom = getDouble("bottom"),
    )

    private fun launchWithoutInitialNavigation(): ActivityScenario<MainActivity> {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("about:blank")).apply {
            setClass(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
        }
        return ActivityScenario.launch(intent)
    }

    private data class PhysicalInsets(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
    )

    private data class Rect(
        val left: Double,
        val top: Double,
        val right: Double,
        val bottom: Double,
    ) {
        val width: Double get() = right - left
        val height: Double get() = bottom - top
    }

    private data class SystemGestureEnvironment(
        val webViewVersion: String,
        val navigationMode: String?,
        val backGestureScaleLeft: String?,
        val backGestureScaleRight: String?,
        val systemGestures: PhysicalInsets,
        val mandatorySystemGestures: PhysicalInsets,
        val window: Rect,
    )

    private data class GestureFixture(
        val devicePixelRatio: Double,
        val viewportWidth: Double,
        val viewportHeight: Double,
        val safeRight: Double,
        val safeBottom: Double,
        val wrapper: Rect,
        val target: Rect,
        val targetScreen: Rect,
        val webViewFrame: Rect,
        val wrapperPosition: String,
        val wrapperPointerEvents: String,
        val targetPointerEvents: String,
        val targetTouchAction: String,
        val targetWillChange: String,
    )

    private data class PointerObservation(
        val type: String,
        val pointerType: String,
        val dx: Double,
    )

    private companion object {
        const val GESTURE_PROBE_TITLE = "Nexus control gesture probe"
        const val GESTURAL_NAVIGATION_MODE = "2"
        const val NAVIGATION_MODE_SETTING = "navigation_mode"
        const val BACK_GESTURE_SCALE_LEFT_SETTING = "back_gesture_inset_scale_left"
        const val BACK_GESTURE_SCALE_RIGHT_SETTING = "back_gesture_inset_scale_right"
        const val WAIT_TIMEOUT_MILLIS = 5_000L
        const val TOUCH_MOVE_COUNT = 8
        const val TOUCH_TRAVEL_CSS_PX = 24.0
        const val COMMIT_DISPLACEMENT_CSS_PX = 20.0
        const val CSS_PX_TOLERANCE = 0.5
        const val NEXUS_BOTTOM_GAP_CSS_PX = 12.0
        const val SYSTEM_GESTURE_CLEARANCE_CSS_PX = 52.0
        const val SUCCESS_DIAGNOSTIC_MARKER = "NEXUS_CONTROL_GESTURE_DIAGNOSTICS:"
        val GESTURE_PROBE_HTML =
            """
            <!doctype html>
            <html>
              <head>
                <meta charset="utf-8">
                <meta
                  name="viewport"
                  content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"
                >
                <title>$GESTURE_PROBE_TITLE</title>
                <style>
                  * { box-sizing: border-box; }
                  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
                  #safe-values {
                    position: fixed;
                    visibility: hidden;
                    padding-right: env(safe-area-inset-right);
                    padding-bottom: env(safe-area-inset-bottom);
                  }
                  #nexus-wrapper {
                    position: fixed;
                    z-index: 10000;
                    right: max(52px, env(safe-area-inset-right));
                    bottom: max(calc(env(safe-area-inset-bottom) + 12px), 52px);
                    width: 48px;
                    height: 48px;
                    pointer-events: none;
                  }
                  #nexus-control {
                    position: relative;
                    display: block;
                    box-sizing: border-box;
                    width: 48px;
                    height: 48px;
                    padding: 0;
                    border: 0;
                    background: transparent;
                    pointer-events: auto;
                    touch-action: pan-y pinch-zoom;
                    transform: translateY(0);
                    will-change: transform;
                  }
                </style>
              </head>
              <body>
                <div id="safe-values"></div>
                <div id="nexus-wrapper">
                  <button id="nexus-control" type="button">Nexus</button>
                </div>
                <script>
                  const target = document.getElementById('nexus-control');
                  const observations = [];
                  let originX = null;
                  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
                    target.addEventListener(type, (event) => {
                      if (type === 'pointerdown') originX = event.clientX;
                      observations.push({
                        type,
                        pointerType: event.pointerType,
                        dx: originX === null ? 0 : event.clientX - originX,
                      });
                    });
                  }
                  const rect = (element) => {
                    const value = element.getBoundingClientRect();
                    return {
                      left: value.left,
                      top: value.top,
                      right: value.right,
                      bottom: value.bottom,
                    };
                  };
                  const px = (name, value) => {
                    const parsed = Number.parseFloat(value);
                    if (!Number.isFinite(parsed)) {
                      throw new TypeError('Invalid CSS px ' + name + ': ' + value);
                    }
                    return parsed;
                  };
                  window.nexusReadGestureFixture = () => {
                    const safe = getComputedStyle(document.getElementById('safe-values'));
                    const wrapper = document.getElementById('nexus-wrapper');
                    const wrapperStyle = getComputedStyle(wrapper);
                    const targetStyle = getComputedStyle(target);
                    return JSON.stringify({
                      devicePixelRatio: window.devicePixelRatio,
                      viewportWidth: document.documentElement.clientWidth,
                      viewportHeight: document.documentElement.clientHeight,
                      safeRight: px('safe-area-inset-right', safe.paddingRight),
                      safeBottom: px('safe-area-inset-bottom', safe.paddingBottom),
                      wrapper: rect(wrapper),
                      target: rect(target),
                      wrapperPosition: wrapperStyle.position,
                      wrapperPointerEvents: wrapperStyle.pointerEvents,
                      targetPointerEvents: targetStyle.pointerEvents,
                      targetTouchAction: targetStyle.touchAction,
                      targetWillChange: targetStyle.willChange,
                    });
                  };
                  window.nexusResetPointerObservations = () => {
                    observations.length = 0;
                    originX = null;
                  };
                  window.nexusPointerObservationIsTerminal = () => observations.some(
                    ({ type }) => type === 'pointerup' || type === 'pointercancel',
                  );
                  window.nexusReadPointerObservations = () => JSON.stringify(observations);
                </script>
              </body>
            </html>
            """.trimIndent()
    }
}
