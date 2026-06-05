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
