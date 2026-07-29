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
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { PANE_SEARCH_REQUESTED_EVENT } from "@/lib/panes/paneSearchEvents";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
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
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import Nexus from "./Nexus";

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
let webSearchResults: unknown[] = [];
let viewport: ReturnType<typeof mockViewport>;

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

function webSearchResult() {
  return {
    type: "web_result",
    id: "provider:1",
    result_type: "web_result",
    result_ref: "provider:1",
    source_id: "provider:1",
    title: "A web result",
    url: "https://example.com/story",
    display_url: "example.com/story",
    deep_link: "https://example.com/story",
    citation_target: "external_snapshot:provider:1",
    locator: {
      type: "external_url",
      url: "https://example.com/story",
      title: "A web result",
      display_url: "example.com/story",
    },
    snippet: "An excerpt",
    extra_snippets: [],
    published_at: null,
    source_name: "Example",
    rank: 1,
    provider: "provider",
    provider_request_id: null,
    context_ref: { type: "web_result", id: "provider:1" },
    media_id: null,
    media_kind: null,
    score: 1,
    selected: false,
  };
}

function mockApi() {
  openablesResponse = Promise.resolve(
    jsonResponse({ data: { items: [] } }),
  );
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
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/resource-items/openables/search") {
        return typeof openablesResponse === "function"
          ? openablesResponse(init)
          : openablesResponse;
      }
      if (url.pathname === "/api/search") {
        return jsonResponse({
          results: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/web/search") {
        return jsonResponse({ data: { results: webSearchResults } });
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
            dailyNote: null,
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
  const { state } = useWorkspaceStore();
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
    </>
  );
}

function renderNexus(input: {
  readonly mobile?: boolean;
  readonly state?: WorkspaceState;
} = {}) {
  const mobile = input.mobile ?? false;
  viewport = mockViewport(mobile);
  return render(
    withRenderEnvironment(
      <MobileChromeProvider>
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
                  <ShareControllerProvider>
                    <WorkspaceProbe />
                    <Nexus />
                  </ShareControllerProvider>
                </LecternProvider>
              </WorkspaceStoreProvider>
            </PaneReturnMementoProvider>
          </FeedbackProvider>
        </KeybindingsProvider>
      </MobileChromeProvider>,
      { initialViewport: mobile ? "mobile" : "desktop" },
    ),
  );
}

function maxPaneState(): WorkspaceState {
  const panes = Array.from({ length: MAX_PANES }, (_, index) => ({
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

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  requests = [];
  webSearchResults = [];
  mockApi();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Nexus shell contracts", () => {
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

  it("consumes the exact WebSearch URL intent into the explicit Web page", async () => {
    window.history.replaceState(
      {},
      "",
      "/?nexus=1&intent=WebSearch&q=design%20systems",
    );

    renderNexus();

    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).getByRole("heading", { name: "Web Search" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("combobox", { name: "Search the web" }),
    ).toHaveValue("design systems");
    expect(window.location.search).toBe("");
  });

  it("runs the same WebSearch URL intent through the live provider on mobile", async () => {
    webSearchResults = [webSearchResult()];
    window.history.replaceState(
      {},
      "",
      "/?nexus=1&intent=WebSearch&q=epistemology",
    );

    renderNexus({ mobile: true });

    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).getByRole("searchbox", { name: "Search the web" }),
    ).toHaveValue("epistemology");
    await waitFor(() =>
      expect(
        requests.some(
          ({ url }) =>
            url.pathname === "/api/web/search" &&
            url.searchParams.get("q") === "epistemology",
        ),
      ).toBe(true),
    );
    await userEvent.click(
      await within(dialog).findByRole("button", {
        name: "Actions for A web result",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Open another tab" }),
    ).toBeVisible();
  });

  it("uses Nexus.Open to open the shell, enter available actions, and no-op without actions", async () => {
    renderNexus();

    openWithKeyboard();
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).getByRole("combobox", { name: "Find anything" }),
    ).toHaveFocus();

    openWithKeyboard();
    expect(
      await within(dialog).findByRole("heading", {
        name: /Actions for Libraries/,
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("menuitem", { name: "Close tab" }),
    ).toBeVisible();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Back to Nexus" }),
    );
    const input = await within(dialog).findByRole("combobox", {
      name: "Find anything",
    });
    await userEvent.type(input, "notes");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("option", { name: /^Notes\b/ }),
      ).toHaveAttribute("aria-selected", "true"),
    );

    openWithKeyboard();
    dialog = screen.getByRole("dialog", { name: "Nexus" });
    expect(
      within(dialog).queryByRole("heading", { name: /Actions for/ }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("combobox", { name: "Find anything" }),
    ).toHaveValue("notes");
  });

  it("teaches the current pane Search binding and closes only after consumption", async () => {
    renderNexus();
    openWithKeyboard();
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
      name: "Find anything",
    });
    await userEvent.type(input, "search this pane");
    const option = await within(dialog).findByRole("option", {
      name: /^Search this pane\. Ctrl\+F\. Command$/,
    });
    const consume = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(PANE_SEARCH_REQUESTED_EVENT, consume, {
      once: true,
    });

    await userEvent.click(option);

    expect(consume).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
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
      name: "Find anything",
    });
    await userEvent.type(input, "alpha");
    await openablesStarted;
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /^Libraries\b/ }),
      ).toHaveAttribute("aria-selected", "true"),
    );

    resolveOpenables(
      jsonResponse({ data: { items: [openablePageResult()] } }),
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
      query: "alpha",
      target_href: "/libraries",
      label_snapshot: "Libraries",
      source: "Workspace",
    });
    expect(
      String(selectionRequests()[0]!.body?.client_mutation_id),
    ).toMatch(/^[0-9a-f-]{36}$/i);
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
      name: "Find anything",
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
      screen.queryByRole("option", { name: /^Alpha\b/ }),
    ).toBeNull();

    resolveBeta(jsonResponse({ data: { items: [] } }));
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
      name: "Find anything",
    });
    await userEvent.type(input, "page");
    expect(
      await screen.findByRole("option", {
        name: /^Page before mutation\b/,
      }),
    ).toBeVisible();
    const callsBeforeMutation = openablesCalls;

    mutationCompleted = true;
    fireEvent.click(
      screen.getByRole("option", { name: /^Page\. Create$/ }),
      { shiftKey: true },
    );
    expect(
      await screen.findByText(/Your page was created\./),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    input = await screen.findByRole("combobox", {
      name: "Find anything",
    });
    expect(input).toHaveValue("page");
    expect(
      await screen.findByRole("option", {
        name: /^Page after mutation\b/,
      }),
    ).toBeVisible();
    expect(openablesCalls).toBeGreaterThan(callsBeforeMutation);
  });

  it("carries Shift+Enter Fork through the shell and records the accepted new tab", async () => {
    renderNexus();
    act(() => requestNexusOpen({ kind: "Root" }));
    const input = await screen.findByRole("combobox", {
      name: "Find anything",
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
      name: "Find anything",
    });

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(
      await screen.findByRole("heading", { name: "Tab limit reached" }),
    ).toBeVisible();
    expect(screen.getByText(/destination is ready to open/i)).toBeVisible();
    expect(selectionRequests()).toHaveLength(0);

    await userEvent.click(
      screen.getByRole("button", { name: "Manage tabs" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    act(() => requestNexusOpen({ kind: "Root" }));
    expect(
      await screen.findByRole("heading", { name: "Ready to open" }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() =>
      requestNexusOpen({
        kind: "QuickAction",
        actionId: "Nexus.Quick.Page",
      }),
    );
    expect(await screen.findByText("Creating page…")).toBeVisible();
    expect(
      await screen.findByText(/Your page was created\./),
    ).toBeVisible();
    expect(selectionRequests()).toHaveLength(0);

    fireEvent.click(screen.getByRole("presentation"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    act(() => requestNexusOpen({ kind: "Root" }));
    expect(
      await screen.findByText(/Your page was created\./),
    ).toBeVisible();
    expect(
      requests.filter(
        ({ url, init }) =>
          url.pathname === "/api/notes/pages" &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);
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
      within(mobileDialog).getByRole("button", { name: "Import" }),
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
  });
});
