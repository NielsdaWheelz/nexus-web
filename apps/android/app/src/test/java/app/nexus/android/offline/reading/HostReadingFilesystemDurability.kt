package app.nexus.android.offline.reading

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption

/** Real host filesystem calls; Robolectric's Linux.open cannot open directories. */
internal object HostReadingFilesystemDurability : OfflineReadingDurability {
    override fun syncTree(directory: File) {
        directory.walkBottomUp().forEach { file ->
            if (file.isDirectory) syncDirectory(file)
            else if (file.isFile) file.inputStream().use { it.fd.sync() }
        }
    }

    override fun syncDirectory(directory: File) {
        FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) }
    }
}
