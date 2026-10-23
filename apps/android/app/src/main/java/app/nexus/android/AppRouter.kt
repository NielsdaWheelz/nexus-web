package app.nexus.android

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import app.nexus.android.webkit.OwnedOrigin
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.SecureRandom

/**
 * Installed interface delivery at the exact configured origin. Reserved misses
 * terminate locally; only ordinary GET app documents receive the installed
 * entry. Auth, public documents and API requests remain explicit remote routes.
 * Downloaded content belongs exclusively to ShelfRouter's separate origin.
 */
internal class AppRouter(private val context: Context, private val session: DeviceSession) {
    private val origin = OwnedOrigin(BuildConfig.NEXUS_BASE_URL)
    private val base = Uri.parse(BuildConfig.NEXUS_BASE_URL)
    private val assets = WebViewAssetLoader.Builder().setDomain(base.host!!)
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
        if (path == "/_nexus/device/startup.json") {
            if (request.requestHeaders.entries.firstOrNull { it.key.equals("X-Nexus-Wire", true) }?.value != BuildConfig.NEXUS_WIRE.toString()) {
                return response(426, "Upgrade Required", "application/json", "{\"error\":{\"code\":\"E_WIRE_MISMATCH\",\"message\":\"update nexus\"}}".toByteArray())
            }
            if (request.method != "GET") return response(405, "Method Not Allowed", "text/plain", ByteArray(0))
            return try {
                val snapshot = runBlocking { session.startup() }
                if (snapshot == null) response(204, "No Content", "application/json", ByteArray(0))
                else response(200, "OK", "application/json", snapshot.toString().toByteArray(Charsets.UTF_8))
            } catch (error: java.io.IOException) {
                val body = JSONObject().put("error", JSONObject().put("code", (error as? LocalStateError)?.code ?: "E_LOCAL_STATE_IO").put("message", error.message)).toString()
                response(500, "Internal Server Error", "application/json", body.toByteArray(Charsets.UTF_8))
            }
        }
        if (path.startsWith("/_nexus/app/")) {
            if (path in setOf("/_nexus/app/index.html", "/_nexus/app/security-headers.json")) {
                return response(404, "Not Found", "text/plain", ByteArray(0))
            }
            if (request.method != "GET") return response(405, "Method Not Allowed", "text/plain", ByteArray(0))
            return assets.shouldInterceptRequest(uri)?.takeIf { it.data != null }?.apply {
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
