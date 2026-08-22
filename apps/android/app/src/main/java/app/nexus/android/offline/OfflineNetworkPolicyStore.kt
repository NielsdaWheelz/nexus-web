package app.nexus.android.offline

import android.content.Context

internal enum class NetworkPolicy {
    UnmeteredOnly,
    AnyConnected,
}

/** The single durable owner for the network policy shared by audio and reading downloads. */
internal class OfflineNetworkPolicyStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCE_FILE,
        Context.MODE_PRIVATE,
    )

    fun get(): NetworkPolicy {
        val persisted = preferences.getString(KEY, NetworkPolicy.UnmeteredOnly.name)
            ?: error("offline network policy preference was null")
        return enumValues<NetworkPolicy>().singleOrNull { it.name == persisted }
            ?: error("unknown persisted offline network policy $persisted")
    }

    fun set(policy: NetworkPolicy) {
        check(preferences.edit().putString(KEY, policy.name).commit())
    }

    internal companion object {
        const val PREFERENCE_FILE = "offline_media_policy"
        const val KEY = "network_policy"
    }
}
