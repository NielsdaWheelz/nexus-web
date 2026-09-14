package app.nexus.android

import org.junit.Assert.assertEquals
import org.junit.Test

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

}
