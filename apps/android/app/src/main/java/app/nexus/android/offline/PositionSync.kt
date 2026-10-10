package app.nexus.android.offline

import app.nexus.android.NexusOriginClient
import app.nexus.android.NexusOriginError
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.math.BigDecimal

/**
 * One pass carrying device positions back to nexus, and refreshing the baseline
 * of every synced copy so online reading on this device never looks like a
 * conflict. Returns true when the pass should run again later.
 */
internal suspend fun syncPositions(store: OfflineStore, origin: NexusOriginClient): Boolean {
    // the account first: positions read after it belong to it, or to a later account me() then refuses
    val account = store.account ?: return false
    val items = store.syncItems()
    if (items.isEmpty() || store.authRequired) return false
    var retry = false
    try {
        if (origin.me() != account) {
            store.requireAuth(account)
            return false
        }
        for (item in items) {
            try {
                val device = item.device
                if (device == null) {
                    store.synced(item.mediaId, null, origin.getReaderState(item.mediaId))
                    continue
                }
                put(store, origin, item, device)
            } catch (error: NexusOriginError) {
                if (error.status == 401 || error.status == 403) throw error
                // a refresh of a source that is gone has nothing to keep
                if (error.status != 404 || item.device != null) retry = true
            } catch (_: IOException) {
                // justify-ignore-error: the position stays on the device; a later pass retries it.
                retry = true
            }
        }
    } catch (error: NexusOriginError) {
        if (error.status != 401 && error.status != 403) return true
        store.requireAuth(account)
        return false
    } catch (_: IOException) {
        // justify-ignore-error: no network for the account check; a later pass retries.
        return true
    }
    return retry
}

/** PUT against the copy's generation and base revision; a conflict compares locators first. */
private suspend fun put(store: OfflineStore, origin: NexusOriginClient, item: SyncItem, device: JSONObject) {
    val body = JSONObject()
        .put("locator", device)
        .put("base_revision", item.baseRevision)
        .put("expected_reader_generation", item.generation)
    try {
        store.synced(item.mediaId, device, origin.putReaderState(item.mediaId, body), accepted = true)
    } catch (error: NexusOriginError) {
        when {
            error.code == "E_READER_STATE_CONFLICT" -> {
                val canonical = origin.getReaderState(item.mediaId)
                if (canonical.opt("locator")?.let { sameJson(it, device) } == true) {
                    store.synced(item.mediaId, device, canonical)
                } else {
                    store.conflicted(item.mediaId, canonical)
                }
            }
            error.code == "E_READER_CONTENT_CHANGED" -> store.markPosition(item.mediaId, "ContentChanged")
            error.status == 404 -> store.markPosition(item.mediaId, "SourceUnavailable")
            else -> throw error
        }
    }
}

/** JSON equality where `1` equals `1.0`. */
private fun sameJson(left: Any, right: Any): Boolean = when {
    left is Number && right is Number -> BigDecimal(left.toString()).compareTo(BigDecimal(right.toString())) == 0
    left is JSONObject && right is JSONObject ->
        left.length() == right.length() &&
            left.keys().asSequence().all { right.has(it) && sameJson(left.get(it), right.get(it)) }
    left is JSONArray && right is JSONArray ->
        left.length() == right.length() && (0 until left.length()).all { sameJson(left.get(it), right.get(it)) }
    else -> left == right
}
