package app.nexus.android

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

internal object RetryPolicies {
    val SAME_SYSTEM_CLIENT_RECOVERY: List<Duration> =
        listOf(1.seconds, 2.seconds, 5.seconds, 15.seconds, 30.seconds)
}
