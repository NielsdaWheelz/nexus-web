import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Build- and proof-time reader of the sole Android player protocol oracle.
 * The identity is the SHA-256 of the file's raw bytes; nothing re-serializes
 * it. This is build tooling beside `next.config.ts`, never product source:
 * the web build injects the digest as
 * `NEXT_PUBLIC_ANDROID_PLAYER_PROTOCOL_CONTRACT_SHA256` and the runtime reads
 * only that.
 */
export const ANDROID_PLAYER_PROTOCOL_CORPUS_PATH =
  "testdata/android/player-protocol.json";

export type AndroidPlayerProtocolCorpus = {
  readonly bytes: Buffer;
  readonly contractSha256: string;
};

export function readAndroidPlayerProtocolCorpus(): AndroidPlayerProtocolCorpus {
  const bytes = readFileSync(
    path.resolve(__dirname, "../..", ANDROID_PLAYER_PROTOCOL_CORPUS_PATH),
  );
  return {
    bytes,
    contractSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
