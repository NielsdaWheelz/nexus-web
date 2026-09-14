package app.nexus.android.offline.reading

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.io.Closeable
import java.io.File

/** Immutable source rectangles; resolved spans include implied rows. */
internal data class OfflineReadingTableRectangle(
    val table: Long,
    val row: Long,
    val column: Long,
    val rowSpan: Long,
    val columnSpan: Long,
) {
    val rowEnd = Math.addExact(row, rowSpan)
    val columnEnd = Math.addExact(column, columnSpan)

    init {
        require(table >= 0 && row >= 0 && column >= 0)
        require(rowSpan > 0 && columnSpan in 1..1000)
    }
}

/**
 * Qualification candidate, not yet activated by package installation.
 * The package staging owner supplies immutable verified rectangles, its exact
 * revision and a measured cache budget. It owns the file and accounts its bytes.
 */
internal fun stageOfflineReadingTableGeometry(
    file: File,
    revision: String,
    cacheKiB: Int,
    rectangles: Sequence<OfflineReadingTableRectangle>,
) {
    require(file.parentFile?.isDirectory == true && !file.exists())
    require(revision.matches(Regex("[0-9a-f]{64}")) && cacheKiB > 0)
    SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
        db.execSQL("PRAGMA cache_size = -$cacheKiB")
        db.rawQuery("PRAGMA mmap_size = 0", null).use { it.moveToFirst() }
        db.execSQL("PRAGMA temp_store = FILE")
        db.rawQuery("PRAGMA journal_mode = DELETE", null).use { it.moveToFirst() }
        db.execSQL("PRAGMA synchronous = FULL")
        db.beginTransaction()
        try {
            db.execSQL("CREATE TABLE identity (revision TEXT NOT NULL)")
            db.execSQL("INSERT INTO identity VALUES (?)", arrayOf(revision))
            db.execSQL("""CREATE TABLE cells (
                table_id INTEGER NOT NULL, row_start INTEGER NOT NULL,
                column_start INTEGER NOT NULL, row_end INTEGER NOT NULL,
                column_end INTEGER NOT NULL,
                PRIMARY KEY (table_id, row_start, column_start)
            ) WITHOUT ROWID""")
            db.compileStatement("INSERT INTO cells VALUES (?, ?, ?, ?, ?)").use { insert ->
                for (cell in rectangles) {
                    insert.bindLong(1, cell.table)
                    insert.bindLong(2, cell.row)
                    insert.bindLong(3, cell.column)
                    insert.bindLong(4, cell.rowEnd)
                    insert.bindLong(5, cell.columnEnd)
                    insert.executeInsert()
                }
            }
            db.execSQL("CREATE INDEX cells_columns ON cells (table_id, column_start, row_start)")
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }
    file.inputStream().use { it.fd.sync() }
}

/** One opened package owns this readonly connection and every returned cursor. */
internal class OfflineReadingTableGeometry(file: File, revision: String, cacheKiB: Int) : Closeable {
    private val db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY)

    init {
        try {
            require(cacheKiB > 0)
            db.execSQL("PRAGMA cache_size = -$cacheKiB")
            db.rawQuery("PRAGMA mmap_size = 0", null).use { it.moveToFirst() }
            db.execSQL("PRAGMA temp_store = FILE")
            db.rawQuery("SELECT revision FROM identity", null).use { row ->
                require(row.moveToFirst() && row.getString(0) == revision && !row.moveToNext())
            }
        } catch (error: Throwable) {
            db.close()
            throw error
        }
    }

    // Every cursor is one bounded page: Android otherwise counts the entire
    // result and restarts the query when its CursorWindow fills.
    fun intersecting(
        table: Long,
        row: Long,
        rowEnd: Long,
        column: Long,
        columnEnd: Long,
        after: Pair<Long, Long>?,
        maxRows: Int,
    ): Cursor {
        require(table >= 0 && row >= 0 && rowEnd > row && column >= 0 && columnEnd > column)
        require(maxRows > 0)
        val continuation = if (after == null) "" else " AND (row_start, column_start) > (?, ?)"
        val arguments = mutableListOf(table.toString(), rowEnd.toString(), row.toString(),
            columnEnd.toString(), column.toString())
        if (after != null) {
            require(after.first >= 0 && after.second >= 0)
            arguments.add(after.first.toString())
            arguments.add(after.second.toString())
        }
        arguments.add(maxRows.toString())
        return db.rawQuery(
            """SELECT row_start, column_start, row_end, column_end FROM cells
               WHERE table_id = ? AND row_start < ? AND row_end > ?
                 AND column_start < ? AND column_end > ?$continuation
               ORDER BY row_start, column_start LIMIT ?""",
            arguments.toTypedArray(),
        )
    }

    override fun close() = db.close()
}
