import { readFileSync } from "node:fs";
import path from "node:path";

const canonicalReaderEpub = Buffer.from(
  readFileSync(
    path.resolve(
      __dirname,
      "../../../testdata/epub/canonical-reader-positions.epub.b64",
    ),
    "utf8",
  ).trim(),
  "base64",
);

export function uniqueCanonicalReaderEpub(runIdentity: string): Buffer {
  const endOfCentralDirectory = canonicalReaderEpub.lastIndexOf(
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  );
  if (endOfCentralDirectory < 0) {
    throw new Error("The canonical reader EPUB has no ZIP end record.");
  }
  const comment = Buffer.from(`nexus-test:${runIdentity}`, "utf8");
  const archive = Buffer.from(
    canonicalReaderEpub.subarray(0, endOfCentralDirectory + 22),
  );
  archive.writeUInt16LE(comment.byteLength, endOfCentralDirectory + 20);
  return Buffer.concat([archive, comment]);
}
