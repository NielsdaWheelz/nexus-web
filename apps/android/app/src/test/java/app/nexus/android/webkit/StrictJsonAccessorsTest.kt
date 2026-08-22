package app.nexus.android.webkit

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/**
 * Risk: Android's `org.json.JSONException` is a checked `Exception`, unlike the
 * JVM test artifact's `RuntimeException`. The strict accessors must surface an
 * absent key as the owned `IllegalStateException` so the wire classifiers'
 * `RuntimeException` catches are sound on a real device.
 */
class StrictJsonAccessorsTest {
    private val empty = JSONObject()

    @Test
    fun `absent keys surface as the owned illegal state on every accessor`() {
        val accessors = listOf<Pair<String, () -> Any>>(
            "requireObject" to { empty.requireObject("missing") },
            "requireArray" to { empty.requireArray("missing", 1) },
            "requireBoundedString" to { empty.requireBoundedString("missing", 0, 1) },
            "requireCanonicalUuid" to { empty.requireCanonicalUuid("missing") },
            "requireLong" to { empty.requireLong("missing", 0, 1) },
            "requireFiniteDouble" to { empty.requireFiniteDouble("missing", 0.0, 1.0) },
            "requireBoolean" to { empty.requireBoolean("missing") },
        )
        accessors.forEach { (name, accessor) ->
            try {
                accessor()
                fail("$name accepted an absent key")
            } catch (error: IllegalStateException) {
                assertEquals(name, "missing is absent", error.message)
            }
        }
    }

    @Test
    fun `null values are absent rather than platform exceptions`() {
        val nulled = JSONObject().put("key", JSONObject.NULL)
        try {
            nulled.requireBoundedString("key", 0, 8)
            fail("JSON null was accepted as a string")
        } catch (error: IllegalStateException) {
            assertEquals("key must be a string", error.message)
        }
    }
}
