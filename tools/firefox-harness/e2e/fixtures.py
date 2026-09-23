"""temporary fixture origin for the firefox capture v1 journeys.

serves http://fixtures.nexus-capture.test:8899 and http://other.nexus-capture.test:8899
(firefox resolves both to loopback via network.dns.localDomains). every route is
deterministic; the article carries beginning/end sentinels, apparatus, an embed,
private state that must never leave the browser, and relative links.
"""

from __future__ import annotations

import io
import os
import sys
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("FIXTURE_PORT", "8899"))
OTHER_HOST = "other.nexus-capture.test"

ARTICLE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture Article: The Green Knight</title>

<meta property="og:site_name" content="Fixture Gazette">
<meta property="article:published_time" content="2026-09-20T10:00:00Z">
<script>window.__secret = "SCRIPT-SECRET-7f3a";</script>
<style>.hidden-note{display:none}</style>
</head>
<body>
<nav class="account"><span>Signed in as ACCOUNT-SECRET-user@example.com</span><a href="/logout">Log out</a></nav>
<main>
<article>
<h1>The Green Knight</h1>
<p class="byline">By Sir Gawain and Jane Austen</p>
<p id="lead" data-private-token="DATA-SECRET-4c1d" onclick="alert(1)">BEGIN-SENTINEL-8a1f The knight rode out at dawn, his <a href="../notes/green.html" title="green note">green mantle</a> catching the light.</p>
<p>He carried a letter<sup><a href="#fn1" id="fnref1">1</a></sup> whose seal he never broke.</p>
<figure><img src="images/knight.png" alt="a knight"><figcaption>the knight</figcaption></figure>
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="a video" width="560" height="315"></iframe>
<blockquote class="twitter-tweet"><p>The quest is the point.</p>&mdash; Gawain (@gawain) <a href="https://twitter.com/gawain/status/1234567890">September 20, 2026</a></blockquote>
<form action="/subscribe" method="post"><input type="hidden" name="csrf" value="FORM-SECRET-9e2b"><input type="text" name="email"><button>Subscribe</button></form>
<p hidden>HIDDEN-SECRET-1b4e</p>
<p class="hidden-note">A styled-hidden note that is still article prose.</p>
<p>Year passed as years do. He kept the girdle, and the shame, and both were his. END-SENTINEL-c2d9</p>
<section class="footnotes"><ol><li id="fn1"><p>The letter was from the Lady. <a href="#fnref1">↩</a></p></li></ol></section>
</article>
</main>
<aside class="related"><h2>Related</h2><p>Unrelated recommendation card text that must not outscore the body. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></aside>
</body></html>
"""

LOGIN_PAGE = """<!doctype html><html><head><title>Sign in</title></head><body><h1>Please sign in to download</h1><form><input name=u><input name=p type=password></form></body></html>"""


def minimal_pdf(text: str) -> bytes:
    """one-page pdf with a text object; parseable by mupdf."""
    content = f"BT /F1 24 Tf 72 700 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def minimal_epub(title: str) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        def entry(name: str) -> zipfile.ZipInfo:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # deterministic bytes
            info.compress_type = zipfile.ZIP_DEFLATED
            return info
        mimetype = zipfile.ZipInfo("mimetype", date_time=(2026, 1, 1, 0, 0, 0))
        archive.writestr(mimetype, "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr(
            entry("META-INF/container.xml"),
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        archive.writestr(
            entry("OEBPS/content.opf"),
            '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:fixture-epub-1</dc:identifier>'
            f"<dc:title>{title}</dc:title><dc:language>en</dc:language></metadata>"
            '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            '<item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>'
            '<spine><itemref idref="c1"/></spine></package>',
        )
        archive.writestr(
            entry("OEBPS/nav.xhtml"),
            '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
            '<head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li></ol></nav></body></html>',
        )
        archive.writestr(
            entry("OEBPS/chapter1.xhtml"),
            '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>'
            f"<body><h1>{title}</h1><p>EPUB-SENTINEL-5e7a The first chapter of the fixture book.</p></body></html>",
        )
    return out.getvalue()


PDF = minimal_pdf("PDF-SENTINEL-3d0c fixture paper")
EPUB = minimal_epub("Fixture Book")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: D102
        sys.stderr.write("fixture %s %s\n" % (self.headers.get("Host"), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):  # noqa: N802
        self._send(405, b"", "text/plain")

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        host = (self.headers.get("Host") or "").split(":")[0]
        if path in ("/", "/articles/green-knight"):
            self._send(200, ARTICLE.encode(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        elif path == "/links":
            body = (
                "<!doctype html><html><head><title>Links</title></head><body><main>"
                '<p><a id="epub-link" href="/book.epub">the fixture book (epub)</a></p>'
                '<p><a id="pdf-link" href="/paper.pdf">the fixture paper (pdf)</a></p>'
                '<p><a id="extensionless-link" href="/download?id=paper-7">extensionless paper</a></p>'
                '<p><a id="signed-link" href="/paper.pdf?sig=SIGNED-SECRET-ab12&amp;expires=2000000000">signed paper</a></p>'
                '<p><a id="redirect-same-link" href="/redirect-same">same-origin redirect to paper</a></p>'
                f'<p><a id="redirect-cross-link" href="/redirect-cross">cross-origin redirect to paper</a></p>'
                '<p><a id="login-link" href="/login.pdf">a pdf link that returns a login page</a></p>'
                '<p><a id="huge-link" href="/huge.pdf">oversized stream</a></p>'
                '<p><a id="huge-declared-link" href="/huge-declared.pdf">oversized declared</a></p>'
                f'<p><a id="cross-link" href="http://{OTHER_HOST}:{PORT}/paper.pdf">cross-origin paper</a></p>'
                "</main></body></html>"
            ).encode()
            self._send(200, body, "text/html; charset=utf-8", {"Cache-Control": "no-store"})
        elif path == "/paper.pdf" or path == "/download":
            extra = {"Content-Disposition": 'attachment; filename="paper-extensionless.pdf"'} if path == "/download" else {}
            self._send(200, PDF, "application/pdf" if path == "/paper.pdf" else "application/octet-stream", extra)
        elif path == "/book.epub":
            self._send(200, EPUB, "application/epub+zip")
        elif path == "/redirect-same":
            self._send(302, b"", "text/plain", {"Location": "/paper.pdf"})
        elif path == "/redirect-cross":
            self._send(302, b"", "text/plain", {"Location": f"http://{OTHER_HOST}:{PORT}/paper.pdf"})
        elif path == "/login.pdf":
            self._send(200, LOGIN_PAGE.encode(), "text/html; charset=utf-8")
        elif path == "/huge.pdf":
            # unknown length: a chunked stream that keeps going past the pdf limit
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            chunk = b"\0" * (1024 * 1024)
            try:
                self.wfile.write(f"{len(PDF):x}\r\n".encode() + PDF + b"\r\n")
                for _ in range(130):
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/huge-declared.pdf":
            # honest but oversized declaration; the body is never fully sent
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(130 * 1024 * 1024))
            self.end_headers()
            try:
                self.wfile.write(PDF)
                chunk = b"\0" * (1024 * 1024)
                for _ in range(130):
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/internal-only":
            self._send(200, b"internal", "text/plain")
        else:
            self._send(404, b"not found", "text/plain")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write(f"fixture origin on :{PORT}\n")
    server.serve_forever()
