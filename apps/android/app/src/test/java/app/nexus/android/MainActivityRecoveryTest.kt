package app.nexus.android

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import app.nexus.android.offline.readingweb.OFFLINE_READING_MAIN_URL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainActivityRecoveryTest {
    @Test
    fun `a main-frame redirect loop enters canonical recovery once then becomes a native retry terminal`() {
        val circuit = RedirectLoopCircuit()

        assertEquals(
            RedirectLoopAction.Recover("https://nexus.example.test/auth/session/recover?next=%2Fmedia%2F123"),
            circuit.onRedirectLoop(
                "https://nexus.example.test/media/123",
                "https://nexus.example.test",
            ),
        )
        assertEquals(RedirectLoopAction.Terminal, circuit.onRedirectLoop(null, "https://nexus.example.test"))
    }

    @Test
    fun `a successful non-auth navigation resets redirect-loop recovery while auth navigation does not`() {
        val circuit = RedirectLoopCircuit()
        circuit.onRedirectLoop(
            "https://nexus.example.test/browse",
            "https://nexus.example.test",
        )

        circuit.onSuccessfulNavigation("https://nexus.example.test/auth/session/recover?next=%2Fbrowse")
        assertEquals(RedirectLoopAction.Terminal, circuit.onRedirectLoop(null, "https://nexus.example.test"))

        circuit.onSuccessfulNavigation("https://nexus.example.test/browse")
        assertEquals(
            RedirectLoopAction.Recover("https://nexus.example.test/auth/session/recover?next=%2Fbrowse"),
            circuit.onRedirectLoop("https://nexus.example.test/browse", "https://nexus.example.test"),
        )
    }

    @Test
    fun `late hosted failures cannot cover the current offline shelf document`() {
        val hosted = "https://nexus.example.test/media/123"
        val shelf = "https://appassets.androidplatform.net/nexus-offline/index.html"

        assertEquals(true, hostedFailureBelongsToCurrentDocument(hosted, hosted, false))
        assertEquals(false, hostedFailureBelongsToCurrentDocument(hosted, shelf, true))
        assertEquals(false, hostedFailureBelongsToCurrentDocument(hosted, shelf, false))
    }

    @Test
    fun `a cold start without a validated network keeps the shelf and still offers an undownloaded launch link`() {
        withoutValidatedNetwork()
        val link = Uri.parse("${BuildConfig.NEXUS_BASE_URL}/browse")

        launchShell(Intent(Intent.ACTION_VIEW, link)) { activity ->
            assertEquals(
                "an unvalidated network must cold-start the packaged shelf",
                OFFLINE_READING_MAIN_URL,
                shadowOf(activity.webView).lastLoadedUrl,
            )
            assertNull(
                "the held link is offered only once the shelf is up",
                ShadowDialog.getLatestDialog(),
            )

            completeShelfNavigation(activity)

            val ask = ShadowDialog.getLatestDialog()
            assertNotNull(
                "a launch link the shelf cannot serve must be offered, never silently dropped",
                ask,
            )
            assertNotNull(
                "the ask must state that the held link is not downloaded",
                requireNotNull(ask.window).decorView.findText(
                    "This link is not downloaded. Reconnect before opening it.",
                ),
            )
        }
    }

    @Test
    fun `a cold start without a validated network still offers a held auth handoff link`() {
        withoutValidatedNetwork()
        val handoff = Uri.parse("nexus://auth/handoff?code=abc")

        launchShell(Intent(Intent.ACTION_VIEW, handoff)) { activity ->
            completeShelfNavigation(activity)

            assertNotNull(
                "a cold-start sign-in handoff must survive the shelf, never be dropped",
                ShadowDialog.getLatestDialog(),
            )
        }
    }

    @Test
    fun `an unavailable account binding shows the Android affordance that opens the downloaded copies shelf`() {
        withoutValidatedNetwork()

        launchShell(Intent(Intent.ACTION_VIEW)) { activity ->
            activity.showOfflineReadingBindingTerminal()

            val terminal = activity.window.decorView
            assertNotNull(
                "the account-binding terminal must state why hosted Nexus is unavailable",
                terminal.findText("Nexus could not confirm this account for downloads."),
            )
            activity.webView.loadUrl(BuildConfig.NEXUS_BASE_URL)
            val affordance = terminal.findButton("Open downloaded copies")
            assertNotNull("only Android can offer the shelf here", affordance)

            affordance!!.performClick()

            assertEquals(
                "the Android affordance opens the exact packaged shelf",
                OFFLINE_READING_MAIN_URL,
                shadowOf(activity.webView).lastLoadedUrl,
            )
        }
    }

    private fun launchShell(intent: Intent, body: (MainActivity) -> Unit) {
        val context: Context = RuntimeEnvironment.getApplication()
        // The media session is a separate process boundary this shell proof does
        // not exercise; refusing the bind keeps the controller unconnected.
        shadowOf(context as android.app.Application)
            .declareActionUnbindable("androidx.media3.session.MediaSessionService")
        val controller = Robolectric.buildActivity(
            MainActivity::class.java,
            intent.setClass(context, MainActivity::class.java),
        )
        try {
            body(controller.setup().get())
        } finally {
            controller.close()
        }
    }

    /** Drives the WebView callbacks the platform raises for a committed document. */
    private fun completeShelfNavigation(activity: MainActivity) {
        val client = activity.webView.webViewClient
        client.onPageStarted(activity.webView, OFFLINE_READING_MAIN_URL, null)
        client.onPageFinished(activity.webView, OFFLINE_READING_MAIN_URL)
    }

    private fun withoutValidatedNetwork() {
        val context: Context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(ConnectivityManager::class.java)
        shadowOf(manager).setDefaultNetworkActive(false)
        manager.activeNetwork?.let { shadowOf(manager).setNetworkCapabilities(it, null) }
    }

    private fun View.findButton(label: String): Button? =
        views().filterIsInstance<Button>().firstOrNull { it.text.toString() == label }

    private fun View.findText(text: String): TextView? =
        views().filterIsInstance<TextView>().firstOrNull { it.text.toString() == text }

    private fun View.views(): List<View> =
        if (this is ViewGroup) {
            listOf(this) + (0 until childCount).flatMap { getChildAt(it).views() }
        } else {
            listOf(this)
        }
}
