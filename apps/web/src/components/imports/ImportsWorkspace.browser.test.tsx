import { render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import {
  decodeImportsUrlState,
  encodeImportsUrlState,
  type ImportsUrlState,
} from "@/lib/imports/importsUrlState";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import ImportInspector from "./ImportInspector";
import ImportsBadge from "./ImportsBadge";
import ImportsWorkspace from "./ImportsWorkspace";

/**
 * Oracle: the content rubric and target behavior of
 * `docs/cutovers/imports-workspace-hard-cutover.md` and contract §6. Every
 * assertion below is a rubric row or a spec sentence — never a transcript of
 * what these components render. The BFF is stubbed at `fetch` with the exact
 * shapes the strict decoders declare, so the real provider, hooks, decoders and
 * resource-action runtime run.
 */

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATTENTION_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const INDEX_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_MEDIA_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_EVENT_ID = "88888888-8888-4888-8888-888888888888";
const FACTS_REVISION = "3".repeat(64);
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const UPLOAD_ONE = "nup1.session-one.signature-one";
const UPLOAD_TWO = "nup1.session-two.signature-two";
const LONG_TITLE =
  "A 712-page systems book whose title keeps going well past the width of any pane a reader can open";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const ABSENT = { kind: "Absent" } as const;

function present(value: unknown) {
  return { kind: "Present", value };
}

function attentionMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    ref: `media:${ATTENTION_MEDIA_ID}`,
    title: LONG_TITLE,
    media_kind: "pdf",
    source_label: present("example.invalid"),
    media_ref: present(`media:${ATTENTION_MEDIA_ID}`),
    state: {
      kind: "NeedsAttention",
      stage: "Extract",
      failure_code: present("E_SOURCE_TOO_LARGE"),
    },
    accepted_at: "2026-09-06T08:00:00Z",
    updated_at: "2026-09-06T09:00:00Z",
    matched_event: ABSENT,
    capabilities: {
      can_open: false,
      can_remove: true,
      recovery: present({
        kind: "RetrySource",
        expected_attempt_id: ATTEMPT_ID,
        input: "StoredSource",
      }),
      unavailable_reason: ABSENT,
    },
    ...overrides,
  };
}

function indexMediaItem() {
  return {
    ref: `media:${INDEX_MEDIA_ID}`,
    title: "A readable report",
    media_kind: "web_article",
    source_label: present("reports.invalid"),
    media_ref: present(`media:${INDEX_MEDIA_ID}`),
    state: {
      kind: "NeedsAttention",
      stage: "Index",
      failure_code: present("E_WORKER_HANDLER_FAILED"),
    },
    accepted_at: "2026-09-07T08:00:00Z",
    updated_at: "2026-09-07T09:00:00Z",
    matched_event: ABSENT,
    capabilities: {
      can_open: true,
      can_remove: true,
      recovery: present({
        kind: "RepairSearch",
        expected_revision: 3,
        expected_job_id: JOB_ID,
        input: "PublishedContent",
      }),
      unavailable_reason: ABSENT,
    },
  };
}

function activeMediaItem() {
  return {
    ref: `media:${ACTIVE_MEDIA_ID}`,
    title: "A bounded PDF",
    media_kind: "pdf",
    source_label: ABSENT,
    media_ref: present(`media:${ACTIVE_MEDIA_ID}`),
    state: {
      kind: "Active",
      status: "Processing",
      stage: "Extract",
      waiting_reason: ABSENT,
      progress: present({
        kind: "Counted",
        stage: "Extract",
        completed: 80,
        total: 712,
        unit: "Page",
        run_count: 1,
        updated_at: "2026-09-08T11:00:00Z",
      }),
      next_retry_at: ABSENT,
    },
    accepted_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-08T11:00:00Z",
    matched_event: ABSENT,
    capabilities: {
      can_open: false,
      can_remove: false,
      recovery: ABSENT,
      unavailable_reason: ABSENT,
    },
  };
}

function queuedMediaItem() {
  return {
    ...activeMediaItem(),
    ref: `media:${ACTIVE_MEDIA_ID}`,
    title: "A queued article",
    state: {
      kind: "Active",
      status: "Queued",
      stage: "SourceProcessing",
      waiting_reason: present("Capacity"),
      progress: ABSENT,
      next_retry_at: ABSENT,
    },
  };
}

function failedSourceEvent(id: string, occurredAt: string) {
  return {
    id,
    occurred_at: occurredAt,
    stage: present("Extract"),
    failure_code: present("E_SOURCE_FETCH_FAILED"),
    facts: {
      kind: "SourceFailed",
      source_attempt_id: ATTEMPT_ID,
      execution_id: ABSENT,
      origin: "Domain",
      terminal: false,
      progress: ABSENT,
    },
  };
}

function acceptedSourceEvent(id: string, occurredAt: string, attemptNo: number) {
  return {
    id,
    occurred_at: occurredAt,
    stage: ABSENT,
    failure_code: ABSENT,
    facts: {
      kind: "SourceAccepted",
      source_attempt_id: ATTEMPT_ID,
      attempt_no: attemptNo,
    },
  };
}

function baselineSourceEvent(id: string, occurredAt: string) {
  return {
    id,
    occurred_at: occurredAt,
    stage: ABSENT,
    failure_code: ABSENT,
    facts: {
      kind: "SourceHistoryBaseline",
      source_attempt_id: "99999999-9999-4999-8999-999999999999",
      attempt_no: 1,
      outcome: { kind: "Succeeded" },
    },
  };
}

function historyMediaItem() {
  return {
    ref: `media:${HISTORY_MEDIA_ID}`,
    title: "A recovered essay",
    media_kind: "web_article",
    source_label: present("essays.invalid"),
    media_ref: present(`media:${HISTORY_MEDIA_ID}`),
    state: { kind: "Complete" },
    accepted_at: "2026-09-06T07:00:00Z",
    updated_at: "2026-09-07T07:00:00Z",
    matched_event: present(failedSourceEvent(EVENT_ID, "2026-09-06T08:00:00Z")),
    capabilities: {
      can_open: true,
      can_remove: true,
      recovery: ABSENT,
      unavailable_reason: ABSENT,
    },
  };
}

function uploadItem(handle: string, title: string) {
  return {
    ref: `upload:${handle}`,
    title,
    media_kind: "pdf",
    source_label: ABSENT,
    media_ref: ABSENT,
    state: {
      kind: "NeedsAttention",
      stage: "Upload",
      failure_code: present("E_UPLOAD_TRANSPORT_FAILED"),
    },
    accepted_at: "2026-09-08T09:00:00Z",
    updated_at: "2026-09-08T09:30:00Z",
    matched_event: ABSENT,
    capabilities: {
      can_open: false,
      can_remove: true,
      recovery: present({
        kind: "RetryUpload",
        expected_generation: 2,
        input: "ChooseOriginalFile",
      }),
      unavailable_reason: ABSENT,
    },
  };
}

let pageReads = 0;

function pageBody(
  items: readonly Record<string, unknown>[],
  options: {
    readonly groups?: readonly { stage: string; count: number }[];
    readonly matchedCount?: number;
    readonly nextCursor?: string | null;
  } = {},
) {
  pageReads += 1;
  const nextCursor = options.nextCursor ?? null;
  return {
    data: {
      observed_at: `2026-09-08T12:00:${String(pageReads % 60).padStart(2, "0")}Z`,
      matched_count: options.matchedCount ?? items.length,
      groups: options.groups ?? [],
      items,
      next_cursor: nextCursor === null ? ABSENT : present(nextCursor),
    },
  };
}

function summaryBody(needsAttentionCount: number, activeCount: number, read: number) {
  return {
    data: {
      observed_at: `2026-09-08T12:00:${String(read % 60).padStart(2, "0")}Z`,
      needs_attention_count: needsAttentionCount,
      active_count: activeCount,
    },
  };
}

function detailBody(
  item: Record<string, unknown>,
  options: {
    readonly canRead?: boolean;
    readonly canSearch?: boolean;
    readonly recordedSince?: string;
  } = {},
) {
  return {
    data: {
      item,
      readiness: {
        can_read: options.canRead ?? true,
        can_search: options.canSearch ?? false,
        can_play: false,
      },
      history_coverage:
        options.recordedSince === undefined
          ? { kind: "Full" }
          : { kind: "Partial", recorded_since: options.recordedSince },
    },
  };
}

function historyBody(entries: readonly Record<string, unknown>[]) {
  return { data: { entries, next_cursor: ABSENT } };
}

function mediaSnapshot(ref: string, capabilities: readonly unknown[]) {
  const id = ref.slice("media:".length);
  return {
    ref,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/media/${id}`,
      unresolvedReason: null,
    },
    missing: false,
    factsRevision: FACTS_REVISION,
    capabilities,
  };
}

interface RecordedRequest {
  readonly path: string;
  readonly method: string;
  readonly query: string;
  readonly body: unknown;
}

interface BffConfig {
  /** The summary read. `read` counts from 1; a promise defers the answer. */
  readonly summary: (read: number) => unknown;
  /** The page read for a resolved `view` and its filters. */
  readonly page: (query: URLSearchParams) => unknown;
  readonly detail?: (ref: string) => unknown;
  readonly history?: (ref: string) => unknown;
  /** The media action snapshot capabilities for one media ref. */
  readonly capabilities?: (ref: string) => readonly unknown[];
  /** A recovery or upload command; `null` falls through to the default 202. */
  readonly command?: (
    request: RecordedRequest,
  ) => Response | Promise<Response> | null;
}

function installBff(config: BffConfig): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  let summaryReads = 0;
  vi.stubGlobal(
    "fetch",
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const request = target instanceof Request ? target : null;
      const url = new URL(request?.url ?? String(target), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const recorded: RecordedRequest = {
        path: url.pathname,
        method,
        query: url.search,
        body,
      };
      requests.push(recorded);

      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        const answer = await config.summary(summaryReads);
        return answer instanceof Response ? answer : jsonResponse(answer);
      }
      if (url.pathname === "/api/imports") {
        const answer = await config.page(url.searchParams);
        return answer instanceof Response ? answer : jsonResponse(answer);
      }
      if (url.pathname.startsWith("/api/imports/")) {
        const rest = decodeURIComponent(url.pathname.slice("/api/imports/".length));
        if (rest.endsWith("/history")) {
          const ref = rest.slice(0, -"/history".length);
          const answer = await (config.history?.(ref) ?? historyBody([]));
          return answer instanceof Response ? answer : jsonResponse(answer);
        }
        const answer = await config.detail?.(rest);
        if (answer === undefined) {
          return jsonResponse(
            { error: { code: "E_IMPORT_NOT_FOUND", message: "No such import." } },
            404,
          );
        }
        return answer instanceof Response ? answer : jsonResponse(answer);
      }
      if (url.pathname === RESOLVE_PATH && method === "POST") {
        const refs: string[] = Array.isArray((body as { refs?: unknown })?.refs)
          ? (body as { refs: string[] }).refs
          : [];
        return jsonResponse({
          data: {
            snapshots: refs.map((ref) =>
              mediaSnapshot(ref, config.capabilities?.(ref) ?? []),
            ),
          },
        });
      }
      if (method !== "GET") {
        const answer = await (config.command?.(recorded) ?? null);
        if (answer !== null) return answer;
        return jsonResponse({ data: null }, 202);
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      return jsonResponse({ data: null });
    },
  );
  return requests;
}

/**
 * The composition Track F wires: the workspace owns the view, the filters and
 * the list; the pane owns URL state and the secondary surface that renders the
 * inspector; the navigation renders one badge inside the destination link.
 */
function ImportsHarness({ initial }: { initial: string }) {
  const [state, setState] = useState<ImportsUrlState>(() =>
    decodeImportsUrlState(new URLSearchParams(initial)),
  );
  const selected =
    state.selected.kind === "Present" ? state.selected.value : null;
  return (
    <>
      <a href="/imports">
        <ImportsBadge label="Imports" />
      </a>
      <output aria-label="Imports url">
        {encodeImportsUrlState(state, new URLSearchParams()).toString()}
      </output>
      <ImportsWorkspace
        state={state}
        onStateChange={setState}
        selectedRef={selected}
        onSelect={(ref) =>
          setState((current) => ({
            ...current,
            selected: ref === null ? ABSENT : { kind: "Present", value: ref },
          }))
        }
      />
      {selected === null ? null : (
        <div role="complementary" aria-label="Import detail">
          <button
            type="button"
            onClick={() =>
              setState((current) => ({ ...current, selected: ABSENT }))
            }
          >
            Back to imports
          </button>
          <ImportInspector importRef={selected} />
        </div>
      )}
    </>
  );
}

function renderImports(initial = "") {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: ACCOUNT_ID, calendarTimeZone: "UTC" }}
      >
        <MobileChromeProvider>
          <KeybindingsProvider>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  initialState={createDefaultWorkspaceState(
                    "/imports",
                    workspacePrimaryMetrics,
                  )}
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                >
                  <LecternProvider>
                    <LibraryPlacementControllerProvider>
                      <ShareControllerProvider>
                        <OfflineMediaProvider
                          accountId={ACCOUNT_ID}
                          transport={null}
                        >
                          <ResourceOverlaysProvider>
                            <GlobalPlayerProvider>
                              <ResourceActionRuntimeProvider>
                                <ImportsProvider>
                                  <ImportsHarness initial={initial} />
                                </ImportsProvider>
                                <ResourceActionOverlays />
                              </ResourceActionRuntimeProvider>
                            </GlobalPlayerProvider>
                          </ResourceOverlaysProvider>
                        </OfflineMediaProvider>
                      </ShareControllerProvider>
                    </LibraryPlacementControllerProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
    ),
  );
}

function selectedTab(): HTMLElement {
  const tab = screen
    .getAllByRole("tab")
    .find((candidate) => candidate.getAttribute("aria-selected") === "true");
  if (tab === undefined) throw new Error("No view tab is selected");
  return tab;
}

function importsUrl(): string {
  return screen.getByRole("status", { name: "Imports url" }).textContent ?? "";
}

/**
 * The touch-target rule that applies to one element, read out of the live
 * stylesheet. A coarse pointer cannot be emulated inside this runner, so the
 * proof a mobile reader gets a full target is that the rule selects the row's
 * actual command and asks for the 44px token — the defect this catches is a
 * rule whose selector matches nothing.
 */
function coarsePointerMinHeight(element: Element): string | null {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSMediaRule)) continue;
      if (!rule.conditionText.includes("pointer: coarse")) continue;
      for (const inner of Array.from(rule.cssRules)) {
        if (!(inner instanceof CSSStyleRule)) continue;
        if (element.matches(inner.selectorText)) return inner.style.minHeight;
      }
    }
  }
  return null;
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

const originalInnerWidth = window.innerWidth;

describe("Imports workspace", () => {
  afterEach(() => {
    setViewportWidth(originalInnerWidth);
    vi.unstubAllGlobals();
  });

  it("caps the visible attention badge at 99+ while the exact count stays accessible", async () => {
    installBff({
      summary: () => summaryBody(150, 2, 1),
      page: () => pageBody([attentionMediaItem()], {
        groups: [{ stage: "Extract", count: 150 }],
        matchedCount: 150,
      }),
    });

    renderImports("?view=NeedsAttention");

    expect(
      await screen.findByRole("link", { name: "Imports, 150 need attention" }),
    ).toBeVisible();
    expect(screen.getByText("99+")).toBeVisible();
  });

  it("shows no badge while the summary is unknown and none when nothing needs attention", async () => {
    const blocked = deferred<Response>();
    installBff({
      summary: (read) =>
        read === 1 ? blocked.promise : summaryBody(0, 0, read),
      page: () => pageBody([]),
    });

    renderImports("?view=NeedsAttention");

    const link = await screen.findByRole("link", { name: "Imports" });
    expect(link).toBeVisible();

    blocked.resolve(jsonResponse(summaryBody(0, 0, 1)));
    await screen.findByText("No imports need attention");
    expect(
      screen.getByRole("link", { name: "Imports" }),
      "a zero attention count claimed a badge",
    ).toBeVisible();
  });

  it.each([
    ["attention when imports need it", 3, 2, "Needs attention"],
    ["active work when nothing needs attention", 0, 2, "In progress"],
    ["History when no work is outstanding", 0, 0, "History"],
  ])(
    "lands an unqualified entry on %s",
    async (_label, attention, active, expected) => {
      installBff({
        summary: () => summaryBody(attention, active, 1),
        page: () => pageBody([]),
      });

      renderImports("");

      await waitFor(() => expect(selectedTab()).toHaveTextContent(expected));
    },
  );

  it("keeps the view the URL names even when the counts would choose another", async () => {
    installBff({
      summary: () => summaryBody(3, 0, 1),
      page: () => pageBody([historyMediaItem()]),
    });

    renderImports("?view=History");

    await waitFor(() => expect(selectedTab()).toHaveTextContent("History"));
    expect(await screen.findByText("A recovered essay")).toBeVisible();
  });

  it("materializes the visible 30-day window when the reader opens History", async () => {
    installBff({
      summary: () => summaryBody(1, 0, 1),
      page: () => pageBody([attentionMediaItem()], {
        groups: [{ stage: "Extract", count: 1 }],
      }),
    });

    renderImports("?view=NeedsAttention");
    await screen.findByText(LONG_TITLE);

    await userEvent.click(screen.getByRole("tab", { name: /History/ }));

    await waitFor(() => expect(importsUrl()).toContain("view=History"));
    expect(importsUrl(), "History opened without its visible 30-day window").toMatch(
      /from=\d{4}-\d{2}-\d{2}/,
    );
  });

  it("narrows the list by a filter and clears every filter at once", async () => {
    const queries: string[] = [];
    installBff({
      summary: () => summaryBody(2, 0, 1),
      page: (query) => {
        queries.push(query.toString());
        const filtered = query.get("q") !== null;
        return pageBody(filtered ? [indexMediaItem()] : [attentionMediaItem(), indexMediaItem()], {
          groups: filtered
            ? [{ stage: "Index", count: 1 }]
            : [
                { stage: "Extract", count: 1 },
                { stage: "Index", count: 1 },
              ],
        });
      },
    });

    renderImports("?view=NeedsAttention");
    await screen.findByText(LONG_TITLE);

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search imports" }),
      "report{Enter}",
    );

    await waitFor(() =>
      expect(screen.queryByText(LONG_TITLE), "a filtered read kept an unmatched row").toBeNull(),
    );
    expect(queries.at(-1)).toContain("q=report");
    expect(screen.getByText("Search: report")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));

    expect(await screen.findByText(LONG_TITLE)).toBeVisible();
    expect(queries.at(-1), "clearing the filters kept the query").not.toContain("q=");
  });

  it("explains why a completed row matched a history filter beside its current outcome", async () => {
    installBff({
      summary: () => summaryBody(0, 0, 1),
      page: () => pageBody([historyMediaItem()]),
      detail: () => detailBody(historyMediaItem()),
      history: () =>
        historyBody([
          failedSourceEvent(EVENT_ID, "2026-09-06T08:00:00Z"),
          acceptedSourceEvent(OTHER_EVENT_ID, "2026-09-06T07:00:00Z", 2),
        ]),
    });

    renderImports("?view=History&had_failures=true");

    const row = await screen.findByRole("listitem", { name: /A recovered essay/ });
    expect(within(row).getByText("Complete")).toBeVisible();
    expect(
      within(row).getByText(/^Matched: /),
      "a currently successful row did not explain why it matched",
    ).toHaveTextContent("Matched: Extraction failed · Sep 6");

    await userEvent.click(
      within(row).getByRole("button", { name: "A recovered essay" }),
    );

    const inspector = await screen.findByRole("complementary", {
      name: "Import detail",
    });
    expect(within(inspector).getByText("Source attempt 2")).toBeVisible();
    expect(
      within(inspector).getByText("Source accepted"),
      "the matched attempt was not offered in the inspector",
    ).toBeVisible();
  });

  it("keeps two recovery commands on different rows pending independently", async () => {
    vi.stubGlobal("confirm", () => true);
    const retry = deferred<Response>();
    const remove = deferred<Response>();
    installBff({
      summary: () => summaryBody(2, 0, 1),
      page: () => pageBody([uploadItem(UPLOAD_ONE, "Field notes.pdf"), uploadItem(UPLOAD_TWO, "Second notes.pdf")], {
        groups: [{ stage: "Upload", count: 2 }],
      }),
      command: (request) => {
        if (request.path === `/api/media/uploads/${UPLOAD_ONE}/retry`) {
          return retry.promise;
        }
        if (
          request.path === `/api/media/uploads/${UPLOAD_TWO}` &&
          request.method === "DELETE"
        ) {
          return remove.promise;
        }
        return null;
      },
    });

    renderImports("?view=NeedsAttention");

    const first = await screen.findByRole("listitem", { name: /Field notes\.pdf/ });
    const second = screen.getByRole("listitem", { name: /Second notes\.pdf/ });

    await userEvent.upload(
      within(first).getByLabelText("Choose Field notes.pdf to retry the upload"),
      new File([new Uint8Array([37, 80, 68, 70])], "Field notes.pdf", {
        type: "application/pdf",
      }),
    );
    expect(
      await within(first).findByRole("button", { name: "Starting…" }),
      "a started recovery did not say what it started",
    ).toBeVisible();
    expect(
      within(second).getByRole("button", { name: "Retry upload" }),
      "one pending row disabled another row's own recovery",
    ).toBeEnabled();

    await userEvent.click(within(second).getByRole("button", { name: "Remove" }));
    expect(
      await within(second).findByRole("button", { name: "Starting…" }),
    ).toBeVisible();
    expect(
      within(first).getByRole("button", { name: "Starting…" }),
      "a second pending command replaced the first row's pending state",
    ).toBeVisible();

    retry.resolve(
      jsonResponse({
        data: {
          kind: "NeedsAttention",
          session_handle: UPLOAD_ONE,
          failure: {
            kind: "TransportFailed",
            reason: { kind: "Network" },
            failed_at: "2026-09-08T09:30:00Z",
          },
          capabilities: { can_retry_upload: true, can_remove: true },
        },
      }),
    );
    expect(
      await screen.findByText(
        "The upload didn’t finish. Choose the original file to retry.",
      ),
      "a refused recovery told the reader nothing",
    ).toBeVisible();

    remove.resolve(new Response(null, { status: 204 }));
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("listitem", { name: "Second notes.pdf" }),
        ).getByRole("button", { name: "Remove" }),
      ).toBeVisible(),
    );
  });

  it("refuses a file that is not the one this import accepted", async () => {
    const requests = installBff({
      summary: () => summaryBody(1, 0, 1),
      page: () =>
        pageBody([uploadItem(UPLOAD_ONE, "Field notes.pdf")], {
          groups: [{ stage: "Upload", count: 1 }],
        }),
    });

    renderImports("?view=NeedsAttention");

    const row = await screen.findByRole("listitem", { name: "Field notes.pdf" });
    await userEvent.upload(
      within(row).getByLabelText("Choose Field notes.pdf to retry the upload"),
      new File([new Uint8Array([37, 80, 68, 70])], "Other notes.pdf", {
        type: "application/pdf",
      }),
    );

    expect(await screen.findByText("Choose the original file")).toBeVisible();
    expect(
      requests.filter((request) => request.path.endsWith("/retry")),
      "a retry sent bytes the import never accepted",
    ).toEqual([]);
  });

  it("says a selected import that no longer exists is gone", async () => {
    installBff({
      summary: () => summaryBody(0, 0, 1),
      page: () => pageBody([historyMediaItem()]),
    });

    renderImports(`?view=History&selected=media%3A${HISTORY_MEDIA_ID}`);

    const inspector = await screen.findByRole("complementary", {
      name: "Import detail",
    });
    expect(
      await within(inspector).findByText("This import is no longer available"),
    ).toBeVisible();
  });

  it("keeps the last good row and explains a stale recovery as a conflict", async () => {
    installBff({
      summary: () => summaryBody(1, 0, 1),
      page: () => pageBody([attentionMediaItem()], {
        groups: [{ stage: "Extract", count: 1 }],
      }),
      capabilities: () => [
        {
          kind: "Recovery",
          availability: { kind: "Available" },
          offer: {
            kind: "RetrySource",
            expectedAttemptId: ATTEMPT_ID,
            input: "StoredSource",
          },
        },
      ],
      command: (request) =>
        request.path === `/api/media/${ATTENTION_MEDIA_ID}/retry`
          ? jsonResponse(
              {
                error: {
                  code: "E_RESOURCE_CONFLICT",
                  message: "A newer attempt owns this import.",
                },
              },
              409,
            )
          : null,
    });

    renderImports("?view=NeedsAttention");

    const row = await screen.findByRole("listitem", { name: new RegExp(LONG_TITLE.slice(0, 20)) });
    await userEvent.click(
      await within(row).findByRole("button", { name: "Retry source processing" }),
    );

    expect(await screen.findByText("This import changed")).toBeVisible();
    expect(screen.getByText("Review its current status")).toBeVisible();
    expect(
      within(row).getByText("Extraction failed"),
      "a refused command changed the row it did not act on",
    ).toBeVisible();
  });

  it("stops reading settled work while the rows, the last observation and Refresh remain", async () => {
    const requests = installBff({
      summary: (read) => summaryBody(0, 0, read),
      page: () => pageBody([historyMediaItem()]),
    });

    renderImports("?view=History");
    await screen.findByText("A recovered essay");
    const readsAfterLoad = requests.filter(
      (request) => request.path === "/api/imports/summary",
    ).length;

    await expect(
      waitFor(
        () =>
          expect(
            requests.filter((request) => request.path === "/api/imports/summary"),
          ).toHaveLength(readsAfterLoad + 1),
        { timeout: 6_500 },
      ),
      "settled work kept polling",
    ).rejects.toThrow();

    expect(screen.getByText("A recovered essay")).toBeVisible();
    expect(
      screen.getByText(/^Last checked /),
      "the reader was not told how fresh the settled list is",
    ).toBeVisible();
    expect(screen.queryByText("Couldn’t refresh imports")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        requests.filter((request) => request.path === "/api/imports/summary"),
      ).toHaveLength(readsAfterLoad + 1),
    );
  });

  it("keeps the last update on screen when a refresh fails", async () => {
    installBff({
      summary: (read) =>
        read === 1
          ? summaryBody(1, 0, read)
          : jsonResponse(
              { error: { code: "E_UPSTREAM", message: "Upstream is down." } },
              502,
            ),
      page: () => pageBody([attentionMediaItem()], {
        groups: [{ stage: "Extract", count: 1 }],
      }),
    });

    renderImports("?view=NeedsAttention");
    await screen.findByText(LONG_TITLE);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Couldn’t refresh imports")).toBeVisible();
    expect(screen.getByText("Showing the last update")).toBeVisible();
    expect(
      screen.getByText(LONG_TITLE),
      "a failed refresh discarded the last good rows",
    ).toBeVisible();
  });

  it("returns focus to the row the inspector was opened from", async () => {
    installBff({
      summary: () => summaryBody(2, 0, 1),
      page: () => pageBody([attentionMediaItem(), indexMediaItem()], {
        groups: [
          { stage: "Extract", count: 1 },
          { stage: "Index", count: 1 },
        ],
      }),
      detail: () => detailBody(indexMediaItem(), { canRead: true }),
      history: () => historyBody([baselineSourceEvent(EVENT_ID, "2026-09-07T08:00:00Z")]),
    });

    renderImports("?view=NeedsAttention");

    const target = await screen.findByRole("button", { name: "A readable report" });
    target.focus();
    await userEvent.keyboard("{Enter}");

    const inspector = await screen.findByRole("complementary", {
      name: "Import detail",
    });
    expect(
      within(inspector).getByText(
        "Search indexing failed. You can still read this document.",
      ),
    ).toBeVisible();
    expect(
      within(inspector).getByText("Detailed execution history was not recorded"),
    ).toBeVisible();

    await userEvent.click(
      within(inspector).getByRole("button", { name: "Back to imports" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "A readable report" }),
        "closing the inspector dropped focus to the document",
      ).toHaveFocus(),
    );
  });

  it("keeps a long title, a full touch target and every refinement reachable at 200% zoom", async () => {
    installBff({
      summary: () => summaryBody(2, 1, 1),
      page: () =>
        pageBody([attentionMediaItem(), uploadItem(UPLOAD_ONE, "Field notes.pdf")], {
          groups: [{ stage: "Upload", count: 1 }, { stage: "Extract", count: 1 }],
        }),
    });

    renderImports("?view=NeedsAttention");
    await screen.findByText(LONG_TITLE);

    setViewportWidth(320);

    expect(
      screen.getByRole("button", { name: LONG_TITLE }),
      "a truncated title stopped naming itself",
    ).toBeVisible();
    expect(
      coarsePointerMinHeight(
        screen.getByRole("button", { name: "Retry upload" }),
      ),
      "a row command has no 44px touch-target rule of its own",
    ).toBe("var(--size-xl)");
    expect(screen.getByRole("searchbox", { name: "Search imports" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  it("states the queue reason and counted progress of active work", async () => {
    installBff({
      summary: () => summaryBody(0, 2, 1),
      page: () => pageBody([activeMediaItem(), { ...queuedMediaItem(), ref: `media:${INDEX_MEDIA_ID}` }]),
    });

    renderImports("?view=InProgress");

    expect(await screen.findByText("Extracting page 80 of 712")).toBeVisible();
    expect(screen.getByText("Waiting for capacity")).toBeVisible();
  });
});
