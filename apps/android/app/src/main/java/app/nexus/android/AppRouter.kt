package app.nexus.android

import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import app.nexus.android.webkit.OwnedOrigin
import app.nexus.android.offline.OfflineStore
import app.nexus.android.playback.ListeningPublication
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.SecureRandom
import java.util.UUID

/**
 * Installed interface delivery at the exact configured origin. Reserved misses
 * terminate locally; only ordinary GET app documents receive the installed
 * entry. Auth, public documents and API requests remain explicit remote routes.
 * Fixed device reads expose account-bound content; non-episode reading copies
 * keep ShelfRouter's isolated document origin.
 */
internal class AppRouter(private val context: Context, private val session: DeviceSession) {
    private val origin = OwnedOrigin(BuildConfig.NEXUS_BASE_URL)
    private val base = Uri.parse(BuildConfig.NEXUS_BASE_URL)
    private val assets = WebViewAssetLoader.Builder().setDomain(base.host!!.lowercase())
        .setHttpAllowed(base.scheme == "http")
        .addPathHandler("/_nexus/app/", WebViewAssetLoader.PathHandler { path ->
            WebViewAssetLoader.AssetsPathHandler(context).handle("app/$path")
        }).build()

    fun isOwned(uri: Uri): Boolean = origin.matches(uri)

    fun isAppRoute(uri: Uri): Boolean {
        if (!isOwned(uri)) return false
        val path = uri.path ?: "/"
        return !(path in setOf("/login", "/forgot-password", "/share", "/s", "/android", "/version", "/extension/connect/start", "/account/identities") || path == "/account/password" || path.startsWith("/account/password/") ||
            path == "/auth" || path.startsWith("/auth/") || path == "/api" || path.startsWith("/api/") ||
            path.startsWith("/s/") || path.startsWith("/_nexus/") || path.startsWith("/_next/") ||
            path in setOf("/privacy", "/terms", "/robots.txt", "/favicon.ico", "/manifest.webmanifest", "/sitemap.xml") ||
            path.startsWith("/.well-known/"))
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!isOwned(uri)) return null
        val path = uri.path ?: "/"
        if (path.startsWith("/_nexus/device/")) {
            if (request.requestHeaders.entries.firstOrNull { it.key.equals("X-Nexus-Wire", true) }?.value != BuildConfig.NEXUS_WIRE.toString()) {
                return response(426, "Upgrade Required", "application/json", "{\"error\":{\"code\":\"E_WIRE_MISMATCH\",\"message\":\"update nexus\"}}".toByteArray())
            }
            if (request.method != "GET") return response(405, "Method Not Allowed", "text/plain", ByteArray(0))
            return try {
                runBlocking { session.initialize() }
                if (path == "/_nexus/device/startup.json") {
                    val snapshot = runBlocking { session.startup() }
                    return if (snapshot == null) response(204, "No Content", "application/json", ByteArray(0))
                    else response(200, "OK", "application/json", snapshot.toString().toByteArray(Charsets.UTF_8))
                }
                val account = session.accountId()
                    ?: throw LocalStateError("E_LOCAL_STATE_UNBOUND", "sign in first")
                var mime = "application/json"
                val stream = when (path) {
                    "/_nexus/device/catalog.json" -> runBlocking { session.catalog.open() }
                    "/_nexus/device/listening.json" -> ListeningPublication.open(context, account)
                    "/_nexus/device/downloads.json" -> {
                        if (Build.VERSION.SDK_INT < 34) return response(404, "Not Found", "application/json", ByteArray(0))
                        OfflineStore.get(context).openDownloads()
                    }
                    else -> {
                        if (Build.VERSION.SDK_INT < 34) return response(404, "Not Found", "application/json", ByteArray(0))
                        val parts = path.removePrefix("/_nexus/device/").split('/')
                        if (parts.size != 4 || parts[0] != "episodes" || parts[3] !in setOf("episode.json", "transcript.json", "artwork"))
                            return response(404, "Not Found", "application/json", ByteArray(0))
                        val mediaId = try { UUID.fromString(parts[1]) } catch (_: IllegalArgumentException) { return response(404, "Not Found", "application/json", ByteArray(0)) }
                        val packageId = try { UUID.fromString(parts[2]) } catch (_: IllegalArgumentException) { return response(404, "Not Found", "application/json", ByteArray(0)) }
                        val component = OfflineStore.get(context).openEpisodeComponent(mediaId, packageId, parts[3])
                            ?: return response(404, "Not Found", "application/json", ByteArray(0))
                        mime = component.mime
                        component.input
                    }
                }
                if (stream == null) response(204, "No Content", "application/json", ByteArray(0))
                else WebResourceResponse(mime, if (mime == "application/json") "utf-8" else null, 200, "OK",
                    mapOf("Cache-Control" to "private, no-store", "X-Content-Type-Options" to "nosniff"), stream)
            } catch (error: java.io.IOException) {
                val code = when (error) {
                    is LocalStateError -> error.code
                    is ListeningPublication.Error -> error.code
                    else -> "E_LOCAL_STATE_IO"
                }
                val body = JSONObject().put("error", JSONObject().put("code", code).put("message", error.message)).toString()
                response(500, "Internal Server Error", "application/json", body.toByteArray(Charsets.UTF_8))
            }
        }
        if (path.startsWith("/_nexus/app/")) {
            if (path in setOf("/_nexus/app/index.html", "/_nexus/app/security-headers.json")) {
                return response(404, "Not Found", "text/plain", ByteArray(0))
            }
            if (request.method != "GET") return response(405, "Method Not Allowed", "text/plain", ByteArray(0))
            // AndroidX matches authority literally, including ports. Origin admission
            // above has already checked the effective port; only asset lookup is canonicalized.
            return assets.shouldInterceptRequest(uri.buildUpon().authority(base.host!!.lowercase()).build())?.takeIf { it.data != null }?.apply {
                // These bundled formats are absent from older Android MIME tables.
                mimeType = when (path.substringAfterLast('.')) {
                    "woff2" -> "font/woff2"
                    "mjs" -> "text/javascript"
                    else -> mimeType
                }
                responseHeaders = (responseHeaders ?: emptyMap()) + mapOf("Cache-Control" to "public, max-age=31536000, immutable", "X-Content-Type-Options" to "nosniff")
            } ?: response(404, "Not Found", "text/plain", ByteArray(0))
        }
        if (path.startsWith("/_nexus/")) return response(404, "Not Found", "text/plain", ByteArray(0))
        if (!request.isForMainFrame || request.method != "GET" || !isAppRoute(uri)) return null
        val nonce = Base64.encodeToString(ByteArray(18).also { SecureRandom().nextBytes(it) }, Base64.NO_WRAP)
        val html = context.assets.open("app/index.html").bufferedReader().use { it.readText() }
            .replace("__NEXUS_NONCE__", nonce)
        val policy = JSONObject(context.assets.open("app/security-headers.json").bufferedReader().use { it.readText() })
        val headers = policy.keys().asSequence().associateWith {
            val value = policy.getString(it).replace("__NEXUS_NONCE__", nonce)
            if (it.equals("Content-Security-Policy", true) && base.scheme == "https") "$value; upgrade-insecure-requests" else value
        }
        return response(200, "OK", "text/html", html.toByteArray(Charsets.UTF_8), headers)
    }

    private fun response(status: Int, reason: String, mime: String, body: ByteArray, headers: Map<String, String> = emptyMap()) =
        WebResourceResponse(mime, "utf-8", status, reason,
            headers + mapOf("Cache-Control" to "private, no-store", "X-Content-Type-Options" to "nosniff"), ByteArrayInputStream(body))
}
