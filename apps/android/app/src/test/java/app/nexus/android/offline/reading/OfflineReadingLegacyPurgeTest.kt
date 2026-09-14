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
class OfflineReadingLegacyPurgeTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `completed account purge cannot be undone by a suspended local conversion`() {
        InstalledLegacyReadingFixture(temporary.newFolder()).use { fixture ->
            lateinit var store: OfflineReadingStore
            var purged = false
            val bindingDirectory = File(fixture.root, fixture.binding.toString())
            val durability = object : OfflineReadingDurability {
                override fun syncDirectory(directory: File) = Unit
                override fun syncTree(directory: File) {
                    if (purged || !directory.name.endsWith(".migration")) return
                    assertTrue(File(directory, "source.sqlite").isFile)
                    assertTrue(directory.listFiles()!!.any { it.name.endsWith(".html") })
                    store.beginAccountTransition(null)
                    val removed = store.completeAccountTransition(null)
                    assertEquals(OfflineReadingBindingView.Absent, removed.binding)
                    assertFalse(bindingDirectory.exists())
                    purged = true
                }
            }
            store = OfflineReadingStore(fixture.context, database = fixture.database,
                seal = fixture.seal, rootDirectory = fixture.root, durability = durability,
                integrityExecutor = Executor(Runnable::run), reconcileOnInit = false,
                progressOriginFactory = OfflineReaderProgressOriginFactory {
                    error("local conversion must not reach the progress origin")
                })
            val completed = store.reconcile()
            assertTrue("conversion never reached the owned file boundary", purged)
            assertEquals(OfflineReadingBindingView.Absent, completed.binding)
            assertTrue(completed.items.isEmpty())
            assertFalse("conversion recreated a purged account directory", bindingDirectory.exists())
            fixture.database.readableDatabase.rawQuery("SELECT count(*) FROM offline_reader_account_transitions", null).use {
                check(it.moveToFirst())
                assertEquals(0L, it.getLong(0))
            }
        }
    }
}
