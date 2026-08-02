import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "vitest/browser";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Component, type ReactNode } from "react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ApiError } from "@/lib/api/client";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { requestNexusOpen } from "@/lib/nexus/events";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  createDefaultWorkspaceState,
  createEmptyPaneHistory,
  createPaneVisit,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  MAX_PANES,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
} from "@/lib/workspace/mobileChrome";
import Nexus from "./Nexus";
import { nexusErrorMessage } from "./useNexusController";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_REF = `page:${PAGE_ID}`;
const PAGE_HREF = `/pages/${PAGE_ID}`;

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

interface RecordedRequest {
  readonly url: URL;
  readonly init: RequestInit | undefined;
  readonly body: Record<string, unknown> | null;
}

let requests: RecordedRequest[] = [];
let openablesResponse:
  | Promise<Response>
  | ((init: RequestInit | undefined) => Promise<Response>);
let searchResponse:
  | Promise<Response>
  | ((init: RequestInit | undefined) => Promise<Response>);
let selectionResponse:
  | Promise<Response>
  | ((init: RequestInit | undefined) => Promise<Response>);
let mediaFromUrlResponse: Promise<Response> | null;
let viewport: ReturnType<typeof mockViewport>;
let allowWorkspaceSessionWrite = false;

class NexusDefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error ? <p>Nexus defect boundary</p> : this.props.children;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> | null {
  return typeof init?.body === "string"
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : null;
}

function openablePageResult() {
  return {
    ref: PAGE_REF,
    scheme: "page",
    id: PAGE_ID,
    label: "Alpha",
    summary: "Provider result",
    route: PAGE_HREF,
    activation: {
      resourceRef: PAGE_REF,
      kind: "route",
      href: PAGE_HREF,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "direct",
        noteReferenceTarget: true,
      },
      sharing: "ResourceGrants",
      libraryPlacement: "None",
      attachable: true,
      chatSubject: "readable",
      readable: "body",
      inspectable: "none",
      citableResultType: "note_block",
      citationOutputSource: false,
      appSearchScope: true,
      conversationSearchScope: true,
      promptRender: "inline_body",
      expansionPolicy: "page_note_blocks",
      expandable: true,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1 },
  };
}

function mockApi() {
  openablesResponse = Promise.resolve(
    jsonResponse({ data: { items: [] } }),
  );
  searchResponse = Promise.resolve(
    jsonResponse({
      results: [],
      page: { has_more: false, next_cursor: null },
    }),
  );
  selectionResponse = Promise.resolve(jsonResponse({ data: null }));
  mediaFromUrlResponse = null;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const body = requestBody(init);
      requests.push({ url, init, body });

      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/me/nexus-history") {
        return jsonResponse({
          data: { recent: [], frecency_by_href: {} },
        });
      }
      if (
        url.pathname === "/api/me/nexus-selections" &&
        init?.method === "POST"
      ) {
        return typeof selectionResponse === "function"
          ? selectionResponse(init)
          : selectionResponse;
      }
      if (
        allowWorkspaceSessionWrite &&
        url.pathname === "/api/me/workspace-session" &&
        init?.method === "PUT"
      ) {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/resource-items/openables/search") {
        return typeof openablesResponse === "function"
          ? openablesResponse(init)
          : openablesResponse;
      }
      if (url.pathname === "/api/search") {
        return typeof searchResponse === "function"
          ? searchResponse(init)
          : searchResponse;
      }
      if (
        url.pathname === "/api/media/from-url" &&
        init?.method === "POST" &&
        mediaFromUrlResponse
      ) {
        return mediaFromUrlResponse;
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (
        url.pathname === "/api/notes/pages" &&
        init?.method === "POST" &&
        body
      ) {
        return jsonResponse({
          data: {
            id: body.page_id,
            title: "Untitled",
            updatedAt: null,
            dailyPage: null,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });
}

function mockViewport(initialMobile: boolean) {
  let mobile = initialMobile;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query.includes("max-width") ? mobile : false;
        },
        media: query,
        onchange: null,
        addEventListener(
          _event: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          if (query.includes("max-width")) listeners.add(listener);
        },
        removeEventListener(
          _event: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          listeners.delete(listener);
        },
        addListener(listener: EventListenerOrEventListenerObject) {
          if (query.includes("max-width")) listeners.add(listener);
        },
        removeListener(listener: EventListenerOrEventListenerObject) {
          listeners.delete(listener);
        },
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList,
  );
  return {
    setMobile(next: boolean) {
      mobile = next;
      const event = new Event("change");
      act(() => {
        for (const listener of listeners) {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      });
    },
  };
}

function WorkspaceProbe() {
  const { state, pendingPaneEntryDeliveryByPaneId } = useWorkspaceStore();
  const panes = getWorkspacePrimaryPanes(state);
  const active = panes.find(
    (pane) => pane.id === state.activePrimaryPaneId,
  );
  return (
    <>
      <output data-testid="workspace-pane-count">{panes.length}</output>
      <output data-testid="workspace-active-href">
        {active?.currentVisit.href ?? ""}
      </output>
      <output data-testid="workspace-pending-entry">
        {JSON.stringify(
          Array.from(pendingPaneEntryDeliveryByPaneId.values())[0]?.entry ??
            null,
        )}
      </output>
    </>
  );
}

function ReaderScrollportProbe() {
  const readerScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: "nexus-test-reader",
      enabled: true,
    });
  return (
    <div
      ref={readerScrollportRef}
      role="region"
      aria-label="Reader content"
      style={{ height: 100, overflow: "auto" }}
    >
      <div style={{ height: 1_000 }} />
    </div>
  );
}

function renderNexus(input: {
  readonly mobile?: boolean;
  readonly readerScrollportProbe?: boolean;
  readonly state?: WorkspaceState;
  readonly onDefect?: (error: unknown) => void;
} = {}) {
  const mobile = input.mobile ?? false;
  viewport = mockViewport(mobile);
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          calendarTimeZone: "UTC",
        }}
      >
        <MobileChromeProvider>
          {input.readerScrollportProbe ? <ReaderScrollportProbe /> : null}
          <KeybindingsProvider>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                  initialState={
                    input.state ??
                    createDefaultWorkspaceState(
                      "/libraries",
                      workspacePrimaryMetrics,
                    )
                  }
                >
                  <LecternProvider>
                    <GlobalPlayerProvider>
                      <ShareControllerProvider>
                        <WorkspaceProbe />
                        {input.onDefect ? (
                          <NexusDefectBoundary onDefect={input.onDefect}>
                            <Nexus />
                          </NexusDefectBoundary>
                        ) : (
                          <Nexus />
                        )}
                      </ShareControllerProvider>
                    </GlobalPlayerProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
      { initialViewport: mobile ? "mobile" : "desktop" },
    ),
  );
}

function paneCountState(paneCount: number): WorkspaceState {
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    id: `pane-${index}`,
    currentVisit: createPaneVisit("/libraries"),
    primaryWidthPx: workspacePrimaryMetrics.primaryDefaultWidthPx,
    visibility: index === 0 ? ("visible" as const) : ("minimized" as const),
    history: createEmptyPaneHistory(),
    attachedSecondaryPaneId: null,
  }));
  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: panes[0]!.id,
    primaryPanes: panes,
  });
}

function maxPaneState(): WorkspaceState {
  return paneCountState(MAX_PANES);
}

function openWithKeyboard() {
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
}

function selectionRequests(): RecordedRequest[] {
  return requests.filter(
    ({ url, init }) =>
      url.pathname === "/api/me/nexus-selections" &&
      init?.method === "POST",
  );
}

function queryHistoryRequests(): RecordedRequest[] {
  return requests.filter(
    ({ url }) =>
      url.pathname === "/api/me/nexus-history" &&
      url.searchParams.has("query"),
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  requests = [];
  allowWorkspaceSessionWrite = false;
  mockApi();
});

afterEach(() => {
  document.documentElement.style.removeProperty("font-size");
  document.documentElement.style.removeProperty("--text-md");
  document.body.style.removeProperty("font-size");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Nexus shell contracts", () => {
  it("maps only finite operation failures and preserves diagnostics", () => {
    expect(
      nexusErrorMessage(
        new ApiError(0, "E_NETWORK", "offline", "req-nexus"),
        "Command",
      ),
    ).toMatchObject({ tone: "Danger", requestId: "req-nexus" });

    const sameSystem = new ApiError(500, "E_INTERNAL", "broken");
    expect(() => nexusErrorMessage(sameSystem, "Command")).toThrow(sameSystem);

    const unknownCode = new ApiError(409, "E_NEW_NEXUS_FAILURE", "new");
    expect(() => nexusErrorMessage(unknownCode, "CreatePage")).toThrow(
      unknownCode,
    );

    const nonApi = new Error("decoder failed");
    expect(() => nexusErrorMessage(nonApi, "SaveHistory")).toThrow(nonApi);
  });

  it("routes an unknown journal code through owner state into the render boundary", async () => {
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    selectionResponse = Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: "E_NEW_HISTORY_FAILURE", message: "new" },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    try {
      renderNexus({ mobile: true, onDefect });
      await userEvent.click(
        screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Nexus" });
      await userEvent.click(
        within(dialog).getByRole("button", { name: /^Notes Place$/ }),
      );

      expect(await screen.findByText("Nexus defect boundary")).toBeVisible();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E_NEW_HISTORY_FAILURE" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("consumes the exact Root URL intent once and preserves unrelated URL state", async () => {
    window.history.replaceState(
      {},
      "",
      "/?keep=1&nexus=1&intent=Root#reader",
    );

    renderNexus();

    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#reader");
  });

  it("routes a retired WebSearch URL to query-free recovery", async () => {
    window.history.replaceState(
      {},
      "",
      "/?nexus=1&intent=WebSearch&q=epistemology",
    );

    renderNexus({ mobile: true });

    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).getByRole("heading", {
        name: "This link is no longer supported",
      }),
    ).toBeVisible();
    expect(within(dialog).queryByText("epistemology")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("records an accepted mobile href selection through the shared history owner", async () => {
    renderNexus({ mobile: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Notes Place$/ }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    expect(selectionRequests()).toHaveLength(0);
    const firstFrame = frameCallbacks.splice(0);
    act(() => {
      for (const callback of firstFrame) callback(performance.now());
    });
    expect(selectionRequests()).toHaveLength(0);
    const secondFrame = frameCallbacks.splice(0);
    act(() => {
      for (const callback of secondFrame) callback(performance.now());
    });
    expect(selectionRequests()).toHaveLength(0);
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    expect(selectionRequests()[0]!.body).toMatchObject({
      query: null,
      target_href: "/notes",
      label_snapshot: "Notes",
      source: "Static",
    });
    expect(selectionRequests()[0]!.init?.keepalive).toBe(true);
  });

  it("flushes one accepted selection on page hide before its deferred frames", async () => {
    allowWorkspaceSessionWrite = true;
    renderNexus({ mobile: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Notes Place$/ }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    expect(selectionRequests()).toHaveLength(0);

    fireEvent(window, new Event("pagehide"));
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    act(() => {
      for (const callback of frameCallbacks.splice(0)) {
        callback(performance.now());
      }
      for (const callback of frameCallbacks.splice(0)) {
        callback(performance.now());
      }
    });
    expect(selectionRequests()).toHaveLength(1);
    expect(selectionRequests()[0]!.init?.keepalive).toBe(true);
  });

  it("interrupts persistence for foreground work and replays the same mutation afterward", async () => {
    let attempt = 0;
    selectionResponse = async (init) => {
      attempt += 1;
      if (attempt > 1) return jsonResponse({ data: null });
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Selection persistence requires an abort signal");
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };
    renderNexus({ mobile: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Notes Place$/ }),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    const mutationId = selectionRequests()[0]!.body?.client_mutation_id;
    const firstSignal = selectionRequests()[0]!.init?.signal;
    expect(mutationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstSignal).toBeInstanceOf(AbortSignal);

    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Nexus" });
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(selectionRequests()).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(selectionRequests()).toHaveLength(2));
    expect(selectionRequests()[1]!.body?.client_mutation_id).toBe(mutationId);
  });

  it("uses Nexus.Open to open the inline row menu and no-ops without row actions", async () => {
    renderNexus();

    openWithKeyboard();
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).getByRole("combobox", { name: "Find anything…" }),
    ).toHaveFocus();

    openWithKeyboard();
    expect(
      await within(dialog).findByRole("menuitem", { name: "Close tab" }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("heading", { name: /Actions for/ }),
    ).toBeNull();

    await userEvent.keyboard("{Escape}");
    const input = await within(dialog).findByRole("combobox", {
      name: "Find anything…",
    });
    expect(input).toHaveFocus();
    await userEvent.type(input, "zzzz-no-actions");

    openWithKeyboard();
    dialog = screen.getByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).queryByRole("heading", { name: /Actions for/ }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("combobox", { name: "Find anything…" }),
    ).toHaveValue("zzzz-no-actions");
  });

  it("executes the committed key when a provider arrives and logs only the accepted target", async () => {
    let resolveOpenables!: (response: Response) => void;
    const openablesStarted = new Promise<void>((resolve) => {
      openablesResponse = () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveOpenables = resolveResponse;
        });
      };
    });
    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });
    await userEvent.type(input, "libraries");
    await openablesStarted;
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).not.toBeNull(),
    );
    const committedKey = input.getAttribute("aria-activedescendant");

    resolveOpenables(
      jsonResponse({ data: { items: [openablePageResult()] } }),
    );
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", committedKey),
    );
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    expect(screen.getByTestId("workspace-pane-count")).toHaveTextContent("1");
    expect(screen.getByTestId("workspace-active-href")).toHaveTextContent(
      "/libraries",
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    expect(selectionRequests()[0]!.body).toMatchObject({
      query: "libraries",
      target_href: "/libraries",
      label_snapshot: "Libraries",
      source: "Workspace",
    });
    expect(
      String(selectionRequests()[0]!.body?.client_mutation_id),
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("starts query-aware history only after the foreground provider chain settles", async () => {
    let resolveOpenables!: (response: Response) => void;
    let resolveSearch!: (response: Response) => void;
    const openablesStarted = new Promise<void>((resolve) => {
      openablesResponse = () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveOpenables = resolveResponse;
        });
      };
    });
    const searchStarted = new Promise<void>((resolve) => {
      searchResponse = () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveSearch = resolveResponse;
        });
      };
    });
    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });

    fireEvent.change(input, { target: { value: "alpha" } });
    await openablesStarted;
    expect(queryHistoryRequests()).toHaveLength(0);

    resolveOpenables(jsonResponse({ data: { items: [] } }));
    await searchStarted;
    expect(queryHistoryRequests()).toHaveLength(0);

    resolveSearch(
      jsonResponse({
        results: [],
        page: { has_more: false, next_cursor: null },
      }),
    );
    await waitFor(() => expect(queryHistoryRequests()).toHaveLength(1));
    expect(queryHistoryRequests()[0]!.url.searchParams.get("query")).toBe(
      "alpha",
    );
  });

  it("never projects a delayed provider response onto a newer query revision", async () => {
    let requestCount = 0;
    let resolveAlpha!: (response: Response) => void;
    let resolveBeta!: (response: Response) => void;
    let markAlphaStarted!: () => void;
    let markBetaStarted!: () => void;
    const alphaStarted = new Promise<void>((resolve) => {
      markAlphaStarted = resolve;
    });
    const betaStarted = new Promise<void>((resolve) => {
      markBetaStarted = resolve;
    });
    openablesResponse = () => {
      requestCount += 1;
      if (requestCount === 1) {
        markAlphaStarted();
        return new Promise<Response>((resolve) => {
          resolveAlpha = resolve;
        });
      }
      markBetaStarted();
      return new Promise<Response>((resolve) => {
        resolveBeta = resolve;
      });
    };

    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });
    await userEvent.type(input, "alpha");
    await alphaStarted;
    await userEvent.clear(input);
    await userEvent.type(input, "beta");
    await betaStarted;

    resolveAlpha(
      jsonResponse({ data: { items: [openablePageResult()] } }),
    );
    await waitFor(() => expect(input).toHaveValue("beta"));
    expect(
      screen.queryByRole("gridcell", { name: /^Alpha\b/ }),
    ).toBeNull();

    resolveBeta(jsonResponse({ data: { items: [] } }));
  });

  it("keeps a moved query-action identity outside progressive result merges", async () => {
    let resolveOpenables!: (response: Response) => void;
    const openablesStarted = new Promise<void>((resolve) => {
      openablesResponse = () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveOpenables = resolveResponse;
        });
      };
    });
    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });
    await userEvent.type(input, "alpha");
    await openablesStarted;
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).toMatch(
        /Continuation%3AAsk$/,
      ),
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const stabilizedAction = input.getAttribute("aria-activedescendant");
    expect(stabilizedAction).toMatch(/Continuation%3AAddToToday$/);

    resolveOpenables(
      jsonResponse({ data: { items: [openablePageResult()] } }),
    );
    await waitFor(() =>
      expect(input).toHaveAttribute(
        "aria-activedescendant",
        stabilizedAction,
      ),
    );
  });

  it("invalidates same-query Openables after a Nexus-owned mutation", async () => {
    let openablesCalls = 0;
    let mutationCompleted = false;
    openablesResponse = async () => {
      openablesCalls += 1;
      return jsonResponse({
        data: {
          items: [
            {
              ...openablePageResult(),
              label: mutationCompleted
                ? "Page after mutation"
                : "Page before mutation",
            },
          ],
        },
      });
    };

    renderNexus({ state: maxPaneState() });
    act(() => requestNexusOpen({ kind: "Root" }));
    let input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });
    await userEvent.type(input, "page");
    expect(
      await screen.findByRole("gridcell", {
        name: /^Page before mutation\b/,
      }),
    ).toBeVisible();
    const callsBeforeMutation = openablesCalls;

    mutationCompleted = true;
    fireEvent.click(
      screen.getByRole("gridcell", { name: /^New Page\b/ }),
      { shiftKey: true },
    );
    const recoveryDialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      await within(recoveryDialog).findByText(/Your page was created\./),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });
    expect(input).toHaveValue("page");
    expect(
      await screen.findByRole("gridcell", {
        name: /^Page after mutation\b/,
      }),
    ).toBeVisible();
    expect(openablesCalls).toBeGreaterThan(callsBeforeMutation);
  });

  it("bounds Openables responses within one visible Nexus session", async () => {
    let openablesCalls = 0;
    openablesResponse = async (init) => {
      openablesCalls += 1;
      const query = String(requestBody(init)?.q);
      return jsonResponse({
        data: {
          items: [{ ...openablePageResult(), label: `Result ${query}` }],
        },
      });
    };

    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });

    for (let index = 0; index <= 32; index += 1) {
      fireEvent.change(input, { target: { value: `cache-${index}` } });
      await waitFor(() => expect(openablesCalls).toBe(index + 1));
      expect(
        await screen.findByRole("gridcell", {
          name: new RegExp(`^Result cache-${index}\\b`),
        }),
      ).toBeVisible();
    }

    fireEvent.change(input, { target: { value: "cache-0" } });
    await waitFor(() => expect(openablesCalls).toBe(34));
  });

  it("carries Shift+Enter Fork through the shell and records the accepted new tab", async () => {
    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    await waitFor(() =>
      expect(screen.getByTestId("workspace-pane-count")).toHaveTextContent("2"),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    expect(selectionRequests()[0]!.body).toMatchObject({
      query: null,
      target_href: "/libraries",
      source: "Workspace",
    });
  });

  it("retains rejected Fork and completed workflow activations without logging them", async () => {
    renderNexus({ state: maxPaneState() });
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything…",
    });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(
      await screen.findByRole("heading", { name: "Tab limit reached" }),
    ).toBeVisible();
    expect(screen.getByText(/destination is ready to open/i)).toBeVisible();
    expect(selectionRequests()).toHaveLength(0);

    viewport.setMobile(true);
    expect(
      await screen.findByRole("heading", { name: "Tab limit reached" }),
    ).toBeVisible();
    expect(screen.getByText(/destination is ready to open/i)).toBeVisible();
    viewport.setMobile(false);
    expect(
      await screen.findByRole("heading", { name: "Tab limit reached" }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Manage tabs" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Manage tabs" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("heading", { name: "Tab limit reached" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() =>
      requestNexusOpen({
        kind: "QuickAction",
        actionId: "Nexus.Quick.Page",
      }),
    );
    let recoveryDialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      await within(recoveryDialog).findByText(/Your page was created\./),
    ).toBeVisible();
    expect(selectionRequests()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    recoveryDialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      within(recoveryDialog).getByText(/Your page was created\./),
    ).toBeVisible();
    expect(
      requests.filter(
        ({ url, init }) =>
          url.pathname === "/api/notes/pages" &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("retries a rejected desktop Quick Note as the same AppendNote capability", async () => {
    renderNexus({ state: maxPaneState() });

    act(() =>
      requestNexusOpen({
        kind: "QuickAction",
        actionId: "Nexus.Quick.Note",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Tab limit reached" }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Manage tabs" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Close Libraries" })[0]!,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry open" }));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-active-href")).toHaveTextContent(
        /^\/daily\/\d{4}-\d{2}-\d{2}$/,
      ),
    );
    expect(screen.getByTestId("workspace-pending-entry")).toHaveTextContent(
      /"kind":"AppendNote"/,
    );
    expect(screen.getByTestId("workspace-pending-entry")).toHaveTextContent(
      /"noteId":"[^"]+"/,
    );
    expect(screen.getByTestId("workspace-pending-entry")).toHaveTextContent(
      /"clientMutationId":"[^"]+"/,
    );
  });

  it("keeps the mobile Import draft when the shared workflow projects onto desktop", async () => {
    renderNexus({ mobile: true });
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const mobileDialog = await screen.findByRole("dialog", {
      name: "Nexus",
    });
    await userEvent.click(
      within(mobileDialog).getByRole("button", { name: /^Import\b/ }),
    );
    const links = await within(mobileDialog).findByRole("textbox", {
      name: "Links",
    });
    await userEvent.type(links, "https://example.com/article");

    viewport.setMobile(false);

    const desktopDialog = await screen.findByRole("dialog", {
      name: "Nexus",
    });
    expect(
      within(desktopDialog).getByRole("heading", { name: "Add content" }),
    ).toBeVisible();
    expect(
      within(desktopDialog).getByRole("textbox", { name: "Links" }),
    ).toHaveValue("https://example.com/article");

    viewport.setMobile(true);

    const mobileAgain = await screen.findByRole("dialog", {
      name: "Add content",
    });
    expect(
      within(mobileAgain).getByRole("heading", { name: "Add content" }),
    ).toBeVisible();
    expect(
      within(mobileAgain).getByRole("textbox", { name: "Links" }),
    ).toHaveValue("https://example.com/article");
  });

  it("keeps active Add work behind the Stop guard until Close is confirmed", async () => {
    mediaFromUrlResponse = new Promise<Response>(() => {});
    renderNexus({ mobile: true });
    const trigger = screen.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await userEvent.click(trigger);
    const nexus = await screen.findByRole("dialog", { name: "Nexus" });
    await userEvent.click(
      within(nexus).getByRole("button", { name: /^Import\b/ }),
    );
    const links = await within(nexus).findByRole("textbox", {
      name: "Links",
    });
    await userEvent.type(links, "https://example.com/running");
    await userEvent.click(
      within(nexus).getByRole("button", { name: "Review links" }),
    );
    await userEvent.click(
      await within(nexus).findByRole("button", { name: "Add 1 item" }),
    );
    expect(
      await within(nexus).findAllByText("Adding 1 item…"),
    ).not.toHaveLength(0);

    fireEvent.keyDown(document, { key: "Escape" });
    let confirmation = await screen.findByRole("dialog", {
      name: "Stop active work?",
    });
    expect(nexus).toHaveAttribute("inert");
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Keep working" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Stop active work?" }),
      ).toBeNull(),
    );
    expect(nexus).toBeVisible();
    expect(within(nexus).getAllByText("Adding 1 item…")).not.toHaveLength(0);

    await userEvent.click(
      within(nexus).getByRole("button", { name: "Close Add content" }),
    );
    confirmation = await screen.findByRole("dialog", {
      name: "Stop active work?",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", {
        name: "Stop and close",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each([
    {
      paneCount: 1,
      label: "Open Nexus, 1 tab",
      rootFontSize: 16,
    },
    {
      paneCount: 9,
      label: "Open Nexus, 9 tabs",
      rootFontSize: 16,
    },
    {
      paneCount: MAX_PANES,
      label: `Open Nexus, ${MAX_PANES} tabs`,
      rootFontSize: 16,
    },
    {
      paneCount: 1,
      label: "Open Nexus, 1 tab",
      rootFontSize: 32,
    },
    {
      paneCount: 9,
      label: "Open Nexus, 9 tabs",
      rootFontSize: 32,
    },
    {
      paneCount: MAX_PANES,
      label: `Open Nexus, ${MAX_PANES} tabs`,
      rootFontSize: 32,
    },
  ])(
    "keeps count $paneCount fixed at a $rootFontSize px root text scale",
    ({ paneCount, label, rootFontSize }) => {
      document.documentElement.style.fontSize = `${rootFontSize}px`;
      renderNexus({
        mobile: true,
        state: paneCountState(paneCount),
      });

      const wrapper = screen.getByTestId("nexus-wrapper");
      const buttons = within(wrapper).getAllByRole("button");
      expect(buttons).toHaveLength(1);
      const button = within(wrapper).getByRole("button", { name: label });
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("aria-haspopup", "dialog");

      const counter = within(button).getByText(String(paneCount));
      expect(counter).toHaveAttribute("aria-hidden", "true");
      expect(getComputedStyle(counter).pointerEvents).toBe("none");

      const wrapperRect = wrapper.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const counterRect = counter.getBoundingClientRect();
      const expectedCounterSize =
        Number.parseFloat(getComputedStyle(counter).fontSize) * 1.625;

      expect(wrapperRect.width).toBeCloseTo(48, 1);
      expect(wrapperRect.height).toBeCloseTo(48, 1);
      expect(buttonRect.width).toBeCloseTo(48, 1);
      expect(buttonRect.height).toBeCloseTo(48, 1);
      expect(counterRect.width).toBeCloseTo(expectedCounterSize, 1);
      expect(counterRect.height).toBeCloseTo(expectedCounterSize, 1);
      expect(counterRect.top - buttonRect.top).toBeCloseTo(1, 1);
      expect(buttonRect.right - counterRect.right).toBeCloseTo(1, 1);
      expect(counterRect.left).toBeGreaterThanOrEqual(buttonRect.left);
      expect(counterRect.bottom).toBeLessThanOrEqual(buttonRect.bottom);
      expect(counter.scrollWidth).toBeLessThanOrEqual(
        counter.clientWidth + 1,
      );
      expect(counter.scrollHeight).toBeLessThanOrEqual(
        counter.clientHeight + 1,
      );
    },
  );

  it("opens one full-screen Nexus task without exposing an outside-click dismissal", async () => {
    renderNexus({ mobile: true });
    const wrapper = screen.getByTestId("nexus-wrapper");
    const button = screen.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    const before = wrapper.getBoundingClientRect();

    await userEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const search = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    await waitFor(() => expect(search).toHaveFocus());
    expect(
      within(dialog).queryByRole("combobox", { name: "Find anything…" }),
    ).toBeNull();
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the unpainted modal projection is intentionally role=presentation and has no user-facing label
    const projection = dialog.parentElement as HTMLElement;
    expect(projection).toHaveAttribute("data-modal-backdrop", "true");
    expect(getComputedStyle(projection).position).toBe("fixed");
    const frameRect = dialog.getBoundingClientRect();
    expect(frameRect.left).toBeCloseTo(0, 1);
    expect(frameRect.top).toBeCloseTo(0, 1);
    expect(frameRect.right).toBeCloseTo(window.innerWidth, 1);
    expect(frameRect.bottom).toBeCloseTo(window.innerHeight, 1);
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the removed grabber is decorative and intentionally has no accessible query
    expect(document.querySelector("[data-grabber]")).toBeNull();

    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("inert");
    expect(button).not.toBeVisible();
    const after = wrapper.getBoundingClientRect();
    expect(after.left).toBeCloseTo(before.left, 1);
    expect(after.top).toBeCloseTo(before.top, 1);
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);

    fireEvent.click(projection);
    expect(dialog).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() => expect(button).toHaveFocus());
    expect(wrapper.getBoundingClientRect().width).toBeCloseTo(before.width, 1);
    expect(wrapper.getBoundingClientRect().height).toBeCloseTo(before.height, 1);
  });

  it("focuses mobile search on open and clears before dismissing Root", async () => {
    renderNexus({ mobile: true });
    const button = screen.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, "Project Ideas");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).toBeVisible();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("keeps mobile search and creation fields at the iOS no-zoom size", async () => {
    document.documentElement.style.setProperty("--text-md", "16px");
    document.body.style.fontSize = "15px";
    renderNexus({ mobile: true });
    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });

    expect(
      getComputedStyle(
        within(dialog).getByRole("searchbox", { name: "Find anything…" }),
      ).fontSize,
    ).toBe("16px");

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^New Library\b/ }),
    );
    expect(
      getComputedStyle(
        await within(dialog).findByRole("textbox", { name: "Name" }),
      ).fontSize,
    ).toBe("16px");
  });

  it("keeps the obstruction stable and paints nothing when reader retreat hides Nexus", async () => {
    renderNexus({ mobile: true, readerScrollportProbe: true });
    const wrapper = screen.getByTestId("nexus-wrapper");
    const button = screen.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    const before = wrapper.getBoundingClientRect();
    const reader = screen.getByRole("region", { name: "Reader content" });

    reader.scrollTop = 40;
    fireEvent.scroll(reader);

    await waitFor(() => {
      expect(button).toHaveAttribute("aria-hidden", "true");
    });
    expect(button).toHaveAttribute("inert");
    expect(getComputedStyle(button).visibility).toBe("visible");

    reader.scrollTop = 96;
    fireEvent.scroll(reader);

    await waitFor(() => {
      expect(button).toHaveAttribute(
        "data-mobile-chrome-phase",
        "Hidden",
      );
    });
    expect(getComputedStyle(button).visibility).toBe("hidden");
    const after = wrapper.getBoundingClientRect();
    expect(after.left).toBeCloseTo(before.left, 1);
    expect(after.top).toBeCloseTo(before.top, 1);
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
  });

  it.each([
    {
      paneCount: 1,
      label: "Open Nexus, 1 tab",
      rootFontSize: 16,
    },
    {
      paneCount: 9,
      label: "Open Nexus, 9 tabs",
      rootFontSize: 16,
    },
    {
      paneCount: MAX_PANES,
      label: `Open Nexus, ${MAX_PANES} tabs`,
      rootFontSize: 16,
    },
    {
      paneCount: 1,
      label: "Open Nexus, 1 tab",
      rootFontSize: 32,
    },
    {
      paneCount: 9,
      label: "Open Nexus, 9 tabs",
      rootFontSize: 32,
    },
    {
      paneCount: MAX_PANES,
      label: `Open Nexus, ${MAX_PANES} tabs`,
      rootFontSize: 32,
    },
  ])(
    "keeps count $paneCount fixed at a $rootFontSize px root text scale",
    ({ paneCount, label, rootFontSize }) => {
      document.documentElement.style.fontSize = `${rootFontSize}px`;
      renderNexus({
        mobile: true,
        state: paneCountState(paneCount),
      });

      const wrapper = screen.getByTestId("nexus-wrapper");
      const buttons = within(wrapper).getAllByRole("button");
      expect(buttons).toHaveLength(1);
      const button = within(wrapper).getByRole("button", { name: label });
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("aria-haspopup", "dialog");

      const counter = within(button).getByText(String(paneCount));
      expect(counter).toHaveAttribute("aria-hidden", "true");
      expect(getComputedStyle(counter).pointerEvents).toBe("none");

      const wrapperRect = wrapper.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const counterRect = counter.getBoundingClientRect();
      const expectedCounterSize =
        Number.parseFloat(getComputedStyle(counter).fontSize) * 1.625;

      expect(wrapperRect.width).toBeCloseTo(48, 1);
      expect(wrapperRect.height).toBeCloseTo(48, 1);
      expect(buttonRect.width).toBeCloseTo(48, 1);
      expect(buttonRect.height).toBeCloseTo(48, 1);
      expect(counterRect.width).toBeCloseTo(expectedCounterSize, 1);
      expect(counterRect.height).toBeCloseTo(expectedCounterSize, 1);
      expect(counterRect.top - buttonRect.top).toBeCloseTo(1, 1);
      expect(buttonRect.right - counterRect.right).toBeCloseTo(1, 1);
      expect(counterRect.left).toBeGreaterThanOrEqual(buttonRect.left);
      expect(counterRect.bottom).toBeLessThanOrEqual(buttonRect.bottom);
      expect(counter.scrollWidth).toBeLessThanOrEqual(
        counter.clientWidth + 1,
      );
      expect(counter.scrollHeight).toBeLessThanOrEqual(
        counter.clientHeight + 1,
      );
    },
  );

  it("opens Switchboard while preserving the stable Nexus wrapper", async () => {
    renderNexus({ mobile: true });
    const wrapper = screen.getByTestId("nexus-wrapper");
    const button = screen.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    const before = wrapper.getBoundingClientRect();

    await userEvent.click(button);

    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("inert");
    const after = wrapper.getBoundingClientRect();
    expect(after.left).toBeCloseTo(before.left, 1);
    expect(after.top).toBeCloseTo(before.top, 1);
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
  });

  it("keeps the obstruction stable and paints nothing when reader retreat hides Nexus", async () => {
    renderNexus({ mobile: true, readerScrollportProbe: true });
    const wrapper = screen.getByTestId("nexus-wrapper");
    const button = screen.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    const before = wrapper.getBoundingClientRect();
    const reader = screen.getByRole("region", { name: "Reader content" });

    reader.scrollTop = 40;
    fireEvent.scroll(reader);

    await waitFor(() => {
      expect(button).toHaveAttribute("aria-hidden", "true");
    });
    expect(button).toHaveAttribute("inert");
    expect(getComputedStyle(button).visibility).toBe("visible");

    reader.scrollTop = 96;
    fireEvent.scroll(reader);

    await waitFor(() => {
      expect(button).toHaveAttribute(
        "data-mobile-chrome-phase",
        "Hidden",
      );
    });
    expect(getComputedStyle(button).visibility).toBe("hidden");
    const after = wrapper.getBoundingClientRect();
    expect(after.left).toBeCloseTo(before.left, 1);
    expect(after.top).toBeCloseTo(before.top, 1);
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
  });
});
