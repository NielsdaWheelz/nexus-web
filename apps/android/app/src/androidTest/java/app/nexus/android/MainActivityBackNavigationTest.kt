package app.nexus.android

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityBackNavigationTest {
    @Test
    fun rendererEscapeOwnerConsumesOneBackBeforeTheActivityFinishes() {
        launchWithoutInitialNavigation().use { scenario ->
            loadBackProbe(
                scenario,
                path = "android-test-back-arbitration",
                title = BACK_PROBE_TITLE,
                html = BACK_PROBE_HTML,
            )

            scenario.onActivity { activity -> activity.webView.clearHistory() }
            scenario.onActivity { activity ->
                assertFalse(
                    "The Back arbitration probe requires an empty native WebView history.",
                    activity.webView.canGoBack(),
                )
                activity.onBackPressedDispatcher.onBackPressed()
            }

            waitUntil("Expected native Back to reach the renderer's top Escape owner.") {
                var handled = false
                scenario.onActivity { activity ->
                    handled = activity.webView.title == BACK_HANDLED_TITLE
                }
                handled
            }
            scenario.onActivity { activity ->
                assertFalse("Renderer-handled Back finished MainActivity.", activity.isFinishing)
                activity.onBackPressedDispatcher.onBackPressed()
            }
            waitUntil("Expected unhandled Back to finish MainActivity.") {
                scenario.state == Lifecycle.State.DESTROYED
            }
        }
    }

    @Test
    fun rendererEscapeExceptionDelegatesBackInsteadOfCrashing() {
        launchWithoutInitialNavigation().use { scenario ->
            loadBackProbe(
                scenario,
                path = "android-test-back-exception",
                title = BACK_EXCEPTION_PROBE_TITLE,
                html = BACK_EXCEPTION_PROBE_HTML,
            )

            scenario.onActivity { activity ->
                activity.webView.clearHistory()
                assertFalse(
                    "The Back exception probe requires an empty native WebView history.",
                    activity.webView.canGoBack(),
                )
                activity.onBackPressedDispatcher.onBackPressed()
            }
            waitUntil("Expected renderer arbitration failure to delegate ordinary Back.") {
                scenario.state == Lifecycle.State.DESTROYED
            }
        }
    }

    private fun loadBackProbe(
        scenario: ActivityScenario<MainActivity>,
        path: String,
        title: String,
        html: String,
    ) {
        val probeUrl = "${BuildConfig.NEXUS_BASE_URL}/$path"
        scenario.onActivity { activity ->
            activity.webView.stopLoading()
            activity.webView.loadDataWithBaseURL(
                probeUrl,
                html,
                "text/html",
                "utf-8",
                probeUrl,
            )
        }
        waitUntil("Expected the Back arbitration probe to finish loading.") {
            var loaded = false
            scenario.onActivity { activity ->
                loaded = activity.webView.title == title &&
                    activity.webView.progress == 100
            }
            loaded
        }
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

    private companion object {
        const val BACK_PROBE_TITLE = "Android Back arbitration probe"
        const val BACK_HANDLED_TITLE = "Android Back handled"
        const val BACK_EXCEPTION_PROBE_TITLE = "Android Back exception probe"
        const val BACK_PROBE_HTML =
            """
            <!doctype html>
            <html>
              <head><title>Android Back arbitration probe</title></head>
              <body>
                <script>
                  document.addEventListener('keydown', function onKeyDown(event) {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    document.title = 'Android Back handled';
                    document.removeEventListener('keydown', onKeyDown);
                  });
                </script>
              </body>
            </html>
            """
        const val BACK_EXCEPTION_PROBE_HTML =
            """
            <!doctype html>
            <html>
              <head><title>Android Back exception setup failed</title></head>
              <body>
                <script>
                  Object.defineProperty(window, 'KeyboardEvent', {
                    configurable: true,
                    value: function () { throw new Error('Android Back exception probe'); },
                  });
                  try {
                    new KeyboardEvent('keydown');
                  } catch (error) {
                    document.title = 'Android Back exception probe';
                  }
                </script>
              </body>
            </html>
            """
    }
}
