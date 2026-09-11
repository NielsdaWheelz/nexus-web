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
import { UploadSessionError } from "@/lib/media/ingestionClient";
import {
  IMPORTS_SETTLED_LINE,
  IMPORT_FAILURE_COPY,
  importAgeLine,
  importConsequenceLine,
  importReasonLine,
  importRecoveryAbsenceLine,
  importStatusLine,
  historyEventLine,
  historyMatchLine,
  importsAttentionPhrase,
  importsDateChipLabel,
  importsDateFilterLabel,
  importsBriefSegments,
  importsSummaryLine,
  uploadSessionActionErrorMessage,
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
const NOW = new Date("2026-09-08T12:00:00Z");

function failedExtraction(
  progress: Extract<
    HistoryEntry["facts"],
    { kind: "SourceFailed" }
  >["progress"] = absent(),
): HistoryEntry {
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
      terminal: true,
      progress,
    },
  };
}

/**
 * The one failure class that is not terminal: the queue's own execution
 * failure, recorded with the queue's `terminal` flag (`jobs/history_projections`).
 */
function interruptedRun(): HistoryEntry {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    occurredAt: "2026-09-06T08:30:00Z",
    stage: present("Extract"),
    failureCode: present("E_WORKER_INTERRUPTED"),
    facts: {
      kind: "SourceFailed",
      sourceAttemptId: ATTEMPT_ID,
      executionId: absent(),
      origin: "Execution",
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
    expect(historyMatchLine(failedExtraction(), DISPLAY, NOW)).toBe(
      "Matched: Extraction failed · Sep 6",
    );
    expect(
      historyMatchLine(
        { ...failedExtraction(), occurredAt: "2025-09-06T08:00:00Z" },
        DISPLAY,
        NOW,
      ),
      "an event from an earlier year was dated as if it were this one",
    ).toBe("Matched: Extraction failed · Sep 6, 2025");
    expect(
      historyEventLine(failedExtraction()),
      "a domain failure was narrated as the source refusing Nexus",
    ).toBe(
      "Extraction failed. The import could not use this source. Source could not be fetched. No more automatic retries.",
    );
    expect(
      historyEventLine(interruptedRun()),
      "an execution failure that will be retried promised no retry",
    ).toBe(
      `Extraction failed. The run failed. ${IMPORT_FAILURE_COPY.E_WORKER_INTERRUPTED.reason}. An automatic retry follows.`,
    );
  });

  it("narrates a recorded stage change as a moment, not as work in flight", () => {
    expect(
      historyEventLine({
        id: "88888888-8888-4888-8888-888888888888",
        occurredAt: "2026-09-06T08:10:00Z",
        stage: present("Extract"),
        failureCode: absent(),
        facts: {
          kind: "SourceStageChanged",
          sourceAttemptId: ATTEMPT_ID,
          executionId: JOB_ID,
        },
      }),
      "a past event read as work still running",
    ).toBe("Extraction started");
  });

  it("says how far a run had got when its progress was recorded at the failure", () => {
    expect(
      historyEventLine(
        failedExtraction(
          present({ completed: 480, total: present(712), unit: present("Page") }),
        ),
      ),
      "the counted progress recorded at the failure was never shown",
    ).toBe(
      "Extraction failed. The import could not use this source. Source could not be fetched. No more automatic retries. Stopped at page 480 of 712.",
    );
    expect(
      historyEventLine(
        failedExtraction(
          present({ completed: 480, total: absent(), unit: present("Page") }),
        ),
      ),
      "a count without a recorded total claimed one",
    ).toBe(
      "Extraction failed. The import could not use this source. Source could not be fetched. No more automatic retries. Stopped at page 480.",
    );
  });

  it("names the outcome a baseline attempt recorded, not only the detail it lacks", () => {
    const baseline = (
      outcome: Extract<
        HistoryEntry["facts"],
        { kind: "SourceHistoryBaseline" }
      >["outcome"],
    ): HistoryEntry => ({
      id: "99999999-9999-4999-8999-999999999999",
      occurredAt: "2026-09-06T07:00:00Z",
      stage: absent(),
      failureCode: absent(),
      facts: {
        kind: "SourceHistoryBaseline",
        sourceAttemptId: ATTEMPT_ID,
        attemptNo: 1,
        outcome,
      },
    });
    expect(
      historyEventLine(
        baseline({ kind: "Failed", failureCode: "E_SOURCE_TOO_LARGE" }),
      ),
      "a pre-cut attempt the migration recorded as failed read exactly like one recorded as succeeded",
    ).toBe(
      `Detailed execution history was not recorded. This attempt failed: ${IMPORT_FAILURE_COPY.E_SOURCE_TOO_LARGE.reason}.`,
    );
    expect(historyEventLine(baseline({ kind: "Succeeded" }))).toBe(
      "Detailed execution history was not recorded. This attempt succeeded.",
    );
    expect(historyEventLine(baseline({ kind: "InFlight" }))).toBe(
      "Detailed execution history was not recorded. This attempt was still running.",
    );
    expect(
      historyEventLine({
        id: "10101010-1010-4010-8010-101010101010",
        occurredAt: "2026-09-06T07:00:00Z",
        stage: absent(),
        failureCode: absent(),
        facts: { kind: "UploadHistoryBaseline", generation: 1 },
      }),
      "an upload baseline records no outcome and must not be given one",
    ).toBe("Detailed execution history was not recorded");
  });

  it("says a superseded command moved on rather than claiming it finished", () => {
    expect(
      uploadSessionActionErrorMessage(
        new UploadSessionError({ kind: "Superseded" }),
      ),
      "a stale generation and a lost session were both told the import finished",
    ).toBe("This import moved on. Imports has been refreshed.");
  });

  it("keeps a standing negative off work that has nothing to recover", () => {
    expect(
      importRecoveryAbsenceLine({
        kind: "Active",
        status: "Processing",
        stage: "Extract",
        waitingReason: absent(),
        progress: absent(),
        nextRetryAt: absent(),
      }),
      "running work was told a recovery is missing",
    ).toBeNull();
    expect(importRecoveryAbsenceLine({ kind: "Complete" })).toBe(
      "This import finished. There is nothing to recover.",
    );
    expect(
      importRecoveryAbsenceLine({
        kind: "NeedsAttention",
        stage: "Extract",
        failureCode: absent(),
      }),
    ).toBe("No recovery is offered for this import.");
  });

  it("names which recorded time a History date range bounds", () => {
    expect(importsDateFilterLabel("Failure")).toBe("Failed during");
    expect(importsDateFilterLabel("AnyEvent")).toBe("Recorded during");
    // The bound is a UTC calendar day (contract D17) named the way every other
    // date this owner writes is named — never the URL's own spelling, and never
    // the day before it, whatever zone the reader is in.
    expect(
      importsDateChipLabel("Failure", "From", "2026-08-09", "en-US"),
      "an applied date filter named the URL parameter instead of the bound",
    ).toBe("Failed on or after Aug 9, 2026");
    expect(importsDateChipLabel("Failure", "Before", "2026-08-09", "en-US")).toBe(
      "Failed before Aug 9, 2026",
    );
    expect(importsDateChipLabel("AnyEvent", "From", "2026-08-09", "en-US")).toBe(
      "Recorded on or after Aug 9, 2026",
    );
    expect(importsDateChipLabel("AnyEvent", "Before", "2026-08-09", "en-US")).toBe(
      "Recorded before Aug 9, 2026",
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
    expect(
      historyEventLine({
        ...failedUpload({ kind: "UploadExecutionStarted", generation: 2 }),
        stage: present("Validate"),
        failureCode: absent(),
      }),
      "server-side verification starting was narrated as the upload starting",
    ).toBe("Validation started");
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
      historyMatchLine(rejected, DISPLAY, NOW),
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

  it("joins only the brief segments this read has, so no separator opens the line", () => {
    const now = new Date("2026-09-08T12:00:00Z");
    expect(
      importsBriefSegments(4, "2026-09-08T11:58:00Z", DISPLAY, now),
      "a read page and its observation were not both stated",
    ).toEqual(["4 imports in this view", "Last checked 2 minutes ago"]);
    expect(
      importsBriefSegments(null, "2026-09-08T11:58:00Z", DISPLAY, now),
      "an unread page still carried the separator the count it lacks would need",
    ).toEqual(["Last checked 2 minutes ago"]);
    expect(
      importsBriefSegments(1, null, DISPLAY, now),
      "a page read before any observation landed carried a stray separator",
    ).toEqual(["1 import in this view"]);
    expect(importsBriefSegments(null, null, DISPLAY, now)).toEqual([]);
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
