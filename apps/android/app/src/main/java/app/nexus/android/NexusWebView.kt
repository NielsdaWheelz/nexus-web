package app.nexus.android

import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView

object NexusWebView {
    const val USER_AGENT_TOKEN = "NexusAndroidShell"

    fun configure(view: WebView) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.safeBrowsingEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(true)
        settings.userAgentString = "${settings.userAgentString} $USER_AGENT_TOKEN"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    }
}
