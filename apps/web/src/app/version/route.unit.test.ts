import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const SOURCE_SHA = "a".repeat(40);

describe("GET /version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the exact immutable deployment identity without caching", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", SOURCE_SHA);

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ source_sha: SOURCE_SHA });
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
