import { describe, expect, it } from "vitest";
import { assertNever } from "@/lib/assertNever";
import { absent, present } from "@/lib/api/presence";
import {
  decodeImportDetail,
  decodeImportHistoryPage,
  decodeImportPage,
  decodeImportSummary,
  decodeSearchAdmission,
  decodeSourceAdmission,
  type HistoryFacts,
} from "./importsClient";
import { parseImportRef } from "./importRef";

/**
 * Oracle: the Imports wire contract — the DTOs of the cutover contract §4 and
 * the `HistoryEntry` facts variants of §2. The decoder is the one boundary that
 * turns those payloads into owned data, so it must accept exactly the declared
 * shape, keep every declared owned absence as `Presence`, and refuse a page
 * whose declared cross-field invariants the server failed to preserve.
 */
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const WINNER_MEDIA_ID = "12121212-1212-4212-8212-121212121212";
const UPLOAD_REF = "upload:nup1.session-one.signature-one";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const NEXT_ATTEMPT_ID = "23232323-2323-4323-8323-232323232323";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const EXECUTION_ID = "44444444-4444-4444-8444-444444444444";
const OBSERVED_AT = "2026-09-08T12:00:00Z";
const OCCURRED_AT = "2026-09-08T11:59:00Z";

/** The §2 variant catalog, in branch order: upload, source, index. */
const HISTORY_FACT_KINDS = [
  "UploadAccepted",
  "UploadExecutionStarted",
  "UploadFailed",
  "UploadRecoveryAccepted",
  "UploadPublished",
  "UploadHistoryBaseline",
  "SourceAccepted",
  "SourceExecutionStarted",
  "SourceStageChanged",
  "SourceRetryScheduled",
  "SourceFailed",
  "SourceRecoveryAccepted",
  "SourceSucceeded",
  "SourceSuperseded",
  "SourceHistoryBaseline",
  "IndexAccepted",
  "IndexExecutionStarted",
  "IndexRetryScheduled",
  "IndexFailed",
  "IndexRecoveryAccepted",
  "IndexSucceeded",
  "IndexSuperseded",
] as const;

const HISTORY_FACTS: readonly Record<string, unknown>[] = [
  { kind: "UploadAccepted", generation: 1 },
  { kind: "UploadExecutionStarted", generation: 1 },
  {
    kind: "UploadFailed",
    generation: 1,
    transport: {
      kind: "Present",
      value: { kind: "HttpRejected", status: 503 },
    },
  },
  { kind: "UploadRecoveryAccepted", generation: 2 },
  {
    kind: "UploadPublished",
    generation: 2,
    media_id: MEDIA_ID,
    source_attempt_id: ATTEMPT_ID,
  },
  { kind: "UploadHistoryBaseline", generation: 2 },
  { kind: "SourceAccepted", source_attempt_id: ATTEMPT_ID, attempt_no: 1 },
  {
    kind: "SourceExecutionStarted",
    source_attempt_id: ATTEMPT_ID,
    execution_id: EXECUTION_ID,
  },
  {
    kind: "SourceStageChanged",
    source_attempt_id: ATTEMPT_ID,
    execution_id: EXECUTION_ID,
  },
  {
    kind: "SourceRetryScheduled",
    source_attempt_id: ATTEMPT_ID,
    execution_id: { kind: "Present", value: EXECUTION_ID },
    next_attempt_at: "2026-09-08T12:05:00Z",
  },
  {
    kind: "SourceFailed",
    source_attempt_id: ATTEMPT_ID,
    execution_id: { kind: "Present", value: EXECUTION_ID },
    origin: "Execution",
    terminal: false,
    progress: {
      kind: "Present",
      value: {
        completed: 84,
        total: { kind: "Present", value: 712 },
        unit: { kind: "Present", value: "Page" },
      },
    },
  },
  {
    kind: "SourceRecoveryAccepted",
    source_attempt_id: ATTEMPT_ID,
    recovery: { kind: "RetrySource", new_source_attempt_id: NEXT_ATTEMPT_ID },
  },
  {
    kind: "SourceSucceeded",
    source_attempt_id: ATTEMPT_ID,
    execution_id: { kind: "Absent" },
  },
  {
    kind: "SourceSuperseded",
    source_attempt_id: ATTEMPT_ID,
    winner_media_id: WINNER_MEDIA_ID,
  },
  {
    kind: "SourceHistoryBaseline",
    source_attempt_id: ATTEMPT_ID,
    attempt_no: 1,
    outcome: { kind: "Failed", failure_code: "E_INGEST_FAILED" },
  },
  { kind: "IndexAccepted", revision: 3, job_id: JOB_ID },
  {
    kind: "IndexExecutionStarted",
    revision: 3,
    job_id: JOB_ID,
    execution_id: EXECUTION_ID,
  },
  {
    kind: "IndexRetryScheduled",
    revision: 3,
    job_id: JOB_ID,
    execution_id: { kind: "Present", value: EXECUTION_ID },
    next_attempt_at: "2026-09-08T12:07:00Z",
  },
  {
    kind: "IndexFailed",
    revision: 3,
    job_id: JOB_ID,
    execution_id: { kind: "Absent" },
    origin: "Execution",
    terminal: true,
  },
  { kind: "IndexRecoveryAccepted", revision: 4, job_id: JOB_ID },
  {
    kind: "IndexSucceeded",
    revision: 4,
    job_id: JOB_ID,
    execution_id: EXECUTION_ID,
  },
  {
    kind: "IndexSuperseded",
    revision: 4,
    job_id: JOB_ID,
    execution_id: EXECUTION_ID,
  },
];

function eventId(index: number): string {
  return `000000${index.toString(16).padStart(2, "0")}-1111-4111-8111-111111111111`;
}

function historyEntry(
  facts: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return {
    id: eventId(index),
    occurred_at: OCCURRED_AT,
    stage: { kind: "Present", value: "Extract" },
    failure_code: { kind: "Absent" },
    facts,
  };
}

/**
 * The exhaustive consumer the union owes its readers: adding a variant must
 * break this switch at compile time, and `assertNever` proves the compiler
 * knows the match is total.
 */
function factsSubject(facts: HistoryFacts): string {
  switch (facts.kind) {
    case "UploadAccepted":
    case "UploadExecutionStarted":
    case "UploadFailed":
    case "UploadRecoveryAccepted":
    case "UploadPublished":
    case "UploadHistoryBaseline":
      return `upload generation ${facts.generation}`;
    case "SourceAccepted":
    case "SourceExecutionStarted":
    case "SourceStageChanged":
    case "SourceRetryScheduled":
    case "SourceFailed":
    case "SourceRecoveryAccepted":
    case "SourceSucceeded":
    case "SourceSuperseded":
    case "SourceHistoryBaseline":
      return `source attempt ${facts.sourceAttemptId}`;
    case "IndexAccepted":
    case "IndexExecutionStarted":
    case "IndexRetryScheduled":
    case "IndexFailed":
    case "IndexRecoveryAccepted":
    case "IndexSucceeded":
    case "IndexSuperseded":
      return `index revision ${facts.revision} job ${facts.jobId}`;
    default:
      return assertNever(facts, "HistoryFacts");
  }
}

function uploadItem(): Record<string, unknown> {
  return {
    ref: UPLOAD_REF,
    title: "Field notes.pdf",
    media_kind: "pdf",
    source_label: { kind: "Absent" },
    media_ref: { kind: "Absent" },
    state: {
      kind: "NeedsAttention",
      stage: "Upload",
      failure_code: { kind: "Present", value: "E_UPLOAD_TRANSPORT_FAILED" },
    },
    accepted_at: "2026-09-08T11:00:00Z",
    updated_at: "2026-09-08T11:30:00Z",
    matched_event: { kind: "Absent" },
    capabilities: {
      can_open: false,
      can_remove: true,
      recovery: {
        kind: "Present",
        value: {
          kind: "RetryUpload",
          expected_generation: 2,
          input: "ChooseOriginalFile",
        },
      },
      unavailable_reason: { kind: "Absent" },
    },
  };
}

function activeItem(): Record<string, unknown> {
  return {
    ref: MEDIA_REF,
    title: "The long document",
    media_kind: "epub",
    source_label: { kind: "Present", value: "example.com" },
    media_ref: { kind: "Present", value: MEDIA_REF },
    state: {
      kind: "Active",
      status: "Processing",
      stage: "Extract",
      waiting_reason: { kind: "Present", value: "RetryBackoff" },
      progress: {
        kind: "Present",
        value: {
          kind: "Counted",
          stage: "Extract",
          completed: 84,
          total: 712,
          unit: "Page",
          run_count: 2,
          updated_at: "2026-09-08T11:58:00Z",
        },
      },
      next_retry_at: { kind: "Present", value: "2026-09-08T12:05:00Z" },
    },
    accepted_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-08T11:58:00Z",
    matched_event: { kind: "Absent" },
    capabilities: {
      can_open: true,
      can_remove: true,
      recovery: { kind: "Absent" },
      unavailable_reason: { kind: "Present", value: "SameSourceTerminal" },
    },
  };
}

function recoveredItem(): Record<string, unknown> {
  return {
    ref: "media:99999999-9999-4999-8999-999999999999",
    title: "Recovered essay",
    media_kind: "web_article",
    source_label: { kind: "Present", value: "example.org" },
    media_ref: {
      kind: "Present",
      value: "media:99999999-9999-4999-8999-999999999999",
    },
    state: { kind: "Complete" },
    accepted_at: "2026-09-01T09:00:00Z",
    updated_at: "2026-09-01T09:30:00Z",
    matched_event: {
      kind: "Present",
      value: {
        id: eventId(255),
        occurred_at: "2026-09-01T09:10:00Z",
        stage: { kind: "Present", value: "Extract" },
        failure_code: { kind: "Present", value: "E_INGEST_FAILED" },
        facts: {
          kind: "SourceFailed",
          source_attempt_id: ATTEMPT_ID,
          execution_id: { kind: "Absent" },
          origin: "Domain",
          terminal: true,
          progress: { kind: "Absent" },
        },
      },
    },
    capabilities: {
      can_open: true,
      can_remove: true,
      recovery: {
        kind: "Present",
        value: {
          kind: "RepairSearch",
          expected_revision: 4,
          expected_job_id: JOB_ID,
          input: "PublishedContent",
        },
      },
      unavailable_reason: { kind: "Absent" },
    },
  };
}

function pageData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      observed_at: OBSERVED_AT,
      matched_count: 5,
      groups: [
        { stage: "Upload", count: 1 },
        { stage: "Extract", count: 1 },
      ],
      items: [uploadItem(), activeItem(), recoveredItem()],
      next_cursor: { kind: "Present", value: "imports:History:2" },
      ...overrides,
    },
  };
}

describe("Imports transport decoders", () => {
  it("decodes a page of imports and keeps every declared owned absence", () => {
    const page = decodeImportPage(pageData());

    expect(page.observedAt).toBe(OBSERVED_AT);
    expect(page.matchedCount).toBe(5);
    expect(page.groups).toEqual([
      { stage: "Upload", count: 1 },
      { stage: "Extract", count: 1 },
    ]);
    expect(page.nextCursor).toEqual(present("imports:History:2"));
    expect(page.items.map((item) => item.ref)).toEqual([
      UPLOAD_REF,
      MEDIA_REF,
      "media:99999999-9999-4999-8999-999999999999",
    ]);

    const [upload, active, recovered] = page.items;
    expect(upload.mediaRef).toEqual(absent());
    expect(upload.sourceLabel).toEqual(absent());
    expect(upload.state).toEqual({
      kind: "NeedsAttention",
      stage: "Upload",
      failureCode: present("E_UPLOAD_TRANSPORT_FAILED"),
    });
    expect(upload.capabilities.recovery).toEqual(
      present({
        kind: "RetryUpload",
        expectedGeneration: 2,
        input: "ChooseOriginalFile",
      }),
    );

    expect(active.state).toEqual({
      kind: "Active",
      status: "Processing",
      stage: "Extract",
      waitingReason: present("RetryBackoff"),
      progress: present({
        kind: "Counted",
        stage: "Extract",
        completed: 84,
        total: 712,
        unit: "Page",
        run_count: 2,
        updated_at: "2026-09-08T11:58:00Z",
      }),
      nextRetryAt: present("2026-09-08T12:05:00Z"),
    });
    expect(active.capabilities.unavailableReason).toEqual(
      present("SameSourceTerminal"),
    );

    expect(active.mediaRef).toEqual(present(MEDIA_REF));
    expect(recovered.state).toEqual({ kind: "Complete" });
    expect(recovered.matchedEvent).toEqual(
      present({
        id: eventId(255),
        occurredAt: "2026-09-01T09:10:00Z",
        stage: present("Extract"),
        failureCode: present("E_INGEST_FAILED"),
        facts: {
          kind: "SourceFailed",
          sourceAttemptId: ATTEMPT_ID,
          executionId: absent(),
          origin: "Domain",
          terminal: true,
          progress: absent(),
        },
      }),
    );
    expect(recovered.capabilities.recovery).toEqual(
      present({
        kind: "RepairSearch",
        expectedRevision: 4,
        expectedJobId: JOB_ID,
        input: "PublishedContent",
      }),
    );
  });

  it("decodes a page that matched nothing as an explicit empty result", () => {
    const page = decodeImportPage(
      pageData({
        matched_count: 0,
        groups: [],
        items: [],
        next_cursor: { kind: "Absent" },
      }),
    );

    expect(page.items).toEqual([]);
    expect(page.groups).toEqual([]);
    expect(page.matchedCount).toBe(0);
    expect(page.nextCursor).toEqual(absent());
  });

  const brokenPages: readonly [string, Record<string, unknown>, string][] = [
    [
      "more items than the query matched",
      { matched_count: 2 },
      "GET /api/imports returned more items than it matched",
    ],
    [
      "the same import twice",
      { items: [uploadItem(), activeItem(), activeItem()] },
      "GET /api/imports returned the same import twice",
    ],
    [
      "stage groups larger than the match",
      {
        groups: [
          { stage: "Upload", count: 3 },
          { stage: "Extract", count: 3 },
        ],
      },
      "GET /api/imports grouped more imports than it matched",
    ],
    [
      "a continuation cursor with nothing to continue from",
      { matched_count: 0, groups: [], items: [] },
      "GET /api/imports continues a page that returned no items",
    ],
    [
      "a null where an owned absence belongs",
      { next_cursor: null },
      "Invalid Presence: expected an object, got null",
    ],
    [
      "an unknown envelope key",
      { unread_count: 1 },
      "GET /api/imports.data must contain exactly [observed_at, matched_count, groups, items, next_cursor]",
    ],
  ];

  for (const [description, overrides, rejection] of brokenPages) {
    it(`refuses a page carrying ${description}`, () => {
      expect(() => decodeImportPage(pageData(overrides))).toThrow(rejection);
    });
  }

  it("refuses an item naming a failure code the catalog does not carry", () => {
    expect(() =>
      decodeImportPage(
        pageData({
          items: [
            {
              ...uploadItem(),
              state: {
                kind: "NeedsAttention",
                stage: "Upload",
                failure_code: { kind: "Present", value: "E_UPLOAD_HICCUP" },
              },
            },
          ],
        }),
      ),
    ).toThrow("GET /api/imports.items[0].state.failure_code.value must be one of");
  });

  it("refuses a media ref that is not the canonical resource ref grammar", () => {
    expect(() =>
      decodeImportPage(
        pageData({
          items: [{ ...activeItem(), media_ref: { kind: "Present", value: MEDIA_ID } }],
        }),
      ),
    ).toThrow("GET /api/imports.items[0].media_ref.value must be a media resource ref");
  });

  it("decodes every history facts variant into its own typed subject", () => {
    const page = decodeImportHistoryPage({
      data: {
        entries: HISTORY_FACTS.map(historyEntry),
        next_cursor: { kind: "Absent" },
      },
    });

    expect(page.entries.map((entry) => entry.facts.kind)).toEqual([
      ...HISTORY_FACT_KINDS,
    ]);
    expect(new Set(page.entries.map((entry) => factsSubject(entry.facts)))).toEqual(
      new Set([
        "upload generation 1",
        "upload generation 2",
        `source attempt ${ATTEMPT_ID}`,
        `index revision 3 job ${JOB_ID}`,
        `index revision 4 job ${JOB_ID}`,
      ]),
    );
    expect(page.nextCursor).toEqual(absent());

    const uploadFailed = page.entries[2].facts;
    if (uploadFailed.kind !== "UploadFailed") throw new Error("fixture order");
    expect(uploadFailed.transport).toEqual(
      present({ kind: "HttpRejected", status: 503 }),
    );

    const sourceFailed = page.entries[10].facts;
    if (sourceFailed.kind !== "SourceFailed") throw new Error("fixture order");
    expect(sourceFailed.progress).toEqual(
      present({
        completed: 84,
        total: present(712),
        unit: present("Page"),
      }),
    );

    const baseline = page.entries[14].facts;
    if (baseline.kind !== "SourceHistoryBaseline") {
      throw new Error("fixture order");
    }
    expect(baseline.outcome).toEqual({
      kind: "Failed",
      failureCode: "E_INGEST_FAILED",
    });

    const indexRetry = page.entries[17].facts;
    if (indexRetry.kind !== "IndexRetryScheduled") {
      throw new Error("fixture order");
    }
    expect(indexRetry.nextAttemptAt).toBe("2026-09-08T12:07:00Z");
  });

  it("preserves the historical provider rejection in a failed baseline", () => {
    const page = decodeImportHistoryPage({
      data: {
        entries: [
          historyEntry(
            {
              kind: "SourceHistoryBaseline",
              source_attempt_id: ATTEMPT_ID,
              attempt_no: 1,
              outcome: { kind: "Failed", failure_code: "E_LLM_BAD_REQUEST" },
            },
            1,
          ),
        ],
        next_cursor: { kind: "Absent" },
      },
    });

    expect(page.entries[0].facts).toEqual({
      kind: "SourceHistoryBaseline",
      sourceAttemptId: ATTEMPT_ID,
      attemptNo: 1,
      outcome: { kind: "Failed", failureCode: "E_LLM_BAD_REQUEST" },
    });
  });

  it("decodes the nested recovery and baseline outcomes a history entry can carry", () => {
    const page = decodeImportHistoryPage({
      data: {
        entries: [
          {
            kind: "SourceRecoveryAccepted",
            source_attempt_id: ATTEMPT_ID,
            recovery: { kind: "RepairSource", job_id: JOB_ID },
          },
          {
            kind: "SourceHistoryBaseline",
            source_attempt_id: ATTEMPT_ID,
            attempt_no: 2,
            outcome: { kind: "Succeeded" },
          },
          {
            kind: "SourceHistoryBaseline",
            source_attempt_id: ATTEMPT_ID,
            attempt_no: 3,
            outcome: { kind: "InFlight" },
          },
          {
            kind: "UploadFailed",
            generation: 3,
            transport: { kind: "Absent" },
          },
        ].map(historyEntry),
        next_cursor: { kind: "Present", value: "imports:history:2" },
      },
    });

    const [recovery, succeeded, inFlight, rejected] = page.entries.map(
      (entry) => entry.facts,
    );
    if (recovery.kind !== "SourceRecoveryAccepted") throw new Error("variant");
    expect(recovery.recovery).toEqual({ kind: "RepairSource", jobId: JOB_ID });
    if (succeeded.kind !== "SourceHistoryBaseline") throw new Error("variant");
    expect(succeeded.outcome).toEqual({ kind: "Succeeded" });
    if (inFlight.kind !== "SourceHistoryBaseline") throw new Error("variant");
    expect(inFlight.outcome).toEqual({ kind: "InFlight" });
    if (rejected.kind !== "UploadFailed") throw new Error("variant");
    expect(rejected.transport).toEqual(absent());
  });

  it("refuses a history entry whose facts are not a declared variant", () => {
    expect(() =>
      decodeImportHistoryPage({
        data: {
          entries: [historyEntry({ kind: "SourceHeartbeat" }, 1)],
          next_cursor: { kind: "Absent" },
        },
      }),
    ).toThrow("GET /api/imports/:ref/history.entries[0].facts.kind must be one of");
  });

  it("decodes the summary the badge counts", () => {
    expect(
      decodeImportSummary({
        data: {
          observed_at: OBSERVED_AT,
          needs_attention_count: 3,
          active_count: 2,
        },
      }),
    ).toEqual({
      observedAt: OBSERVED_AT,
      needsAttentionCount: 3,
      activeCount: 2,
    });
  });

  it("decodes a detail whose recorded history is only partial", () => {
    const detail = decodeImportDetail({
      data: {
        item: recoveredItem(),
        readiness: { can_read: true, can_search: false, can_play: false },
        history_coverage: {
          kind: "Partial",
          recorded_since: "2026-08-20T00:00:00Z",
        },
      },
    });

    expect(detail.readiness).toEqual({
      canRead: true,
      canSearch: false,
      canPlay: false,
    });
    expect(detail.historyCoverage).toEqual({
      kind: "Partial",
      recordedSince: "2026-08-20T00:00:00Z",
    });
    expect(detail.item.title).toBe("Recovered essay");
  });

  it("decodes the admission a source retry and a source repair return", () => {
    const data = {
      kind: "SourceRetry",
      media_id: MEDIA_ID,
      source_attempt_id: NEXT_ATTEMPT_ID,
      job_id: JOB_ID,
    };

    expect(decodeSourceAdmission({ data }, "SourceRetry")).toEqual({
      mediaId: MEDIA_ID,
      sourceAttemptId: NEXT_ATTEMPT_ID,
      jobId: JOB_ID,
    });
    expect(
      decodeSourceAdmission(
        { data: { ...data, kind: "SourceRepair" } },
        "SourceRepair",
      ),
    ).toEqual({
      mediaId: MEDIA_ID,
      sourceAttemptId: NEXT_ATTEMPT_ID,
      jobId: JOB_ID,
    });
    expect(() => decodeSourceAdmission({ data }, "SourceRepair")).toThrow();
    expect(() =>
      decodeSourceAdmission({ data: { ...data, requeued: true } }, "SourceRetry"),
    ).toThrow();
  });

  it("decodes the admission a search repair returns", () => {
    const data = {
      kind: "SearchRepair",
      media_id: MEDIA_ID,
      revision: 4,
      job_id: JOB_ID,
    };

    expect(decodeSearchAdmission({ data })).toEqual({
      mediaId: MEDIA_ID,
      revision: 4,
      jobId: JOB_ID,
    });
    expect(() =>
      decodeSearchAdmission({ data: { ...data, kind: "SourceRepair" } }),
    ).toThrow();
    expect(() => decodeSearchAdmission({ data: { ...data, revision: 0 } })).toThrow();
    expect(() =>
      decodeSearchAdmission({ data: { ...data, requeued: true } }),
    ).toThrow();
  });

  it("parses only the two import ref grammars", () => {
    expect(parseImportRef(UPLOAD_REF)).toBe(UPLOAD_REF);
    expect(parseImportRef(MEDIA_REF)).toBe(MEDIA_REF);
    expect(parseImportRef("media:not-a-uuid")).toBeNull();
    expect(parseImportRef("library:11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(parseImportRef(MEDIA_REF.toUpperCase())).toBeNull();
    expect(parseImportRef("upload:")).toBeNull();
    expect(parseImportRef("upload:nup1.a b.c")).toBeNull();
    expect(parseImportRef("upload:nup1.session:one")).toBeNull();
    expect(parseImportRef(MEDIA_ID)).toBeNull();
  });
});
