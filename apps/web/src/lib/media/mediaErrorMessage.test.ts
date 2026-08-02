import { describe, expect, it } from "vitest";
import { mediaErrorMessage } from "./mediaErrorMessage";

const noSourceActions = {
  can_retry: false,
  can_refresh_source: false,
};

describe("mediaErrorMessage", () => {
  it("presents source suspension without a public repair action", () => {
    expect(
      mediaErrorMessage({
        kind: "Source",
        processingStatus: "suspended",
        lastErrorCode: null,
        capabilities: noSourceActions,
        sourceUrl: "https://example.com/article",
      }),
    ).toEqual({
      kind: "Source",
      severity: "error",
      title: "Import stopped; repair required.",
      explanation:
        "Automatic retries are exhausted. The stopped import remains visible for operator repair.",
      action: { kind: "None" },
    });
  });

  it("guides access-denied sources through the existing source URL", () => {
    expect(
      mediaErrorMessage({
        kind: "Source",
        processingStatus: "failed",
        lastErrorCode: "E_SOURCE_ACCESS_DENIED",
        capabilities: noSourceActions,
        sourceUrl: "https://example.com/article",
      }),
    ).toMatchObject({
      title: "This page blocked the import.",
      explanation:
        "Open the original page in your browser and use Nexus Capture there.",
      action: {
        kind: "OpenSource",
        href: "https://example.com/article",
      },
    });
  });

  it.each([
    [
      "E_INVALID_FILE_TYPE",
      "This link is not a valid PDF or EPUB.",
      "Use a valid direct download link or upload the file.",
    ],
    [
      "E_SOURCE_TOO_LARGE",
      "This document is too large to import.",
      "Use a smaller PDF or EPUB, or upload a smaller file.",
    ],
    [
      "E_SOURCE_NOT_READABLE",
      "Nexus could not find a readable article.",
      "Use a different source, or open the original page and capture it from your browser.",
    ],
  ])("presents terminal source guidance for %s", (lastErrorCode, title, explanation) => {
    expect(
      mediaErrorMessage({
        kind: "Source",
        processingStatus: "failed",
        lastErrorCode,
        capabilities: noSourceActions,
        sourceUrl: null,
      }),
    ).toMatchObject({
      title,
      explanation,
      action: { kind: "None" },
    });
  });

  it("offers Retry only from the backend capability", () => {
    expect(
      mediaErrorMessage({
        kind: "Source",
        processingStatus: "failed",
        lastErrorCode: "E_SOURCE_FETCH_FAILED",
        capabilities: {
          can_retry: true,
          can_refresh_source: true,
        },
        sourceUrl: null,
      }),
    ).toMatchObject({
      title: "Import failed.",
      action: { kind: "Retry" },
    });
  });

  it("defects on an unknown owned source error code", () => {
    expect(() =>
      mediaErrorMessage({
        kind: "Source",
        processingStatus: "failed",
        lastErrorCode: "E_INVENTED",
        capabilities: noSourceActions,
        sourceUrl: null,
      }),
    ).toThrow("Unsupported media source error code: E_INVENTED");
  });

  it.each([
    ["pending", "Search and AI are still preparing."],
    ["indexing", "Search and AI are still preparing."],
    ["failed", "This document is readable, but search and AI are unavailable."],
    ["suspended", "Search and AI stopped and need repair."],
    ["no_text", "Search and AI are unavailable because no text was found."],
    ["ocr_required", "Search and AI are unavailable until this document has OCR."],
  ])("presents retrieval status %s", (retrievalStatus, title) => {
    expect(
      mediaErrorMessage({
        kind: "Retrieval",
        retrievalStatus,
      }),
    ).toMatchObject({
      kind: "Retrieval",
      title,
      action: { kind: "None" },
    });
  });

  it("defects on an unknown owned retrieval status", () => {
    expect(() =>
      mediaErrorMessage({
        kind: "Retrieval",
        retrievalStatus: "invented",
      }),
    ).toThrow("Unsupported media retrieval status: invented");
  });
});
