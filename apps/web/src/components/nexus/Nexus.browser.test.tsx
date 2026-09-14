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
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { MAX_NEXUS_HISTORY_TARGETS } from "@/lib/nexus/history";
import { ArtworkProvider } from "@/lib/media/ArtworkProvider";
import { ARTWORK_CAPACITY } from "@/lib/media/artworkCapacity";
import { NEXUS_OPEN_PERFORMANCE } from "@/lib/nexus/performance";
import { requestNexusOpen } from "@/lib/nexus/events";
import { writeDailyDraft } from "@/lib/notes/dailyDraftStore";
import { resolveDailyLocalDate } from "@/lib/notes/openDailyPage";
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
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALENDAR_TIME_ZONE = "UTC";

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
let respondToHistory: (
  body: Record<string, unknown> | null,
) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface StubbedHistory {
  readonly recent: readonly {
    readonly target_href: string;
    readonly label_snapshot: string;
    readonly source: string;
    readonly last_used_at: string;
  }[];
  readonly frecencyByHref: Readonly<Record<string, number>>;
}

/**
 * The history read as the service implements it, so no proof here is more
 * permissive than the server: a bounded command is answered with scores for the
 * requested candidates that have history and silence for every other candidate,
 * and only a command outside the input bounds is refused outright.
 */
function historyQueryResponse(
  body: Record<string, unknown> | null,
  history: StubbedHistory,
): Response {
  const targets = body?.target_hrefs;
  if (!Array.isArray(targets) || targets.length > MAX_NEXUS_HISTORY_TARGETS) {
    return errorResponse(400, "E_INVALID_REQUEST", "Unbounded Nexus history query");
  }
  return jsonResponse({
    data: {
      recent: history.recent,
      frecency_by_href: Object.fromEntries(
        targets.flatMap((href: unknown) =>
          typeof href === "string" && href in history.frecencyByHref
            ? [[href, history.frecencyByHref[href]]]
            : [],
        ),
      ),
    },
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
      if (url.pathname === "/api/imports/summary") {
        return jsonResponse({
          data: {
            observed_at: "2026-09-08T00:00:00Z",
            needs_attention_count: 0,
            active_count: 0,
          },
        });
      }
      if (url.pathname === "/api/nexus/history/query") {
        return respondToHistory(body);
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
          accountId: ACCOUNT_ID,
          calendarTimeZone: CALENDAR_TIME_ZONE,
        }}
      >
        <ArtworkProvider limits={ARTWORK_CAPACITY}>
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
                      accountId={ACCOUNT_ID}
                      transport={null}
                    >
                      <GlobalPlayerProvider>
                        <ShareControllerProvider>
                          <ImportsProvider>
                            <WorkspaceProbe />
                            <Nexus />
                          </ImportsProvider>
                        </ShareControllerProvider>
                      </GlobalPlayerProvider>
                    </OfflineMediaProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
        </ArtworkProvider>
      </AuthenticatedAccountProvider>,
      { initialViewport },
    ),
  );
}

function writeAtomicTodayDraft() {
  writeDailyDraft({
    version: 1,
    accountId: ACCOUNT_ID,
    localDate: resolveDailyLocalDate({ kind: "Today" }, CALENDAR_TIME_ZONE),
    noteId: "11111111-1111-4111-8111-111111111111",
    clientMutationId: "nexus-browser-atomic-draft",
    bodyPmJson: {
      type: "object_embed",
      attrs: {
        objectType: "media",
        objectId: "11111111-1111-4111-8111-111111111111",
        label: "Attachment",
        relationType: "embeds",
        displayMode: "compact",
      },
    },
    bodyText: "",
    handoff: { kind: "None" },
  });
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
      request.pathname === "/api/nexus/history/query" &&
      request.body?.query !== null,
  );
}

function historyReads() {
  return requests.filter(
    (request) => request.pathname === "/api/nexus/history/query",
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

const MOBILE_ROOT_SECTIONS = [
  ["Open", ["Libraries"]],
  [
    "Quick Actions",
    ["Quick Note", "Today", "New Chat", "New Page", "New Library", "Import"],
  ],
  ["Places", ["Lectern", "Libraries", "Browse", "Podcasts", "Chats", "Notes"]],
] as const;

const MOBILE_ROOT_GEOMETRIES = [
  ["390px portrait", 390, 800, "16px"],
  ["320px portrait", 320, 800, "16px"],
  ["short landscape", 640, 360, "16px"],
  ["200% text", 390, 800, "32px"],
] as const;

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
    respondToHistory = async (body) =>
      historyQueryResponse(body, { recent: [], frecencyByHref: {} });
    localStorage.clear();
    document.documentElement.style.removeProperty("font-size");
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

  it.each(["desktop", "mobile"] as const)("contains history exhaustion and retains add work on %s", async (viewport) => {
    let releaseHistory!: (response: Response) => void;
    let started!: () => void;
    const firstRead = new Promise<void>((resolve) => { started = resolve; });
    respondToHistory = () => {
      started();
      return new Promise<Response>((resolve) => { releaseHistory = resolve; });
    };
    await page.viewport(viewport === "mobile" ? 390 : 1_280, 900);
    renderNexus(viewport);
    const sibling = screen.getByRole("status", { name: "Workspace pane count" });
    requestNexusOpen({ kind: "Add", seed: {
      kind: "Content", initialFocus: "Url", initialDestinations: [],
    } });
    await firstRead;
    const draft = "https://example.org/retained-draft";
    fireEvent.change(await screen.findByRole("textbox", { name: "Links" }), { target: { value: draft } });
    respondToHistory = async () => new Response(null, { status: 502 });
    releaseHistory(new Response(null, { status: 502 }));
    const retry = await screen.findByRole("button", { name: "Retry Nexus" }, { timeout: 3_000 });
    expect(sibling.isConnected, "feature failure unmounted another workspace view").toBe(true);
    respondToHistory = async (body) =>
      historyQueryResponse(body, { recent: [], frecencyByHref: {} });
    await userEvent.click(retry);
    expect(await screen.findByRole("textbox", { name: "Links" })).toHaveValue(draft);
    expect(sibling.isConnected).toBe(true);
  });

  it("scores its whole displayed union for an open session and never for a closed one", async () => {
    await page.viewport(390, 800);
    respondToHistory = async (body) =>
      historyQueryResponse(body, {
        recent: [
          {
            // A recent target that is not a destination, so following it moves
            // the candidate union a latched read would notice.
            target_href: "/media/11111111-1111-4111-8111-111111111111",
            label_snapshot: "Deep Work",
            source: "Recent",
            last_used_at: "2026-09-13T00:00:00Z",
          },
        ],
        // Scores for the two destinations the record grammar refused before
        // this change: the read answers the command that carries them instead
        // of refusing the whole command, so its recents survive.
        frecencyByHref: { "/daily": 0.9, "/browse": 0.8 },
      });
    renderNexus("mobile");
    expect(
      historyReads(),
      "a closed Nexus scored candidates nobody is looking at",
    ).toHaveLength(0);

    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    await waitFor(() => expect(historyReads()).toHaveLength(1));
    expect(
      historyReads()[0]?.body?.target_hrefs,
      "Nexus must send the candidates it displays, not a subset its own copy of the server grammar allows",
    ).toEqual(
      expect.arrayContaining([
        ...DESTINATIONS.map((destination) => destination.href),
        "/libraries",
      ]),
    );
    const recent = within(
      await within(dialog).findByRole("region", { name: "Recent" }),
    ).getByRole("button", {
      name: "Deep Work /media/11111111-1111-4111-8111-111111111111",
    });
    expect(
      recent,
      "an unscoreable candidate in the union cost the whole read its recents",
    ).toBeVisible();

    await userEvent.click(recent);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Workspace active location" }),
      ).toHaveTextContent("/media/11111111-1111-4111-8111-111111111111"),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1), {
      timeout: 3_000,
    });
    expect(
      historyReads(),
      "pane navigation re-scored candidates for a Nexus nobody had open",
    ).toHaveLength(1);
  });

  it.each(["desktop", "mobile"] as const)(
    "contains a refused selection write and replays its exact mutation once on %s",
    async (viewport) => {
      await page.viewport(viewport === "mobile" ? 390 : 1_280, 900);
      let writes = 0;
      respondToSelection = async () => {
        writes += 1;
        return writes === 1
          ? errorResponse(400, "E_INVALID_REQUEST", "Unsupported Nexus target")
          : jsonResponse({ data: null });
      };
      renderNexus(viewport);
      const sibling = screen.getByRole("status", {
        name: "Workspace pane count",
      });
      if (viewport === "mobile") {
        await userEvent.click(
          await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
        );
        const dialog = await screen.findByRole("dialog", { name: "Nexus" });
        await userEvent.click(
          within(
            within(dialog).getByRole("region", { name: "Places" }),
          ).getByRole("button", { name: "Notes" }),
        );
      } else {
        fireEvent.keyDown(document, { key: "k", ctrlKey: true });
        const dialog = await screen.findByRole("dialog", { name: "Nexus" });
        const input = within(dialog).getByRole("combobox", {
          name: "Find anything…",
        });
        await waitFor(() => expect(input).toHaveFocus());
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      }

      await waitFor(() => expect(selectionRequests()).toHaveLength(1), {
        timeout: 3_000,
      });
      const mutationId = selectionRequests()[0]?.body?.client_mutation_id;
      expect(typeof mutationId).toBe("string");
      const retry = await screen.findByRole(
        "button",
        { name: "Retry Nexus" },
        { timeout: 3_000 },
      );
      expect(
        sibling.isConnected,
        "a refused history write unmounted another workspace view",
      ).toBe(true);
      if (viewport === "mobile") {
        expect(
          screen.getByRole("button", { name: /^Open Nexus, / }),
          "a refused history write deleted the way back into Nexus",
        ).toBeVisible();
      }

      await userEvent.click(retry);
      await waitFor(() => expect(selectionRequests()).toHaveLength(2), {
        timeout: 3_000,
      });
      expect(
        selectionRequests().map((request) => request.body?.client_mutation_id),
        "recovery must replay the frozen selection, not mint a second history use",
      ).toEqual([mutationId, mutationId]);
      if (viewport === "mobile") {
        await userEvent.click(
          screen.getByRole("button", { name: /^Open Nexus, / }),
        );
      } else {
        fireEvent.keyDown(document, { key: "k", ctrlKey: true });
      }
      await waitFor(() =>
        expect(
          screen.getByRole("dialog", { name: "Nexus" }),
          "recovery restored the opener but not the Nexus session it guards",
        ).toBeVisible(),
      );

      // A page exit flushes every selection the journal still holds, so it
      // reports whether the replayed one was committed or is still queued.
      fireEvent(window, new Event("pagehide"));
      expect(
        selectionRequests(),
        "the committed replay stayed queued and would be sent a second time",
      ).toHaveLength(2);
    },
  );

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
    const open = within(dialog).getByRole("region", { name: "Open" });
    const currentRow = within(open).getByRole("listitem");
    await waitFor(() =>
      expect(
        within(currentRow).getByRole("button", {
          name: "Libraries Tab · Current",
        }),
      ).toBeVisible(),
    );
    const more = within(currentRow).getByRole("button", {
      name: "Actions for Libraries",
    });
    await userEvent.click(more);
    expect(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Close tab",
      }),
      "One tap on a mobile row's More control did not expose that row's canonical action",
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(more).toHaveFocus());

    const quickActions = within(dialog).getByRole("region", {
      name: "Quick Actions",
    });
    expect(
      within(quickActions).getByRole("button", {
        name: /^Quick Note Create · \/n(?:\s|$)/,
      }),
    ).toBeVisible();
    expect(
      within(quickActions).getByRole("button", { name: "Today Place" }),
    ).toBeVisible();

    const places = within(dialog).getByRole("region", { name: "Places" });
    const placeButtons = within(places).getAllByRole("button");
    expect(placeButtons).toEqual([
      within(places).getByRole("button", { name: "Lectern" }),
      within(places).getByRole("button", { name: "Libraries" }),
      within(places).getByRole("button", { name: "Browse" }),
      within(places).getByRole("button", { name: "Podcasts" }),
      within(places).getByRole("button", { name: "Chats" }),
      within(places).getByRole("button", { name: "Notes" }),
    ]);
    expect(within(places).queryByRole("button", { name: "Stats" })).toBeNull();
    expect(within(places).queryByRole("button", { name: "Atlas" })).toBeNull();
    expect(within(places).queryByRole("button", { name: "Oracle" })).toBeNull();

    await userEvent.click(
      within(places).getByRole("button", { name: "Notes" }),
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

  it.each(MOBILE_ROOT_GEOMETRIES)(
    "renders blank mobile Root as one reachable full-width vertical stream at %s",
    async (name, width, height, rootFontSize) => {
      await page.viewport(width, height);
      document.documentElement.style.fontSize = rootFontSize;
      renderNexus("mobile");

      await userEvent.click(
        await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Nexus" });
      const search = within(dialog).getByRole("searchbox", {
        name: "Find anything…",
      });
      await waitFor(() => expect(search).toHaveFocus());

      const sections = MOBILE_ROOT_SECTIONS.map(([label]) =>
        within(dialog).getByRole("region", { name: label }),
      );
      expect(
        within(dialog)
          .getAllByRole("heading", { level: 3 })
          .map((heading) => heading.textContent?.trim()),
        `${name}: blank Root lost its labeled semantic section order`,
      ).toEqual(MOBILE_ROOT_SECTIONS.map(([label]) => label));

      const scrollOwners = [
        dialog,
        // justify-eslint-override: a content scroller intentionally has no ARIA
        // role; inspecting every descendant's browser overflow behavior avoids
        // coupling this geometry proof to a class name or test id.
        // eslint-disable-next-line testing-library/no-node-access
        ...Array.from(dialog.querySelectorAll<HTMLElement>("*")),
      ].filter((element) => {
        const style = window.getComputedStyle(element);
        return [style.overflowX, style.overflowY].some(
          (overflow) => overflow === "auto" || overflow === "scroll",
        );
      });
      expect(
        scrollOwners,
        `${name}: Root must expose one content scroller, not nested or sideways scroll surfaces`,
      ).toHaveLength(1);
      const [scrollOwner] = scrollOwners;
      expect(
        scrollOwner,
        `${name}: Root has no observable content scroller`,
      ).toBeDefined();
      expect(
        scrollOwner!.contains(
          within(dialog).getByRole("heading", { level: 2, name: "Nexus" }),
        ),
        `${name}: the fixed Nexus header moved inside the content scroller`,
      ).toBe(false);
      expect(
        scrollOwner!.contains(search),
        `${name}: the fixed search input moved inside the content scroller`,
      ).toBe(false);

      const rowGeometry = MOBILE_ROOT_SECTIONS.flatMap(
        ([sectionLabel, rowLabels], sectionIndex) => {
          const section = sections[sectionIndex]!;
          const list = within(section).getByRole("list");
          const rows = within(list).getAllByRole("listitem");
          expect(
            rows,
            `${name}: ${sectionLabel} lost a canonical row`,
          ).toHaveLength(rowLabels.length);
          return rows.map((row, rowIndex) => {
            const rowLabel = rowLabels[rowIndex]!;
            const [primary] = within(row).getAllByRole("button");
            expect(primary).toHaveAccessibleName(
              new RegExp(`^${rowLabel}(?:\\b|$)`),
            );
            expect(primary!.textContent?.trim().startsWith(rowLabel)).toBe(
              true,
            );
            return {
              list,
              row,
              primary: primary!,
              controls: within(row).getAllByRole("button"),
            };
          });
        },
      );
      const boxes = rowGeometry.map(({ row }) => row.getBoundingClientRect());
      expect(
        rowGeometry.every(
          ({ list }, index) =>
            Math.abs(boxes[index]!.width - list.clientWidth) <= 1,
        ),
        `${name}: every canonical row must occupy its section's full width`,
      ).toBe(true);
      expect(
        boxes.every(
          (box, index) =>
            index === 0 || box.top >= boxes[index - 1]!.bottom - 1,
        ),
        `${name}: rows must form one vertical stream instead of sharing horizontal tracks`,
      ).toBe(true);
      expect(
        rowGeometry.every(({ controls }) =>
          controls.every((control) => {
            const box = control.getBoundingClientRect();
            return box.width >= 48 && box.height >= 48;
          }),
        ),
        `${name}: every primary and More control must retain a 48px touch target`,
      ).toBe(true);
      expect(
        rowGeometry.every(
          ({ primary }) => primary.scrollWidth <= primary.clientWidth + 1,
        ),
        `${name}: a row label clips instead of growing or wrapping at ${rootFontSize} root text`,
      ).toBe(true);

      for (const [
        sectionIndex,
        [sectionLabel],
      ] of MOBILE_ROOT_SECTIONS.entries()) {
        const list = within(sections[sectionIndex]!).getByRole("list");
        expect(
          list.scrollWidth,
          `${name}: ${sectionLabel} remains horizontally scrollable`,
        ).toBeLessThanOrEqual(list.clientWidth + 1);
        list.scrollLeft = 24;
        expect(list.scrollLeft).toBe(0);
      }

      const finalRow = rowGeometry.at(-1)!.row;
      finalRow.scrollIntoView({ block: "nearest" });
      await waitFor(() => {
        const rowBox = finalRow.getBoundingClientRect();
        const ownerBox = scrollOwner!.getBoundingClientRect();
        expect(
          rowBox.top >= ownerBox.top - 1 &&
            rowBox.bottom <= ownerBox.bottom + 1,
          `${name}: the final Places row is not reachable in the sole content scroller`,
        ).toBe(true);
      });

      expect(
        dialog.scrollWidth,
        `${name}: Nexus Root overflows horizontally`,
      ).toBeLessThanOrEqual(dialog.clientWidth + 1);
    },
  );

  it("preserves typed input and actions through exact query-owned Back restoration", async () => {
    const trimmedQuery = "LiBrArIeS";
    const query = `  ${trimmedQuery}  `;
    const unavailableReason = "Open Today to finish the current embedded draft";
    await page.viewport(320, 800);
    document.documentElement.style.fontSize = "32px";
    writeAtomicTodayDraft();
    renderNexus("mobile");

    const opener = await screen.findByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await userEvent.click(opener);
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });
    let search = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    await userEvent.type(search, query);

    await waitFor(() =>
      expect(within(dialog).getAllByRole("heading", { level: 3 })).toHaveLength(
        2,
      ),
    );
    const typedSectionOrder = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent?.trim());
    const queryActions = within(dialog).getByRole("region", {
      name: "Do with query",
    });
    const results = within(dialog).getByRole("region", { name: "Results" });
    const resultRows = within(results).getAllByRole("listitem");
    const status = within(dialog).getByRole("status", { name: "Nexus status" });
    const ask = within(queryActions).getByRole("button", {
      name: `Ask Nexus about “${trimmedQuery}” Chat`,
    });
    expect(ask).toBeVisible();
    const addToToday = within(queryActions).getByRole("button", {
      name: `Add “${trimmedQuery}” to Today. Unavailable. ${unavailableReason}`,
    });
    expect(
      within(addToToday).getByText("Append note"),
      "The unavailable query action lost its useful nonrepeating metadata",
    ).toBeVisible();
    expect(within(addToToday).getByText(unavailableReason)).toBeVisible();
    expect(
      within(queryActions).getByRole("button", {
        name: `Browse for “${trimmedQuery}”… Choose a kind`,
      }),
    ).toBeVisible();
    const create = within(queryActions).getByRole("button", {
      name: `Create “${trimmedQuery}”… Choose a type`,
    });
    expect(
      within(queryActions).getByRole("button", {
        name: `See all results for “${trimmedQuery}” Search`,
      }),
    ).toBeVisible();
    expect(create.textContent?.split(trimmedQuery)).toHaveLength(2);

    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(dialog).toBeVisible();
    expect(selectionRequests()).toHaveLength(0);
    fireEvent.compositionEnd(search);

    for (let index = 0; index < resultRows.length; index += 1) {
      await userEvent.keyboard("{ArrowDown}");
    }
    await waitFor(() =>
      expect(status).toHaveTextContent(
        `Ask Nexus about “${trimmedQuery}”. ${resultRows.length + 1} of ${resultRows.length + 5}.`,
      ),
    );
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() =>
      expect(status).toHaveTextContent(
        `${resultRows.length} of ${resultRows.length + 5}.`,
      ),
    );
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(status).toHaveTextContent(unavailableReason));

    const unavailableCopy = within(addToToday).getByText(unavailableReason);
    expect(
      unavailableCopy.scrollWidth,
      "The owned unavailable reason is visually clipped at 320px and 200% text",
    ).toBeLessThanOrEqual(unavailableCopy.clientWidth + 1);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: `Create “${trimmedQuery}”`,
      }),
      "Keyboard Enter on a query action did not enter its owned workflow",
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    dialog = await screen.findByRole("dialog", { name: "Nexus" });
    search = within(dialog).getByRole("searchbox", { name: "Find anything…" });
    await waitFor(() => expect(search).toHaveValue(query));
    await waitFor(() => expect(search).toHaveFocus());
    expect(
      within(dialog).getByRole("status", { name: "Nexus status" }),
      "Returning from a query-owned workflow did not restore its exact active row",
    ).toHaveTextContent(`Create “${trimmedQuery}”…`);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(search).toHaveValue(""));
    expect(search).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    expect(opener).toHaveFocus();
    expect(
      typedSectionOrder,
      "A typed mobile query must present owned Results before its verb-first actions",
    ).toEqual(["Results", "Do with query"]);
  });

  it("contains an unbroken no-results query inside the sole vertical owner", async () => {
    const query =
      "LibrariesWithAnIntentionallyLongQueryForMobilePaletteValidation";
    await page.viewport(320, 800);
    document.documentElement.style.fontSize = "32px";
    renderNexus("mobile");

    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const search = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    fireEvent.change(search, { target: { value: query } });

    const emptyResults = await within(dialog).findByText(
      `No results for “${query}”`,
    );
    const queryActions = within(dialog).getByRole("region", {
      name: "Do with query",
    });
    expect(within(queryActions).getAllByRole("listitem")).toHaveLength(5);
    expect(within(queryActions).getAllByRole("button")).toHaveLength(5);
    expect(
      within(dialog).getByRole("status", { name: "Nexus status" }),
    ).toHaveTextContent("0 results");
    expect(
      within(dialog).queryByRole("region", { name: "Results" }),
    ).toBeNull();

    const queryScrollOwners = [
      dialog,
      // justify-eslint-override: the content scroller intentionally has no
      // ARIA role; browser overflow is the acceptance boundary under test.
      // eslint-disable-next-line testing-library/no-node-access
      ...Array.from(dialog.querySelectorAll<HTMLElement>("*")),
    ].filter((element) => {
      const style = window.getComputedStyle(element);
      return [style.overflowX, style.overflowY].some(
        (overflow) => overflow === "auto" || overflow === "scroll",
      );
    });
    expect(queryScrollOwners).toHaveLength(1);
    const [queryScrollOwner] = queryScrollOwners;
    expect(queryScrollOwner).toBeDefined();
    const dialogBox = dialog.getBoundingClientRect();
    const queryScrollBox = queryScrollOwner!.getBoundingClientRect();
    const emptyResultsBox = emptyResults.getBoundingClientRect();
    expect(
      queryScrollBox.left >= dialogBox.left - 1 &&
        queryScrollBox.right <= dialogBox.right + 1,
      "The vertical results owner expanded beyond the Nexus dialog",
    ).toBe(true);
    expect(
      emptyResultsBox.left >= queryScrollBox.left - 1 &&
        emptyResultsBox.right <= queryScrollBox.right + 1,
      "The query-owned empty state expanded beyond its scroll owner",
    ).toBe(true);
    expect(
      queryScrollOwner!.scrollWidth,
      "An unbroken query made the vertical results owner scroll sideways",
    ).toBeLessThanOrEqual(queryScrollOwner!.clientWidth + 1);
    queryScrollOwner!.scrollLeft = 24;
    expect(queryScrollOwner!.scrollLeft).toBe(0);
    expect(
      emptyResults.scrollWidth,
      "The query-owned empty state does not wrap an unbroken query",
    ).toBeLessThanOrEqual(emptyResults.clientWidth + 1);
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
      within(dialog).getByRole("button", { name: "Notes" }),
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
      queryHistoryRequests()[0]?.body?.query,
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

  it("preserves Enter, Space, and assistive native button activation", async () => {
    const pane = workspacePane("only-pane", "/libraries");
    await page.viewport(390, 800);
    renderNexus(
      "mobile",
      createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: pane.id,
        primaryPanes: [pane],
      }),
    );

    const button = await screen.findByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    performance.clearMarks(NEXUS_OPEN_PERFORMANCE.start);
    performance.clearMeasures(NEXUS_OPEN_PERFORMANCE.measure);

    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await waitFor(() =>
      expect(
        performance.getEntriesByName(NEXUS_OPEN_PERFORMANCE.measure),
      ).toHaveLength(1),
    );
    await dismissNexus();

    button.focus();
    await userEvent.keyboard(" ");
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    await dismissNexus();

    fireEvent.click(button, { detail: 0 });
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
    expect(activePaneStatus()).toHaveTextContent(pane.id);
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
    expect(await screen.findByRole("dialog", { name: "Nexus" })).toBeVisible();
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
