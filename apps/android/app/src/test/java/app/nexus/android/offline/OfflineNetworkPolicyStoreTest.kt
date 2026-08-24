package app.nexus.android.offline

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineNetworkPolicyStoreTest {
    @Test
    fun `existing preference key values and default remain stable`() {
        val context = RuntimeEnvironment.getApplication() as Context
        val preferences = context.getSharedPreferences(
            OfflineNetworkPolicyStore.PREFERENCE_FILE,
            Context.MODE_PRIVATE,
        )
        preferences.edit().clear().commit()
        val store = OfflineNetworkPolicyStore(context)

        assertEquals(NetworkPolicy.UnmeteredOnly, store.get())
        store.set(NetworkPolicy.AnyConnected)
        assertEquals("AnyConnected", preferences.getString("network_policy", null))
        assertEquals(NetworkPolicy.AnyConnected, OfflineNetworkPolicyStore(context).get())
    }
}
