"""The security headers every anonymous resource-share API response carries, errors included."""

import re

from starlette.responses import Response

PUBLIC_RESOURCE_SHARE_PATH_RE = re.compile(r"^/public/resource-share(?:/.*)?$")


def apply_public_resource_share_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'none'; object-src 'none'; base-uri 'none'; "
        "form-action 'none'; frame-ancestors 'none'"
    )
    if "set-cookie" in response.headers:
        del response.headers["set-cookie"]
