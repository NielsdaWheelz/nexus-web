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
            val oauthEndpoint = Uri.parse(BuildConfig.NEXUS_BASE_URL)
                .buildUpon()
                .appendEncodedPath("auth/oauth")
                .build()
            val handoff = allOf(
                hasAction(Intent.ACTION_VIEW),
                hasData(
                    uriWithHandoffContract(
                        endpoint = oauthEndpoint,
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
        endpoint: Uri,
        provider: String,
        mode: String,
        next: String
    ): Matcher<Uri> = object : TypeSafeMatcher<Uri>() {
        private val challenge = Regex("^[0-9a-f]{64}$")
        private val queryNames = setOf("provider", "mode", "flow", "hc", "next")

        override fun matchesSafely(item: Uri): Boolean =
            item.scheme.equals(endpoint.scheme, ignoreCase = true) &&
                item.host.equals(endpoint.host, ignoreCase = true) &&
                effectivePort(item) == effectivePort(endpoint) &&
                item.userInfo == null &&
                item.path == endpoint.path &&
                item.fragment == null &&
                item.queryParameterNames == queryNames &&
                item.getQueryParameters("provider") == listOf(provider) &&
                item.getQueryParameters("mode") == listOf(mode) &&
                item.getQueryParameters("flow") == listOf("handoff") &&
                item.getQueryParameters("next") == listOf(next) &&
                item.getQueryParameters("hc").singleOrNull()?.let(challenge::matches) == true

        override fun describeTo(description: Description) {
            description
                .appendText("owned OAuth handoff URI for provider ")
                .appendValue(provider)
                .appendText(" and return target ")
                .appendValue(next)
        }

        private fun effectivePort(uri: Uri): Int =
            when {
                uri.port >= 0 -> uri.port
                uri.scheme.equals("https", ignoreCase = true) -> 443
                uri.scheme.equals("http", ignoreCase = true) -> 80
                else -> -1
            }
    }
}
