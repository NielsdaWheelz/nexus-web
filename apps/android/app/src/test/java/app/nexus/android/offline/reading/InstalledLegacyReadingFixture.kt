package app.nexus.android.offline.reading

import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.robolectric.RuntimeEnvironment

/** Original installed bytes and SQLite rows, independent of the converter. */
internal class InstalledLegacyReadingFixture(val root: File, html: String = "<p>reader text</p>", canonical: String = "reader text") : AutoCloseable {
    val context = RuntimeEnvironment.getApplication()
    val databaseName = "legacy-activation-${UUID.randomUUID()}.db"
    val database = OfflineReadingDatabase(context, databaseName)
    val account = UUID.randomUUID()
    val binding = UUID.randomUUID()
    val packageId = UUID.randomUUID()
    val media = UUID.randomUUID()
    val seal = MemoryBindingSeal()
    val installedDirectory = File(root, "$binding/$packageId").apply { mkdirs() }
    val reader = JSONObject().put("readerContractVersion", 1).put("mediaId", media.toString())
        .put("mediaKind", "WebArticle").put("title", "Original copy")
        .put("navigation", JSONArray().put(JSONObject().put("fragmentId", "intro").put("label", "Original")))
        .put("fragments", JSONArray().put(JSONObject().put("fragmentId", "intro").put("ordinal", 0)
            .put("htmlSanitized", html).put("canonicalText", canonical)))
        .toString().toByteArray()
    val entry = OfflineReadingManifestEntry("reader.json", "application/json", reader.size.toLong(), sha256Hex(reader))
    val revision = OfflineReadingRevision.compute(7, listOf(entry))
    val locator = """{"kind":"web","target":{"fragment_id":"intro"},"locations":{"text_offset":7,"progression":null,"total_progression":null,"position":null},"text":{"quote":"text","quote_prefix":"reader ","quote_suffix":null}}"""

    init {
        File(installedDirectory, "reader.json").writeBytes(reader)
        val manifest = JSONObject().put("packageSchemaVersion", 1).put("readerContractVersion", 1)
            .put("minimumReaderBundleVersion", 1).put("mediaId", media.toString()).put("mediaKind", "WebArticle")
            .put("title", "Original copy").put("readerGeneration", 7).put("readerRevisionKey", revision)
            .put("entries", JSONArray().put(JSONObject().put("path", entry.path).put("mediaType", entry.mediaType)
                .put("sizeBytes", entry.sizeBytes).put("sha256", entry.sha256)))
        File(installedDirectory, "manifest.json").writeText(manifest.toString())
        val now = "2026-09-13T00:00:00Z"
        database.writableDatabase.transaction {
            execSQL("INSERT INTO offline_reader_binding VALUES(?, 1, ?, ?, ?, 1, ?)",
                arrayOf(UUID.randomUUID().toString(), binding.toString(), account.toString(), seal.create(binding, account), now))
            execSQL("INSERT INTO offline_reader_packages VALUES(?, ?, ?, 'WebArticle', 'Original copy', 7, ?, 1, 1, 1, ?, ?, NULL, NULL)",
                arrayOf(packageId.toString(), binding.toString(), media.toString(), revision, reader.size, now))
            execSQL("INSERT INTO offline_reader_progress_baselines VALUES(?, ?, ?, 7, ?, ?)",
                arrayOf(UUID.randomUUID().toString(), binding.toString(), media.toString(), """{"state":"Empty","revision":41}""", now))
            execSQL("INSERT INTO offline_reader_progress_pending VALUES(?, ?, ?, 7, ?, 41, ?, 'Pending', ?)",
                arrayOf(UUID.randomUUID().toString(), binding.toString(), media.toString(), revision, locator, now))
        }
    }

    override fun close() {
        database.close()
        context.deleteDatabase(databaseName)
    }
}
