package app.nexus.android.offline.reading

import android.content.Context
import app.nexus.android.offline.OfflineNetworkPolicyStore
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.Executor
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OfflineReadingProgressChoiceTest {
    private lateinit var context: Context
    private lateinit var root: File
    private lateinit var databaseName: String
    private val accountId = UUID.fromString("22222222-2222-4222-8222-222222222222")
    private val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(
            OfflineNetworkPolicyStore.PREFERENCE_FILE,
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
        databaseName = "offline-reading-${UUID.randomUUID()}.db"
        root = kotlin.io.path.createTempDirectory("offline-reading-store").toFile()
    }

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
        root.deleteRecursively()
    }

    @Test
    fun `a newer downloaded generation exposes preserved old intent without applying or resolving it`() {
        val database = OfflineReadingDatabase(context, databaseName)
        val store = store(database)
        store.bindAccountAfterExternalPurge(accountId)
        store.enqueue(mediaId, "Old copy", OfflineReadingMediaKind.WebArticle, 7)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!))
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":1,"progression":0.2,"total_progression":0.2,"position":2},"text":{"quote":"eader","quote_prefix":"r","quote_suffix":null}}"""
        store.saveReaderProgress(mediaId, 7, installed.readerRevisionKey, locator)
        val pending = store.pendingSyncCandidates(mediaId).single()
        store.recordConflict(pending, AttestedRemoteReaderState(accountId, 7,
            "{\"state\":\"Empty\",\"revision\":1}"))
        val oldView = ((store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem).availability as OfflineReadingAvailability.Ready).progress
        var intentId = ""
        database.readableDatabase.queryOne("SELECT id FROM offline_reader_progress_pending") { intentId = it.text("id") }
        root.walkTopDown().single { it.name == "reader.json" }.writeText("corrupt")
        store.reconcile()
        store.cancel(mediaId)
        store.enqueue(mediaId, "New copy", OfflineReadingMediaKind.WebArticle, 8)
        assertTrue(publishRealPackage(store, store.nextRunnableTransfer()!!, readerGeneration = 8))
        val lease = store.open(mediaId)
        assertTrue("old intent was exposed as an actionable location in the new generation",
            lease.progress is NativeReaderProgressView.ContentChanged)
        assertEquals(locator, (lease.progress as NativeReaderProgressView.ContentChanged).deviceLocatorJson)
        assertEquals("{\"kind\":\"Publication\",\"reader_generation\":7}", lease.progress.sourceJson)
        assertTrue(store.saveReaderProgress(mediaId, 8, lease.readerRevisionKey, locator) is
            NativeReaderProgressView.ContentChanged)
        for (useCanonical in listOf(true, false)) {
            assertTrue("a stale choice discarded preserved intent", store.resolveReaderProgress(mediaId,
                lease.readerGeneration, lease.readerRevisionKey, readerProgressViewJson(oldView), useCanonical) is
                NativeReaderProgressView.ContentChanged)
            database.readableDatabase.queryOne("SELECT id, reader_generation, locator_json FROM offline_reader_progress_pending") {
                assertEquals(intentId, it.text("id"))
                assertEquals(7L, it.long("reader_generation"))
                assertEquals(locator, it.text("locator_json"))
            }
        }
        assertTrue(resolveProgress(store, useCanonical = false) is NativeReaderProgressView.ContentChanged)
        assertTrue(resolveProgress(store, useCanonical = true) is NativeReaderProgressView.Canonical)
        database.readableDatabase.queryOne("SELECT count(*) AS count FROM offline_reader_progress_pending") {
            assertEquals(0L, it.long("count"))
        }
        store.closeLease(lease.id)
        database.close()
    }

    /**
     * Downloads-then-publishes through the production install sequence: canonical archive
     * bytes staged, the REAL package verifier deciding acceptance, then durable publication.
     */
    private fun publishRealPackage(
        store: OfflineReadingStore,
        transfer: OfflineReadingTransfer,
        title: String = "Verified copy",
        readerGeneration: Long = 7,
    ): Boolean {
        val artifact = buildWebArticleReadingPackage(transfer.mediaId, title, readerGeneration)
            .stageArtifact(store.stagingArchiveFor(transfer), accountId)
        val verified = store.verifyDownloadedPackage(transfer.id, transfer.stagingName, artifact)
            ?: return false
        return store.publishVerifiedPackage(
            transfer.id,
            transfer.stagingName,
            verified,
            AttestedOfflineReaderBaseline(
                accountId,
                readerGeneration,
                "{\"state\":\"Empty\",\"revision\":0}",
            ),
        )
    }

    private fun resolveProgress(store: OfflineReadingStore, useCanonical: Boolean): NativeReaderProgressView {
        val installed = store.snapshot().items.single() as OfflineReadingItemSnapshot.PackageItem
        return store.resolveReaderProgress(mediaId, installed.readerGeneration, installed.readerRevisionKey,
            readerProgressViewJson((installed.availability as OfflineReadingAvailability.Ready).progress), useCanonical)
    }

    private fun store(database: OfflineReadingDatabase) = OfflineReadingStore(
        context = context,
        database = database,
        seal = MemoryBindingSeal(),
        ids = OfflineReadingIdSource { UUID.randomUUID() },
        clock = Clock.fixed(Instant.parse("2026-08-13T18:00:00Z"), ZoneOffset.UTC),
        rootDirectory = root,
        durability = NoOpDurability,
        progressOriginFactory = OfflineReaderProgressOriginFactory {
            error("progress sync must not run without an active network")
        },
        integrityExecutor = Executor(Runnable::run),
    )
}
