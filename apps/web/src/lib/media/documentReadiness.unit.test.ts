import { describe, expect, it } from "vitest";
import { shouldLoadInitialMediaFragments } from "./documentReadiness";

describe("initial media fragment gate", () => {
  it("loads first-paint fragments only for readable podcast and video media", () => {
    for (const kind of ["podcast_episode", "video"]) {
      expect(
        shouldLoadInitialMediaFragments({ kind, capabilities: { can_read: true } }),
        kind,
      ).toBe(true);
      expect(
        shouldLoadInitialMediaFragments({ kind, capabilities: { can_read: false } }),
        kind,
      ).toBe(false);
    }
  });

  it("does not seed eligible document readers with the transcript fragment array", () => {
    for (const kind of ["web_article", "epub", "pdf"]) {
      expect(
        shouldLoadInitialMediaFragments({ kind, capabilities: { can_read: true } }),
        kind,
      ).toBe(false);
    }
  });
});
