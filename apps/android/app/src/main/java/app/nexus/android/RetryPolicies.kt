package app.nexus.android

import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

internal object RetryPolicies {
    // UNQUALIFIED artwork experiment: bounds the complete foreground read,
    // including server-directed backoff. Existing retry steps remain shared.
    val ARTWORK_READ_DEADLINE: Duration = 30.seconds
    val SAME_SYSTEM_CLIENT_RECOVERY: List<Duration> =
        listOf(1.seconds, 2.seconds, 5.seconds, 15.seconds, 30.seconds)
}
