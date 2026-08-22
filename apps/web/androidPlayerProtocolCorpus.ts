import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Build- and proof-time identity of the sole Android player protocol oracle:
 * the SHA-256 of the file's raw bytes, never a re-serialization. This is build
 * tooling beside `next.config.ts`, not product source; the web build injects
 * the digest as `NEXT_PUBLIC_ANDROID_PLAYER_PROTOCOL_CONTRACT_SHA256` and the
 * runtime reads only that.
 */
export const ANDROID_PLAYER_PROTOCOL_CORPUS_PATH =
  "testdata/android/player-protocol.json";

export function androidPlayerProtocolContractSha256(): string {
  return createHash("sha256")
    .update(
      readFileSync(
        path.resolve(__dirname, "../..", ANDROID_PLAYER_PROTOCOL_CORPUS_PATH),
      ),
    )
    .digest("hex");
}
