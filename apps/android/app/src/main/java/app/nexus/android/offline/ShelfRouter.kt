package app.nexus.android.offline

import android.content.Context
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import com.google.common.io.ByteStreams
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.UUID

internal const val SHELF_HOST = "appassets.androidplatform.net"
internal const val SHELF_ORIGIN = "https://$SHELF_HOST"
internal const val SHELF_URL = "$SHELF_ORIGIN/shelf/index.html"

private val RANGE = Regex("bytes=(\\d+)-(\\d*)")

/**
 * Answers every WebView request to the shelf host from the apk or the store, so
 * that name never reaches the network; while the shelf is the main document,
 * every other subresource answers 404. Main frames elsewhere are never touched.
 */
internal class ShelfRouter(context: Context, private val store: OfflineStore) {
    private val assets = WebViewAssetLoader.Builder()
        .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()

    fun intercept(request: WebResourceRequest, shelfActive: Boolean): WebResourceResponse? {
        val url = request.url
        if (!url.host.equals(SHELF_HOST, ignoreCase = true)) {
            return if (shelfActive && !request.isForMainFrame) notFound() else null
        }
        val segments = url.pathSegments
        if (segments.size > 3 && segments[0] == "shelf" && segments[1] == "copies") {
            val mediaId = try {
                UUID.fromString(segments[2])
            } catch (_: IllegalArgumentException) {
                // justify-ignore-error: a path that names no media id names no copy.
                return notFound()
            }
            val file = store.copyFile(mediaId, segments.drop(3).joinToString("/")) ?: return notFound()
            val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
            return serve(file, range)
        }
        // the asset loader answers a missing asset with a null body
        return assets.shouldInterceptRequest(url)?.takeIf { it.data != null } ?: notFound()
    }

    private fun serve(file: File, range: String?): WebResourceResponse {
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
            ?: "application/octet-stream"
        val length = file.length()
        val headers = mapOf("Accept-Ranges" to "bytes", "Cache-Control" to "no-store")
        if (range == null) {
            return WebResourceResponse(mime, null, 200, "OK", headers + ("Content-Length" to "$length"), FileInputStream(file))
        }
        val match = RANGE.matchEntire(range)
        val start = match?.groupValues?.get(1)?.toLongOrNull()
        val end = match?.groupValues?.get(2)?.let { if (it.isEmpty()) length - 1 else it.toLongOrNull() }
            ?.coerceAtMost(length - 1)
        if (start == null || end == null || start > end) {
            return WebResourceResponse(
                "text/plain", null, 416, "Range Not Satisfiable",
                headers + ("Content-Range" to "bytes */$length"), ByteArrayInputStream(ByteArray(0)),
            )
        }
        val input = FileInputStream(file).apply { channel.position(start) }
        return WebResourceResponse(
            mime, null, 206, "Partial Content",
            headers + mapOf("Content-Range" to "bytes $start-$end/$length", "Content-Length" to "${end - start + 1}"),
            ByteStreams.limit(input, end - start + 1),
        )
    }

    private fun notFound() = WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)),
    )
}
