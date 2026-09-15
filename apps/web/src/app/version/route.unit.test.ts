import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const SOURCE_SHA = "a".repeat(40);
const PROTOCOL_CONTRACT_SHA256 = createHash("sha256")
  .update(
    readFileSync(
      path.resolve(
        __dirname,
        "../../../../../testdata/android/player-protocol.json",
      ),
    ),
  )
  .digest("hex");

describe("GET /version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the exact immutable deployment identity without caching", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", SOURCE_SHA);

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      source_sha: SOURCE_SHA,
      player_protocol: {
        version: 2,
        contract_sha256: PROTOCOL_CONTRACT_SHA256,
      },
    });
  });

  it.each([undefined, "", "A".repeat(40), "a".repeat(39), ` ${SOURCE_SHA}`])(
    "fails closed for a missing or malformed deployment identity",
    (sourceSha) => {
      if (sourceSha === undefined) {
        delete process.env.VERCEL_GIT_COMMIT_SHA;
      } else {
        vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sourceSha);
      }

      expect(() => GET()).toThrow(/VERCEL_GIT_COMMIT_SHA/);
    },
  );

});
