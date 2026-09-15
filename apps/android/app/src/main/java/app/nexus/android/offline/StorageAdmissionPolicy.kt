package app.nexus.android.offline

/**
 * The one owner of the shared 512-MiB free-space reserve that every offline
 * download (Media3 audio and offline reading) must preserve. Both the audio
 * factory and the reading store delegate here; neither may keep a duplicate
 * of this calculation.
 */
internal object StorageAdmissionPolicy {
    const val RESERVE_BYTES: Long = 512L * 1024L * 1024L

    fun preservesReserve(availableBytes: Long, nextBytes: Long): Boolean {
        return nextBytes >= 0 &&
            nextBytes <= Long.MAX_VALUE - RESERVE_BYTES &&
            availableBytes >= nextBytes + RESERVE_BYTES
    }
}
