"""temporary storage proxy: forwards to minio, delaying PUT bodies by DELAY_SECONDS.

the api signs upload urls against this origin during the popup-closure journey;
sigv4 covers the host header, which is forwarded unchanged.
"""

from __future__ import annotations

import http.client
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = int(os.environ.get("PROXY_PORT", "9100"))
UPSTREAM = ("127.0.0.1", int(os.environ.get("MINIO_PORT", "9000")))
DELAY = float(os.environ.get("DELAY_SECONDS", "8"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: D102
        sys.stderr.write("proxy %s\n" % (fmt % args))

    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.command == "PUT" and DELAY > 0:
            sys.stderr.write(f"proxy delaying PUT {self.path} for {DELAY}s\n")
            time.sleep(DELAY)
        upstream = http.client.HTTPConnection(*UPSTREAM, timeout=120)
        headers = {key: value for key, value in self.headers.items() if key.lower() != "transfer-encoding"}
        upstream.request(self.command, self.path, body=body, headers=headers)
        response = upstream.getresponse()
        payload = response.read()
        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() in ("transfer-encoding", "connection"):
                continue
            self.send_header(key, value)
        if not any(k.lower() == "content-length" for k, _ in response.getheaders()):
            self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        upstream.close()

    do_GET = do_PUT = do_POST = do_HEAD = do_DELETE = do_OPTIONS = _forward


if __name__ == "__main__":
    sys.stderr.write(f"storage delay proxy on :{LISTEN} -> {UPSTREAM} delay={DELAY}s\n")
    ThreadingHTTPServer(("127.0.0.1", LISTEN), Handler).serve_forever()
