package app.nexus.android.offline.reading

import android.database.sqlite.SQLiteDatabase
import java.io.Closeable
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.text.CharacterIterator

/** Stage fixed-width text for ICU without copying a complete source into heap. */
internal fun stageLegacyReaderText(staging: File, fragment: Long, durability: OfflineReadingDurability): File {
    val target = File(staging, "$fragment.utf16")
    SQLiteDatabase.openOrCreateDatabase(File(staging, "source.sqlite"), null).use { database ->
        database.execSQL("CREATE TABLE IF NOT EXISTS text_complete (fragment_ordinal INTEGER PRIMARY KEY, source_sha256 TEXT NOT NULL)")
        val (path, digest) = database.rawQuery("SELECT canonical_path, canonical_sha256 FROM fragments WHERE ordinal = ?", arrayOf(fragment.toString())).use {
            require(it.moveToFirst())
            it.getString(0) to it.getString(1)
        }
        database.rawQuery("SELECT source_sha256 FROM text_complete WHERE fragment_ordinal = ?", arrayOf(fragment.toString())).use {
            if (it.moveToFirst()) {
                require(it.getString(0) == digest)
                return target
            }
        }
        File(staging, path).bufferedReader().use { input ->
            target.bufferedWriter(Charsets.UTF_16BE).use { output -> input.copyTo(output) }
        }
        target.inputStream().use { it.fd.sync() }
        durability.syncDirectory(staging)
        database.execSQL("INSERT INTO text_complete VALUES(?, ?)", arrayOf(fragment, digest))
    }
    return target
}

/** ICU's random-access source, with one bounded page shared by its cursors. */
internal class LegacyReaderText(file: File) : Closeable {
    val length = file.length().also {
        require(it % 2 == 0L && it <= OFFLINE_READING_MAX_READER_JSON_BYTES * 2)
    }.div(2).toInt()
    private val channel = FileChannel.open(file.toPath(), StandardOpenOption.READ)
    private val page = ByteBuffer.allocate(DEFAULT_BUFFER_SIZE)
    private var pageStart = -1

    fun characterAt(index: Int): Char {
        require(index in 0 until length)
        if (pageStart < 0 || index < pageStart || index >= pageStart + page.limit() / 2) {
            pageStart = index / (page.capacity() / 2) * (page.capacity() / 2)
            page.clear()
            page.limit(minOf(page.capacity(), (length - pageStart) * 2))
            while (page.hasRemaining()) {
                check(channel.read(page, pageStart.toLong() * 2 + page.position()) > 0)
            }
            page.flip()
        }
        return page.getChar((index - pageStart) * 2)
    }

    fun iterator(): CharacterIterator = Cursor(0)

    private inner class Cursor(private var position: Int) : CharacterIterator {
        override fun first(): Char = setIndex(0)
        override fun last(): Char = setIndex(if (length == 0) 0 else length - 1)
        override fun current(): Char = if (position == length) CharacterIterator.DONE else characterAt(position)
        override fun next(): Char = setIndex(minOf(position + 1, length))
        override fun previous(): Char {
            if (position == 0) return CharacterIterator.DONE
            return setIndex(position - 1)
        }
        override fun setIndex(value: Int): Char {
            require(value in 0..length)
            position = value
            return current()
        }
        override fun getBeginIndex(): Int = 0
        override fun getEndIndex(): Int = length
        override fun getIndex(): Int = position
        public override fun clone(): Any = Cursor(position)
    }

    override fun close() = channel.close()
}
