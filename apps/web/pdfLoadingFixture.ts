import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** Legal, uncompressed page streams isolate byte demand from image complexity. */
function sourcePdf(bytes: number, pages: number): Buffer {
  const output = Buffer.alloc(bytes, 32);
  const offsets = [0];
  let position = output.write("%PDF-1.4\n%NEXUS\n");
  const write = (value: string) => { position += output.write(value, position, "ascii"); };
  const object = (id: number, value: string) => {
    offsets[id] = position;
    write(`${id} 0 obj\n${value}\nendobj\n`);
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 4} 0 R`).join(" ")}] /Count ${pages} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i += 1) object(i + 4,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${i + pages + 4} 0 R >>`);
  const objects = 3 + 2 * pages;
  const streamBytes = Math.floor((bytes - position - (objects + 1) * 20 - 4096) / pages) - 100;
  for (let i = 0; i < pages; i += 1) {
    const id = i + pages + 4;
    offsets[id] = position;
    write(`${id} 0 obj\n<< /Length ${streamBytes} >>\nstream\n`);
    const start = position;
    write(`BT\n/F1 18 Tf\n72 720 Td\n(Page ${i + 1} of ${pages}: needle) Tj\nET\n%`);
    position = start + streamBytes - 1;
    write("\nendstream\nendobj\n");
  }
  // Place the xref at the physical end so demand loading must reach the tail.
  const xrefBytes = `xref\n0 ${objects + 1}\n0000000000 65535 f \n` +
    offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const tailBytes = `trailer\n<< /Size ${objects + 1} /Root 1 0 R >>\nstartxref\n`;
  const xrefPosition = bytes - xrefBytes.length - tailBytes.length - 10 - "\n%%EOF\n".length;
  if (xrefPosition <= position) throw new Error("PDF recipe exceeded its encoded source size");
  position = xrefPosition;
  write(xrefBytes + tailBytes + String(xrefPosition).padStart(10, "0") + "\n%%EOF\n");
  if (position !== bytes) throw new Error("PDF recipe omitted its final source bytes");
  return output;
}

/** External HTTP boundary on the controller's existing isolated Vite server. */
export function servePdfLoadingFixture(): Plugin {
  const sources = new Map<number, { bytes: Buffer; sha256: string }>();
  const held = new Map<string, Set<() => void>>();
  return { name: "serve-pdf-loading-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (url.pathname === "/__pdf_loading/release") {
        const visit = url.searchParams.get("visit") ?? "";
        for (const release of held.get(visit) ?? []) release();
        held.delete(visit); response.statusCode = 204; response.end(); return;
      }
      const match = /^\/__pdf_loading\/(range|whole)\/(16|100)\.pdf(?:\?|$)/.exec(request.url ?? "");
      if (match === null) { next(); return; }
      const size = Number(match[2]);
      let source = sources.get(size);
      if (source === undefined) {
        const bytes = sourcePdf(size * 1024 ** 2, size * 2);
        source = { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; sources.set(size, source);
      }
      const bytes = source.bytes;
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Nexus-Test-Source-Sha256", source.sha256);
      if (match[1] === "range") response.setHeader("Accept-Ranges", "bytes");
      const requested = match[1] === "range" ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "") : null;
      const start = requested === null ? 0 : Number(requested[1]);
      const end = requested === null || requested[2] === "" ? bytes.length - 1 : Math.min(Number(requested[2]), bytes.length - 1);
      if (start > end || start >= bytes.length) { response.statusCode = 416; response.setHeader("Content-Range", `bytes */${bytes.length}`); response.end(); return; }
      response.statusCode = requested === null ? 200 : 206;
      if (requested !== null) response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
      response.setHeader("Content-Length", end - start + 1);
      const send = (from: number) => {
        const stream = Readable.from((function* () {
          for (let offset = from; offset <= end; offset += 64 * 1024) yield bytes.subarray(offset, Math.min(offset + 64 * 1024, end + 1));
        })());
        response.once("close", () => stream.destroy());
        stream.pipe(response);
      };
      if (url.searchParams.get("hold") === "1") {
        const visit = url.searchParams.get("visit");
        if (visit === null) throw new Error("Held PDF transport requires its test visit identity");
        const firstEnd = Math.min(start + 1024, end + 1);
        response.write(bytes.subarray(start, firstEnd));
        const resume = () => send(firstEnd);
        let pending = held.get(visit);
        if (pending === undefined) { pending = new Set(); held.set(visit, pending); }
        pending.add(resume);
        response.once("close", () => { pending.delete(resume); if (pending.size === 0) held.delete(visit); });
      } else send(start);
    });
  } };
}
