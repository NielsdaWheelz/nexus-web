import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import {
  SAFE_FAILURE_CODES,
  parseImportRef,
  type ImportRef,
  type SafeFailureCode,
} from "@/lib/imports/importRef";
import type {
  HistoryEntry,
  ImportItem,
  ImportState,
} from "@/lib/imports/importsClient";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  IMPORTS_SETTLED_LINE,
  IMPORT_FAILURE_COPY,
  importAgeLine,
  importConsequenceLine,
  importReasonLine,
  importStatusLine,
  historyEventLine,
  historyMatchLine,
  importsAttentionPhrase,
  importsFreshnessLine,
  importsSummaryLine,
} from "@/lib/status/imports";

/**
 * Oracle: the content rubric of `docs/cutovers/imports-workspace-hard-cutover.md`
 * ("Rows / status design", "Navigation / information design", "Inspector /
 * explanation design") and contract §6, which name these exact lines. The
 * catalog is `SAFE_FAILURE_CODES`, the browser mirror of the Python owner.
 */

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_HANDLE = "nup1.session-one.signature-one";

function ref(raw: string): ImportRef {
  const parsed = parseImportRef(raw);
  if (parsed === null) throw new Error(`fixture ref ${raw} must parse`);
  return parsed;
}

function mediaImport(state: ImportState): ImportItem {
  return {
    ref: ref(`media:${MEDIA_ID}`),
    title: "A 712-page systems book",
    mediaKind: "pdf",
    sourceLabel: absent(),
    mediaRef: present(assumeCanonicalResourceRef(`media:${MEDIA_ID}`)),
    state,
    acceptedAt: "2026-09-06T08:00:00Z",
    updatedAt: "2026-09-06T09:00:00Z",
    matchedEvent: absent(),
    capabilities: {
      canOpen: false,
      canRemove: true,
      recovery: absent(),
      unavailableReason: absent(),
    },
  };
}

function uploadImport(state: ImportState): ImportItem {
  return {
    ...mediaImport(state),
    ref: ref(`upload:${UPLOAD_HANDLE}`),
    title: "Field notes.pdf",
    mediaRef: absent(),
  };
}

const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const DISPLAY = { displayLocale: "en-US", displayTimeZone: "UTC" } as const;

function failedExtraction(): HistoryEntry {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    occurredAt: "2026-09-06T08:00:00Z",
    stage: present("Extract"),
    failureCode: present("E_SOURCE_FETCH_FAILED"),
    facts: {
      kind: "SourceFailed",
      sourceAttemptId: ATTEMPT_ID,
      executionId: absent(),
      origin: "Domain",
      terminal: false,
      progress: absent(),
    },
  };
}

function failedUpload(facts: HistoryEntry["facts"]): HistoryEntry {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    occurredAt: "2026-09-06T08:00:00Z",
    stage: present("Upload"),
    failureCode: present("E_UPLOAD_TRANSPORT_FAILED"),
    facts,
  };
}

describe("Imports copy owner", () => {
  it("names every catalogued failure code without inventing one", () => {
    expect(Object.keys(IMPORT_FAILURE_COPY).sort()).toEqual(
      [...SAFE_FAILURE_CODES].sort(),
    );
    for (const code of SAFE_FAILURE_CODES) {
      const copy = IMPORT_FAILURE_COPY[code];
      expect(copy.reason.length, `${code} has no reason line`).toBeGreaterThan(0);
      expect(copy.reason.endsWith("."), `${code} reason is a sentence`).toBe(false);
      expect(copy.title.endsWith("."), `${code} title is not a sentence`).toBe(true);
      expect(
        copy.explanation.endsWith("."),
        `${code} explanation is not a sentence`,
      ).toBe(true);
    }
  });

  it.each([
    [
      "a queued import waiting for capacity",
      mediaImport({
        kind: "Active",
        status: "Queued",
        stage: "SourceProcessing",
        waitingReason: present("Capacity"),
        progress: absent(),
        nextRetryAt: absent(),
      }),
      "Waiting for capacity",
    ],
    [
      "a queued import whose waiting reason was never recorded",
      mediaImport({
        kind: "Active",
        status: "Queued",
        stage: "Extract",
        waitingReason: absent(),
        progress: absent(),
        nextRetryAt: absent(),
      }),
      "Extraction queued",
    ],
    [
      "a queued import waiting out its retry backoff",
      mediaImport({
        kind: "Active",
        status: "Queued",
        stage: "Extract",
        waitingReason: present("RetryBackoff"),
        progress: absent(),
        nextRetryAt: present("2026-09-06T10:00:00Z"),
      }),
      "Waiting to retry",
    ],
    [
      "counted extraction progress",
      mediaImport({
        kind: "Active",
        status: "Processing",
        stage: "Extract",
        waitingReason: absent(),
        progress: present({
          kind: "Counted",
          stage: "Extract",
          completed: 80,
          total: 712,
          unit: "Page",
          run_count: 1,
          updated_at: "2026-09-06T09:00:00Z",
        }),
        nextRetryAt: absent(),
      }),
      "Extracting page 80 of 712",
    ],
    [
      "source work with no counted evidence",
      mediaImport({
        kind: "Active",
        status: "Processing",
        stage: "SourceProcessing",
        waitingReason: absent(),
        progress: absent(),
        nextRetryAt: absent(),
      }),
      "Source processing",
    ],
    [
      "indexing",
      mediaImport({
        kind: "Active",
        status: "Processing",
        stage: "Index",
        waitingReason: absent(),
        progress: absent(),
        nextRetryAt: absent(),
      }),
      "Indexing for search",
    ],
    [
      "a failed extraction",
      mediaImport({
        kind: "NeedsAttention",
        stage: "Extract",
        failureCode: present("E_SOURCE_TOO_LARGE"),
      }),
      "Extraction failed",
    ],
    [
      "an upload that never finished",
      uploadImport({
        kind: "NeedsAttention",
        stage: "Upload",
        failureCode: present("E_UPLOAD_TRANSPORT_FAILED"),
      }),
      "Upload failed",
    ],
    [
      "an upload whose link expired",
      uploadImport({
        kind: "NeedsAttention",
        stage: "Upload",
        failureCode: present("E_UPLOAD_CAPABILITY_EXPIRED"),
      }),
      "Upload link expired",
    ],
    [
      "an upload the server refused to verify",
      uploadImport({
        kind: "NeedsAttention",
        stage: "Validate",
        failureCode: present("E_SOURCE_INTEGRITY"),
      }),
      "Upload rejected",
    ],
  ])("states %s as its own status line", (_label, item, expected) => {
    expect(importStatusLine(item)).toBe(expected);
  });

  it("keeps a failure without a recorded code free of an invented reason", () => {
    const item = mediaImport({
      kind: "NeedsAttention",
      stage: "Extract",
      failureCode: absent(),
    });
    expect(importReasonLine(item)).toBeNull();
    expect(
      importReasonLine(
        mediaImport({
          kind: "NeedsAttention",
          stage: "Extract",
          failureCode: present("E_SOURCE_TOO_LARGE" satisfies SafeFailureCode),
        }),
      ),
    ).toBe(IMPORT_FAILURE_COPY.E_SOURCE_TOO_LARGE.reason);
  });

  it("promises reading after a failed search index only when the document is readable", () => {
    const item = mediaImport({
      kind: "NeedsAttention",
      stage: "Index",
      failureCode: present("E_WORKER_HANDLER_FAILED"),
    });
    expect(importConsequenceLine(item, { canRead: true })).toBe(
      "Search indexing failed. You can still read this document.",
    );
    expect(importConsequenceLine(item, { canRead: false })).toBe(
      "Search indexing failed.",
    );
  });

  it("explains a filter match in one clause and the attempt itself in full", () => {
    expect(historyMatchLine(failedExtraction(), DISPLAY)).toBe(
      "Matched: Extraction failed · Sep 6",
    );
    expect(historyEventLine(failedExtraction())).toBe(
      "Extraction failed. The source was refused. Source could not be fetched. An automatic retry follows.",
    );
  });

  it("narrates an upload and an index event with the reason that was recorded", () => {
    expect(
      historyEventLine(
        failedUpload({
          kind: "UploadFailed",
          generation: 2,
          transport: present({ kind: "HttpRejected", status: 503 }),
        }),
      ),
    ).toBe("Upload failed. The storage service rejected this upload (503).");
    const rejected: HistoryEntry = {
      ...failedUpload({
        kind: "UploadFailed",
        generation: 2,
        transport: absent(),
      }),
      stage: present("Validate"),
      failureCode: present("E_SOURCE_INTEGRITY"),
    };
    expect(
      historyEventLine(rejected),
      "a rejected upload was narrated without the code the server recorded",
    ).toBe(`Upload rejected. ${IMPORT_FAILURE_COPY.E_SOURCE_INTEGRITY.reason}.`);
    expect(
      historyMatchLine(rejected, DISPLAY),
      "the attempt list and the row named one fact two ways",
    ).toBe("Matched: Upload rejected · Sep 6");
    expect(
      historyEventLine({
        id: "66666666-6666-4666-8666-666666666666",
        occurredAt: "2026-09-06T08:00:00Z",
        stage: present("Index"),
        failureCode: present("E_WORKER_HANDLER_FAILED"),
        facts: {
          kind: "IndexFailed",
          revision: 3,
          jobId: JOB_ID,
          executionId: absent(),
          origin: "Execution",
          terminal: true,
        },
      }),
    ).toBe(
      `Search indexing failed. The run failed. ${IMPORT_FAILURE_COPY.E_WORKER_HANDLER_FAILED.reason}. No more automatic retries.`,
    );
  });

  it("dates a row by the age of what it states", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    expect(
      importAgeLine(
        mediaImport({
          kind: "NeedsAttention",
          stage: "Extract",
          failureCode: present("E_SOURCE_TOO_LARGE"),
        }),
        DISPLAY,
        now,
      ),
    ).toEqual({ dateTime: "2026-09-06T09:00:00Z", text: "Updated 3 hours ago" });
    expect(
      importAgeLine(
        mediaImport({
          kind: "Active",
          status: "Processing",
          stage: "Extract",
          waitingReason: absent(),
          progress: absent(),
          nextRetryAt: absent(),
        }),
        DISPLAY,
        now,
      ),
      "running work was dated from a change instead of its acceptance",
    ).toEqual({ dateTime: "2026-09-06T08:00:00Z", text: "Started 4 hours ago" });
  });

  it("dates the last observation in words the reader can place", () => {
    expect(
      importsFreshnessLine(
        "2026-09-08T11:58:00Z",
        { displayLocale: "en-US" },
        new Date("2026-09-08T12:00:00Z"),
      ),
    ).toBe("Last checked 2 minutes ago");
  });

  it("counts attention for the navigation without a plural it cannot claim", () => {
    expect(importsAttentionPhrase(1)).toBe("1 needs attention");
    expect(importsAttentionPhrase(3)).toBe("3 need attention");
    expect(
      importsSummaryLine({
        observedAt: "2026-09-08T12:00:00Z",
        needsAttentionCount: 3,
        activeCount: 2,
      }),
    ).toBe("3 need attention · 2 in progress");
    expect(
      importsSummaryLine({
        observedAt: "2026-09-08T12:00:00Z",
        needsAttentionCount: 0,
        activeCount: 0,
      }),
    ).toBe(IMPORTS_SETTLED_LINE);
  });
});
