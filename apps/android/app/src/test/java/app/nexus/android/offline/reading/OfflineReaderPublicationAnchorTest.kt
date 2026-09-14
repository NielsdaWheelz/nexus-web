package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@org.junit.runner.RunWith(org.robolectric.RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [35])
@org.robolectric.annotation.SQLiteMode(org.robolectric.annotation.SQLiteMode.Mode.NATIVE)
class OfflineReaderPublicationAnchorTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `retained anchors bind the first visible original occurrence and exact unit`() {
        val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        val media = UUID.fromString("11111111-1111-4111-8111-111111111111")
        for (fixture in listOf("epub-anchor-visible", "epub-anchor-name", "epub-anchor-id-name", "epub-anchor-hidden-first", "epub-anchor-aria-hidden-first")) {
            val source = OfflineReadingPackageVerifier().verifyAndExtract(
                readerPublicationArtifact(temporary.root, fixture), account, media, File(temporary.root, fixture))
            val prepared = prepareOfflineReadingPackage(source)
            assertTrue(File(prepared.source.extractedDirectory, "units/second.json").isFile)
            assertEquals(File(source.extractedDirectory, OFFLINE_READING_TABLE_INDEX_NAME).sha256Hex(), prepared.tableIndexSha256)
        }
        for ((fixture, reason) in listOf("epub-anchor-later" to "publication anchor names a later original id",
            "epub-anchor-missing" to "publication anchor has no visible original id",
            "epub-anchor-duplicate" to "publication anchor identity is duplicated")) {
            val members = OfflineReadingPackageVerifier().verifyAndExtract(
                readerPublicationArtifact(temporary.root, fixture), account, media, File(temporary.root, fixture))
            val failure = assertThrows("retained anchor accepted a foreign source occurrence: $fixture", IllegalArgumentException::class.java) {
                prepareOfflineReadingPackage(members)
            }
            assertEquals(reason, failure.message)
        }
    }

    @Test
    fun `epub readiness requires current prepared format even without declared anchors`() {
        for (fixture in listOf("epub", "epub-anchor-visible")) {
            val account = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            val media = UUID.fromString("11111111-1111-4111-8111-111111111111")
            val directory = File(temporary.root, fixture)
            val members = OfflineReadingPackageVerifier().verifyAndExtract(
                readerPublicationArtifact(temporary.root, fixture), account, media, directory)
            val manifest = members.manifest
            val original = OfflineReadingPackage(UUID.randomUUID(), account, media, manifest.mediaKind, manifest.title,
                manifest.readerGeneration, manifest.readerRevisionKey, 2, members.installedBytes, Instant.EPOCH, null)
            assertTrue(OfflineReadingInstalledPackageVerifier().membersAreValid(original, directory))
            assertFalse("unprepared epub was ready", installedTableIndexIsReady(original, directory))
            val prepared = prepareOfflineReadingPackage(members)
            val installed = original.copy(sizeBytes = prepared.installedBytes, tableIndexSha256 = prepared.tableIndexSha256)
            println("native_epub_prepared_index=" + JSONObject().put("fixture", fixture)
                .put("source_bytes", members.installedBytes).put("prepared_index_bytes", prepared.installedBytes - members.installedBytes))
            assertTrue(installedTableIndexIsReady(installed, directory))
            val index = File(directory, OFFLINE_READING_TABLE_INDEX_NAME)
            // The previous preparation format had the same file/revision owner,
            // but did not attest original-id joins. A matching digest is insufficient.
            SQLiteDatabase.openDatabase(index.path, null, SQLiteDatabase.OPEN_READWRITE).use { it.version = 0 }
            val previousFormat = installed.copy(tableIndexSha256 = index.sha256Hex())
            assertTrue(OfflineReadingInstalledPackageVerifier().membersAreValid(previousFormat, directory))
            assertFalse("old prepared format bypassed source joins", installedTableIndexIsReady(previousFormat, directory))
        }
    }

    @Test
    fun `maximum member graph measures aggregate anchor verification`() {
        val directory = temporary.newFolder("maximum-metadata")
        val installed = maximumMetadata(directory)
        val manifestFile = File(directory, "manifest.json")
        val sourceDigest = manifestFile.sha256Hex()
        val (memberCount, expanded) = OfflineReadingManifestParser.parse(manifestFile.readBytes()).let {
            it.entries.size to it.entries.sumOf { entry -> entry.sizeBytes }
        }
        // Pin the unchanged graph from baseline 104ba8ddd92809b8, not a
        // freshly copied candidate result or a smaller replacement workload.
        assertEquals("9afd1818b8c4e77c919b2363184fab4a5541d2b2276d2bd28bd83371f73b9d72", sourceDigest)
        assertEquals("876d06e579d55606bbebaca21bc89c68a10bd78921faf5ba7140d2671fda812a", installed.readerRevisionKey)
        assertEquals(520_633_402L, expanded)
        assertEquals(OFFLINE_READING_MAX_ENTRIES, memberCount)
        assertTrue("metadata recipe did not approach the supported aggregate", expanded >= OFFLINE_READING_MAX_EXPANDED_BYTES * 95 / 100)
        assertTrue(expanded <= OFFLINE_READING_MAX_EXPANDED_BYTES)
        println("native_anchor_maximum_input=" + JSONObject().put("manifest_sha256", sourceDigest)
            .put("reader_revision", installed.readerRevisionKey).put("member_count", memberCount)
            .put("unit_count", 2045).put("source_element_count", 2045L * 488).put("fragment_count", 21).put("anchor_count", 2045L * 488 * 2).put("expanded_bytes", expanded)
            .put("installed_bytes", installed.sizeBytes).put("recipe", "empty-visible-id-and-name-with-exact-first-unit-anchors")
            .put("java_version", System.getProperty("java.version")).put("jvm_max_heap_bytes", Runtime.getRuntime().maxMemory()))
        val staging = temporary.newFolder("metadata-preparation")
        val candidateIndex = File(staging, "publication/$OFFLINE_READING_TABLE_INDEX_NAME")
        val indexPeak = AtomicLong()
        val journalPeak = AtomicLong()
        val vacuumPeak = AtomicLong()
        val privateDiskPeak = AtomicLong()
        val heapPeak = AtomicLong()
        val samples = AtomicLong()
        val sampler = Executors.newSingleThreadScheduledExecutor()
        val sample = Runnable {
            heapPeak.accumulateAndGet(Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory(), ::maxOf)
            val indexBytes = candidateIndex.length()
            val journalBytes = File(candidateIndex.path + "-journal").length()
            // SQLite VACUUM temporary files may already be unlinked on Linux.
            // This dedicated test JVM owns the only active preparation connection.
            val vacuumBytes = if (System.getProperty("os.name") == "Linux") File("/proc/self/fd").listFiles().orEmpty().sumOf { fd ->
                val target = try { Files.readSymbolicLink(fd.toPath()).fileName.toString() }
                    catch (_: java.nio.file.NoSuchFileException) { "" }
                if (target.startsWith("etilqs_")) fd.length() else 0L
            } else 0L
            indexPeak.accumulateAndGet(indexBytes, ::maxOf)
            journalPeak.accumulateAndGet(journalBytes, ::maxOf)
            vacuumPeak.accumulateAndGet(vacuumBytes, ::maxOf)
            privateDiskPeak.accumulateAndGet(indexBytes + journalBytes + vacuumBytes, ::maxOf)
            samples.incrementAndGet()
        }
        sample.run()
        val heapBefore = heapPeak.get()
        val linux = System.getProperty("os.name") == "Linux"
        val processBefore = if (linux) File("/proc/self/status").readLines().filter {
            it.startsWith("VmRSS:") || it.startsWith("VmHWM:")
        } else emptyList()
        val sampling = sampler.scheduleAtFixedRate(sample, 0, 100, TimeUnit.MILLISECONDS)
        try {
            val started = System.nanoTime()
            assertTrue("maximum attested anchor graph failed member validation",
                OfflineReadingInstalledPackageVerifier().membersAreValid(installed, directory))
            val membersCompleted = System.nanoTime()
            val prepared = stageRetainedReadingPackage(directory, staging)
            val ready = installed.copy(sizeBytes = prepared.installedBytes, tableIndexSha256 = prepared.tableIndexSha256)
            assertTrue("maximum anchor graph was not prepared", installedTableIndexIsReady(ready, prepared.source.extractedDirectory))
            val completed = System.nanoTime()
            sample.run()
            check(!sampling.isDone)
            sampler.shutdown()
            check(sampler.awaitTermination(10, TimeUnit.SECONDS))
            val processAfter = if (linux) File("/proc/self/status").readLines().filter {
                it.startsWith("VmRSS:") || it.startsWith("VmHWM:")
            } else emptyList()
            assertEquals(sourceDigest, manifestFile.sha256Hex())
            assertEquals(installed.sizeBytes, directory.walkTopDown().filter(File::isFile).sumOf(File::length))
            println("native_anchor_maximum=" + JSONObject().put("scope", "unqualified-host-retained-members-copy-and-preparation")
                .put("memory_observer", if (linux) "sampled-jvm-heap-and-linux-status" else "sampled-jvm-heap-only")
                .put("manifest_sha256", sourceDigest).put("reader_revision", installed.readerRevisionKey)
                .put("member_count", memberCount).put("anchor_count", 2045L * 488 * 2)
                .put("expanded_bytes", expanded).put("verification_ms", (membersCompleted - started) / 1_000_000.0)
                .put("copy_preparation_readiness_ms", (completed - membersCompleted) / 1_000_000.0)
                .put("whole_ready_ms", (completed - started) / 1_000_000.0)
                .put("sampled_index_peak_bytes", indexPeak.get()).put("sampled_journal_peak_bytes", journalPeak.get())
                .put("sampled_vacuum_temporary_peak_bytes", vacuumPeak.get()).put("sampled_private_disk_peak_bytes", privateDiskPeak.get())
                .put("final_index_bytes", candidateIndex.length()).put("original_source_bytes", installed.sizeBytes)
                .put("candidate_installed_bytes", prepared.installedBytes)
                .put("sampled_disk_upper_bound_bytes", installed.sizeBytes * 2 + privateDiskPeak.get())
                .put("heap_used_before_bytes", heapBefore).put("sampled_heap_used_peak_bytes", heapPeak.get())
                .put("sample_interval_ms", 100).put("samples", samples.get())
                .put("process_before", JSONArray(processBefore)).put("process_after", JSONArray(processAfter)))
        } finally {
            sampler.shutdownNow()
            check(sampler.awaitTermination(10, TimeUnit.SECONDS))
        }
    }

    private fun maximumMetadata(directory: File): OfflineReadingPackage {
        val media = UUID.fromString("11111111-1111-4111-8111-111111111111")
        val entries = linkedMapOf<String, OfflineReadingManifestEntry>()
        // Baseline 104ba8ddd92809b8 used the existing JVM org.json dependency.
        // Android orders object keys differently and escapes every path slash.
        // Use that same public serializer, one member at a time, before measurement.
        val baselineJson = org.robolectric.RobolectricTestRunner::class.java.classLoader.loadClass("org.json.JSONObject")
        check(baselineJson != JSONObject::class.java)
        val baselineObject = baselineJson.getConstructor(String::class.java)
        fun write(key: String, body: JSONObject) {
            if (key == "index/anchors-2044.json") {
                val anchor = body.getJSONArray("anchors").getJSONObject(0).toString()
                println("native_anchor_fixture_serializer=" + JSONObject()
                    .put("baseline_implementation", baselineJson.protectionDomain.codeSource.location.toString())
                    .put("android_implementation", JSONObject::class.java.protectionDomain.codeSource.location?.toString() ?: JSONObject.NULL)
                    .put("android_anchor", anchor).put("baseline_anchor", baselineObject.newInstance(anchor).toString()))
            }
            val bytes = baselineObject.newInstance(body.toString()).toString().toByteArray()
            val file = File(directory, key)
            check(file.parentFile.mkdirs() || file.parentFile.isDirectory)
            file.writeBytes(bytes)
            entries[key] = OfflineReadingManifestEntry(key, "application/json", bytes.size.toLong(), file.sha256Hex())
        }
        fun ref(key: String): JSONObject = entries.getValue(key).let {
            JSONObject().put("key", it.path).put("bytes", it.sizeBytes).put("sha256", it.sha256)
        }
        fun page(next: JSONObject?): JSONObject = JSONObject().put("units", JSONArray()).put("sections", JSONArray())
            .put("toc", JSONArray()).put("landmarks", JSONArray()).put("page_list", JSONArray())
            .put("table_metadata", JSONArray()).put("anchors", JSONArray()).put("next_ref", next ?: JSONObject.NULL)
        for (ordinal in 0 until 2045) {
            val nodes = JSONArray()
            for (index in 0 until 488) {
                val attributes = JSONArray()
                for ((name, prefix) in listOf("id" to "a", "name" to "b")) attributes.put(JSONObject()
                    .put("namespace", JSONObject.NULL).put("name", name).put("value", "${prefix}${ordinal}_$index".padEnd(44, 'x')))
                nodes.put(JSONObject().put("kind", "Element").put("parent", JSONObject.NULL)
                    .put("namespace", "html").put("name", "a").put("attributes", attributes))
            }
            write("units/$ordinal.json", JSONObject().put("fragment_id", "original-${ordinal / 100}").put("fragment_idx", ordinal / 100)
                .put("start_cp", 0).put("end_cp", 0).put("render_start_cp", 0).put("render_end_cp", 0)
                .put("fragment_document_start_cp", 0).put("fragment_length_cp", 0)
                .put("document_word_start", 0).put("starts_in_word", false).put("canonical_text", "")
                .put("word_boundaries", JSONArray().put(0)).put("render_nodes", nodes).put("assets", JSONArray())
                .put("document_embeds", JSONArray()).put("table_contexts", JSONArray())
                .put("epub_target", JSONObject().put("section_id", "chapter-${ordinal / 100}").put("href_path", "chapter-${ordinal / 100}.xhtml").put("anchor_id", JSONObject.NULL)))
        }
        // 48,800 owned elements per full fragment and 997,960 total leave
        // room for the original XHTML wrappers within the existing EPUB limits.
        val sections = JSONArray()
        for (fragment in 0..20) sections.put(JSONObject().put("section_id", "chapter-$fragment")
            .put("unit_key", "units/${fragment * 100}.json").put("label", "chapter").put("ordinal", fragment)
            .put("fragment_id", "original-$fragment").put("fragment_idx", fragment)
            .put("level", JSONObject.NULL).put("depth", JSONObject.NULL).put("start_offset", 0).put("end_offset", 0)
            .put("href_path", "chapter-$fragment.xhtml").put("href_fragment", JSONObject.NULL).put("anchor_id", JSONObject.NULL))
        write("index/contents.json", page(null).put("sections", sections))
        write("index/section.json", page(null).put("sections", sections))
        var next = ref("index/section.json")
        for (ordinal in 2044 downTo 0) {
            val anchors = JSONArray()
            for (index in 0 until 488) for (prefix in listOf("a", "b")) anchors.put(JSONObject()
                .put("href_path", "chapter-${ordinal / 100}.xhtml")
                .put("anchor_id", "${prefix}${ordinal}_$index".padEnd(44, 'x')).put("unit_key", "units/$ordinal.json").put("offset_cp", 0))
            val key = "index/anchors-$ordinal.json"
            write(key, page(next).put("anchors", anchors))
            next = ref(key)
        }
        for (number in 2 downTo 0) {
            val positions = JSONArray()
            for (ordinal in number * 682 until minOf((number + 1) * 682, 2045)) positions.put(JSONObject()
                .put("member", ref("units/$ordinal.json")).put("ordinal", ordinal).put("fragment_id", "original-${ordinal / 100}")
                .put("fragment_idx", ordinal / 100).put("start_cp", 0).put("end_cp", 0))
            val key = "index/positions-$number.json"
            write(key, page(next).put("units", positions))
            next = ref(key)
        }
        write("descriptor.json", JSONObject().put("reader_contract_version", 1).put("media_id", media.toString())
            .put("reader_generation", 7).put("kind", "epub").put("title", "Maximum metadata")
            .put("first_unit_ref", ref("units/0.json")).put("index_ref", next).put("contents_ref", ref("index/contents.json"))
            .put("table_metadata_ref", JSONObject.NULL).put("unit_count", 2045).put("canonical_length", 0))
        val sorted = entries.values.sortedBy { it.path }
        val revision = OfflineReadingRevision.compute(7, sorted)
        val manifest = JSONObject().put("packageSchemaVersion", 2).put("readerContractVersion", 1).put("minimumReaderBundleVersion", 2)
            .put("mediaId", media.toString()).put("mediaKind", "Epub").put("title", "Maximum metadata")
            .put("readerGeneration", 7).put("readerRevisionKey", revision)
            .put("entries", JSONArray(sorted.map { entry -> JSONObject().put("path", entry.path).put("mediaType", entry.mediaType)
                .put("sizeBytes", entry.sizeBytes).put("sha256", entry.sha256) }))
        val file = File(directory, "manifest.json").apply { writeText(baselineObject.newInstance(manifest.toString()).toString()) }
        return OfflineReadingPackage(UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
            UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), media, OfflineReadingMediaKind.Epub, "Maximum metadata",
            7, revision, 2, file.length() + sorted.sumOf { it.sizeBytes }, Instant.EPOCH, null)
    }
}
