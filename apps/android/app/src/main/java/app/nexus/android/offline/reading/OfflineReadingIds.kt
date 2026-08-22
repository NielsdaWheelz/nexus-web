package app.nexus.android.offline.reading

import java.security.SecureRandom
import java.time.Clock
import java.util.UUID

internal fun interface OfflineReadingIdSource {
    fun next(): UUID
}

internal class Uuid7Source(
    private val clock: Clock = Clock.systemUTC(),
    private val random: SecureRandom = SecureRandom(),
) : OfflineReadingIdSource {
    override fun next(): UUID {
        val unixMilliseconds = clock.millis()
        check(unixMilliseconds in 0..0xffffffffffffL)
        val randomA = random.nextInt(1 shl 12).toLong()
        val randomB = random.nextLong() and 0x3fffffffffffffffL
        val mostSignificantBits =
            (unixMilliseconds shl 16) or 0x7000L or randomA
        val leastSignificantBits = Long.MIN_VALUE or randomB
        return UUID(mostSignificantBits, leastSignificantBits)
    }
}
