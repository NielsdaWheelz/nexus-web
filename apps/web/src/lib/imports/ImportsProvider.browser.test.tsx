import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { parseImportRef, type ImportRef } from "@/lib/imports/importRef";
import { publishImportsInvalidation } from "@/lib/imports/importsClient";
import { decodeImportsUrlState } from "@/lib/imports/importsUrlState";
import { ImportsProvider, useImports } from "./ImportsProvider";
import { useImportDetail } from "./useImportDetail";
import { useImportHistory } from "./useImportHistory";
import { useImportsPage } from "./useImportsPage";

/**
 * Oracle: contract §5 and decision D10 — one provider owns the summary, the
 * wake signals and the single bounded five-second observation; the query hooks
 * read pages and detail on that same cadence without a second poller. Every
 * body below is the shape the strict decoders declare, so the proof exercises
 * the real transport rather than a stub of owned code.
 */
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MEDIA_ID = "55555555-5555-4555-8555-555555555555";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "66666666-6666-4666-8666-666666666666";
const NEXT_EVENT_ID = "77777777-7777-4777-8777-777777777777";
const UPLOAD_HANDLE = "nup1.session-one.signature-one";
const UPLOAD_REF = `upload:${UPLOAD_HANDLE}`;

function importRef(raw: string): ImportRef {
  const ref = parseImportRef(raw);
  if (ref === null) throw new Error(`fixture ref ${raw} must parse`);
  return ref;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A distinct observation instant per read, so a tick is observable. */
function observedAt(read: number): string {
  const minutes = String(Math.floor(read / 60) % 60).padStart(2, "0");
  const seconds = String(read % 60).padStart(2, "0");
  return `2026-09-08T12:${minutes}:${seconds}Z`;
}

function summaryBody(needsAttentionCount: number, activeCount: number, observedAt: string) {
  return {
    data: {
      observed_at: observedAt,
      needs_attention_count: needsAttentionCount,
      active_count: activeCount,
    },
  };
}

function mediaItem(mediaId: string, title: string) {
  return {
    ref: `media:${mediaId}`,
    title,
    media_kind: "pdf",
    source_label: { kind: "Absent" },
    media_ref: { kind: "Present", value: `media:${mediaId}` },
    state: {
      kind: "Active",
      status: "Processing",
      stage: "Extract",
      waiting_reason: { kind: "Absent" },
      progress: { kind: "Absent" },
      next_retry_at: { kind: "Absent" },
    },
    accepted_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-08T11:00:00Z",
    matched_event: { kind: "Absent" },
    capabilities: {
      can_open: true,
      can_remove: true,
      recovery: { kind: "Absent" },
      unavailable_reason: { kind: "Absent" },
    },
  };
}

function uploadItem() {
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
    accepted_at: "2026-09-08T09:00:00Z",
    updated_at: "2026-09-08T09:30:00Z",
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

// The server stamps `observed_at` on every read, so no two page reads share
// one — the field can never stand in for "this page shows the same work".
let pageObservations = 0;

function pageBody(
  items: readonly unknown[],
  { nextCursor = null as string | null } = {},
) {
  pageObservations += 1;
  return {
    data: {
      observed_at: observedAt(pageObservations),
      matched_count: items.length + (nextCursor === null ? 0 : 1),
      groups: [],
      items,
      next_cursor:
        nextCursor === null
          ? { kind: "Absent" }
          : { kind: "Present", value: nextCursor },
    },
  };
}

function detailBody(item: unknown) {
  return {
    data: {
      item,
      readiness: { can_read: true, can_search: false, can_play: false },
      history_coverage: { kind: "Full" },
    },
  };
}

function historyEntry(id: string, occurredAt: string) {
  return {
    id,
    occurred_at: occurredAt,
    stage: { kind: "Present", value: "Extract" },
    failure_code: { kind: "Absent" },
    facts: {
      kind: "SourceAccepted",
      source_attempt_id: ATTEMPT_ID,
      attempt_no: 1,
    },
  };
}

function historyBody(entries: readonly unknown[], nextCursor: string | null) {
  return {
    data: {
      entries,
      next_cursor:
        nextCursor === null
          ? { kind: "Absent" }
          : { kind: "Present", value: nextCursor },
    },
  };
}

const NEEDS_ATTENTION_STATE = decodeImportsUrlState(
  new URLSearchParams({ view: "NeedsAttention" }),
);

function Probe({
  selected,
  filter,
}: {
  selected: ImportRef | null;
  filter: string | null;
}) {
  const {
    summary,
    loadState,
    observation,
    pending,
    refresh,
    setPaneOpen,
    dispatchUpload,
  } = useImports();
  const page = useImportsPage(
    "NeedsAttention",
    filter === null
      ? NEEDS_ATTENTION_STATE
      : decodeImportsUrlState(
          new URLSearchParams({ view: "NeedsAttention", q: filter }),
        ),
  );
  const detail = useImportDetail(selected);
  const history = useImportHistory(selected);
  const [dispatchFailures, setDispatchFailures] = useState(0);
  return (
    <>
      <output aria-label="Imports summary">
        {summary === null
          ? "Unknown"
          : `${summary.needsAttentionCount} attention, ${summary.activeCount} active`}
      </output>
      <output aria-label="Imports load state">{loadState.kind}</output>
      <output aria-label="Imports revision">{observation.revision}</output>
      <output aria-label="Imports observed at">
        {observation.observedAt ?? "Never"}
      </output>
      <output aria-label="Imports page">
        {page.status === "ready"
          ? page.items.map((item) => item.title).join(" | ")
          : page.status}
      </output>
      <output aria-label="Imports detail">
        {detail.status === "ready" ? detail.data.item.title : detail.status}
      </output>
      <output aria-label="Imports history">
        {history.status === "ready"
          ? history.entries.map((entry) => entry.id).join(" | ")
          : history.status}
      </output>
      <output aria-label="Imports pending">
        {[...pending].sort().join(" | ") || "None"}
      </output>
      <output aria-label="Imports dispatch failures">{dispatchFailures}</output>
      <button type="button" onClick={() => void refresh()}>
        Refresh imports
      </button>
      <button type="button" onClick={() => setPaneOpen(true)}>
        Open imports
      </button>
      <button type="button" onClick={() => setPaneOpen(false)}>
        Close imports
      </button>
      <button type="button" onClick={() => page.loadMore()}>
        Load more imports
      </button>
      <button type="button" onClick={() => history.loadMore()}>
        Load more history
      </button>
      <button
        type="button"
        onClick={() => {
          void dispatchUpload({
            kind: "RemoveUpload",
            ref: importRef(UPLOAD_REF),
          }).catch(() => setDispatchFailures((count) => count + 1));
        }}
      >
        Remove upload
      </button>
      <button
        type="button"
        onClick={() => {
          void dispatchUpload({
            kind: "RetryUpload",
            ref: importRef(UPLOAD_REF),
            file: new File([new Uint8Array([37, 80, 68, 70])], "Field notes.pdf", {
              type: "application/pdf",
            }),
            expectedGeneration: 2,
          }).catch(() => setDispatchFailures((count) => count + 1));
        }}
      >
        Retry upload
      </button>
    </>
  );
}

interface ImportsTree {
  readonly selected?: ImportRef | null;
  readonly filter?: string | null;
}

function importsTree({ selected = null, filter = null }: ImportsTree) {
  return (
    <ImportsProvider>
      <Probe selected={selected} filter={filter} />
    </ImportsProvider>
  );
}

function renderImports(tree: ImportsTree = {}) {
  return render(importsTree(tree));
}

function hideDocument(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function showDocument(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function summary(name = "Imports summary") {
  return screen.getByRole("status", { name });
}

describe("Imports provider observation", () => {
  afterEach(() => {
    showDocument();
    vi.unstubAllGlobals();
  });

  it("converges an invalidation raised mid-read through one trailing read", async () => {
    const blocked = deferred<Response>();
    const bodies: Array<Response | Promise<Response>> = [
      jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:00Z")),
      blocked.promise,
      jsonResponse(summaryBody(3, 0, "2026-09-08T12:00:02Z")),
    ];
    let reads = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      const body = bodies.shift();
      if (body === undefined) throw new Error("Unexpected summary read");
      reads += 1;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      try {
        return await body;
      } finally {
        inFlight -= 1;
      }
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 0 active"));

    await userEvent.click(screen.getByRole("button", { name: "Refresh imports" }));
    await waitFor(() => expect(reads).toBe(2));
    publishImportsInvalidation();
    blocked.resolve(jsonResponse(summaryBody(2, 0, "2026-09-08T12:00:01Z")));

    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(summary()).toHaveTextContent("3 attention, 0 active"));
    expect(maximumInFlight).toBe(1);
  });

  it("keeps the last good summary and stops automatic reads when one fails", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      reads += 1;
      if (reads === 1) return jsonResponse(summaryBody(5, 1, "2026-09-08T12:00:00Z"));
      if (reads === 2) throw new TypeError("offline");
      throw new Error("Unexpected summary read after the window ended");
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("5 attention, 1 active"));
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports load state" }),
        ).toHaveTextContent("Failed"),
      { timeout: 6_500 },
    );
    expect(summary()).toHaveTextContent("5 attention, 1 active");
    expect(reads).toBe(2);
  });

  it("never polls a hidden document and resumes when it comes forward", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      reads += 1;
      return jsonResponse(summaryBody(0, 1, observedAt(reads)));
    });

    // A tab opened in the background is hidden before this provider mounts and
    // fires no `visibilitychange` until it comes forward.
    hideDocument();
    renderImports();
    await waitFor(() => expect(reads).toBe(1));
    await expect(
      waitFor(() => expect(reads).toBe(2), { timeout: 6_500 }),
    ).rejects.toThrow();

    showDocument();
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(reads).toBe(3), { timeout: 6_500 });
  });

  it("stops reading once no work is active and still refreshes on demand", async () => {
    const bodies = [
      jsonResponse(summaryBody(0, 1, "2026-09-08T12:00:00Z")),
      jsonResponse(summaryBody(0, 0, "2026-09-08T12:00:05Z")),
      jsonResponse(summaryBody(2, 0, "2026-09-08T12:00:20Z")),
    ];
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      const body = bodies.shift();
      if (body === undefined) throw new Error("Unexpected summary read");
      reads += 1;
      return body;
    });

    renderImports();
    await waitFor(
      () => expect(summary()).toHaveTextContent("0 attention, 0 active"),
      { timeout: 6_500 },
    );
    await expect(
      waitFor(() => expect(reads).toBe(3), { timeout: 6_500 }),
    ).rejects.toThrow();

    await userEvent.click(screen.getByRole("button", { name: "Refresh imports" }));
    await waitFor(() => expect(summary()).toHaveTextContent("2 attention, 0 active"));
  });

  it("treats another tab, a resume and a placement-backed removal as wake signals", async () => {
    const bodies = [
      jsonResponse(summaryBody(0, 0, "2026-09-08T12:00:00Z")),
      jsonResponse(summaryBody(4, 0, "2026-09-08T12:00:01Z")),
      jsonResponse(summaryBody(2, 0, "2026-09-08T12:00:02Z")),
      jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:03Z")),
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      const body = bodies.shift();
      if (body === undefined) throw new Error("Unexpected summary read");
      return body;
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("0 attention, 0 active"));

    const otherTab = new BroadcastChannel("Imports.Invalidated");
    let crossTabHints = 0;
    otherTab.addEventListener("message", () => {
      crossTabHints += 1;
    });
    otherTab.postMessage(null);
    await waitFor(() => expect(summary()).toHaveTextContent("4 attention, 0 active"));

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(summary()).toHaveTextContent("2 attention, 0 active"));

    publishLibraryPlacementChange("Unknown");
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 0 active"));
    await waitFor(() => expect(crossTabHints).toBe(1));
    otherTab.close();
  });

  it("re-keys the page and the selected detail only when the observation changes", async () => {
    let pageReads = 0;
    let detailReads = 0;
    const titles = ["First title", "Second title"];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        return jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:00Z"));
      }
      if (url.pathname === "/api/imports") {
        pageReads += 1;
        return jsonResponse(pageBody([mediaItem(MEDIA_ID, titles[0])]));
      }
      if (url.pathname === `/api/imports/${encodeURIComponent(`media:${MEDIA_ID}`)}`) {
        const title = titles[Math.min(detailReads, titles.length - 1)];
        detailReads += 1;
        return jsonResponse(detailBody(mediaItem(MEDIA_ID, title)));
      }
      return jsonResponse(historyBody([], null));
    });

    renderImports({ selected: importRef(`media:${MEDIA_ID}`) });
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports detail" }),
      ).toHaveTextContent("First title"),
    );
    expect(pageReads).toBe(1);

    publishImportsInvalidation();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports detail" }),
      ).toHaveTextContent("Second title"),
    );
    await waitFor(() => expect(pageReads).toBe(2));
  });

  it("keeps appended pages when a live re-read finds the same first page", async () => {
    let pageReads = 0;
    let summaryReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        return jsonResponse(summaryBody(0, 1, observedAt(summaryReads)));
      }
      if (url.pathname === "/api/imports") {
        if (url.searchParams.get("cursor") === "imports:NeedsAttention:2") {
          return jsonResponse(pageBody([mediaItem(OTHER_MEDIA_ID, "Appended")]));
        }
        pageReads += 1;
        return jsonResponse(
          pageBody([mediaItem(MEDIA_ID, "First")], {
            nextCursor: "imports:NeedsAttention:2",
          }),
        );
      }
      return jsonResponse(historyBody([], null));
    });

    renderImports();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "First",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open imports" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Load more imports" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "First | Appended",
      ),
    );

    const readsBeforeTick = pageReads;
    await waitFor(() => expect(pageReads).toBeGreaterThan(readsBeforeTick), {
      timeout: 6_500,
    });
    expect(
      screen.getByRole("status", { name: "Imports page" }),
    ).toHaveTextContent("First | Appended");
  });

  it("restarts the continuation when a live re-read finds different work", async () => {
    let pageReads = 0;
    let summaryReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        return jsonResponse(summaryBody(0, 1, observedAt(summaryReads)));
      }
      if (url.pathname === "/api/imports") {
        if (url.searchParams.get("cursor") === "imports:NeedsAttention:2") {
          return jsonResponse(pageBody([mediaItem(OTHER_MEDIA_ID, "Appended")]));
        }
        pageReads += 1;
        return jsonResponse(
          pageBody([mediaItem(MEDIA_ID, `Page ${pageReads}`)], {
            nextCursor: "imports:NeedsAttention:2",
          }),
        );
      }
      return jsonResponse(historyBody([], null));
    });

    renderImports();
    await userEvent.click(screen.getByRole("button", { name: "Open imports" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Page 2",
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load more imports" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Page 2 | Appended",
      ),
    );

    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports page" }),
        ).toHaveTextContent("Page 3"),
      { timeout: 6_500 },
    );
    expect(
      screen.getByRole("status", { name: "Imports page" }),
    ).not.toHaveTextContent("Appended");
  });

  it("pages the selected import's history through its own cursor", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        return jsonResponse(summaryBody(0, 0, "2026-09-08T12:00:00Z"));
      }
      if (url.pathname === "/api/imports") return jsonResponse(pageBody([]));
      if (url.pathname.endsWith("/history")) {
        return url.searchParams.get("cursor") === null
          ? jsonResponse(
              historyBody(
                [historyEntry(EVENT_ID, "2026-09-08T11:00:00Z")],
                "imports-history:2",
              ),
            )
          : jsonResponse(
              historyBody(
                [historyEntry(NEXT_EVENT_ID, "2026-09-08T10:00:00Z")],
                null,
              ),
            );
      }
      return jsonResponse(detailBody(mediaItem(MEDIA_ID, "Detail")));
    });

    renderImports({ selected: importRef(`media:${MEDIA_ID}`) });
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports history" }),
      ).toHaveTextContent(EVENT_ID),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Load more history" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports history" }),
      ).toHaveTextContent(`${EVENT_ID} | ${NEXT_EVENT_ID}`),
    );
  });

  it("keys a dispatched upload command by its ref and command and replays once", async () => {
    const removal = deferred<Response>();
    let removals = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        return jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:00Z"));
      }
      if (url.pathname === "/api/imports") {
        return jsonResponse(pageBody([uploadItem()]));
      }
      if (
        url.pathname === `/api/media/uploads/${UPLOAD_HANDLE}` &&
        init?.method === "DELETE"
      ) {
        removals += 1;
        return removal.promise;
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 0 active"));
    await userEvent.click(screen.getByRole("button", { name: "Remove upload" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove upload" }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports pending" }),
      ).toHaveTextContent(`${UPLOAD_REF}|RemoveUpload`),
    );
    expect(removals).toBe(1);

    removal.resolve(new Response(null, { status: 204 }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports pending" }),
      ).toHaveTextContent("None"),
    );
    expect(
      screen.getByRole("status", { name: "Imports dispatch failures" }),
    ).toHaveTextContent("0");
  });
  it("re-reads after a retry the server refuses as a stale identity", async () => {
    // Unchanged counts, so the only thing that can move the revision is the
    // invalidation the refused command publishes.
    const bodies = [
      jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:00Z")),
      jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:01Z")),
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        const body = bodies.shift();
        if (body === undefined) throw new Error("Unexpected summary read");
        return body;
      }
      if (url.pathname === "/api/imports") {
        return jsonResponse(pageBody([uploadItem()]));
      }
      if (
        url.pathname === `/api/media/uploads/${UPLOAD_HANDLE}/retry` &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            error: {
              code: "E_RESOURCE_CONFLICT",
              message: "This import changed",
              details: { current: { generation: 3 } },
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 0 active"));

    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports dispatch failures" }),
      ).toHaveTextContent("1"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports observed at" }),
      ).toHaveTextContent("2026-09-08T12:00:01Z"),
    );
    expect(
      screen.getByRole("status", { name: "Imports revision" }),
    ).toHaveTextContent("1");
  });
  it("asks for a fresh retry when the admitted capability has already expired", async () => {
    const bodies = [
      jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:00Z")),
      jsonResponse(summaryBody(1, 0, "2026-09-08T12:00:01Z")),
    ];
    let retries = 0;
    let puts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.origin !== window.location.origin) {
        puts += 1;
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/api/imports/summary") {
        const body = bodies.shift();
        if (body === undefined) throw new Error("Unexpected summary read");
        return body;
      }
      if (url.pathname === "/api/imports") {
        return jsonResponse(pageBody([uploadItem()]));
      }
      if (
        url.pathname === `/api/media/uploads/${UPLOAD_HANDLE}/retry` &&
        init?.method === "POST"
      ) {
        retries += 1;
        // The server mints the memoized generation's capability without
        // extending its original expiry, so a window that has already closed
        // stays closed however often it is asked for.
        return jsonResponse({
          data: {
            kind: "UploadRequired",
            session_handle: UPLOAD_HANDLE,
            generation: 2,
            method: "PUT",
            upload_url: "https://storage.example/staged-object",
            required_headers: { "Content-Type": "application/pdf" },
            expires_at: "2026-09-08T11:00:00Z",
            idempotency_outcome: "Created",
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 0 active"));

    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports dispatch failures" }),
      ).toHaveTextContent("1"),
    );
    expect(retries).toBe(1);
    expect(puts).toBe(0);
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports observed at" }),
      ).toHaveTextContent("2026-09-08T12:00:01Z"),
    );
  });

  it("keeps the window when the read a reader asked for is the one that fails", async () => {
    // The trailing read of a single-flight pair belongs to the reader, not to
    // the poller: only a failed *automatic* read may end the window (D10).
    const blocked = deferred<Response>();
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      reads += 1;
      if (reads === 1) return jsonResponse(summaryBody(1, 1, observedAt(1)));
      if (reads === 2) return blocked.promise;
      if (reads === 3) throw new TypeError("offline");
      return jsonResponse(summaryBody(2, 1, observedAt(reads)));
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 1 active"));
    // The automatic five-second read is in flight when the reader asks again,
    // so the reader's read is the trailing one.
    await waitFor(() => expect(reads).toBe(2), { timeout: 6_500 });
    await userEvent.click(screen.getByRole("button", { name: "Refresh imports" }));
    blocked.resolve(jsonResponse(summaryBody(1, 1, observedAt(2))));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports load state" }),
      ).toHaveTextContent("Failed"),
    );

    await waitFor(() => expect(summary()).toHaveTextContent("2 attention, 1 active"), {
      timeout: 6_500,
    });
  });

  it("keeps the window when a refresh outlives the automatic read behind it", async () => {
    // The mirror of the case above. The window belongs to the wake that started
    // it, not to whichever read fails: an automatic read that fails after the
    // reader refreshed cannot end the window the reader just opened (D10).
    const blocked = deferred<Response>();
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname !== "/api/imports/summary") {
        return jsonResponse(pageBody([]));
      }
      reads += 1;
      if (reads === 1) return jsonResponse(summaryBody(1, 1, observedAt(1)));
      if (reads === 2) return await blocked.promise;
      return jsonResponse(summaryBody(2, 1, observedAt(reads)));
    });

    renderImports();
    await waitFor(() => expect(summary()).toHaveTextContent("1 attention, 1 active"));
    // The automatic five-second read is in flight when the reader asks again.
    await waitFor(() => expect(reads).toBe(2), { timeout: 6_500 });
    await userEvent.click(screen.getByRole("button", { name: "Refresh imports" }));
    blocked.reject(new TypeError("offline"));

    // The reader's trailing read answers with fresh counts, so nothing on
    // screen says the pane stopped observing — and it must not have.
    await waitFor(() => expect(summary()).toHaveTextContent("2 attention, 1 active"));
    expect(
      screen.getByRole("status", { name: "Imports load state" }),
    ).toHaveTextContent("Ready");
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(4), {
      timeout: 6_500,
    });
  });

  it("re-keys the page and the detail exactly once for one invalidation", async () => {
    const blockedSummary = deferred<Response>();
    let pageReads = 0;
    let detailReads = 0;
    let summaryReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        if (summaryReads === 2) return blockedSummary.promise;
        return jsonResponse(summaryBody(0, 1, observedAt(summaryReads)));
      }
      if (url.pathname === "/api/imports") {
        pageReads += 1;
        return jsonResponse(pageBody([mediaItem(MEDIA_ID, `Page ${pageReads}`)]));
      }
      if (url.pathname.endsWith("/history")) {
        return jsonResponse(historyBody([], null));
      }
      detailReads += 1;
      return jsonResponse(detailBody(mediaItem(MEDIA_ID, `Detail ${detailReads}`)));
    });

    renderImports({ selected: importRef(`media:${MEDIA_ID}`) });
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Page 1",
      ),
    );

    publishImportsInvalidation();
    // Both re-keyed reads win the race with the summary read that re-keyed them.
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Page 2",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports detail" }),
      ).toHaveTextContent("Detail 2"),
    );
    blockedSummary.resolve(jsonResponse(summaryBody(0, 1, observedAt(2))));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports observed at" }),
      ).toHaveTextContent(observedAt(2)),
    );

    // That observation is the one the re-key already answered, so the live
    // channel must not read the same page or detail again.
    await expect(
      waitFor(() => expect(pageReads + detailReads).toBeGreaterThan(4), {
        timeout: 1_500,
      }),
    ).rejects.toThrow();
  });

  it("drops a live page and detail when the reader returns to an earlier key", async () => {
    const detailReads = new Map<string, number>();
    let pageReads = 0;
    let summaryReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        return jsonResponse(summaryBody(0, 1, observedAt(summaryReads)));
      }
      if (url.pathname === "/api/imports") {
        pageReads += 1;
        return jsonResponse(pageBody([mediaItem(MEDIA_ID, `Page ${pageReads}`)]));
      }
      if (url.pathname.endsWith("/history")) {
        return jsonResponse(historyBody([], null));
      }
      const ref = decodeURIComponent(url.pathname.slice("/api/imports/".length));
      const read = (detailReads.get(ref) ?? 0) + 1;
      detailReads.set(ref, read);
      return jsonResponse(
        detailBody(
          mediaItem(
            ref === `media:${MEDIA_ID}` ? MEDIA_ID : OTHER_MEDIA_ID,
            `Detail ${read}`,
          ),
        ),
      );
    });

    const first = importRef(`media:${MEDIA_ID}`);
    const second = importRef(`media:${OTHER_MEDIA_ID}`);
    const { rerender } = renderImports({ selected: first });
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Page 1",
      ),
    );
    // One five-second observation gives both hooks a live overlay for this key.
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports page" }),
        ).toHaveTextContent("Page 2"),
      { timeout: 6_500 },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports detail" }),
      ).toHaveTextContent("Detail 2"),
    );

    rerender(importsTree({ selected: second, filter: "alpha" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Page 3",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports detail" }),
      ).toHaveTextContent("Detail 1"),
    );

    rerender(importsTree({ selected: first, filter: null }));
    // Back on the first key: an overlay may only ever be newer than the keyed
    // read it shadows, so the read now in flight wins.
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports page" }),
        ).toHaveTextContent("Page 4"),
      { timeout: 2_000 },
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports detail" }),
        ).toHaveTextContent("Detail 3"),
      { timeout: 2_000 },
    );
  });

  it("keeps the five-second cadence across a filter and a selection change", async () => {
    const pageReads = new Map<string, number>();
    const detailReads = new Map<string, number>();
    let summaryReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        return jsonResponse(summaryBody(0, 1, observedAt(summaryReads)));
      }
      if (url.pathname === "/api/imports") {
        const filter = url.searchParams.get("q") ?? "Unfiltered";
        const read = (pageReads.get(filter) ?? 0) + 1;
        pageReads.set(filter, read);
        return jsonResponse(pageBody([mediaItem(MEDIA_ID, `${filter} ${read}`)]));
      }
      if (url.pathname.endsWith("/history")) {
        return jsonResponse(historyBody([], null));
      }
      const ref = decodeURIComponent(url.pathname.slice("/api/imports/".length));
      const read = (detailReads.get(ref) ?? 0) + 1;
      detailReads.set(ref, read);
      return jsonResponse(
        detailBody(
          mediaItem(
            ref === `media:${MEDIA_ID}` ? MEDIA_ID : OTHER_MEDIA_ID,
            `Detail ${read}`,
          ),
        ),
      );
    });

    const { rerender } = renderImports({
      selected: importRef(`media:${MEDIA_ID}`),
    });
    await userEvent.click(screen.getByRole("button", { name: "Open imports" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "Unfiltered 1",
      ),
    );
    // One live tick, so the next one is a whole interval away and the assertion
    // below measures the cadence rather than the tail of this one.
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports page" }),
        ).toHaveTextContent("Unfiltered 2"),
      { timeout: 6_500 },
    );

    rerender(
      importsTree({
        selected: importRef(`media:${OTHER_MEDIA_ID}`),
        filter: "alpha",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Imports page" })).toHaveTextContent(
        "alpha 1",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Imports detail" }),
      ).toHaveTextContent("Detail 1"),
    );

    // A key the reader changed is not an observation, so it must not cost the
    // next tick: page one and the newly selected detail are read again on the
    // provider's five-second observation (contract D10).
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports page" }),
        ).toHaveTextContent("alpha 2"),
      { timeout: 6_500 },
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Imports detail" }),
        ).toHaveTextContent("Detail 2"),
      { timeout: 2_000 },
    );
  });
});
