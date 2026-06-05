package app.nexus.android

import android.net.Uri

internal const val DEFAULT_AUTH_RETURN_TARGET = "/libraries"

internal fun Uri.Builder.appendNonDefaultAuthReturnTarget(target: String): Uri.Builder =
    if (target == DEFAULT_AUTH_RETURN_TARGET) this else appendQueryParameter("next", target)
