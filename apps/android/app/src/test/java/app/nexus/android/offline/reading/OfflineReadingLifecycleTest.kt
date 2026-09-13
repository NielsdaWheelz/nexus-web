package app.nexus.android.offline.reading

import android.app.job.JobInfo
import app.nexus.android.offline.NetworkPolicy
import app.nexus.android.offline.StorageAdmissionPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class OfflineReadingLifecycleTest {
    @Test
    fun `interruption restarts once from zero then requires manual retry`() {
        val first = interruptTransfer(
            state = ReadingTransferState.Downloading(
                receivedBytes = 41,
                totalBytes = 100,
            ),
            automaticRestartCount = 0,
        )

        assertEquals(
            InterruptionResult(
                state = ReadingTransferState.Restarting(
                    attempt = 1,
                    reason = ReadingRestartReason.Interrupted,
                ),
                automaticRestartCount = 1,
                shouldReschedule = true,
            ),
            first,
        )

        assertEquals(
            InterruptionResult(
                state = ReadingTransferState.Failed(ReadingFailureReason.SystemStopped),
                automaticRestartCount = 1,
                shouldReschedule = false,
            ),
            interruptTransfer(
                state = ReadingTransferState.Downloading(
                    receivedBytes = 0,
                    totalBytes = 100,
                ),
                automaticRestartCount = first.automaticRestartCount,
            ),
        )
    }

    @Test
    fun `policy checkpoint does not spend the interruption budget`() {
        assertEquals(
            InterruptionResult(
                state = ReadingTransferState.Restarting(
                    attempt = 1,
                    reason = ReadingRestartReason.PolicyChanged,
                ),
                automaticRestartCount = 0,
                shouldReschedule = true,
            ),
            checkpointForPolicyChange(automaticRestartCount = 0),
        )
    }

    @Test
    fun `storage admission accounts for compressed expanded overhead and shared reserve`() {
        val requiredWithoutReserve = 40L + 60L + OFFLINE_READING_FILESYSTEM_OVERHEAD_BYTES

        assertTrue(
            OfflineReadingStorageAdmission.canAdmit(
                availableBytes = requiredWithoutReserve + StorageAdmissionPolicy.RESERVE_BYTES,
                compressedBytes = 40,
                expandedBytes = 60,
            )
        )
        assertFalse(
            OfflineReadingStorageAdmission.canAdmit(
                availableBytes = requiredWithoutReserve + StorageAdmissionPolicy.RESERVE_BYTES - 1,
                compressedBytes = 40,
                expandedBytes = 60,
            )
        )
        assertFalse(
            OfflineReadingStorageAdmission.canAdmit(
                availableBytes = Long.MAX_VALUE,
                compressedBytes = Long.MAX_VALUE,
                expandedBytes = 1,
            )
        )
    }

    @Test
    fun `fixed queue job schedules only when work has no admitted runner`() {
        assertTrue(shouldScheduleOfflineReadingJob(hasQueuedWork = true, jobIsPendingOrRunning = false))
        assertFalse(shouldScheduleOfflineReadingJob(hasQueuedWork = true, jobIsPendingOrRunning = true))
        assertFalse(shouldScheduleOfflineReadingJob(hasQueuedWork = false, jobIsPendingOrRunning = false))
    }

    @Test
    fun `unmetered policy admits only an Android-assigned unmetered network`() {
        assertEquals(
            JobInfo.NETWORK_TYPE_UNMETERED,
            offlineReadingRequiredNetworkType(NetworkPolicy.UnmeteredOnly),
        )
        assertEquals(
            JobInfo.NETWORK_TYPE_ANY,
            offlineReadingRequiredNetworkType(NetworkPolicy.AnyConnected),
        )
    }

    @Test
    fun `offline reading has an explicit API 34 capability boundary`() {
        assertThrows(OfflineReadingUnsupportedPlatformException::class.java) {
            requireOfflineReadingSupported(33)
        }
        requireOfflineReadingSupported(34)
    }

    @Test
    fun `publication busy and timeout are transient while exact generation conflict is content changed`() {
        assertEquals(
            ReadingFailureReason.Server,
            offlineReadingFailureReason(409, "E_READER_PUBLICATION_BUSY"),
        )
        assertEquals(
            ReadingFailureReason.Server,
            offlineReadingFailureReason(504, "E_OFFLINE_READING_PACKAGE_TIMEOUT"),
        )
        assertEquals(
            ReadingFailureReason.ContentChanged,
            offlineReadingFailureReason(409, "E_READER_CONTENT_CHANGED"),
        )
        assertEquals(
            ReadingFailureReason.TooLarge,
            offlineReadingFailureReason(413, null),
        )
    }

    @Test
    fun `persisted transfer state rejects duplicate and branch-incoherent JSON`() {
        assertEquals(
            ReadingTransferState.Queued(ReadingQueueReason.WaitingForUnmetered),
            OfflineReadingStateCodec.decode(
                OfflineReadingStateCodec.encode(
                    ReadingTransferState.Queued(ReadingQueueReason.WaitingForUnmetered)
                )
            ),
        )
        assertThrows(IllegalStateException::class.java) {
            OfflineReadingStateCodec.decode(
                "{\"kind\":\"Preparing\",\"kind\":\"Verifying\"}"
            )
        }
        assertThrows(IllegalStateException::class.java) {
            OfflineReadingStateCodec.decode(
                "{\"kind\":\"Preparing\",\"reason\":\"Scheduler\"}"
            )
        }
    }

    @Test
    fun `offline locator validation accepts only exact bounded pdf web and epub variants`() {
        OfflineReaderStateValidator.requireLocator(
            """{"kind":"pdf","page":1,"page_progression":0.5,"zoom":1.25,"position":1}"""
        )
        OfflineReaderStateValidator.requireLocator(
            """{"kind":"web","target":{"fragment_id":"fragment"},"locations":{"text_offset":0,"progression":0.0,"total_progression":0.5,"position":1},"text":{"quote":"visible","quote_prefix":null,"quote_suffix":null}}"""
        )
        OfflineReaderStateValidator.requireLocator(
            """{"kind":"epub","target":{"fragment_id":"018f2e74-5efc-7e2f-8a3a-142857142857","href_path":"EPUB/chapter.xhtml","anchor_id":{"kind":"Absent"}},"locations":{"text_offset":0,"progression":0.0,"total_progression":0.5,"position":1},"text":{"quote":null,"quote_prefix":null,"quote_suffix":null}}"""
        )
        listOf(
            """{"kind":"transcript","target":{"fragment_id":"x"},"locations":{"text_offset":0,"progression":0.0,"total_progression":0.0,"position":1},"text":{"quote":null,"quote_prefix":null,"quote_suffix":null}}""",
            """{"kind":"pdf","page":0,"page_progression":null,"zoom":null,"position":null}""",
            """{"kind":"pdf","page":1,"page_progression":2.0,"zoom":null,"position":null}""",
            """{"kind":"web","target":{"fragment_id":"x"},"locations":{"text_offset":0,"progression":0.0,"total_progression":0.0,"position":1},"text":{"quote":null,"quote_prefix":"orphan","quote_suffix":null}}""",
        ).forEach { invalid ->
            assertThrows(RuntimeException::class.java) {
                OfflineReaderStateValidator.requireLocator(invalid)
            }
        }
    }


    @Test
    fun `reader revision matches the independently reviewed shared PDF vector`() {
        // The reviewed shared vector file is the oracle; no language-local copy of the
        // vector's entries or revision key may live in this test.
        val contract = org.json.JSONObject(
            File(
                System.getProperty("nexus.testdata.offlineReadingContract")
                    ?: error("offline-reading shared contract path is missing"),
            ).readText()
        )
        val manifest = (0 until contract.getJSONArray("validPackages").length())
            .map { contract.getJSONArray("validPackages").getJSONObject(it) }
            .single { it.getString("name") == "pdf-verified-copy" }
            .getJSONObject("package")
            .getJSONObject("manifest")
        val entries = (0 until manifest.getJSONArray("entries").length()).map { index ->
            val entry = manifest.getJSONArray("entries").getJSONObject(index)
            OfflineReadingManifestEntry(
                path = entry.getString("path"),
                mediaType = entry.getString("mediaType"),
                sizeBytes = entry.getLong("sizeBytes"),
                sha256 = entry.getString("sha256"),
            )
        }

        assertEquals(
            manifest.getString("readerRevisionKey"),
            OfflineReadingRevision.compute(
                readerGeneration = manifest.getLong("readerGeneration"),
                entries = entries,
            ),
        )
    }


    @Test
    fun `verification failure leaves no publishable directory`() {
        val archive = kotlin.io.path.createTempFile("offline-reading-test", ".zip").toFile()
        val destination = kotlin.io.path.createTempDirectory("offline-reading-destination").toFile()
            .resolve("verified")
        ZipOutputStream(FileOutputStream(archive)).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write("{}".toByteArray())
            zip.closeEntry()
        }

        assertThrows(OfflineReadingPackageException::class.java) {
            OfflineReadingPackageVerifier().verifyAndExtract(
                OfflineReadingTransferArtifact(
                    archive = archive,
                    accountId = UUID.fromString("22222222-2222-4222-8222-222222222222"),
                    readerGeneration = 7,
                    compressedBytes = archive.length(),
                    expandedBytes = 1,
                    packageSha256 = MessageDigest.getInstance("SHA-256")
                        .digest(archive.readBytes())
                        .toHex(),
                ),
                expectedAccountId = UUID.fromString("22222222-2222-4222-8222-222222222222"),
                expectedMediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857"),
                destination = destination,
            )
        }

        assertFalse(destination.exists())
        archive.delete()
        destination.parentFile?.deleteRecursively()
    }

    @Test
    fun `manifest rejects SVG above strict parse memory bound before extraction`() {
        val mediaId = "018f2e74-5efc-7d0d-8a3a-142857142857"
        val oversized = OFFLINE_READING_MAX_SVG_BYTES + 1
        val manifest = """
            {"packageSchemaVersion":1,"readerContractVersion":2,"minimumReaderBundleVersion":2,"mediaId":"$mediaId","mediaKind":"Epub","title":"Bounded SVG","readerGeneration":7,"readerRevisionKey":"${"0".repeat(64)}","entries":[{"path":"reader.json","mediaType":"application/json","sizeBytes":1,"sha256":"${"1".repeat(64)}"},{"path":"assets/oversize.svg","mediaType":"image/svg+xml","sizeBytes":$oversized,"sha256":"${"2".repeat(64)}"}]}
        """.trimIndent()

        assertThrows(IllegalArgumentException::class.java) {
            OfflineReadingManifestParser.parse(manifest.toByteArray())
        }
    }

    @Test
    fun `manifest rejects reader JSON above bounded parse memory contract`() {
        val mediaId = "018f2e74-5efc-7d0d-8a3a-142857142857"
        val oversized = OFFLINE_READING_MAX_READER_JSON_BYTES + 1
        val manifest = """
            {"packageSchemaVersion":1,"readerContractVersion":2,"minimumReaderBundleVersion":2,"mediaId":"$mediaId","mediaKind":"Pdf","title":"Bounded reader","readerGeneration":7,"readerRevisionKey":"${"0".repeat(64)}","entries":[{"path":"document.pdf","mediaType":"application/pdf","sizeBytes":1,"sha256":"${"1".repeat(64)}"},{"path":"reader.json","mediaType":"application/json","sizeBytes":$oversized,"sha256":"${"2".repeat(64)}"}]}
        """.trimIndent()

        assertThrows(IllegalArgumentException::class.java) {
            OfflineReadingManifestParser.parse(manifest.toByteArray())
        }
    }

    @Test
    fun `central directory declaration is bounded before allocation and within archive`() {
        assertThrows(IllegalArgumentException::class.java) {
            validateOfflineReadingCentralDirectoryBounds(
                archiveLength = OFFLINE_READING_MAX_ARCHIVE_BYTES,
                centralOffset = 0,
                centralSize = OFFLINE_READING_MAX_CENTRAL_DIRECTORY_BYTES + 1,
                eocdOffset = OFFLINE_READING_MAX_CENTRAL_DIRECTORY_BYTES + 1,
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateOfflineReadingCentralDirectoryBounds(
                archiveLength = 100,
                centralOffset = 90,
                centralSize = 20,
                eocdOffset = 110,
            )
        }
    }

    @Test
    fun `strict SVG parser rejects executable and non-local XML`() {
        val bad = listOf(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><foreignObject/></svg>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect style=\"fill:red\"/></svg>",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"asset.png\"/></svg>",
            "<!DOCTYPE svg [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><svg>&xxe;</svg>",
        )
        bad.forEach { xml ->
            val file = kotlin.io.path.createTempFile("offline-svg", ".svg").toFile()
            try {
                file.writeText(xml)
                assertFalse(
                    OfflineReadingPackageVerifier().assetSignatureMatches(
                        "assets/test.svg",
                        "image/svg+xml",
                        file,
                    )
                )
            } finally {
                file.delete()
            }
        }
    }

    @Test
    fun `temporarily locked binding defers exposure without destructive purge`() {
        assertEquals(
            BindingReconciliationAction.DeferUntilUnlocked,
            bindingReconciliationAction(BindingSealStatus.Locked),
        )
        assertEquals(
            BindingReconciliationAction.Purge,
            bindingReconciliationAction(BindingSealStatus.Missing),
        )
        assertEquals(
            BindingReconciliationAction.Purge,
            bindingReconciliationAction(BindingSealStatus.Invalid),
        )
    }


    @Test
    fun `web article permits URL prose but rejects remote URL attributes`() {
        val mediaId = UUID.fromString("018f2e74-5efc-7d2f-8a3a-142857142857")
        val entry = OfflineReadingManifestEntry(
            "reader.json",
            "application/json",
            1,
            "0".repeat(64),
        )
        val manifest = OfflineReadingManifest(
            mediaId,
            OfflineReadingMediaKind.WebArticle,
            "Signal on the Train",
            13,
            OfflineReadingRevision.compute(13, listOf(entry)),
            listOf(entry),
        )
        val prose = """
            {"readerContractVersion":2,"mediaId":"$mediaId","mediaKind":"WebArticle","title":"Signal on the Train","navigation":{"media_id":"$mediaId","kind":"web_article","generation":13,"fragments":[{"fragment_id":"018f2e74-5efc-7e2f-8a3a-142857142857","fragment_idx":0,"char_count":34}],"sections":[],"toc_nodes":[],"landmarks":[],"page_list":[]},"fragments":[{"fragmentId":"018f2e74-5efc-7e2f-8a3a-142857142857","fragmentIdx":0,"htmlSanitized":"<article><p>Read https://example.com in prose.</p></article>","canonicalText":"Read https://example.com in prose.","createdAt":"2026-09-11T00:00:00Z"}]}
        """.trimIndent().toByteArray()
        OfflineReaderDocumentVerifier.verify(prose, manifest)

        val remoteAttribute = prose.toString(Charsets.UTF_8)
            .replace("<p>Read", "<p><a href=\\\"https://example.com\\\">Read</a>")
            .toByteArray()
        assertThrows(IllegalArgumentException::class.java) {
            OfflineReaderDocumentVerifier.verify(remoteAttribute, manifest)
        }
        listOf(
            "<a href=javascript:alert(1)>Read</a>",
            "<a href=jav&#x61;script:alert(1)>Read</a>",
            "<img src=//example.com/pixel.png>",
            "<a\nhref=https://example.com>Read</a>",
        ).forEach { mutation ->
            val mutated = prose.toString(Charsets.UTF_8)
                .replace("<p>Read https://example.com in prose.</p>", mutation)
                .toByteArray()
            assertThrows("expected $mutation to reject", IllegalArgumentException::class.java) {
                OfflineReaderDocumentVerifier.verify(mutated, manifest)
            }
        }
    }

    @Test
    fun `manifest requires reader JSON to own application-json MIME`() {
        val mediaId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")
        assertThrows(IllegalArgumentException::class.java) {
            OfflineReadingManifest(
                mediaId,
                OfflineReadingMediaKind.Pdf,
                "False MIME",
                7,
                "0".repeat(64),
                listOf(
                    OfflineReadingManifestEntry(
                        "reader.json",
                        "text/plain",
                        1,
                        "1".repeat(64),
                    )
                ),
            )
        }
    }

    @Test
    fun `process loss restarts stale active state once then converges to manual retry`() {
        assertEquals(
            ReadingTransferState.Failed(ReadingFailureReason.SystemStopped),
            convergeSystemStopped(),
        )
        assertEquals(
            InterruptionResult(
                ReadingTransferState.Restarting(1, ReadingRestartReason.Interrupted),
                automaticRestartCount = 1,
                shouldReschedule = true,
            ),
            reconcileStaleActiveTransfer(
                liveRunnerInProcess = false,
                state = ReadingTransferState.Downloading(41, 100),
                automaticRestartCount = 0,
            ),
        )
        assertEquals(
            InterruptionResult(
                ReadingTransferState.Failed(ReadingFailureReason.SystemStopped),
                automaticRestartCount = 1,
                shouldReschedule = false,
            ),
            reconcileStaleActiveTransfer(
                liveRunnerInProcess = false,
                state = ReadingTransferState.Restarting(1, ReadingRestartReason.Interrupted),
                automaticRestartCount = 1,
            ),
        )
        assertEquals(
            null,
            reconcileStaleActiveTransfer(
                liveRunnerInProcess = true,
                state = ReadingTransferState.Downloading(41, 100),
                automaticRestartCount = 0,
            ),
        )
    }

    @Test
    fun `non-user stop reschedules queued or reconciling work while Task Manager never does`() {
        assertTrue(
            shouldRescheduleStoppedReadingJob(
                userInitiatedStop = false,
                interruption = null,
                hasDurableTransferWork = true,
                reconciliationPending = false,
            )
        )
        assertTrue(
            shouldRescheduleStoppedReadingJob(
                userInitiatedStop = false,
                interruption = null,
                hasDurableTransferWork = false,
                reconciliationPending = true,
            )
        )
        assertFalse(
            shouldRescheduleStoppedReadingJob(
                userInitiatedStop = true,
                interruption = InterruptionResult(
                    ReadingTransferState.Restarting(1, ReadingRestartReason.Interrupted),
                    1,
                    true,
                ),
                hasDurableTransferWork = true,
                reconciliationPending = true,
            )
        )
    }

    @Test
    fun `late callbacks from a stopped transfer run cannot overwrite durable stop state`() {
        val transferId = UUID.fromString("018f2e74-5efc-7d0d-8a3a-142857142857")
        val fence = TransferRunFence(7, transferId, "staging-a")
        assertTrue(transferCallbackIsCurrent(fence, currentRunGeneration = 7, stopped = false))
        assertFalse(transferCallbackIsCurrent(fence, currentRunGeneration = 8, stopped = true))
        assertFalse(transferCallbackIsCurrent(fence, currentRunGeneration = 8, stopped = false))
    }

    @Test
    fun `stale policy reconciliation callback cannot finish a stopped generation`() {
        assertTrue(
            readingJobCallbackOwnsFinish(
                stopped = false,
                currentRunGeneration = 7,
                callbackGeneration = 7,
            )
        )
        assertFalse(
            readingJobCallbackOwnsFinish(
                stopped = true,
                currentRunGeneration = 8,
                callbackGeneration = 7,
            )
        )
        assertFalse(
            readingJobCallbackOwnsFinish(
                stopped = false,
                currentRunGeneration = 8,
                callbackGeneration = 7,
            )
        )
    }
}
