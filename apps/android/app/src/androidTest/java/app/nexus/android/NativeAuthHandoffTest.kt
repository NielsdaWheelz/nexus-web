package app.nexus.android

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Description
import org.hamcrest.Matcher
import org.hamcrest.Matchers.allOf
import org.hamcrest.TypeSafeMatcher
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeAuthHandoffTest {
    @After
    fun releaseIntentRecorder() {
        try {
            Intents.release()
        } catch (_: IllegalStateException) {
            // The recorder is absent when activity launch itself fails.
        }
    }

    @Test
    fun nativeAuthStartCarriesTheExactHandoffContractToTheOwnedOrigin() {
        Intents.init()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val oauthPrefix = "${BuildConfig.NEXUS_BASE_URL}/auth/oauth"
            val handoff = allOf(
                hasAction(Intent.ACTION_VIEW),
                hasData(
                    uriWithHandoffContract(
                        prefix = oauthPrefix,
                        provider = "github",
                        mode = "signin",
                        next = "/browse"
                    )
                )
            )
            Intents.intending(handoff).respondWith(ActivityResult(Activity.RESULT_OK, null))

            scenario.onActivity { activity ->
                activity.startAuthFlow(
                    Uri.parse("nexus://auth/start?provider=github&mode=signin&next=%2Fbrowse")
                )
            }

            intended(handoff)
        }
    }

    private fun uriWithHandoffContract(
        prefix: String,
        provider: String,
        mode: String,
        next: String
    ): Matcher<Uri> = object : TypeSafeMatcher<Uri>() {
        private val challenge = Regex("^[0-9a-f]{64}$")

        override fun matchesSafely(item: Uri): Boolean =
            item.toString().startsWith(prefix) &&
                item.getQueryParameter("provider") == provider &&
                item.getQueryParameter("mode") == mode &&
                item.getQueryParameter("flow") == "handoff" &&
                item.getQueryParameter("next") == next &&
                challenge.matches(item.getQueryParameter("hc") ?: "")

        override fun describeTo(description: Description) {
            description
                .appendText("owned OAuth handoff URI for provider ")
                .appendValue(provider)
                .appendText(" and return target ")
                .appendValue(next)
        }
    }
}
