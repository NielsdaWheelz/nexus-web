package app.nexus.android.offline.reading

import android.database.Cursor
import android.database.MatrixCursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import java.io.Closeable
import java.io.File
import java.io.IOException

/** Qualification input from immutable source metadata, not a frozen package wire. */
internal data class OfflineReadingTableHeaderCell(
    val rectangle: OfflineReadingTableRectangle,
    val kind: String,
    val empty: Boolean,
    val rowGroup: Long?,
    val explicitTargets: Sequence<Pair<Long, Long>>?,
) {
    init { require(kind in setOf("data", "none", "row", "column", "rowgroup", "colgroup")) }
}

internal data class OfflineReadingTableColumnGroup(val table: Long, val start: Long, val end: Long)
internal data class OfflineReadingTableHeaderPageKey(val phase: Long, val outer: Long, val innerOrder: Long, val id: Long)

/** Source-ordered geometry used by the independent association qualification. */
internal fun stageOfflineReadingTableHeaderIndex(
    file: File,
    revision: String,
    cacheKiB: Int,
    cells: Sequence<OfflineReadingTableHeaderCell>,
    columnGroups: Sequence<OfflineReadingTableColumnGroup>,
) {
    writeTableIndex(file, revision, cacheKiB) { db ->
        db.compileStatement("INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").use { insert ->
            db.compileStatement("INSERT INTO explicit_headers VALUES (?, ?, ?, ?)").use { target ->
                var id = 0L
                for (cell in cells) {
                    id = Math.addExact(id, 1L)
                    val r = cell.rectangle
                    insert.bindLong(1, id)
                    insert.bindLong(2, r.table)
                    insert.bindLong(3, r.row)
                    insert.bindLong(4, r.column)
                    insert.bindLong(5, r.rowEnd)
                    insert.bindLong(6, r.columnEnd)
                    insert.bindString(7, cell.kind)
                    insert.bindLong(8, if (cell.empty) 1 else 0)
                    if (cell.rowGroup == null) insert.bindNull(9) else insert.bindLong(9, cell.rowGroup)
                    insert.bindLong(10, if (cell.explicitTargets == null) 0 else 1)
                    insert.executeInsert()
                    var ordinal = 0L
                    cell.explicitTargets?.forEach { (row, column) ->
                        require(row >= 0 && column >= 0)
                        target.bindLong(1, id)
                        target.bindLong(2, ordinal++)
                        target.bindLong(3, row)
                        target.bindLong(4, column)
                        target.executeInsert()
                    }
                }
            }
        }
        for (group in columnGroups) {
            require(group.table >= 0 && group.start >= 0 && group.end > group.start)
            db.execSQL("INSERT INTO column_groups VALUES (?, ?, ?)",
                arrayOf(group.table, group.start, group.end))
        }
    }
}

private data class HeaderCell(
    val id: Long, val row: Long, val column: Long, val rowEnd: Long, val columnEnd: Long,
    val kind: String, val empty: Boolean, val rowGroup: Long?, val explicit: Boolean,
)

private fun Cursor.headerCell() = HeaderCell(getLong(0), getLong(1), getLong(2), getLong(3),
    getLong(4), getString(5), getInt(6) != 0, if (isNull(7)) null else getLong(7), getInt(8) != 0)

private data class HeaderGroups(val table: Long, val principal: HeaderCell, val columnGroup: Pair<Long, Long>?)

private data class TableCoverageNode(
    val id: Long, val low: Long, val high: Long, val split: Long?,
    val minimum: Long, val maximum: Long, val delta: Long, val xor: Long,
    val uniformXor: Long?, val changed: Long, val full: Long,
)

/** Borrowed scalar cursors; the reduction's existing use scopes own both. */
private class TableHeaderState(
    private val db: SQLiteDatabase,
    private val before: SQLiteCursor,
    private val after: SQLiteCursor,
) {
    private data class Interval(val low: Long, val high: Long, val value: Long)

    private fun read(cursor: SQLiteCursor, groupLow: Long, groupHigh: Long, point: Long): Interval? {
        cursor.setSelectionArguments(arrayOf("$groupLow", "$groupHigh", "$point"))
        check(cursor.requery()) { "Table header state cursor could not be requeried" }
        if (!cursor.moveToFirst()) return null
        // No cursor or borrowed row survives a mutation or the next binding.
        return Interval(cursor.getLong(0), cursor.getLong(1), cursor.getLong(2))
    }

    // Negative keys are query-local partitions: (-1,-1) holds the latest
    // data coordinate; (-2,-2) the last unique cell id. Nonnegative keys
    // hold the first header coordinate for that exact source anchor/span.
    fun piece(groupLow: Long, groupHigh: Long, point: Long, end: Long): Pair<Long, Long?> {
        val previous = read(before, groupLow, groupHigh, point)
        if (previous != null && previous.high > point) return minOf(end, previous.high) to previous.value
        val next = read(after, groupLow, groupHigh, point)
        return (next?.low?.let { minOf(end, it) } ?: end) to null
    }

    fun assign(groupLow: Long, groupHigh: Long, low: Long, high: Long, value: Long) {
        for (boundary in longArrayOf(low, high)) {
            // Coordinates are nonnegative integers: <= boundary-1 is exactly
            // the old strict predecessor predicate, including boundary zero.
            val previous = read(before, groupLow, groupHigh, boundary - 1)
            if (previous != null && previous.high > boundary) {
                db.execSQL("UPDATE state SET high=? WHERE group_low=? AND group_high=? AND low=?",
                    arrayOf(boundary, groupLow, groupHigh, previous.low))
                db.execSQL("INSERT INTO state VALUES (?, ?, ?, ?, ?)",
                    arrayOf(groupLow, groupHigh, boundary, previous.high, previous.value))
            }
        }
        db.execSQL("DELETE FROM state WHERE group_low=? AND group_high=? AND low>=? AND low<?", arrayOf(groupLow, groupHigh, low, high))
        var start = low
        var end = high
        val previous = read(before, groupLow, groupHigh, low - 1)
        if (previous != null && previous.high == low && previous.value == value) {
            start = previous.low
            db.execSQL("DELETE FROM state WHERE group_low=? AND group_high=? AND low=?", arrayOf(groupLow, groupHigh, start))
        }
        val next = read(after, groupLow, groupHigh, high)
        if (next != null && next.low == high && next.value == value) {
            end = next.high
            db.execSQL("DELETE FROM state WHERE group_low=? AND group_high=? AND low=?", arrayOf(groupLow, groupHigh, high))
        }
        db.execSQL("INSERT INTO state VALUES (?, ?, ?, ?, ?)", arrayOf(groupLow, groupHigh, start, end, value))
    }
}

private const val CELL_COLUMNS = "id, row_start, column_start, row_end, column_end, kind, empty, row_group, explicit_headers"

/**
 * One synchronous selected-cell reduction. The caller holds its package read
 * lease until this physically finishes, and closes the result before releasing
 * that lease. Scratch, its source-sized interval state and result bytes belong
 * to that query. This candidate is not wired into package activation or serving.
 */
internal class OfflineReadingTableHeaders(
    indexFile: File,
    revision: String,
    scratchFile: File,
    cacheKiB: Int,
    private val pageRows: Int,
    table: Long,
    row: Long,
    column: Long,
) : Closeable {
    private val file = scratchFile
    private val db: SQLiteDatabase
    private var source: SQLiteDatabase? = null
    private var groups: HeaderGroups? = null
    var groupRowsRead = 0L
        private set
    var sourceCellsRead = 0L
        private set
    var coverageNodesBuilt = 0L
        private set
    var coverageNodesRead = 0L
        private set
    var coverageNodesWritten = 0L
        private set
    var coverageNodesVisited = 0L
        private set
    var coverageReadNanos = 0L
        private set
    var coverageWriteNanos = 0L
        private set
    var coverageBuildNanos = 0L
        private set
    var uniqueReductionNanos = 0L
        private set
    var uniqueSpans = 0L
        private set
    var processedCellSpans = 0L
        private set
    var bands = 0L
        private set
    var maxCompletedAxisStateRows = 0L
        private set

    init {
        require(pageRows > 0 && file.parentFile?.isDirectory == true && !file.exists())
        db = SQLiteDatabase.openOrCreateDatabase(file, null)
        try {
            configureTableQuery(db, cacheKiB)
            db.execSQL("CREATE TABLE identity (revision TEXT NOT NULL)")
            db.execSQL("INSERT INTO identity VALUES (?)", arrayOf(revision))
            db.execSQL("""CREATE TABLE selected (
                id INTEGER PRIMARY KEY, row_start INTEGER NOT NULL, column_start INTEGER NOT NULL,
                row_end INTEGER NOT NULL, column_end INTEGER NOT NULL, kind TEXT NOT NULL,
                empty INTEGER NOT NULL, row_group INTEGER, explicit_headers INTEGER NOT NULL)""")
            db.execSQL("""CREATE TABLE events (
                axis INTEGER NOT NULL, at INTEGER NOT NULL, delta INTEGER NOT NULL,
                id INTEGER NOT NULL, low INTEGER NOT NULL, high INTEGER NOT NULL,
                PRIMARY KEY(axis, at, delta, id)) WITHOUT ROWID""")
            db.execSQL("""CREATE TABLE coverage_endpoints (
                axis INTEGER NOT NULL, point INTEGER NOT NULL,
                PRIMARY KEY(axis, point)) WITHOUT ROWID""")
            db.execSQL("CREATE TABLE coverage_positions (position INTEGER PRIMARY KEY, point INTEGER NOT NULL)")
            db.execSQL("""CREATE TABLE coverage (
                id INTEGER PRIMARY KEY, low INTEGER NOT NULL, high INTEGER NOT NULL, split INTEGER,
                minimum INTEGER NOT NULL, maximum INTEGER NOT NULL, delta INTEGER NOT NULL,
                xor_value INTEGER NOT NULL, uniform_xor INTEGER, changed INTEGER NOT NULL, full INTEGER NOT NULL)""")
            db.execSQL("""CREATE TABLE state (
                group_low INTEGER NOT NULL, group_high INTEGER NOT NULL,
                low INTEGER NOT NULL, high INTEGER NOT NULL, value INTEGER NOT NULL,
                PRIMARY KEY(group_low, group_high, low)) WITHOUT ROWID""")
            db.execSQL("""CREATE TABLE result (
                id INTEGER PRIMARY KEY, phase INTEGER NOT NULL,
                outer_position INTEGER NOT NULL, inner_order INTEGER NOT NULL)""")
            db.execSQL("CREATE INDEX result_order ON result(phase, outer_position, inner_order, id)")
            val source = SQLiteDatabase.openDatabase(indexFile.path, null, SQLiteDatabase.OPEN_READONLY)
            this.source = source
            source.execSQL("PRAGMA cache_size = -$cacheKiB")
            source.rawQuery("PRAGMA mmap_size = 0", null).use { it.moveToFirst() }
            source.rawQuery("SELECT revision FROM identity", null).use {
                require(it.moveToFirst() && it.getString(0) == revision && !it.moveToNext())
            }
            val principal = source.rawQuery("SELECT $CELL_COLUMNS FROM cells WHERE table_id=? AND row_start=? AND column_start=?",
                arrayOf("$table", "$row", "$column")).use { require(it.moveToFirst()); it.headerCell() }
            db.beginTransaction()
            try {
                if (principal.explicit) {
                    var after = -1L
                    do {
                        var count = 0
                        source.rawQuery("""SELECT h.ordinal, c.$CELL_COLUMNS FROM explicit_headers h
                            JOIN cells c ON c.table_id=? AND c.row_start=h.row_start AND c.column_start=h.column_start
                            WHERE h.principal=? AND h.ordinal>? ORDER BY h.ordinal LIMIT ?""".replace("c.$CELL_COLUMNS",
                                CELL_COLUMNS.split(", ").joinToString(", ") { "c.$it" }),
                            arrayOf("$table", "${principal.id}", "$after", "$pageRows")).use { targets ->
                            while (targets.moveToNext()) {
                                after = targets.getLong(0)
                                val cell = HeaderCell(targets.getLong(1), targets.getLong(2), targets.getLong(3),
                                    targets.getLong(4), targets.getLong(5), targets.getString(6), targets.getInt(7) != 0,
                                    if (targets.isNull(8)) null else targets.getLong(8), targets.getInt(9) != 0)
                                retain(cell)
                                if (!cell.empty && cell.id != principal.id) result(cell.id, 0, after, 0)
                                count++
                            }
                        }
                    } while (count == pageRows)
                } else {
                    val columnGroup = source.rawQuery("SELECT start, end FROM column_groups WHERE table_id=? AND start<=? ORDER BY start DESC LIMIT 1",
                        arrayOf("$table", "$column")).use {
                        if (it.moveToFirst() && column < it.getLong(1)) it.getLong(0) to it.getLong(1) else null
                    }
                    groups = HeaderGroups(table, principal, columnGroup)
                    val horizontal = "column_start < ${principal.column} AND row_start < ${principal.rowEnd} AND row_end > ${principal.row}"
                    val vertical = "row_start < ${principal.row} AND column_start < ${principal.columnEnd} AND column_end > ${principal.column}"
                    val hasRows = source.rawQuery("SELECT 1 FROM cells WHERE table_id=? AND kind='row' AND empty=0 AND id<>? AND $horizontal LIMIT 1",
                        arrayOf("$table", "${principal.id}")).use { it.moveToFirst() }
                    val hasColumns = source.rawQuery("SELECT 1 FROM cells WHERE table_id=? AND kind='column' AND empty=0 AND id<>? AND $vertical LIMIT 1",
                        arrayOf("$table", "${principal.id}")).use { it.moveToFirst() }
                    if (hasRows || hasColumns) {
                        val intersects = listOfNotNull(if (hasRows) "($horizontal)" else null,
                            if (hasColumns) "($vertical)" else null).joinToString(" OR ")
                        var after = 0L
                        do {
                            var count = 0
                            source.rawQuery("SELECT $CELL_COLUMNS FROM cells WHERE table_id=? AND id>? AND ($intersects) ORDER BY id LIMIT ?",
                                arrayOf("$table", "$after", "$pageRows")).use { cells ->
                                while (cells.moveToNext()) {
                                    val cell = cells.headerCell()
                                    after = cell.id
                                    sourceCellsRead++
                                    retain(cell)
                                    if (hasRows && cell.column < principal.column && cell.row < principal.rowEnd && cell.rowEnd > principal.row) event(0, cell, principal)
                                    if (hasColumns && cell.row < principal.row && cell.column < principal.columnEnd && cell.columnEnd > principal.column) event(1, cell, principal)
                                    count++
                                }
                            }
                        } while (count == pageRows)
                        (db.rawQuery("SELECT low,high,value FROM state WHERE group_low=? AND group_high=? AND low<=? ORDER BY low DESC LIMIT 1",
                            arrayOf("0", "0", "0")) as SQLiteCursor).use { before ->
                            (db.rawQuery("SELECT low,high,value FROM state WHERE group_low=? AND group_high=? AND low>=? ORDER BY low LIMIT 1",
                                arrayOf("0", "0", "0")) as SQLiteCursor).use { after ->
                                val state = TableHeaderState(db, before, after)
                                (db.rawQuery("SELECT * FROM coverage WHERE id=?", arrayOf("0")) as SQLiteCursor).use { nodeCursor ->
                                    if (hasRows) sweep(0, principal, nodeCursor, state)
                                    if (hasColumns) sweep(1, principal, nodeCursor, state)
                                }
                            }
                        }
                    }
                }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
        } catch (error: Throwable) {
            close()
            throw error
        }
    }

    private fun retain(cell: HeaderCell) {
        db.execSQL("INSERT OR IGNORE INTO selected VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            arrayOf(cell.id, cell.row, cell.column, cell.rowEnd, cell.columnEnd, cell.kind,
                if (cell.empty) 1 else 0, cell.rowGroup, if (cell.explicit) 1 else 0))
    }

    private fun event(axis: Int, cell: HeaderCell, principal: HeaderCell) {
        val low = if (axis == 0) maxOf(cell.row, principal.row) else maxOf(cell.column, principal.column)
        val high = if (axis == 0) minOf(cell.rowEnd, principal.rowEnd) else minOf(cell.columnEnd, principal.columnEnd)
        val start = if (axis == 0) cell.column else cell.row
        val end = if (axis == 0) minOf(cell.columnEnd, principal.column) else minOf(cell.rowEnd, principal.row)
        db.execSQL("INSERT INTO events VALUES (?, ?, -1, ?, ?, ?)", arrayOf(axis, start, cell.id, low, high))
        db.execSQL("INSERT INTO events VALUES (?, ?, 1, ?, ?, ?)", arrayOf(axis, end, cell.id, low, high))
        db.execSQL("INSERT OR IGNORE INTO coverage_endpoints VALUES (?, ?)", arrayOf(axis, low))
        db.execSQL("INSERT OR IGNORE INTO coverage_endpoints VALUES (?, ?)", arrayOf(axis, high))
    }

    private fun sweep(axis: Int, principal: HeaderCell, nodeCursor: SQLiteCursor, state: TableHeaderState) {
        db.execSQL("DELETE FROM state")
        db.execSQL("DELETE FROM coverage")
        db.execSQL("DELETE FROM coverage_positions")
        val low = if (axis == 0) principal.row else principal.column
        val high = if (axis == 0) principal.rowEnd else principal.columnEnd
        val edge = if (axis == 0) principal.column else principal.row
        db.execSQL("INSERT OR IGNORE INTO coverage_endpoints VALUES (?, ?)", arrayOf(axis, low))
        db.execSQL("INSERT OR IGNORE INTO coverage_endpoints VALUES (?, ?)", arrayOf(axis, high))
        var afterPoint = -1L
        var position = 0L
        do {
            var count = 0
            db.rawQuery("SELECT point FROM coverage_endpoints WHERE axis=? AND point>? ORDER BY point LIMIT ?",
                arrayOf("$axis", "$afterPoint", "$pageRows")).use { points ->
                while (points.moveToNext()) {
                    afterPoint = points.getLong(0)
                    db.execSQL("INSERT INTO coverage_positions VALUES (?, ?)", arrayOf(position++, afterPoint))
                    count++
                }
            }
        } while (count == pageRows)
        val buildStart = System.nanoTime()
        buildCoverage(1, 0, position - 1, low, high)
        coverageBuildNanos += System.nanoTime() - buildStart
        state.assign(-1, -1, low, high, Long.MAX_VALUE)
        if (principal.kind != "data") state.assign(low, high, low, high, edge)
        var coordinate = edge
        while (coordinate > 0) {
            val epoch = bands + 1
            // One batch at each source boundary, never one iteration per implied slot.
            var afterDelta = -2
            var afterId = 0L
            do {
                var count = 0
                db.rawQuery("SELECT delta, id, low, high FROM events WHERE axis=? AND at=? AND (delta,id)>(?,?) ORDER BY delta,id LIMIT ?",
                    arrayOf("$axis", "$coordinate", "$afterDelta", "$afterId", "$pageRows")).use { events ->
                    while (events.moveToNext()) {
                        afterDelta = events.getInt(0)
                        afterId = events.getLong(1)
                        val a = events.getLong(2)
                        val b = events.getLong(3)
                        updateCoverage(1, a, b, afterDelta.toLong(), afterId, epoch, nodeCursor)
                        count++
                    }
                }
            } while (count == pageRows)
            val next = db.rawQuery("SELECT at FROM events WHERE axis=? AND at<? ORDER BY at DESC LIMIT 1",
                arrayOf("$axis", "$coordinate")).use { if (it.moveToFirst()) it.getLong(0) else 0L }
            if (next < coordinate) {
                bands++
                visitCoverage(1, 0, 0, false, epoch, axis, coordinate - 1, principal, nodeCursor, state)
            }
            coordinate = next
        }
        db.rawQuery("SELECT count(*) FROM state", null).use {
            check(it.moveToFirst())
            maxCompletedAxisStateRows = maxOf(maxCompletedAxisStateRows, it.getLong(0))
        }
    }

    // One leaf per interval between source endpoints, never per logical slot.
    // The complete tree is private query scratch. Recursion retains only its
    // logarithmic path; SQLite owns the explicitly bounded page cache.
    private fun buildCoverage(id: Long, first: Long, last: Long, low: Long, high: Long) {
        check(first < last)
        val split = if (last - first > 1) {
            val middle = first + (last - first) / 2
            val point = db.rawQuery("SELECT point FROM coverage_positions WHERE position=?", arrayOf("$middle"))
                .use { check(it.moveToFirst()); it.getLong(0) }
            buildCoverage(Math.multiplyExact(id, 2), first, middle, low, point)
            buildCoverage(Math.addExact(Math.multiplyExact(id, 2), 1), middle, last, point, high)
            point
        } else null
        db.execSQL("INSERT INTO coverage VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0)", arrayOf(id, low, high, split))
        coverageNodesBuilt++
    }

    private fun coverage(id: Long, cursor: SQLiteCursor): TableCoverageNode {
        coverageNodesRead++
        val start = System.nanoTime()
        // This private scalar cursor never escapes the synchronous reduction.
        // Copy its row before recursive work can bind another node. Rebinding
        // alone does not invalidate the previous window; requery is required.
        cursor.setSelectionArguments(arrayOf("$id"))
        check(cursor.requery()) { "Table coverage cursor could not be requeried" }
        check(cursor.moveToFirst())
        val node = TableCoverageNode(cursor.getLong(0), cursor.getLong(1), cursor.getLong(2),
            if (cursor.isNull(3)) null else cursor.getLong(3), cursor.getLong(4), cursor.getLong(5),
            cursor.getLong(6), cursor.getLong(7), if (cursor.isNull(8)) null else cursor.getLong(8),
            cursor.getLong(9), cursor.getLong(10))
        coverageReadNanos += System.nanoTime() - start
        return node
    }

    private fun updateCoverage(id: Long, low: Long, high: Long, delta: Long, cellId: Long, epoch: Long, cursor: SQLiteCursor): TableCoverageNode {
        val node = coverage(id, cursor)
        val updated = if (low <= node.low && high >= node.high) {
            node.copy(minimum = node.minimum + delta, maximum = node.maximum + delta,
                delta = node.delta + delta, xor = node.xor xor cellId,
                uniformXor = node.uniformXor?.let { it xor cellId }, changed = epoch, full = epoch)
        } else {
            val split = requireNotNull(node.split)
            val left = if (low < split) updateCoverage(id * 2, low, high, delta, cellId, epoch, cursor) else coverage(id * 2, cursor)
            val right = if (high > split) updateCoverage(id * 2 + 1, low, high, delta, cellId, epoch, cursor) else coverage(id * 2 + 1, cursor)
            node.copy(minimum = node.delta + minOf(left.minimum, right.minimum),
                maximum = node.delta + maxOf(left.maximum, right.maximum),
                uniformXor = left.uniformXor?.takeIf { it == right.uniformXor }?.let { it xor node.xor },
                changed = epoch)
        }
        val start = System.nanoTime()
        db.execSQL("UPDATE coverage SET minimum=?, maximum=?, delta=?, xor_value=?, uniform_xor=?, changed=?, full=? WHERE id=?",
            arrayOf(updated.minimum, updated.maximum, updated.delta, updated.xor, updated.uniformXor,
                updated.changed, updated.full, id))
        coverageWriteNanos += System.nanoTime() - start
        coverageNodesWritten++
        return updated
    }

    private fun visitCoverage(id: Long, parentDelta: Long, parentXor: Long, forced: Boolean, epoch: Long,
        axis: Int, inner: Long, principal: HeaderCell, cursor: SQLiteCursor, state: TableHeaderState) {
        val node = coverage(id, cursor)
        coverageNodesVisited++
        if (!forced && node.changed != epoch) return
        val minimum = parentDelta + node.minimum
        val maximum = parentDelta + node.maximum
        check(minimum >= 0)
        if (minimum > 1 || maximum < 1) return
        if (minimum == 1L && maximum == 1L && node.uniformXor != null) {
            unique(axis, inner, node.low, node.high, parentXor xor node.uniformXor, principal, state)
            return
        }
        check(node.split != null)
        // A full ancestor update changes all descendants even if they were not
        // individually written this epoch. Propagate that fact BEFORE deciding
        // whether a child is unchanged. Emit only after the complete event batch.
        val changedBelow = forced || node.full == epoch
        visitCoverage(id * 2, parentDelta + node.delta, parentXor xor node.xor, changedBelow, epoch, axis, inner, principal, cursor, state)
        visitCoverage(id * 2 + 1, parentDelta + node.delta, parentXor xor node.xor, changedBelow, epoch, axis, inner, principal, cursor, state)
    }

    private fun unique(axis: Int, inner: Long, low: Long, high: Long, singleId: Long, principal: HeaderCell, state: TableHeaderState) {
        val started = System.nanoTime()
        uniqueSpans++
        var start = low
        while (start < high) {
            val lastCell = state.piece(-2, -2, start, high)
            val end = lastCell.first
            if (lastCell.second != singleId) {
                processedCellSpans++
                val cell = db.rawQuery("SELECT $CELL_COLUMNS FROM selected WHERE id=?", arrayOf("$singleId"))
                    .use { require(it.moveToFirst()); it.headerCell() }
                if (cell.kind == "data") state.assign(-1, -1, start, end, inner)
                else header(axis, inner, start, end, cell, principal, state)
                state.assign(-2, -2, start, end, singleId)
            }
            start = end
        }
        uniqueReductionNanos += System.nanoTime() - started
    }

    private fun header(axis: Int, inner: Long, low: Long, high: Long, cell: HeaderCell, principal: HeaderCell, state: TableHeaderState) {
        val groupLow = if (axis == 0) cell.row else cell.column
        val groupHigh = if (axis == 0) cell.rowEnd else cell.columnEnd
        var point = low
        while (point < high) {
            val first = state.piece(groupLow, groupHigh, point, high)
            val data = state.piece(-1, -1, point, high)
            val end = minOf(first.first, data.first)
            if ((first.second == null || first.second!! <= requireNotNull(data.second)) && !cell.empty &&
                cell.id != principal.id && cell.kind == if (axis == 0) "row" else "column") {
                result(cell.id, axis, point, inner)
            }
            if (first.second == null) state.assign(groupLow, groupHigh, point, end, inner)
            point = end
        }
    }

    private fun result(id: Long, phase: Int, outer: Long, inner: Long) {
        val innerOrder = -inner
        db.execSQL("INSERT OR IGNORE INTO result VALUES (?, ?, ?, ?)", arrayOf(id, phase, outer, innerOrder))
        db.execSQL("""UPDATE result SET phase=?,outer_position=?,inner_order=? WHERE id=? AND
            (phase>? OR phase=? AND outer_position>? OR phase=? AND outer_position=? AND inner_order>?)""",
            arrayOf(phase, outer, innerOrder, id, phase, phase, outer, phase, outer, innerOrder))
    }

    /** Bounded result page; the query owner closes it before closing this result. */
    fun page(after: OfflineReadingTableHeaderPageKey?): Cursor {
        val page = MatrixCursor(arrayOf("phase", "outer_position", "inner_order", "id", "row_start", "column_start"), pageRows)
        var key = after
        var phase = key?.phase ?: 0L
        while (phase <= 3 && page.count < pageRows) {
            val remaining = pageRows - page.count
            val rows = if (phase <= 1) {
                val continuation = if (key == null) "" else
                    "WHERE (r.phase,r.outer_position,r.inner_order,r.id)>(?,?,?,?)"
                val args = mutableListOf<String>()
                if (key != null) args.addAll(listOf("${key.phase}", "${key.outer}", "${key.innerOrder}", "${key.id}"))
                args.add("$remaining")
                db.rawQuery("""SELECT r.phase,r.outer_position,r.inner_order,r.id,c.row_start,c.column_start
                    FROM result r JOIN selected c ON c.id=r.id $continuation
                    ORDER BY r.phase,r.outer_position,r.inner_order,r.id LIMIT ?""", args.toTypedArray())
            } else {
                val context = groups ?: break
                val principal = context.principal
                val group = if (phase == 2L && principal.rowGroup != null)
                    "kind='rowgroup' AND row_group=${principal.rowGroup}"
                else if (phase == 3L && context.columnGroup != null)
                    "kind='colgroup' AND column_start>=${context.columnGroup.first} AND column_start<${context.columnGroup.second}"
                else {
                    phase++
                    key = null
                    continue
                }
                requireNotNull(source).rawQuery("""SELECT ?,id,0,id,row_start,column_start FROM cells
                    WHERE table_id=? AND $group AND empty=0 AND id<>? AND id>?
                      AND row_start<? AND column_start<? ORDER BY id LIMIT ?""",
                    arrayOf("$phase", "${context.table}", "${principal.id}", "${key?.id ?: 0}",
                        "${principal.rowEnd}", "${principal.columnEnd}", "$remaining"))
            }
            var count = 0
            rows.use {
                while (it.moveToNext()) {
                    page.addRow(arrayOf<Any>(it.getLong(0), it.getLong(1), it.getLong(2), it.getLong(3), it.getLong(4), it.getLong(5)))
                    if (phase >= 2) groupRowsRead++
                    count++
                }
            }
            if (count == remaining) break
            phase = if (phase <= 1) 2 else phase + 1
            key = null
        }
        return page
    }

    val scratchBytes: Long get() = file.length()

    override fun close() {
        try { source?.close() } finally {
            source = null
            try { db.close() } finally {
                if (!SQLiteDatabase.deleteDatabase(file) && file.exists()) {
                    throw IOException("Could not remove selected table query scratch")
                }
            }
        }
    }
}
