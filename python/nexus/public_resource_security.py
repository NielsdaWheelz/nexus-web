"""Shared security policy for every anonymous resource-share API response."""

from __future__ import annotations

import re

from starlette.datastructures import MutableHeaders

PUBLIC_RESOURCE_SHARE_PATH_RE = re.compile(r"^/public/resource-share(?:/.*)?$")
PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": (
        "default-src 'none'; object-src 'none'; base-uri 'none'; "
        "form-action 'none'; frame-ancestors 'none'"
    ),
}


def apply_public_resource_share_headers(headers: MutableHeaders) -> None:
    for key, value in PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.items():
        headers[key] = value
    if "set-cookie" in headers:
        del headers["set-cookie"]
