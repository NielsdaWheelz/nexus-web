// Readiness for the canonical H2-only edge; trust is scoped to the supplied CA.
// Usage: node probe-web.mjs <https-origin> <ca-file>. stdout is /version JSON.
import { readFile } from "node:fs/promises";
import { connect } from "node:http2";
import { isIP } from "node:net";

try {
  const [origin, caFile] = process.argv.slice(2);
  if (!origin || !caFile || process.argv.length !== 4)
    throw new Error("usage: probe-web.mjs <https-origin> <ca-file>");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin)
    throw new Error("an https origin is required");
  const client = connect(origin, { ca: await readFile(caFile), servername: isIP(url.hostname) ? "" : url.hostname });
  try {
    const value = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("web readiness timed out")), 5000);
      const fail = error => { clearTimeout(timeout); reject(error); };
      client.on("error", fail);
      client.on("connect", () => {
        if (client.alpnProtocol !== "h2") return fail(new Error("web did not negotiate h2"));
        const request = client.request({ ":method": "GET", ":path": "/version" });
        let body = "";
        request.setEncoding("utf8");
        request.on("error", fail);
        request.on("response", headers => {
          if (headers[":status"] !== 200) fail(new Error(`web readiness returned ${headers[":status"]}`));
        });
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          clearTimeout(timeout);
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
        request.end();
      });
    });
    console.log(JSON.stringify(value));
  } finally {
    client.destroy();
  }
} catch (error) {
  console.error(`web readiness: ${error.message}`);
  process.exitCode = 1;
}
