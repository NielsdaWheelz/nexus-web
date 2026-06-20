import { describe, expect, it } from "vitest";
import {
  isDocumentProcessingTerminal,
  requireDocumentProcessingStatus,
  shouldLoadInitialMediaFragments,
  shouldLoadWebArticleFragments,
} from "./documentReadiness";

describe("requireDocumentProcessingStatus", () => {
  it("accepts only media document processing statuses", () => {
    expect(requireDocumentProcessingStatus("pending")).toBe("pending");
    expect(requireDocumentProcessingStatus("extracting")).toBe("extracting");
    expect(requireDocumentProcessingStatus("ready_for_reading")).toBe(
      "ready_for_reading",
    );
    expect(requireDocumentProcessingStatus("failed")).toBe("failed");
    expect(() => requireDocumentProcessingStatus("embedding")).toThrow(
      "Unsupported media processing status",
    );
    expect(() => requireDocumentProcessingStatus("ready")).toThrow(
      "Unsupported media processing status",
    );
  });
});

describe("isDocumentProcessingTerminal", () => {
  it("accepts only terminal media document processing statuses", () => {
    expect(isDocumentProcessingTerminal("ready_for_reading")).toBe(true);
    expect(isDocumentProcessingTerminal("failed")).toBe(true);
    expect(isDocumentProcessingTerminal("pending")).toBe(false);
    expect(isDocumentProcessingTerminal("extracting")).toBe(false);
    expect(isDocumentProcessingTerminal("embedding")).toBe(false);
    expect(isDocumentProcessingTerminal("ready")).toBe(false);
  });
});

describe("shouldLoadInitialMediaFragments", () => {
  it("loads initial transcript fragments only when transcript media can read", () => {
    expect(
      shouldLoadInitialMediaFragments({
        kind: "podcast_episode",
        capabilities: { can_read: true },
      }),
    ).toBe(true);
    expect(
      shouldLoadInitialMediaFragments({
        kind: "video",
        capabilities: { can_read: false },
      }),
    ).toBe(false);
  });

  it("does not prefetch reader document fragments handled by dedicated loaders or unknown kinds", () => {
    expect(
      shouldLoadInitialMediaFragments({
        kind: "web_article",
        capabilities: { can_read: true },
      }),
    ).toBe(false);
    expect(
      shouldLoadInitialMediaFragments({
        kind: "epub",
        capabilities: { can_read: true },
      }),
    ).toBe(false);
    expect(
      shouldLoadInitialMediaFragments({
        kind: "pdf",
        capabilities: { can_read: true },
      }),
    ).toBe(false);
    expect(
      shouldLoadInitialMediaFragments({
        kind: "unknown",
        capabilities: { can_read: true },
      }),
    ).toBe(false);
  });
});

// AC-2 / C9: shouldLoadInitialMediaFragments is the SINGLE initial-fragments gate, shared by
// the server seed, the client mount, and prefetch (paneResourceLoaders.media), so a server
// seed can never under-load vs the client for a kind. The five kinds below are the whole
// backend MediaKind enum. C9: a future fragment-rendering kind must be added here AND given an
// empty-seed recovery loader (the web_article / shouldLoadWebArticleFragments pattern).
describe("shouldLoadInitialMediaFragments — one gate across every media kind (AC-2/C9)", () => {
  it("allows only readable transcript kinds; every reader-document kind is false", () => {
    const cases: Array<[string, boolean, boolean]> = [
      ["podcast_episode", true, true],
      ["podcast_episode", false, false],
      ["video", true, true],
      ["video", false, false],
      ["web_article", true, false],
      ["epub", true, false],
      ["pdf", true, false],
    ];
    for (const [kind, canRead, expected] of cases) {
      expect(
        shouldLoadInitialMediaFragments({ kind, capabilities: { can_read: canRead } }),
      ).toBe(expected);
    }
  });
});

describe("shouldLoadWebArticleFragments", () => {
  it("loads deferred web article fragments only when readable and empty", () => {
    expect(
      shouldLoadWebArticleFragments(
        { kind: "web_article", capabilities: { can_read: true } },
        0,
      ),
    ).toBe(true);
    expect(
      shouldLoadWebArticleFragments(
        { kind: "web_article", capabilities: { can_read: true } },
        1,
      ),
    ).toBe(false);
    expect(
      shouldLoadWebArticleFragments(
        { kind: "web_article", capabilities: { can_read: false } },
        0,
      ),
    ).toBe(false);
  });
});
