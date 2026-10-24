// Canonical packaged web entrypoint. TLS/H2 owns the public port; Next's pinned
// standalone runtime owns an ephemeral loopback upstream. Streams are piped,
// never buffered or retried; disconnect cancels only their delivery request.
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createSecureServer } from "node:http2";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// HTTP/2 prohibits connection-specific headers. Also remove headers named by
// an upstream Connection field; preserve arrays such as Set-Cookie verbatim.
function endToEnd(headers) {
  const excluded = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "http2-settings",
    ...(headers.connection ?? "").split(",").map(name => name.trim().toLowerCase()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(":") && !excluded.has(name)));
}

try {
  const publicPort = Number(required("PORT"));
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  const hostname = required("HOSTNAME");
  const cert = await readFile(required("NEXUS_WEB_TLS_CERT_FILE"));
  const key = await readFile(required("NEXUS_WEB_TLS_KEY_FILE"));
  const edge = createSecureServer({ cert, key, allowHTTP1: false });
  // No ALPN is not permission to serve HTTP/1, either.
  edge.on("unknownProtocol", socket => socket.destroy());
  const config = JSON.parse(await readFile(join(directory, ".next/required-server-files.json"), "utf8")).config;
  process.env.NODE_ENV = "production";
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  process.chdir(directory);
  require("next");
  const { startServer } = require("next/dist/server/lib/start-server");
  await startServer({ dir: directory, isDev: false, port: 0, hostname: "127.0.0.1", allowRetry: false });
  // Next publishes the kernel-assigned port before its startup promise settles.
  const upstreamPort = Number(process.env.PORT);
  process.env.PORT = String(publicPort);

  edge.on("request", (incoming, outgoing) => {
    if (incoming.method === "CONNECT") {
      outgoing.writeHead(405);
      outgoing.end();
      return;
    }
    const headers = endToEnd(incoming.headers);
    headers.host = incoming.headers[":authority"] ?? incoming.headers.host;
    if (!headers.host) {
      outgoing.writeHead(400);
      outgoing.end("request authority is required\n");
      return;
    }
    headers["x-forwarded-host"] = headers.host;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-port"] = String(publicPort);
    headers["x-forwarded-for"] = incoming.socket.remoteAddress;
    delete headers.forwarded;
    const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url, headers });
    upstream.on("response", response => {
      outgoing.writeHead(response.statusCode, endToEnd(response.headers));
      response.on("error", error => outgoing.destroy(error));
      response.pipe(outgoing);
    });
    upstream.on("error", error => {
      if (outgoing.destroyed) return;
      console.error("web upstream request failed", error);
      if (outgoing.headersSent) outgoing.destroy(error);
      else {
        outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("web server unavailable\n");
      }
    });
    incoming.on("aborted", () => upstream.destroy());
    incoming.on("error", () => upstream.destroy());
    outgoing.on("error", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  const sessions = new Set();
  edge.on("session", session => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
    session.on("error", error => console.error("web http2 session failed", error));
  });
  // Next owns its upstream shutdown. Closing public sessions releases its
  // streaming delivery requests so the same process can finish that shutdown.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    edge.close();
    for (const session of sessions) session.destroy();
  });
  await new Promise((resolve, reject) => {
    edge.once("error", reject);
    edge.listen(publicPort, hostname, resolve);
  });
  edge.on("error", error => {
    console.error("web listener failed", error);
    process.exit(1);
  });
  console.log(`web ready at https://${hostname}:${publicPort} (http2)`);
} catch (error) {
  console.error(`web: ${error.message}`);
  process.exit(1);
}
