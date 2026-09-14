package app.nexus.android.offline.readingweb

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import app.nexus.android.offline.reading.OfflineReadingLease
import app.nexus.android.offline.reading.OfflineReadingLeaseMember
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal const val OFFLINE_READING_ASSET_HOST = "appassets.androidplatform.net"
internal const val OFFLINE_READING_MAIN_PATH = "/nexus-offline/index.html"
internal const val OFFLINE_READING_MAIN_URL =
    "https://$OFFLINE_READING_ASSET_HOST$OFFLINE_READING_MAIN_PATH"

internal sealed interface OfflineReadingLocalPath {
    data class Static(val assetPath: String) : OfflineReadingLocalPath
    data class Lease(val capability: String, val entryPath: String) : OfflineReadingLocalPath
}

internal data class OfflineByteRange(val start: Long, val endInclusive: Long)
private val LEASE_PATH = Regex("lease/([0-9a-f]{32})/([A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*)")
private val BYTE_RANGE = Regex("bytes=([0-9]+)-([0-9]*)")

internal fun parseOfflineReadingLocalPath(path: String): OfflineReadingLocalPath? {
    if (!path.startsWith("/nexus-offline/") || '%' in path || '\\' in path) return null
    val tail = path.removePrefix("/nexus-offline/")
    if (tail == "index.html" || tail == "asset-manifest.sha256" || tail.startsWith("assets/") || tail.startsWith("pdfjs/")) {
        val parts = tail.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        return OfflineReadingLocalPath.Static(tail)
    }
    val match = LEASE_PATH.matchEntire(tail) ?: return null
    val entryPath = match.groupValues[2]
    if (entryPath.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
    return OfflineReadingLocalPath.Lease(match.groupValues[1], entryPath)
}

internal fun parseOfflineByteRange(header: String, fileLength: Long): OfflineByteRange? {
    if (fileLength <= 0) return null
    val match = BYTE_RANGE.matchEntire(header) ?: return null
    val start = match.groupValues[1].toLongOrNull() ?: return null
    val end = match.groupValues[2].takeIf(String::isNotEmpty)?.toLongOrNull()
        ?: (fileLength - 1)
    if (start >= fileLength || end < start || end >= fileLength) return null
    return OfflineByteRange(start, end)
}

/**
 * Ownership of the reserved host is decided by host and scheme alone: every
 * HTTP(S) request naming it is answered locally, so no decoration can hand the
 * name back to the WebView network stack.
 */
internal fun isOfflineReadingReservedHost(uri: Uri): Boolean =
    (uri.scheme.equals("https", ignoreCase = true) || uri.scheme.equals("http", ignoreCase = true)) &&
        uri.host.equals(OFFLINE_READING_ASSET_HOST, ignoreCase = true)

internal fun isOfflineReadingReservedOrigin(uri: Uri): Boolean =
    uri.scheme == "https" &&
        uri.host == OFFLINE_READING_ASSET_HOST &&
        uri.port == -1 &&
        uri.userInfo == null &&
        uri.query == null &&
        uri.fragment == null

internal fun isOfflineReadingMainFrameUrl(uri: Uri): Boolean =
    isOfflineReadingReservedOrigin(uri) && uri.encodedPath == OFFLINE_READING_MAIN_PATH

internal class OfflineReadingLeaseRegistry(
    private val closeLease: (UUID) -> Unit,
) {
    private val leases = ConcurrentHashMap<String, OfflineReadingLease>()

    fun publish(lease: OfflineReadingLease): String {
        val capability = UUID.randomUUID().toString().replace("-", "")
        leases[capability] = lease
        return capability
    }

    fun resolve(capability: String, path: String): OfflineReadingLeaseMember? {
        val lease = leases[capability] ?: return null
        return try {
            lease.resolveEntry(path)
        } catch (_: IllegalArgumentException) {
            // justify-ignore-error: an entry the package does not declare is not
            // routable; the caller answers the same closed local 404 as an
            // unknown path, and the request carries nothing else to report.
            null
        } catch (_: java.io.IOException) {
            // justify-ignore-error: an unreadable package path is equally unroutable.
            null
        }
    }

    fun close(leaseId: UUID) {
        leases.entries.removeAll { (_, lease) ->
            if (lease.id != leaseId) return@removeAll false
            closeLease(lease.id)
            true
        }
    }

    fun clear() {
        leases.values.map(OfflineReadingLease::id).distinct().forEach(closeLease)
        leases.clear()
    }
}

internal class OfflineReadingRequestRouter(
    context: android.content.Context,
    private val leaseRegistry: OfflineReadingLeaseRegistry,
) {
    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain(OFFLINE_READING_ASSET_HOST)
        .addPathHandler(
            "/",
            WebViewAssetLoader.AssetsPathHandler(context),
        )
        .build()

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!isOfflineReadingReservedHost(uri)) return null
        // A decorated reserved-host URL (query, port, credentials, fragment, or a
        // non-https scheme) is unroutable, never a network fetch on a name a
        // hostile network could answer.
        if (!isOfflineReadingReservedOrigin(uri)) return notFound()
        return when (val route = parseOfflineReadingLocalPath(uri.encodedPath ?: "")) {
            is OfflineReadingLocalPath.Static -> {
                val asset = assetLoader.shouldInterceptRequest(uri)
                // A missing packaged asset answers an empty-bodied 200 from the
                // asset loader; only a real stream is a served asset.
                val data = asset?.data
                if (asset == null || data == null) {
                    notFound()
                } else {
                    WebResourceResponse(
                        asset.mimeType,
                        asset.encoding,
                        200,
                        "OK",
                        mapOf(
                            "Cache-Control" to "no-store",
                            "X-Content-Type-Options" to "nosniff",
                        ),
                        data,
                    )
                }
            }
            is OfflineReadingLocalPath.Lease ->
                leaseRegistry.resolve(route.capability, route.entryPath)
                    ?.let { member -> serveEntry(member, request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value) }
                    ?: notFound()
            null -> notFound()
        }
    }

    /** The offline document has no network escape hatch, including subresources. */
    fun interceptOfflineDocument(request: WebResourceRequest): WebResourceResponse =
        intercept(request) ?: notFound()

    private fun serveEntry(member: OfflineReadingLeaseMember, rangeHeader: String?): WebResourceResponse {
        val file = member.file
        val mimeType = member.mediaType
        // The packaged PDF.js decides range capability from the first response:
        // without an exact `Accept-Ranges: bytes` there it streams the whole
        // package PDF instead of seeking.
        val rangesServed = mimeType == "application/pdf"
        if (rangeHeader == null) {
            return WebResourceResponse(
                mimeType,
                null,
                200,
                "OK",
                mapOf(
                    "Accept-Ranges" to if (rangesServed) "bytes" else "none",
                    "Content-Length" to file.length().toString(),
                    "Cache-Control" to "no-store",
                    "X-Content-Type-Options" to "nosniff",
                ),
                FileInputStream(file),
            )
        }
        if (!rangesServed) return rangeNotSatisfiable(file.length())
        val range = parseOfflineByteRange(rangeHeader, file.length())
            ?: return rangeNotSatisfiable(file.length())
        val length = range.endInclusive - range.start + 1
        return WebResourceResponse(
            mimeType,
            null,
            206,
            "Partial Content",
            mapOf(
                "Accept-Ranges" to "bytes",
                "Content-Range" to "bytes ${range.start}-${range.endInclusive}/${file.length()}",
                "Content-Length" to length.toString(),
                "Cache-Control" to "no-store",
                "X-Content-Type-Options" to "nosniff",
            ),
            BoundedFileInputStream(file, range.start, length),
        )
    }

    private fun notFound() = WebResourceResponse(
        "text/plain",
        "utf-8",
        404,
        "Not Found",
        mapOf("Cache-Control" to "no-store"),
        "Not found".byteInputStream(),
    )

    private fun rangeNotSatisfiable(length: Long) = WebResourceResponse(
        "text/plain",
        "utf-8",
        416,
        "Range Not Satisfiable",
        mapOf("Content-Range" to "bytes */$length", "Cache-Control" to "no-store"),
        ByteArray(0).inputStream(),
    )

}

private class BoundedFileInputStream(
    file: File,
    start: Long,
    private var remaining: Long,
) : InputStream() {
    private val input = FileInputStream(file).also { stream ->
        stream.channel.position(start)
    }

    override fun read(): Int {
        if (remaining == 0L) return -1
        val value = input.read()
        if (value >= 0) remaining -= 1
        return value
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (remaining == 0L) return -1
        val read = input.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
        if (read > 0) remaining -= read
        return read
    }

    override fun close() = input.close()
}
