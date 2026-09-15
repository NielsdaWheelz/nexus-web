package app.nexus.android.offline.reading

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import android.os.Build
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.Executor

@RunWith(AndroidJUnit4::class)
class OfflineReadingDeviceLifecycleTest {
    @Test
    fun sqliteFilesSealRecreateLeaseRemovalAndAccountPurge() {
        assumeTrue(Build.VERSION.SDK_INT >= OFFLINE_READING_MINIMUM_SDK)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val suffix = UUID.randomUUID().toString()
        val databaseName = "offline-reading-device-$suffix.db"
        val root = File(context.filesDir, "offline-reading-device-$suffix")
        val seal = OfflineReadingBindingSeal("nexus_offline_reading_device_test_$suffix")
        val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
        val nextAccountId = UUID.fromString("33333333-3333-4333-8333-333333333333")
        val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")
        var database: OfflineReadingDatabase? = null
        try {
            database = OfflineReadingDatabase(context, databaseName)
            val first = deviceStore(context, database, root, seal)
            first.bindAccountAfterExternalPurge(accountId)
            first.enqueue(mediaId, "Device verified copy", OfflineReadingMediaKind.WebArticle)
            val transfer = first.nextRunnableTransfer()!!
            // The REAL package verifier decides acceptance of a canonical archive on
            // device; no fixture stand-in for owned verification code.
            val built = buildWebArticleReadingPackage(mediaId, "Device verified copy")
            val artifact = built.stageArtifact(first.stagingArchiveFor(transfer), accountId)
            val verified = first.verifyDownloadedPackage(
                transfer.id,
                transfer.stagingName,
                artifact,
            )!!
            assertTrue(
                first.publishVerifiedPackage(
                    transfer.id,
                    transfer.stagingName,
                    verified,
                    AttestedOfflineReaderBaseline(
                        accountId,
                        built.readerGeneration,
                        "{\"state\":\"Empty\",\"revision\":0}",
                    ),
                )
            )
            val firstLease = first.open(mediaId)
            assertArrayEquals(
                built.readerJson,
                firstLease.resolveEntry("reader.json").readBytes(),
            )
            first.closeLease(firstLease.id)
            database.close()

            database = OfflineReadingDatabase(context, databaseName)
            val reopened = deviceStore(context, database, root, seal)
            assertTrue(
                reopened.snapshot().items.single().availability is OfflineReadingAvailability.Ready
            )
            val heldLease = reopened.open(mediaId)
            reopened.remove(mediaId)
            assertTrue(
                reopened.snapshot().items.single().availability is OfflineReadingAvailability.Removing
            )
            reopened.closeLease(heldLease.id)
            assertTrue(reopened.snapshot().items.isEmpty())

            reopened.enqueue(mediaId, "Purged copy", OfflineReadingMediaKind.WebArticle)
            reopened.bindAccountAfterExternalPurge(nextAccountId)
            assertTrue(reopened.snapshot().items.isEmpty())
            assertFalse(root.walkTopDown().any { it.isFile })
        } finally {
            database?.close()
            context.deleteDatabase(databaseName)
            root.deleteRecursively()
            seal.deleteKey()
        }
    }
}

private fun deviceStore(
    context: Context,
    database: OfflineReadingDatabase,
    root: File,
    seal: OfflineReadingBindingSealPort,
) = OfflineReadingStore(
    context = context,
    database = database,
    seal = seal,
    ids = OfflineReadingIdSource { UUID.randomUUID() },
    clock = Clock.fixed(Instant.parse("2026-08-13T18:00:00Z"), ZoneOffset.UTC),
    packageVerifier = OfflineReadingPackageVerifier(),
    installedVerifier = OfflineReadingInstalledPackageVerifier(),
    rootDirectory = root,
    schedulerFactory = { DeviceNoOpScheduler },
    progressOriginFactory = OfflineReaderProgressOriginFactory {
        error("progress sync must not run without an active network")
    },
    integrityExecutor = Executor(Runnable::run),
)

private data object DeviceNoOpScheduler : OfflineReadingSchedulerPort {
    override fun ensureScheduled() = true
    override fun rescheduleForPolicyChange() = true
    override fun suspendForAccountTransition() = Unit
}
