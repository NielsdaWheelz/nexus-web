import { describe, expect, it } from "vitest";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import { IMPORT_FAILURE_COPY } from "@/lib/status/imports";
import { mediaErrorMessage } from "@/lib/media/mediaErrorMessage";

/**
 * Oracle: contract §6 — this module is a total mapping from the one failure
 * record plus this viewer's capabilities, source URL and retrieval status to a
 * reader-facing presentation; it holds no second reason dictionary and no
 * switch on the failure code.
 */

const SOURCE_URL = "https://example.invalid/article";

function sourceInput(
  lastErrorCode: string | null,
  capabilities: { can_retry: boolean },
  sourceUrl: string | null = SOURCE_URL,
) {
  return {
    kind: "Source" as const,
    processingStatus: "failed" as const,
    lastErrorCode,
    capabilities,
    sourceUrl,
  };
}

describe("media error presentation", () => {
  it("shows the failure record's own words rather than a second dictionary", () => {
    const presentation = mediaErrorMessage(
      sourceInput("E_SOURCE_FETCH_FAILED", { can_retry: true }),
    );
    expect(presentation).toEqual({
      kind: "Source",
      severity: "error",
      title: IMPORT_FAILURE_COPY.E_SOURCE_FETCH_FAILED.title,
      explanation: IMPORT_FAILURE_COPY.E_SOURCE_FETCH_FAILED.explanation,
      action: { kind: "Retry" },
    });
  });

  it("gives a code that once shared one generic failure line its own words", () => {
    const presentation = mediaErrorMessage(
      sourceInput("E_INGEST_TIMEOUT", { can_retry: true }),
    );
    expect(presentation?.title, "a catalogued cause was hidden behind a generic line").toBe(
      IMPORT_FAILURE_COPY.E_INGEST_TIMEOUT.title,
    );
    expect(presentation?.explanation).toBe(
      IMPORT_FAILURE_COPY.E_INGEST_TIMEOUT.explanation,
    );
  });

  it("offers a retry only where the same source can help and this viewer may retry", () => {
    expect(
      mediaErrorMessage(
        sourceInput("E_SOURCE_FETCH_FAILED", { can_retry: false }),
      )?.action,
    ).toEqual({ kind: "None" });
    expect(
      mediaErrorMessage(
        sourceInput("E_BILLING_REQUIRED", { can_retry: true }),
      )?.action,
      "a retry was offered for a cause the same source cannot clear",
    ).toEqual({ kind: "None" });
    expect(
      mediaErrorMessage(
        sourceInput("E_SOURCE_TOO_LARGE", { can_retry: true }),
      )?.action,
      "a same-source-terminal reason still offered the same source",
    ).toEqual({ kind: "None" });
  });

  it("offers the original page when only capturing it there can help", () => {
    expect(
      mediaErrorMessage(
        sourceInput("E_SOURCE_ACCESS_DENIED", { can_retry: true }),
      )?.action,
    ).toEqual({ kind: "OpenSource", href: SOURCE_URL });
    expect(
      mediaErrorMessage(
        sourceInput(
          "E_SOURCE_ACCESS_DENIED",
          { can_retry: true },
          null,
        ),
      )?.action,
      "an offer to open a source Nexus never recorded",
    ).toEqual({ kind: "None" });
  });

  it("states that a readable document survives its failed search index", () => {
    expect(
      mediaErrorMessage({ kind: "Retrieval", retrievalStatus: "failed" }),
    ).toEqual({
      kind: "Retrieval",
      severity: "error",
      title: "This document is readable, but search and AI are unavailable.",
      explanation: "Reading and quoting remain available.",
      action: { kind: "None" },
    });
    expect(
      mediaErrorMessage({ kind: "Retrieval", retrievalStatus: "ready" }),
    ).toBeNull();
  });

  it("tells the reader which command recovers a stopped import", () => {
    expect(
      mediaErrorMessage({
        kind: "Source",
        processingStatus: "suspended",
        lastErrorCode: null,
        capabilities: { can_retry: false },
        sourceUrl: null,
      }),
      "a state Imports offers this reader a command for was called operator work",
    ).toEqual({
      kind: "Source",
      severity: "error",
      title: "Processing stopped before this import finished.",
      explanation: `Automatic retries are used up. Imports offers ${RESOURCE_ACTION_CATALOG["ResourceOperation.Media.RepairSource"].label}, which runs the stopped attempt again without creating a new one.`,
      action: { kind: "None" },
    });
  });

  it("tells the reader which command rebuilds a stopped search index", () => {
    expect(
      mediaErrorMessage({ kind: "Retrieval", retrievalStatus: "suspended" }),
      "a state Imports offers this reader a command for was called internal",
    ).toEqual({
      kind: "Retrieval",
      severity: "error",
      title: "Search indexing stopped. You can still read this document.",
      explanation: `${RESOURCE_ACTION_CATALOG["ResourceOperation.Media.RepairSearch"].label} in Imports rebuilds it from the text already imported; the source is not fetched or extracted again.`,
      action: { kind: "None" },
    });
  });

  it("defects on a source code that is not in the catalog", () => {
    expect(() =>
      mediaErrorMessage(
        sourceInput("E_NOT_A_CATALOGUED_CODE", { can_retry: true }),
      ),
    ).toThrow(/E_NOT_A_CATALOGUED_CODE/);
  });
});
