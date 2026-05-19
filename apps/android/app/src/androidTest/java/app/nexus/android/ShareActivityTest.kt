package app.nexus.android

import android.content.Intent
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShareActivityTest {
    @Test
    fun textPlainSendIntentWithSharedTextKeepsShareActivityOpen() {
        val intent = sendIntent("text/plain", "https://example.com/article")

        ActivityScenario.launch<ShareActivity>(intent).use { scenario ->
            waitUntil("Expected ShareActivity to resume for a non-empty shared text.") {
                scenario.state == Lifecycle.State.RESUMED
            }

            assertStaysAt(
                scenario,
                Lifecycle.State.RESUMED,
                "Expected ShareActivity to stay open for a non-empty shared text."
            )
        }
    }

    @Test
    fun sendIntentWithEmptySharedTextFinishesShareActivityImmediately() {
        val intent = sendIntent("text/plain", "   ")

        ActivityScenario.launch<ShareActivity>(intent).use { scenario ->
            waitUntil("Expected ShareActivity to finish for empty shared text.") {
                scenario.state == Lifecycle.State.DESTROYED
            }
        }
    }

    @Test
    fun sendIntentWithoutSharedTextFinishesShareActivityImmediately() {
        val intent = sendIntent("text/plain", null)

        ActivityScenario.launch<ShareActivity>(intent).use { scenario ->
            waitUntil("Expected ShareActivity to finish for absent shared text.") {
                scenario.state == Lifecycle.State.DESTROYED
            }
        }
    }

    private fun sendIntent(mimeType: String, sharedText: CharSequence?): Intent {
        return Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            setClass(
                ApplicationProvider.getApplicationContext(),
                ShareActivity::class.java
            )
            if (sharedText != null) {
                putExtra(Intent.EXTRA_TEXT, sharedText)
            }
        }
    }

    private fun assertStaysAt(
        scenario: ActivityScenario<ShareActivity>,
        state: Lifecycle.State,
        message: String
    ) {
        val deadline = SystemClock.elapsedRealtime() + 1_000
        while (SystemClock.elapsedRealtime() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (scenario.state != state) {
                throw AssertionError(message)
            }
            Thread.sleep(50)
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
}
