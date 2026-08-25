import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { MediaActivityProvider } from "@/lib/media/MediaActivityProvider";
import { NEXUS_OPEN_PERFORMANCE } from "@/lib/nexus/performance";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
} from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createDefaultWorkspaceState,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import Nexus from "./Nexus";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function workspacePane(
  id: string,
  href: string,
  visibility: WorkspacePrimaryPaneState["visibility"] = "visible",
): WorkspacePrimaryPaneState {
  const pane = getWorkspacePrimaryPanes(
    createDefaultWorkspaceState(href, workspacePrimaryMetrics),
  )[0]!;
  return { ...pane, id, visibility };
}

interface TouchCoordinate {
  readonly x: number;
  readonly y: number;
}

function toTopLevelCdpCoordinate(coordinate: TouchCoordinate): TouchCoordinate {
  let sourceWindow: Window = window;
  let x = coordinate.x;
  let y = coordinate.y;

  while (sourceWindow !== sourceWindow.parent) {
    const frame = sourceWindow.frameElement;
    if (
      !frame ||
      sourceWindow.innerWidth <= 0 ||
      sourceWindow.innerHeight <= 0
    ) {
      throw new Error("Cannot project trusted input through the Vitest frame");
    }
    const frameRect = frame.getBoundingClientRect();
    x = frameRect.left + x * (frameRect.width / sourceWindow.innerWidth);
    y = frameRect.top + y * (frameRect.height / sourceWindow.innerHeight);
    sourceWindow = sourceWindow.parent;
  }

  return { x, y };
}

let touchEmulationEnabled = false;
let reducedMotionEmulated = false;

async function enableTrustedTouchInput(maxTouchPoints = 1): Promise<void> {
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints,
  });
  touchEmulationEnabled = true;
}

async function emulateReducedMotion(): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  reducedMotionEmulated = true;
}

async function sendTrustedTouchEvent(
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  touchPoints: readonly (TouchCoordinate & { readonly id: number })[],
  timestamp?: number,
): Promise<void> {
  await cdp().send("Input.dispatchTouchEvent", {
    type,
    touchPoints: touchPoints.map(({ id, ...point }) => ({
      ...toTopLevelCdpCoordinate(point),
      id,
    })),
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

async function dispatchTrustedTouch({
  start,
  moves = [],
  terminal = "touchEnd",
  elapsedSeconds,
}: {
  readonly start: TouchCoordinate;
  readonly moves?: readonly TouchCoordinate[];
  readonly terminal?: "touchEnd" | "touchCancel";
  readonly elapsedSeconds?: number;
}): Promise<void> {
  const elapsed = elapsedSeconds ?? 0;
  const endTimestamp =
    elapsedSeconds === undefined ? undefined : Date.now() / 1_000;
  const startTimestamp =
    endTimestamp === undefined ? undefined : endTimestamp - elapsed;
  await sendTrustedTouchEvent(
    "touchStart",
    [{ ...start, id: 1 }],
    startTimestamp,
  );
  for (const [index, move] of moves.entries()) {
    await sendTrustedTouchEvent(
      "touchMove",
      [{ ...move, id: 1 }],
      startTimestamp === undefined
        ? undefined
        : startTimestamp + (elapsed * (index + 1)) / (moves.length + 1),
    );
  }
  await sendTrustedTouchEvent(terminal, [], endTimestamp);
}

async function dispatchTrustedTouchWithClickOracle(
  button: HTMLElement,
  coordinate: TouchCoordinate,
): Promise<void> {
  const pointerDownRef: { current: PointerEvent | null } = { current: null };
  button.addEventListener(
    "pointerdown",
    (event) => {
      pointerDownRef.current = event;
    },
    { once: true },
  );
  await dispatchTrustedTouch({ start: coordinate });
  const pointerDown = pointerDownRef.current;
  const diagnostic = `local=${JSON.stringify(coordinate)}, topLevel=${JSON.stringify(toTopLevelCdpCoordinate(coordinate))}, phase=${button.getAttribute("data-mobile-chrome-phase") ?? "missing"}, inert=${button.hasAttribute("inert")}`;
  if (pointerDown === null) {
    throw new Error(
      `The trusted touch preceding the click oracle did not reach the current Nexus button; ${diagnostic}`,
    );
  }
  expect(
    {
      trusted: pointerDown.isTrusted,
      pointerType: pointerDown.pointerType,
      primary: pointerDown.isPrimary,
    },
    `The click oracle received the wrong trusted pointer stream; ${diagnostic}`,
  ).toEqual({ trusted: true, pointerType: "touch", primary: true });
  // Chromium's raw touch and synthesized-tap CDP paths deliver trusted touch
  // PointerEvents in this non-hasTouch Vitest context but omit the compatibility
  // click. Inject only that click oracle; never substitute the pointer stream.
  fireEvent.click(button, { detail: 1 });
}

async function dispatchTrustedMouseOrPen(
  pointerType: "mouse" | "pen",
  start: TouchCoordinate,
  end: TouchCoordinate = start,
): Promise<void> {
  const cdpStart = toTopLevelCdpCoordinate(start);
  const cdpEnd = toTopLevelCdpCoordinate(end);
  // Chromium positions the pointing device before native down/up activation;
  // omitting this provider step yields pointer events but no compatibility click.
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...cdpStart,
    buttons: 0,
    pointerType,
  });
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...cdpStart,
    button: "left",
    buttons: 1,
    clickCount: 1,
    force: 0.5,
    pointerType,
  });
  if (start.x !== end.x || start.y !== end.y) {
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...cdpEnd,
      buttons: 1,
      force: 0.5,
      pointerType,
    });
  }
  await cdp().send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...cdpEnd,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType,
  });
}

const TRUSTED_POINTER_TRACE_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "click",
] as const;

interface TrustedPointerTraceEntry {
  readonly type: (typeof TRUSTED_POINTER_TRACE_EVENTS)[number];
  readonly target: string;
  readonly trusted: boolean;
  readonly detail: number;
  readonly pointerType: string;
  readonly primary: boolean;
  readonly x: number;
  readonly y: number;
  readonly pointerId: number;
  readonly captured: boolean;
  readonly phase: string;
}

function beginTrustedPointerTrace(button: HTMLElement) {
  const entries: TrustedPointerTraceEntry[] = [];
  const record = (event: Event) => {
    const mouseEvent = event instanceof MouseEvent ? event : null;
    const pointerEvent = event instanceof PointerEvent ? event : null;
    entries.push({
      type: event.type as TrustedPointerTraceEntry["type"],
      target:
        event.target instanceof Element
          ? event.target.tagName.toLowerCase()
          : String(event.target),
      trusted: event.isTrusted,
      detail: mouseEvent?.detail ?? -1,
      pointerType: pointerEvent?.pointerType ?? "missing",
      primary: pointerEvent?.isPrimary ?? false,
      x: mouseEvent?.clientX ?? Number.NaN,
      y: mouseEvent?.clientY ?? Number.NaN,
      pointerId: pointerEvent?.pointerId ?? -1,
      captured:
        pointerEvent === null
          ? false
          : button.hasPointerCapture(pointerEvent.pointerId),
      phase: button.getAttribute("data-mobile-chrome-phase") ?? "missing",
    });
  };
  for (const type of TRUSTED_POINTER_TRACE_EVENTS) {
    button.addEventListener(type, record);
  }
  return {
    entries,
    stop() {
      for (const type of TRUSTED_POINTER_TRACE_EVENTS) {
        button.removeEventListener(type, record);
      }
    },
  };
}

function trustedPointerTraceDiagnostic(
  entries: readonly TrustedPointerTraceEntry[],
): string {
  if (entries.length === 0) return "<empty>";
  return entries
    .map(
      (entry) =>
        `${entry.type}[target=${entry.target},trusted=${entry.trusted},detail=${entry.detail},type=${entry.pointerType},primary=${entry.primary},x=${entry.x},y=${entry.y},id=${entry.pointerId},capture=${entry.captured},phase=${entry.phase}]`,
    )
    .join(" -> ");
}

function MobileChromeScrollport() {
  const ref = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey: "nexus-browser-proof",
    enabled: true,
  });
  return (
    <div
      ref={ref}
      data-testid="mobile-chrome-scrollport"
      style={{
        position: "fixed",
        width: 1,
        height: 100,
        overflow: "auto",
        opacity: 0,
        pointerEvents: "none",
      }}
    >
      <div style={{ height: 1_000 }} />
    </div>
  );
}

interface RecordedRequest {
  readonly pathname: string;
  readonly search: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
  readonly keepalive: boolean;
  readonly signal: AbortSignal | null;
  readonly activeWorkspaceLocation: string | null;
}

let requests: RecordedRequest[] = [];
let activeWorkspaceLocation: string | null = null;
let respondToOpenables: (init: RequestInit | undefined) => Promise<Response>;
let respondToSearch: (init: RequestInit | undefined) => Promise<Response>;
let respondToSelection: (init: RequestInit | undefined) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function installBff() {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      requests.push({
        pathname: url.pathname,
        search: url.search,
        method,
        body,
        keepalive: init?.keepalive ?? request?.keepalive ?? false,
        signal: init?.signal ?? request?.signal ?? null,
        activeWorkspaceLocation,
      });

      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/media/activity") {
        return jsonResponse({
          data: {
            needs_attention_count: 0,
            active_count: 0,
            has_more: false,
            items: [],
          },
        });
      }
      if (url.pathname === "/api/me/nexus-history") {
        return jsonResponse({
          data: { recent: [], frecency_by_href: {} },
        });
      }
      if (url.pathname === "/api/me/nexus-selections" && method === "POST") {
        return respondToSelection(init);
      }
      if (url.pathname === "/api/me/workspace-session" && method === "PUT") {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/resource-items/openables/search") {
        return respondToOpenables(init);
      }
      if (url.pathname === "/api/search") {
        return respondToSearch(init);
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`Unexpected BFF request: ${method} ${url.pathname}`);
    },
  );
}

function WorkspaceProbe() {
  const { state } = useWorkspaceStore();
  const panes = getWorkspacePrimaryPanes(state);
  const active = panes.find((pane) => pane.id === state.activePrimaryPaneId);
  const activeHref = active?.currentVisit.href ?? null;
  useLayoutEffect(() => {
    activeWorkspaceLocation = activeHref;
  }, [activeHref]);
  return (
    <>
      <output aria-label="Workspace pane count">{panes.length}</output>
      <output aria-label="Workspace active pane">{active?.id ?? ""}</output>
      <output aria-label="Workspace active location">
        {active?.currentVisit.href ?? ""}
      </output>
    </>
  );
}

function renderNexus(
  initialViewport: "desktop" | "mobile",
  initialWorkspaceState: WorkspaceState = createDefaultWorkspaceState(
    "/libraries",
    workspacePrimaryMetrics,
  ),
  withMobileChromeScrollport = false,
) {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          calendarTimeZone: "UTC",
        }}
      >
        <MobileChromeProvider>
          {withMobileChromeScrollport ? <MobileChromeScrollport /> : null}
          <KeybindingsProvider>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  initialState={initialWorkspaceState}
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                >
                  <LecternProvider>
                    <OfflineMediaProvider
                      accountId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                      transport={null}
                    >
                      <GlobalPlayerProvider>
                        <ShareControllerProvider>
                          <MediaActivityProvider>
                            <WorkspaceProbe />
                            <Nexus />
                          </MediaActivityProvider>
                        </ShareControllerProvider>
                      </GlobalPlayerProvider>
                    </OfflineMediaProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
      { initialViewport },
    ),
  );
}

function selectionRequests() {
  return requests.filter(
    (request) =>
      request.pathname === "/api/me/nexus-selections" &&
      request.method === "POST",
  );
}

function openablesRequests(query?: string) {
  return requests.filter(
    (request) =>
      request.pathname === "/api/resource-items/openables/search" &&
      request.method === "POST" &&
      (query === undefined || request.body?.q === query),
  );
}

function queryHistoryRequests() {
  return requests.filter(
    (request) =>
      request.pathname === "/api/me/nexus-history" &&
      new URLSearchParams(request.search).has("query"),
  );
}

async function passAnimationFrames(count: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let remaining = count;
    const advance = () => {
      remaining -= 1;
      if (remaining === 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(advance);
    };
    window.requestAnimationFrame(advance);
  });
}

function activePaneStatus(): HTMLElement {
  return screen.getByRole("status", { name: "Workspace active pane" });
}

async function dismissNexus(): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Nexus" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
  );
}

async function openManageTabs(
  viewport: "desktop" | "mobile",
  paneCount: number,
): Promise<HTMLElement> {
  if (viewport === "mobile") {
    await userEvent.click(
      await screen.findByRole("button", {
        name: `Open Nexus, ${paneCount} tabs`,
      }),
    );
  } else {
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  }
  const dialog = await screen.findByRole("dialog", { name: "Nexus" });
  await userEvent.click(
    await within(dialog).findByRole(
      viewport === "mobile" ? "button" : "gridcell",
      { name: /^Manage tabs…/ },
    ),
  );
  expect(
    await within(dialog).findByRole("heading", { name: "Manage tabs" }),
  ).toBeVisible();
  return dialog;
}

describe("Nexus product composition", () => {
  beforeEach(() => {
    requests = [];
    activeWorkspaceLocation = null;
    respondToOpenables = async () => jsonResponse({ data: { items: [] } });
    respondToSearch = async () =>
      jsonResponse({
        results: [],
        page: { has_more: false, next_cursor: null },
      });
    respondToSelection = async () => jsonResponse({ data: null });
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    installBff();
  });

  afterEach(async () => {
    if (reducedMotionEmulated) {
      await cdp().send("Emulation.setEmulatedMedia", { features: [] });
      reducedMotionEmulated = false;
    }
    if (!touchEmulationEnabled) return;
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    touchEmulationEnabled = false;
  });

  it("opens the desktop command surface and forks its active place into a real workspace pane", async () => {
    await page.viewport(1_280, 900);
    renderNexus("desktop");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
      name: "Find anything…",
    });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Workspace pane count" })
          .textContent,
        "Desktop Nexus Shift+Enter lost its Fork disposition at the workspace boundary",
      ).toBe("2"),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    expect(selectionRequests()[0]?.body).toMatchObject({
      target_href: "/libraries",
      source: "Workspace",
    });
  });

  it("opens the mobile task, focuses search, and follows a place through the same workspace owner", async () => {
    await page.viewport(390, 800);
    renderNexus("mobile");

    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const search = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    await waitFor(() => expect(search).toHaveFocus());
    const places = within(dialog).getByRole("region", { name: "Places" });
    const placeButtons = within(places).getAllByRole("button");
    expect(placeButtons).toEqual([
      within(places).getByRole("button", { name: /^Lectern Place$/ }),
      within(places).getByRole("button", { name: /^Libraries Place$/ }),
      within(places).getByRole("button", { name: /^Browse Place$/ }),
      within(places).getByRole("button", { name: /^Podcasts Place$/ }),
      within(places).getByRole("button", { name: /^Chats Place$/ }),
      within(places).getByRole("button", { name: /^Notes Place$/ }),
    ]);
    expect(
      within(places).queryByRole("button", { name: /^Stats Place$/ }),
    ).toBeNull();
    expect(
      within(places).queryByRole("button", { name: /^Atlas Place$/ }),
    ).toBeNull();
    expect(
      within(places).queryByRole("button", { name: /^Oracle Place$/ }),
    ).toBeNull();

    fireEvent.click(
      within(places).getByRole("button", { name: /^Notes Place$/ }),
    );
    expect(
      selectionRequests(),
      "Nexus history was written before the accepted destination could paint",
    ).toHaveLength(0);

    fireEvent(window, new Event("pagehide"));

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Workspace active location" }),
      ).toHaveTextContent("/notes"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    const selection = selectionRequests()[0];
    expect(selection?.activeWorkspaceLocation).toBe("/notes");
    expect(selection?.keepalive).toBe(true);
    expect(selection?.body).toMatchObject({
      target_href: "/notes",
      label_snapshot: "Notes",
      source: "Static",
    });

    await passAnimationFrames(3);
    expect(
      selectionRequests(),
      "Frames scheduled before pagehide duplicated the flushed Nexus history write",
    ).toHaveLength(1);
  });

  it("replays one mutation after foreground work preempts selection persistence", async () => {
    let attempt = 0;
    respondToSelection = async (init) => {
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
    await page.viewport(390, 800);
    renderNexus("mobile");
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Notes Place$/ }),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    const first = selectionRequests()[0];
    const mutationId = first?.body?.client_mutation_id;
    expect(mutationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first?.signal).toBeInstanceOf(AbortSignal);

    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Nexus" });
    await waitFor(() => expect(first?.signal?.aborted).toBe(true));
    expect(
      selectionRequests(),
      "Foreground Nexus work duplicated an interrupted selection mutation",
    ).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(selectionRequests()).toHaveLength(2));
    expect(selectionRequests()[1]?.body?.client_mutation_id).toBe(mutationId);
  });

  it("starts query-aware history only after the foreground provider chain settles", async () => {
    let resolveOpenables!: (response: Response) => void;
    let resolveSearch!: (response: Response) => void;
    const openablesStarted = new Promise<void>((resolve) => {
      respondToOpenables = async () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveOpenables = resolveResponse;
        });
      };
    });
    const searchStarted = new Promise<void>((resolve) => {
      respondToSearch = async () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveSearch = resolveResponse;
        });
      };
    });
    await page.viewport(1_280, 900);
    renderNexus("desktop");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
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
    expect(
      new URLSearchParams(queryHistoryRequests()[0]?.search).get("query"),
    ).toBe("alpha");
  });

  it("bounds Openables to the 32 most-recent session queries and releases them on dismissal", async () => {
    await page.viewport(1_280, 900);
    renderNexus("desktop");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
      name: "Find anything…",
    });
    const distinctQueries = [..."abcdefghijklmnopqrstuvwxyz", ..."0123456"];

    for (const query of distinctQueries) {
      fireEvent.change(input, { target: { value: query } });
      await waitFor(() =>
        expect(
          openablesRequests(query),
          `Openables did not settle query ${query}`,
        ).toHaveLength(1),
      );
    }

    const leastRecentlyUsed = distinctQueries[0]!;
    fireEvent.change(input, { target: { value: leastRecentlyUsed } });
    await waitFor(() =>
      expect(
        openablesRequests(leastRecentlyUsed),
        "The 33rd distinct Openables query did not evict the least-recently-used query",
      ).toHaveLength(2),
    );

    const backdrop = screen.getByRole("presentation", { hidden: true });
    fireEvent.click(backdrop);
    await waitFor(() => expect(input).toHaveValue(""));
    fireEvent.click(backdrop);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const reopened = await screen.findByRole("dialog", { name: "Nexus" });
    fireEvent.change(
      within(reopened).getByRole("combobox", { name: "Find anything…" }),
      { target: { value: leastRecentlyUsed } },
    );
    await waitFor(() =>
      expect(
        openablesRequests(leastRecentlyUsed),
        "Dismissing Nexus retained an Openables result from the prior session",
      ).toHaveLength(3),
    );
  });

  it("keeps trusted mouse and pen drags non-navigating while native button activation opens Nexus", async () => {
    const firstPane = workspacePane("first-pane", "/libraries");
    const lastPane = workspacePane("last-pane", "/podcasts");
    await page.viewport(390, 800);
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: [firstPane, lastPane],
      }),
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 2 tabs",
    });
    const rect = button.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    const outside = { x: rect.left - 4, y: center.y };

    await dispatchTrustedMouseOrPen("mouse", center, outside);
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    await userEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await dismissNexus();

    const penButton = await screen.findByRole("button", {
      name: "Open Nexus, 2 tabs",
    });
    await waitFor(() => {
      const phase = penButton.getAttribute("data-mobile-chrome-phase");
      expect(
        phase === "Visible" || phase === "Pinned",
        `Expected an operable post-dismiss Nexus button phase (Visible or Pinned), received ${phase ?? "missing"}`,
      ).toBe(true);
    });
    expect(penButton).not.toHaveAttribute("inert");
    const penRect = penButton.getBoundingClientRect();
    const penCenter = {
      x: penRect.left + penRect.width / 2,
      y: penRect.top + penRect.height / 2,
    };
    const penOutside = { x: penRect.left - 4, y: penCenter.y };

    await dispatchTrustedMouseOrPen("pen", penCenter, penOutside);
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    await dispatchTrustedMouseOrPen("pen", penCenter);
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await dismissNexus();
  });

  // Touch scenarios stay last: Chromium does not restore `pointer: fine` after
  // touch emulation is disabled, so later fine-pointer proof would be vacuous.
  // URL/session/title/focus stay with their spec-named journey and WorkspaceHost;
  // physical pointer delivery at the fixed-control geometry stays with Android.
  it("uses trusted mobile touch to skip minimized tabs, clamp, reverse, and serialize slow or rapid swipes without opening Nexus", async () => {
    const firstPane = workspacePane("first-pane", "/libraries");
    const minimizedPane = workspacePane(
      "minimized-pane",
      "/notes",
      "minimized",
    );
    const lastPane = workspacePane("last-pane", "/podcasts");
    await page.viewport(390, 800);
    await enableTrustedTouchInput();
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: lastPane.id,
        primaryPanes: [firstPane, minimizedPane, lastPane],
      }),
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 3 tabs",
    });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    const phase = button.getAttribute("data-mobile-chrome-phase");
    expect(
      phase === "Visible" || phase === "Pinned",
      `Expected an operable Nexus button phase (Visible or Pinned), received ${phase ?? "missing"}`,
    ).toBe(true);
    expect(button).not.toHaveAttribute("inert");
    const rect = button.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const hitCenter = { x: rect.left + rect.width / 2, y: centerY };
    const outerRight = { x: rect.right - rect.width / 6, y: centerY };
    expect(
      [hitCenter, outerRight].every((point) =>
        button.contains(document.elementFromPoint(point.x, point.y)),
      ),
      `The operable Nexus button is not the local hit target at its center and outer third; phase=${button.getAttribute("data-mobile-chrome-phase") ?? "missing"}, inert=${button.hasAttribute("inert")}, rect=${JSON.stringify(rect.toJSON())}`,
    ).toBe(true);
    const firstSwipeTrace = beginTrustedPointerTrace(button);
    performance.clearMarks(NEXUS_OPEN_PERFORMANCE.start);
    performance.clearMeasures(NEXUS_OPEN_PERFORMANCE.measure);

    await dispatchTrustedTouch({
      start: outerRight,
      moves: [
        { x: outerRight.x + 10, y: centerY },
        { x: outerRight.x + 22, y: centerY },
      ],
    });
    expect(
      firstSwipeTrace.entries.some(
        (entry) =>
          entry.type === "pointerdown" &&
          entry.trusted &&
          entry.pointerType === "touch" &&
          entry.primary,
      ),
      `Chromium did not deliver the trusted touch stream to the Nexus button; localStart=${JSON.stringify(outerRight)}, topLevelStart=${JSON.stringify(toTopLevelCdpCoordinate(outerRight))}, pointer trace: ${trustedPointerTraceDiagnostic(firstSwipeTrace.entries)}`,
    ).toBe(true);
    await waitFor(() =>
      expect(
        activePaneStatus(),
        `A trusted Previous swipe from the outer third did not skip the minimized pane; pointer trace: ${trustedPointerTraceDiagnostic(firstSwipeTrace.entries)}`,
      ).toHaveTextContent(firstPane.id),
    );
    firstSwipeTrace.stop();
    const wrapper = screen.getByTestId("nexus-wrapper");
    const wrapperRect = wrapper.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const wrapperStyle = getComputedStyle(wrapper);
    const buttonStyle = getComputedStyle(button);
    expect(
      [
        wrapperRect.width,
        wrapperRect.height,
        buttonRect.width,
        buttonRect.height,
      ],
      "The rendered Nexus target drifted from the Android fixture's 48px wrapper/button envelope",
    ).toEqual([48, 48, 48, 48]);
    expect(
      [
        wrapperStyle.pointerEvents,
        buttonStyle.pointerEvents,
        buttonStyle.touchAction,
        buttonStyle.willChange,
      ],
      "The rendered Nexus pointer arbitration drifted from the Android fixture",
    ).toEqual(["none", "auto", "pan-y pinch-zoom", "transform"]);
    expect(
      {
        right: document.documentElement.clientWidth - wrapperRect.right,
        bottom: document.documentElement.clientHeight - wrapperRect.bottom,
      },
      "The Player-absent Nexus control moved inside the Android fixture's right/bottom envelope",
    ).toEqual({ right: 16, bottom: 12 });
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    expect(
      [
        ...performance.getEntriesByName(NEXUS_OPEN_PERFORMANCE.start),
        ...performance.getEntriesByName(NEXUS_OPEN_PERFORMANCE.measure),
      ],
      "A successful swipe started the Nexus-open performance run",
    ).toEqual([]);

    const center = { x: rect.left + rect.width / 2, y: centerY };
    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x + 10, y: center.y },
        { x: center.x + 22, y: center.y },
      ],
    });
    expect(
      activePaneStatus(),
      "A Previous swipe at the first visible pane wrapped instead of clamping",
    ).toHaveTextContent(firstPane.id);

    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
      ],
    });
    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x + 10, y: center.y },
        { x: center.x + 22, y: center.y },
      ],
    });
    await waitFor(() =>
      expect(
        activePaneStatus(),
        "Rapid Next then Previous swipes did not reduce against sequential workspace state",
      ).toHaveTextContent(firstPane.id),
    );

    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
        { x: center.x - 19, y: center.y },
      ],
    });
    expect(
      activePaneStatus(),
      "A swipe ending at 19px committed from its earlier 22px peak",
    ).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    await userEvent.click(button);
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "A fresh native mouse activation inherited stale touch-stream click suppression",
    ).toBeVisible();
    await dismissNexus();

    await emulateReducedMotion();
    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
      ],
      elapsedSeconds: 2,
    });
    await waitFor(() =>
      expect(
        activePaneStatus(),
        "A slow committed swipe gained a duration cutoff or changed under reduced motion",
      ).toHaveTextContent(lastPane.id),
    );

    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
        { x: center.x + 22, y: center.y },
      ],
    });
    await waitFor(() =>
      expect(
        activePaneStatus(),
        "A reversed swipe used peak travel instead of the final dx direction",
      ).toHaveTextContent(firstPane.id),
    );
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();

    expect(
      button.contains(document.elementFromPoint(center.x, center.y)),
      `The final genuine tap no longer hits the Nexus button; phase=${button.getAttribute("data-mobile-chrome-phase") ?? "missing"}`,
    ).toBe(true);
    const finalTapTrace = beginTrustedPointerTrace(button);
    await dispatchTrustedTouchWithClickOracle(button, center);
    await waitFor(() => {
      const dialog = screen.queryByRole("dialog", { name: "Nexus" });
      if (!dialog) {
        throw new Error(
          `The final genuine tap did not open Nexus; pointer trace: ${trustedPointerTraceDiagnostic(finalTapTrace.entries)}`,
        );
      }
      expect(dialog).toBeVisible();
    });
    finalTapTrace.stop();
  });

  it("yields jitter, vertical, diagonal, and cancelled touch while preserving tap and assistive activation", async () => {
    const firstPane = workspacePane("first-pane", "/libraries");
    const lastPane = workspacePane("last-pane", "/podcasts");
    await page.viewport(390, 800);
    await enableTrustedTouchInput();
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: [firstPane, lastPane],
      }),
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 2 tabs",
    });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    const rect = button.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };

    const outsideStart = { x: rect.left - rect.width, y: center.y };
    const outsideTrace = beginTrustedPointerTrace(button);
    await dispatchTrustedTouch({
      start: outsideStart,
      moves: [{ x: center.x + 22, y: center.y }],
    });
    expect(
      outsideTrace.entries.some((entry) => entry.type === "pointerdown"),
      "A touch originating outside the Nexus target reached its button-owned recognizer",
    ).toBe(false);
    outsideTrace.stop();
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();

    await dispatchTrustedTouch({
      start: center,
      moves: [{ x: center.x + 5, y: center.y + 5 }],
      elapsedSeconds: 2,
    });
    fireEvent.click(button, { detail: 1 });
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "A slow below-slop stream gained a recognizer timer or click suppression",
    ).toBeVisible();
    await dismissNexus();

    await dispatchTrustedTouch({
      start: center,
      moves: [{ x: center.x + 8, y: center.y }],
      terminal: "touchCancel",
    });
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    fireEvent.click(button, { detail: 1 });
    expect(
      screen.queryByRole("dialog", { name: "Nexus" }),
      "Movement at the exact 8px slop boundary did not arm click suppression",
    ).toBeNull();

    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 14, y: center.y + 10 },
        { x: center.x - 22, y: center.y },
      ],
    });
    expect(
      activePaneStatus(),
      "A yielded diagonal 14/10 first decision reconsidered later horizontal movement",
    ).toHaveTextContent(firstPane.id);
    await dispatchTrustedMouseOrPen("pen", center);
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "A fresh pen pointerdown did not consume stale touch suppression before filtering",
    ).toBeVisible();
    await dismissNexus();

    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 15, y: center.y + 10 },
        { x: center.x - 20, y: center.y + 14 },
      ],
    });
    expect(
      activePaneStatus(),
      "The exact 1.5 lock ratio and 20px final dx did not commit independently of final dy",
    ).toHaveTextContent(lastPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();

    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x, y: center.y + 9 },
        { x: center.x, y: center.y + 22 },
      ],
    });
    expect(
      activePaneStatus(),
      "Vertical touch intent acquired adjacent-pane navigation",
    ).toHaveTextContent(lastPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();

    await dispatchTrustedTouchWithClickOracle(button, center);
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await dismissNexus();

    await dispatchTrustedTouch({
      start: center,
      moves: [{ x: center.x - 10, y: center.y }],
      terminal: "touchCancel",
    });
    expect(activePaneStatus()).toHaveTextContent(lastPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    fireEvent.click(button, { detail: 0 });
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
  });

  it("keeps a single visible pane fixed and lets the next genuine tap open Nexus", async () => {
    const onlyPane = workspacePane("only-pane", "/libraries");
    await page.viewport(390, 800);
    await enableTrustedTouchInput();
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: onlyPane.id,
        primaryPanes: [onlyPane],
      }),
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    const rect = button.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
      ],
    });
    expect(activePaneStatus()).toHaveTextContent(onlyPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    await dispatchTrustedTouchWithClickOracle(button, center);
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
  });

  it("cancels trusted multitouch and real browser capture loss without stale click suppression", async () => {
    const firstPane = workspacePane("first-pane", "/libraries");
    const lastPane = workspacePane("last-pane", "/podcasts");
    await page.viewport(390, 800);
    await enableTrustedTouchInput(2);
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: [firstPane, lastPane],
      }),
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 2 tabs",
    });
    const rect = button.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    const jittered = { x: center.x - 4, y: center.y };
    await sendTrustedTouchEvent("touchStart", [{ ...center, id: 1 }]);
    await sendTrustedTouchEvent("touchMove", [{ ...jittered, id: 1 }]);
    await sendTrustedTouchEvent("touchStart", [
      { ...jittered, id: 1 },
      { x: center.x + 4, y: center.y + 4, id: 2 },
    ]);
    await sendTrustedTouchEvent("touchEnd", []);
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(
      screen.queryByRole("dialog", { name: "Nexus" }),
      "A second pointer before movement slop let the first contact open Nexus",
    ).toBeNull();
    fireEvent.click(button, { detail: 1 });
    expect(
      screen.queryByRole("dialog", { name: "Nexus" }),
      "The pre-slop second-pointer stream did not arm its compatibility-click interceptor",
    ).toBeNull();
    await dispatchTrustedTouchWithClickOracle(button, center);
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "Second-pointer cancellation left stale suppression on the next genuine tap",
    ).toBeVisible();
    await dismissNexus();

    await dispatchTrustedTouch({
      start: center,
      moves: [{ x: center.x - 10, y: center.y }],
      terminal: "touchCancel",
    });
    fireEvent.pointerDown(button, {
      pointerId: 99,
      pointerType: "touch",
      isPrimary: false,
      clientX: center.x,
      clientY: center.y,
    });
    fireEvent.click(button, { detail: 1 });
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "A fresh non-primary pointerdown did not consume stale suppression before filtering",
    ).toBeVisible();
    await dismissNexus();

    const pointerId: { current: number | null } = { current: null };
    button.addEventListener(
      "pointerdown",
      (event) => {
        pointerId.current = event.pointerId;
      },
      { once: true },
    );
    await sendTrustedTouchEvent("touchStart", [{ ...center, id: 1 }]);
    const capturedPointerId = pointerId.current;
    expect(
      capturedPointerId,
      "Trusted CDP touch did not produce a browser pointer identity",
    ).not.toBeNull();
    if (capturedPointerId === null) {
      throw new Error(
        "Trusted CDP touch did not produce a browser pointer identity",
      );
    }
    expect(
      button.hasPointerCapture(capturedPointerId),
      "The Nexus button did not acquire real browser pointer capture",
    ).toBe(true);
    const captureAcquired = new Promise<void>((resolve) => {
      button.addEventListener("gotpointercapture", () => resolve(), {
        once: true,
      });
    });
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 4, y: center.y, id: 1 },
    ]);
    await captureAcquired;
    const captureLost = new Promise<void>((resolve) => {
      button.addEventListener("lostpointercapture", () => resolve(), {
        once: true,
      });
    });
    button.releasePointerCapture(capturedPointerId);
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 5, y: center.y, id: 1 },
    ]);
    await captureLost;
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 10, y: center.y, id: 1 },
    ]);
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 22, y: center.y, id: 1 },
    ]);
    await sendTrustedTouchEvent("touchEnd", []);
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
    await dispatchTrustedTouchWithClickOracle(button, center);
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
  });

  it("cancels acquisition or release when Nexus or real mobile chrome makes the button inoperable", async () => {
    const firstPane = workspacePane("first-pane", "/libraries");
    const lastPane = workspacePane("last-pane", "/podcasts");
    await page.viewport(390, 800);
    await enableTrustedTouchInput();
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: [firstPane, lastPane],
      }),
      true,
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 2 tabs",
    });
    const rect = button.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };

    await sendTrustedTouchEvent("touchStart", [{ ...center, id: 1 }]);
    fireEvent.click(button, { detail: 0 });
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await sendTrustedTouchEvent("touchEnd", []);
    await dismissNexus();
    fireEvent.click(button, { detail: 1 });
    expect(
      screen.queryByRole("dialog", { name: "Nexus" }),
      "A pre-slop stream cancelled by Nexus opening did not intercept its compatibility click",
    ).toBeNull();
    await dispatchTrustedTouchWithClickOracle(button, center);
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "A fresh Idle touch pointerdown did not clear stale click suppression",
    ).toBeVisible();
    await dismissNexus();

    await sendTrustedTouchEvent("touchStart", [{ ...center, id: 1 }]);
    fireEvent.click(button, { detail: 0 });
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await sendTrustedTouchEvent("touchEnd", []);
    fireEvent.pointerDown(button, {
      pointerId: 100,
      pointerType: "mouse",
      isPrimary: true,
      clientX: center.x,
      clientY: center.y,
    });
    await dismissNexus();
    fireEvent.click(button, { detail: 1 });
    expect(
      await screen.findByRole("dialog", { name: "Nexus" }),
      "A fresh pointerdown delivered while Nexus was inoperable did not consume stale suppression before filtering",
    ).toBeVisible();
    await dismissNexus();

    await sendTrustedTouchEvent("touchStart", [{ ...center, id: 1 }]);
    fireEvent.click(button, { detail: 0 });
    const releaseDialog = await screen.findByRole("dialog", { name: "Nexus" });
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 10, y: center.y, id: 1 },
    ]);
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 22, y: center.y, id: 1 },
    ]);
    await sendTrustedTouchEvent("touchEnd", []);
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(releaseDialog).toBeVisible();
    await dismissNexus();

    fireEvent.click(button, { detail: 0 });
    const acquisitionDialog = await screen.findByRole("dialog", {
      name: "Nexus",
    });
    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
      ],
    });
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(acquisitionDialog).toBeVisible();
    await dismissNexus();

    await passAnimationFrames(2);
    button.blur();
    const scrollport = screen.getByTestId("mobile-chrome-scrollport");
    scrollport.scrollTop = 0;
    fireEvent.scroll(scrollport);
    await waitFor(() =>
      expect(button).toHaveAttribute("data-mobile-chrome-phase", "Visible"),
    );

    await sendTrustedTouchEvent("touchStart", [{ ...center, id: 1 }]);
    scrollport.scrollTop = 40;
    fireEvent.scroll(scrollport);
    await waitFor(() =>
      expect(button).toHaveAttribute("data-mobile-chrome-phase", "Tracking"),
    );
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 10, y: center.y, id: 1 },
    ]);
    await sendTrustedTouchEvent("touchMove", [
      { x: center.x - 22, y: center.y, id: 1 },
    ]);
    await sendTrustedTouchEvent("touchEnd", []);
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();

    scrollport.scrollTop = 100;
    fireEvent.scroll(scrollport);
    await waitFor(() =>
      expect(button).toHaveAttribute("data-mobile-chrome-phase", "Hidden"),
    );
    await dispatchTrustedTouch({
      start: center,
      moves: [
        { x: center.x - 10, y: center.y },
        { x: center.x - 22, y: center.y },
      ],
    });
    expect(activePaneStatus()).toHaveTextContent(firstPane.id);
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
  });

  it("teaches adjacent swipe only on mobile Manage Tabs with at least two visible panes", async () => {
    const teachingCopy =
      "Open, close, or restore a workspace tab. Swipe the Nexus button left or right to switch visible tabs.";
    const baseCopy = "Open, close, or restore a workspace tab.";
    const firstPane = workspacePane("first-pane", "/libraries");
    const panesWithTwoVisible = [
      firstPane,
      workspacePane("minimized-notes", "/notes", "minimized"),
      workspacePane("second-visible", "/podcasts"),
      workspacePane("minimized-chats", "/chats", "minimized"),
      workspacePane("minimized-browse", "/browse", "minimized"),
      workspacePane("minimized-stats", "/stats", "minimized"),
    ];
    const panesWithOneVisible: WorkspacePrimaryPaneState[] =
      panesWithTwoVisible.map((pane, index) =>
        index === 0 ? pane : { ...pane, visibility: "minimized" },
      );

    await page.viewport(390, 800);
    let view = renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: panesWithTwoVisible,
      }),
    );
    let dialog = await openManageTabs("mobile", panesWithTwoVisible.length);
    expect(within(dialog).getByText(teachingCopy)).toBeVisible();
    view.unmount();

    view = renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: panesWithOneVisible,
      }),
    );
    dialog = await openManageTabs("mobile", panesWithOneVisible.length);
    expect(within(dialog).getByText(baseCopy)).toBeVisible();
    expect(within(dialog).queryByText(teachingCopy)).toBeNull();
    view.unmount();

    await page.viewport(1_280, 900);
    renderNexus(
      "desktop",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: firstPane.id,
        primaryPanes: panesWithTwoVisible,
      }),
    );
    dialog = await openManageTabs("desktop", panesWithTwoVisible.length);
    expect(within(dialog).getByText(baseCopy)).toBeVisible();
    expect(within(dialog).queryByText(teachingCopy)).toBeNull();
  });

  // Unmount adds no reachable product outcome: the recognizer registers no
  // document/window/ancestor listener, so a test would only restate browser and
  // React teardown rather than prove Nexus behavior.
});
