package app.nexus.android.offline.reading

import java.io.File
import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingInstalledAccessTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `temporary installed file access failure cannot authorize deletion`() {
        InstalledLegacyReadingFixture(temporary.newFolder()).use { fixture ->
            val reader = File(fixture.installedDirectory, "reader.json")
            check(reader.setReadable(false, false))
            try {
                // A privileged host ignores the permission bits, which would turn
                // the whole scenario into a happy path with no access failure to
                // survive. Name the missing stimulus instead of passing silently.
                assertFalse("host kept ${reader.path} readable, so no access failure was staged", reader.canRead())
                val store = OfflineReadingStore(fixture.context, database = fixture.database,
                    seal = fixture.seal, rootDirectory = fixture.root, durability = NoOpDurability,
                    integrityExecutor = Executor(Runnable::run))
                assertTrue("temporary file access failure deleted the installed original", fixture.installedDirectory.isDirectory)
                assertFalse("unreadable installed member was still reported as readable work",
                    store.snapshot().items.any { it.availability is OfflineReadingAvailability.Ready })
                fixture.database.readableDatabase.rawQuery("SELECT id FROM offline_reader_packages", null).use {
                    assertTrue("temporary file access failure removed the installed row", it.moveToFirst())
                    assertEquals(fixture.packageId.toString(), it.getString(0))
                }
                check(reader.setReadable(true, true))
                assertTrue(fixture.reader.contentEquals(reader.readBytes()))
                val retried = store.reconcile()
                assertTrue(retried.items.single().availability is OfflineReadingAvailability.Ready)
            } finally {
                reader.setReadable(true, true)
            }
        }
    }
}
