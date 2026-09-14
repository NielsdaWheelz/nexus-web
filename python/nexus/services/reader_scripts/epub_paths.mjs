// Match the existing reader's normalizeTocLinkPath, preserving URL.pathname bytes.
import { createInterface } from "node:readline";
import { writeSync } from "node:fs";

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const href = JSON.parse(line);
  if (typeof href !== "string") throw new Error("EPUB source href must be a string");
  const trimmed = href.trim();
  let pathname = null;
  if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("?") &&
      !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    try {
      pathname = new URL(trimmed, "https://epub.local/").pathname.replace(/^\/+/, "") || null;
    } catch {
      pathname = trimmed.replace(/^\/+/, "") || null;
    }
  }
  const output = Buffer.from(JSON.stringify(pathname) + "\n");
  let offset = 0;
  while (offset < output.length) offset += writeSync(1, output, offset);
}
