package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import com.squareup.moshi.JsonReader
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import okio.buffer
import okio.source

/** The conversion's private staging index; never an installed/current publication. */
internal fun stageLegacyReaderSource(
    directory: File,
    manifest: OfflineReadingManifest,
    staging: File,
    durability: OfflineReadingDurability,
) {
    require(manifest.packageSchemaVersion == 1)
    require(staging.isDirectory)
    val source = File(directory, "reader.json")
    require(source.length() <= OFFLINE_READING_MAX_READER_JSON_BYTES)
    SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
        database.execSQL("CREATE TABLE IF NOT EXISTS complete (source_sha256 TEXT NOT NULL)")
        val sourceDigest = manifest.entries.single { it.path == "reader.json" }.sha256
        database.rawQuery("SELECT source_sha256 FROM complete", null).use {
            if (it.moveToFirst()) {
                require(it.getString(0) == sourceDigest)
                return
            }
        }
        // Interrupted source staging is replayed. Later unit conversion resumes by fragment.
        database.execSQL("DROP TABLE IF EXISTS fragments")
        database.execSQL("DROP TABLE IF EXISTS sections")
        database.execSQL("DROP TABLE IF EXISTS navigation")
        database.execSQL("DROP TABLE IF EXISTS document")
        database.execSQL("CREATE TABLE fragments (fragment_id TEXT PRIMARY KEY, fragment_idx INTEGER NOT NULL UNIQUE, ordinal INTEGER NOT NULL UNIQUE, html_path TEXT NOT NULL, canonical_path TEXT NOT NULL, canonical_length INTEGER NOT NULL, html_sha256 TEXT NOT NULL, canonical_sha256 TEXT NOT NULL)")
        database.execSQL("CREATE TABLE sections (section_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, fragment_id TEXT NOT NULL, href_path TEXT NOT NULL, anchor_id TEXT, start_cp INTEGER NOT NULL, end_cp INTEGER NOT NULL)")
        database.execSQL("CREATE TABLE navigation (ordinal INTEGER PRIMARY KEY, target_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL)")
        database.execSQL("CREATE TABLE document (document_path TEXT NOT NULL)")
        var fragments = 0L
        val common = setOf("readerContractVersion", "mediaId", "mediaKind", "title")
        val expected = common + when (manifest.mediaKind) {
            OfflineReadingMediaKind.Pdf -> setOf("documentPath")
            OfflineReadingMediaKind.Epub -> setOf("navigation", "sections")
            OfflineReadingMediaKind.WebArticle -> setOf("navigation", "fragments")
        }
        val fields = mutableSetOf<String>()
        JsonReader.of(source.source().buffer()).use { reader ->
            reader.beginObject()
            while (reader.hasNext()) {
                val name = reader.nextName()
                require(name in expected && fields.add(name))
                when (name) {
                    "readerContractVersion" -> require(reader.nextLong() == 1L)
                    "mediaId" -> require(reader.nextString() == manifest.mediaId.toString())
                    "mediaKind" -> require(reader.nextString() == manifest.mediaKind.name)
                    "title" -> require(reader.nextString() == manifest.title)
                    "documentPath" -> {
                        val path = reader.nextString()
                        require(manifest.entries.any { it.path == path && it.mediaType == "application/pdf" })
                        database.execSQL("INSERT INTO document VALUES(?)", arrayOf(path))
                    }
                    "navigation" -> {
                        var ordinal = 0L
                        val target = if (manifest.mediaKind == OfflineReadingMediaKind.Epub) "sectionId" else "fragmentId"
                        reader.beginArray()
                        while (reader.hasNext()) {
                            val values = mutableMapOf<String, String>()
                            reader.beginObject()
                            while (reader.hasNext()) {
                                val key = reader.nextName()
                                require(key in setOf(target, "label") && key !in values)
                                values[key] = reader.nextString()
                            }
                            reader.endObject()
                            require(values.keys == setOf(target, "label"))
                            database.execSQL("INSERT INTO navigation VALUES(?, ?, ?)",
                                arrayOf(ordinal++, values.getValue(target), values.getValue("label")))
                        }
                        reader.endArray()
                    }
                    "fragments", "sections" -> {
                        val epub = name == "sections"
                        val keys = if (epub) setOf("sectionId", "ordinal", "fragmentId", "fragmentIdx", "hrefPath", "anchorId", "startOffset", "endOffset", "htmlSanitized", "canonicalText", "assetPaths")
                            else setOf("fragmentId", "ordinal", "htmlSanitized", "canonicalText")
                        var ordinal = 0L
                        reader.beginArray()
                        while (reader.hasNext()) {
                            val values = mutableMapOf<String, Any?>()
                            val html = File(staging, "next.html")
                            val text = File(staging, "next.txt")
                            var codePoints = 0L
                            reader.beginObject()
                            while (reader.hasNext()) {
                                val key = reader.nextName()
                                require(key in keys && key !in values)
                                values[key] = when (key) {
                                    "htmlSanitized" -> spoolLegacyReaderString(reader, html)
                                    "canonicalText" -> spoolLegacyReaderString(reader, text).also { codePoints = it }
                                    "ordinal", "fragmentIdx", "startOffset", "endOffset" -> reader.nextLong()
                                    "anchorId" -> if (reader.peek() == JsonReader.Token.NULL) reader.nextNull<String>() else reader.nextString()
                                    "assetPaths" -> {
                                        reader.beginArray()
                                        while (reader.hasNext()) {
                                            val path = reader.nextString()
                                            require(manifest.entries.any { it.path == path && it.path.startsWith("assets/") })
                                        }
                                        reader.endArray()
                                        Unit
                                    }
                                    else -> reader.nextString()
                                }
                            }
                            reader.endObject()
                            require(values.keys == keys && values["ordinal"] == ordinal)
                            val fragment = values.getValue("fragmentId") as String
                            val index = if (epub) values.getValue("fragmentIdx") as Long else ordinal
                            require(index >= 0)
                            val htmlDigest = html.sha256Hex()
                            val textDigest = text.sha256Hex()
                            val present = database.rawQuery("SELECT fragment_idx, html_sha256, canonical_sha256 FROM fragments WHERE fragment_id = ?", arrayOf(fragment)).use {
                                if (!it.moveToFirst()) false else {
                                    require(it.getLong(0) == index && it.getString(1) == htmlDigest && it.getString(2) == textDigest)
                                    true
                                }
                            }
                            require(epub || !present)
                            if (!present) {
                                val htmlPath = "$fragments.html"
                                val textPath = "$fragments.txt"
                                Files.move(html.toPath(), File(staging, htmlPath).toPath(), StandardCopyOption.REPLACE_EXISTING)
                                Files.move(text.toPath(), File(staging, textPath).toPath(), StandardCopyOption.REPLACE_EXISTING)
                                database.execSQL("INSERT INTO fragments VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                                    arrayOf(fragment, index, fragments++, htmlPath, textPath, codePoints, htmlDigest, textDigest))
                            }
                            if (epub) {
                                val start = values.getValue("startOffset") as Long
                                val end = values.getValue("endOffset") as Long
                                require(start in 0..end && end <= codePoints)
                                database.execSQL("INSERT INTO sections VALUES(?, ?, ?, ?, ?, ?, ?)", arrayOf(
                                    values.getValue("sectionId"), ordinal, fragment, values.getValue("hrefPath"), values["anchorId"], start, end))
                            }
                            ordinal += 1
                        }
                        reader.endArray()
                        require(ordinal > 0)
                    }
                }
            }
            reader.endObject()
            require(fields == expected && reader.peek() == JsonReader.Token.END_DOCUMENT)
        }
        File(staging, "next.html").delete()
        File(staging, "next.txt").delete()
        if (manifest.mediaKind != OfflineReadingMediaKind.Pdf) {
            val table = if (manifest.mediaKind == OfflineReadingMediaKind.Epub) "sections" else "fragments"
            val key = if (manifest.mediaKind == OfflineReadingMediaKind.Epub) "section_id" else "fragment_id"
            database.rawQuery("SELECT 1 FROM navigation LEFT JOIN $table ON $table.$key = navigation.target_id WHERE $table.$key IS NULL LIMIT 1", null).use {
                require(!it.moveToFirst())
            }
        }
        durability.syncTree(staging)
        database.execSQL("INSERT INTO complete VALUES(?)", arrayOf(sourceDigest))
    }
}
