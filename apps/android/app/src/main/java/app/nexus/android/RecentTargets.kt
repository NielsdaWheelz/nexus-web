package app.nexus.android

import androidx.core.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.UUID

/** One account's bounded recent history. DeviceSession serializes and admits every operation. */
internal class RecentTargets(directory: File) {
    private val file = AtomicFile(File(directory, "recent-targets.json"))
    private var failure: String? = null
    fun failed() { failure = "failed" }

    fun purge() {
        file.delete()
        if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists() || File(file.baseFile.path + ".new").exists())
            throw LocalStateError("E_LOCAL_CLEANUP", "recent history could not be removed")
        failure = null
    }

    private fun revision(value: String): Long {
        require(Regex("[1-9][0-9]*").matches(value))
        return value.toLong().also { require(it > 0) }
    }

    private fun key(target: JSONObject): String {
        require(target.opt("kind") is String)
        val kind = target.getString("kind")
        val field = when (kind) {
            "resource_ref" -> "ref"
            "contributor_handle" -> "handle"
            "daily_date" -> "local_date"
            "preview" -> "target"
            "x_capture" -> "capture_id"
            else -> throw IllegalArgumentException("invalid recent target")
        }
        require(target.keys().asSequence().toSet() == setOf("kind", field))
        require(target.opt(field) is String)
        val value = target.getString(field)
        require(value.isNotEmpty())
        if (kind == "x_capture") require(UUID.fromString(value).toString() == value)
        return "$kind:$value"
    }

    private fun value(row: JSONObject, entry: Boolean) {
        require(row.keys().asSequence().toSet() == if (entry) setOf("target", "href", "title_hint", "detail_hint", "used_revision") else setOf("target", "href", "title_hint", "detail_hint"))
        key(row.getJSONObject("target"))
        val target = row.getJSONObject("target")
        require(row.opt("href") is String)
        val href = row.getString("href")
        require(href.length <= 4096)
        val expected = when (target.getString("kind")) {
            "resource_ref" -> {
                val parts = target.getString("ref").split(":")
                require(parts.size == 2 && UUID.fromString(parts[1]).toString() == parts[1])
                val path = when (parts[0]) {
                    "media" -> "media"; "library" -> "libraries"; "conversation" -> "conversations"
                    "podcast" -> "podcasts"; "page" -> "pages"; "note_block" -> "notes"; "oracle_reading" -> "oracle"
                    else -> throw IllegalArgumentException("invalid recent resource")
                }
                val base = "/$path/${parts[1]}"
                if (parts[0] == "conversation" && href.startsWith("$base?leaf=")) {
                    val leaf = href.substringAfter("?leaf=")
                    require(leaf == "empty" || UUID.fromString(leaf).toString() == leaf)
                    "$base?leaf=$leaf"
                } else base
            }
            "contributor_handle" -> {
                val handle = target.getString("handle")
                require(handle.length in 3..80 && Regex("[a-z0-9]+(?:-[a-z0-9]+)*").matches(handle))
                "/authors/$handle"
            }
            "daily_date" -> {
                val date = target.getString("local_date")
                require(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(date))
                val parsed = try { java.time.LocalDate.parse(date) } catch (_: java.time.DateTimeException) { throw IllegalArgumentException("invalid recent date") }
                require(date.substring(0, 4).toInt() >= 100 && parsed.toString() == date)
                "/daily/$date"
            }
            "preview" -> {
                val preview = target.getString("target")
                require(Regex("ndt1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}").matches(preview))
                val parts = preview.split(".")
                val flags = android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP
                val payload = android.util.Base64.decode(parts[1], flags)
                val tag = android.util.Base64.decode(parts[2], flags)
                require(payload.isNotEmpty() && payload.size <= 4096 && tag.size == 32)
                require(android.util.Base64.encodeToString(payload, flags) == parts[1] && android.util.Base64.encodeToString(tag, flags) == parts[2])
                "/browse/preview?target=$preview"
            }
            "x_capture" -> "/x/captures/${target.getString("capture_id")}"
            else -> throw IllegalArgumentException("invalid recent target")
        }
        require(href == expected)
        for (field in listOf("title_hint", "detail_hint")) {
            require(row.has(field))
            if (!row.isNull(field)) {
                require(row.opt(field) is String)
                val hint = row.getString(field)
                val normalized = hint.replace(Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+"), " ").trim(' ')
                require(hint.isNotEmpty() && hint == normalized && hint.codePointCount(0, hint.length) <= 512)
            }
        }
        if (entry) { require(row.opt("used_revision") is String); revision(row.getString("used_revision")) }
    }

    private fun read(account: UUID): JSONObject {
        val bytes = file.readFully()
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        val parser = JSONTokener(text)
        val snapshot = parser.nextValue() as? JSONObject ?: throw IllegalArgumentException("invalid recent snapshot")
        require(parser.nextClean() == '\u0000')
        require(snapshot.keys().asSequence().toSet() == setOf("format_version", "account_id", "epoch", "revision", "entries"))
        require(snapshot.opt("format_version") == 1 && snapshot.opt("account_id") is String && snapshot.getString("account_id") == account.toString())
        require(snapshot.opt("epoch") is String && snapshot.opt("revision") is String)
        val epoch = snapshot.getString("epoch")
        require(UUID.fromString(epoch).toString() == epoch)
        val current = revision(snapshot.getString("revision"))
        val entries = snapshot.getJSONArray("entries")
        require(entries.length() <= 100)
        var previous = current
        val keys = HashSet<String>()
        for (i in 0 until entries.length()) {
            val entry = entries.getJSONObject(i)
            value(entry, true)
            val used = revision(entry.getString("used_revision"))
            require(used >= 2 && used <= previous && (i == 0 || used < previous))
            previous = used
            require(keys.add(key(entry.getJSONObject("target"))))
        }
        return snapshot
    }

    private fun write(snapshot: JSONObject) {
        val bytes = snapshot.toString().toByteArray(Charsets.UTF_8)
        var stream: java.io.FileOutputStream? = null
        var publishing = false
        try {
            stream = file.startWrite()
            stream.write(bytes); stream.fd.sync(); publishing = true; file.finishWrite(stream)
            stream = null
            if (!file.readFully().contentEquals(bytes)) throw IOException("recent write not confirmed")
        } catch (error: IOException) {
            stream?.let(file::failWrite)
            failure = if (publishing) "unconfirmed" else "failed"
            throw error
        }
    }

    fun operation(account: UUID, op: String, epoch: String?, input: JSONObject?): JSONObject {
        val snapshot = try { read(account) } catch (error: FileNotFoundException) {
            if (op != "open" || file.baseFile.exists()) throw error
            JSONObject().put("format_version", 1).put("account_id", account.toString())
                .put("epoch", UUID.randomUUID().toString()).put("revision", "1").put("entries", JSONArray())
                .also {
                    val previous = failure
                    try { write(it) } catch (error: IOException) { failure = previous; throw error }
                }
        }
        if (op != "open") require(snapshot.getString("epoch") == epoch)
        if (op == "use" || op == "reconcile") {
            val entries = snapshot.getJSONArray("entries")
            val list = (0 until entries.length()).map(entries::getJSONObject).toMutableList()
            val command = requireNotNull(input)
            if (op == "reconcile") {
                require(command.keys().asSequence().toSet() == setOf("target", "expected_used_revision", "replacement"))
                require(command.opt("expected_used_revision") is String)
                revision(command.getString("expected_used_revision"))
                require(command.isNull("replacement") || command.opt("replacement") is JSONObject)
            }
            val target = command.getJSONObject("target")
            val index = list.indexOfFirst { key(it.getJSONObject("target")) == key(target) }
            var changed = false
            if (op == "use") {
                value(command, false)
                if (index >= 0) list.removeAt(index)
                val next = Math.addExact(revision(snapshot.getString("revision")), 1).toString()
                list.add(0, JSONObject(command.toString()).put("used_revision", next))
                if (list.size > 100) list.removeAt(list.lastIndex)
                changed = true
            } else if (index >= 0 && list[index].getString("used_revision") == command.getString("expected_used_revision")) {
                val source = list.removeAt(index)
                if (!command.isNull("replacement")) {
                    val replacement = command.getJSONObject("replacement")
                    value(replacement, false)
                    val other = list.indexOfFirst { key(it.getJSONObject("target")) == key(replacement.getJSONObject("target")) }
                    val existing = if (other >= 0) list.removeAt(other) else null
                    val winner = if (existing != null && revision(existing.getString("used_revision")) > revision(source.getString("used_revision"))) existing else {
                        JSONObject(replacement.toString()).put("used_revision", source.getString("used_revision")).also { next ->
                            if (existing != null) for (field in listOf("title_hint", "detail_hint")) {
                                if (!existing.isNull(field)) next.put(field, existing.getString(field))
                            }
                        }
                    }
                    list.add(winner)
                    list.sortByDescending { revision(it.getString("used_revision")) }
                }
                changed = JSONArray(list).toString() != entries.toString()
            }
            if (changed) {
                snapshot.put("revision", Math.addExact(revision(snapshot.getString("revision")), 1).toString()).put("entries", JSONArray(list))
                try { write(snapshot); if (op == "use") failure = null }
                catch (_: IOException) {
                    val committed = try { read(account) } catch (_: Exception) { throw LocalStateError("E_RECENT_IO", "recent could not be read") }
                    return observation(committed)
                }
            }
        }
        return observation(snapshot)
    }
    private fun observation(snapshot: JSONObject) = JSONObject().put("snapshot", snapshot).put("write_failure", failure ?: JSONObject.NULL)
}
