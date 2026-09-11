import { render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import MobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";
import PaneShell from "@/components/workspace/PaneShell";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PaneSecondaryPublication } from "@/lib/panes/panePublications";
import { renderPane } from "@/lib/panes/paneRenderRegistry";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import {
  PaneReturnMementoProvider,
  usePaneReturnMementoCommands,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import {
  assumePaneVisitId,
  createDefaultWorkspaceState,
  type WorkspaceAttachedSecondaryPaneState,
} from "@/lib/workspace/schema";

/**
 * Oracle: contract D8 (the inspector is the `imports-inspector` secondary group
 * this pane publishes, so mobile gets the shared sheet) and the pane's one
 * `ShellScroll` return token. The workspace's own proof stands in for the pane
 * with a harness container; this file renders the real pane body through the
 * real registry inside the real `PaneShell`, so the composition Track F owns —
 * the readiness token, the published group and the sheet — is what is proved.
 * The harness stands in for `WorkspaceHost` only where the workspace store
 * would: it holds the pane href, the published publication and the attached
 * secondary state, exactly as `WorkspaceHost` threads them.
 */

const PANE_ID = "imports-pane";
const SECONDARY_PANE_ID = "imports-secondary-pane";
const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELECTED_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const SELECTED_REF = `media:${SELECTED_MEDIA_ID}`;
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const FACTS_REVISION = "3".repeat(64);
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
/** Short enough that a listed page always overflows it. */
const PANE_HEIGHT_PX = 240;
/**
 * The band the mobile chrome protects at the bottom of the window. Published as
 * the safe-area inset, which is the one input `MobileViewportProvider` takes
 * that needs no app-chrome surface registered in this harness.
 */
const PROTECTED_BAND_PX = 60;
const CAPTURED_SCROLL_TOP_PX = 300;
const HREF_WITH_VIEW = "/imports?view=NeedsAttention";
/** No view named, so the counts choose one — and a failed count chooses none. */
const HREF_UNQUALIFIED = "/imports";
const WORKSPACE_PRIMARY_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const ABSENT = { kind: "Absent" } as const;

function present(value: unknown) {
  return { kind: "Present", value };
}

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

function attentionItem(index: number) {
  const mediaId =
    index === 0
      ? SELECTED_MEDIA_ID
      : `2222222${index}-2222-4222-8222-222222222222`;
  return {
    ref: `media:${mediaId}`,
    title: index === 0 ? "A stalled report" : `A queued report ${index}`,
    media_kind: "pdf",
    source_label: present("example.invalid"),
    media_ref: present(`media:${mediaId}`),
    state: {
      kind: "NeedsAttention",
      stage: "Extract",
      failure_code: present("E_SOURCE_FETCH_FAILED"),
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
  };
}

/** Enough rows that the list is taller than the pane it is read in. */
const LISTED_ITEMS = [0, 1, 2, 3, 4, 5, 6, 7].map(attentionItem);

function pageBody() {
  return {
    data: {
      observed_at: "2026-09-08T12:00:00Z",
      matched_count: LISTED_ITEMS.length,
      groups: [{ stage: "Extract", count: LISTED_ITEMS.length }],
      items: LISTED_ITEMS,
      next_cursor: ABSENT,
    },
  };
}

function summaryBody() {
  return {
    data: {
      observed_at: "2026-09-08T12:00:00Z",
      needs_attention_count: LISTED_ITEMS.length,
      active_count: 0,
    },
  };
}

function detailBody() {
  return {
    data: {
      item: attentionItem(0),
      readiness: { can_read: false, can_search: false, can_play: false },
      history_coverage: { kind: "Full" },
    },
  };
}

interface BffConfig {
  readonly summary: (read: number) => unknown;
  readonly page: () => unknown;
}

function installBff(config: BffConfig): void {
  let summaryReads = 0;
  vi.stubGlobal(
    "fetch",
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const request = target instanceof Request ? target : null;
      const url = new URL(request?.url ?? String(target), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      if (url.pathname === "/api/imports/summary") {
        summaryReads += 1;
        const answer = await config.summary(summaryReads);
        return answer instanceof Response ? answer : jsonResponse(answer);
      }
      if (url.pathname === "/api/imports") {
        const answer = await config.page();
        return answer instanceof Response ? answer : jsonResponse(answer);
      }
      if (url.pathname.endsWith("/history")) {
        return jsonResponse({ data: { entries: [], next_cursor: ABSENT } });
      }
      if (url.pathname.startsWith("/api/imports/")) {
        return jsonResponse(detailBody());
      }
      if (url.pathname === RESOLVE_PATH && method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const refs: string[] = Array.isArray((body as { refs?: unknown })?.refs)
          ? (body as { refs: string[] }).refs
          : [];
        return jsonResponse({
          data: {
            snapshots: refs.map((ref) => ({
              ref,
              activation: {
                resourceRef: ref,
                kind: "route",
                href: `/media/${ref.slice("media:".length)}`,
                unresolvedReason: null,
              },
              missing: false,
              factsRevision: FACTS_REVISION,
              capabilities: [],
            })),
          },
        });
      }
      return jsonResponse({ data: null });
    },
  );
}

const mementoCommands: { current: PaneReturnMementoCommands | null } = {
  current: null,
};

function MementoCommands() {
  const commands = usePaneReturnMementoCommands();
  useEffect(() => {
    mementoCommands.current = commands;
  }, [commands]);
  return null;
}

function attachedSecondary(
  surfaceId: WorkspaceSecondarySurfaceId,
): WorkspaceAttachedSecondaryPaneState {
  return {
    id: SECONDARY_PANE_ID,
    parentPrimaryPaneId: PANE_ID,
    groupId: "imports-inspector",
    activeSurfaceId: surfaceId,
    widthPx: 360,
    visibility: "visible",
  };
}

/** The workspace-store slice `WorkspaceHost` threads around one pane. */
function ImportsPaneHost({
  initialHref,
  isMobile,
  paneMounted,
  fillsWindow,
}: {
  readonly initialHref: string;
  readonly isMobile: boolean;
  /** False stands for the reader leaving this pane and coming back to it. */
  readonly paneMounted: boolean;
  /**
   * The mobile shell gives the pane the whole window, so its body ends where the
   * floating chrome the reader has to clear begins. Only the clearance case
   * needs that geometry; every other case reads a short pane on purpose.
   */
  readonly fillsWindow: boolean;
}) {
  const [href, setHref] = useState(initialHref);
  const [publication, setPublication] =
    useState<PaneSecondaryPublication | null>(null);
  const [secondary, setSecondary] =
    useState<WorkspaceAttachedSecondaryPaneState | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  const collapseSecondary = () =>
    setSecondary((current) =>
      current === null ? null : { ...current, visibility: "collapsed" },
    );
  return (
    <PaneRuntimeProvider
      paneId={PANE_ID}
      visitId={VISIT_ID}
      isActive
      href={href}
      routeId="imports"
      routeKey={routeKey}
      secondaryPane={secondary}
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={(_paneId, next) => setHref(next)}
      onReplacePane={(_paneId, next) => setHref(next)}
      onActivateWorkspaceTarget={() => ({
        kind: "ActivatedExisting",
        paneId: PANE_ID,
      })}
      onGoBackPane={() => undefined}
      onGoForwardPane={() => undefined}
      onRequestSecondarySurface={(_paneId, surfaceId, returnFocusTo) => {
        returnFocusRef.current = returnFocusTo ?? null;
        setSecondary(attachedSecondary(surfaceId));
      }}
      onCloseSecondaryPane={collapseSecondary}
    >
      <PaneSecondaryContext.Provider value={setPublication}>
        {paneMounted ? (
        <div
          data-pane-id={PANE_ID}
          style={
            fillsWindow
              ? { position: "fixed", inset: 0, display: "flex" }
              : { display: "flex", height: PANE_HEIGHT_PX }
          }
        >
          <PaneShell
            paneId={PANE_ID}
            routeKey={routeKey}
            routeHeader={{
              kind: "Section",
              destinationId: "imports",
              context: "None",
            }}
            label="Imports"
            returnMementoEnabled
            queryNavigation="in-place"
            sizing={{
              primaryWidthPx: 684,
              primaryMinWidthPx: 684,
              primaryMaxWidthPx: 1_400,
              renderedPrimarySlotWidthPx: 684,
              renderedPrimarySlotMinWidthPx: 684,
              renderedPrimarySlotMaxWidthPx: 1_400,
              fixedChromeWidthPx: 0,
              storedWidthCorrectionPx: null,
            }}
            bodyMode="standard"
            secondaryPane={secondary}
            secondaryPublication={publication}
            secondarySizing={{
              widthPx: 360,
              minWidthPx: 280,
              maxWidthPx: 720,
              storedWidthCorrectionPx: null,
            }}
            onResizePrimaryPane={() => undefined}
            onCloseSecondaryPane={collapseSecondary}
            isActive
            isMobile={isMobile}
          >
            {renderPane("imports")}
          </PaneShell>
          {isMobile && secondary ? (
            <MobileSecondaryPaneHost
              primaryPaneId={PANE_ID}
              secondaryPaneId={SECONDARY_PANE_ID}
              secondary={secondary}
              publication={publication}
              returnFocusTo={() => returnFocusRef.current}
              onClose={collapseSecondary}
              onActiveSurfaceChange={() => undefined}
            />
          ) : null}
        </div>
        ) : null}
      </PaneSecondaryContext.Provider>
    </PaneRuntimeProvider>
  );
}

function ImportsPane({
  href = HREF_WITH_VIEW,
  isMobile = false,
  paneMounted = true,
  fillsWindow = false,
}: {
  readonly href?: string;
  readonly isMobile?: boolean;
  readonly paneMounted?: boolean;
  readonly fillsWindow?: boolean;
}) {
  return withRenderEnvironment(
    <AuthenticatedAccountProvider
      account={{ accountId: ACCOUNT_ID, calendarTimeZone: "UTC" }}
    >
      <MobileChromeProvider>
        <KeybindingsProvider>
          <FeedbackProvider>
            <PaneReturnMementoProvider>
              <MementoCommands />
              <WorkspaceStoreProvider
                initialState={createDefaultWorkspaceState(
                  "/imports",
                  WORKSPACE_PRIMARY_METRICS,
                )}
                workspacePrimaryMetrics={WORKSPACE_PRIMARY_METRICS}
              >
              <LecternProvider>
                <LibraryPlacementControllerProvider>
                  <ShareControllerProvider>
                    <OfflineMediaProvider accountId={ACCOUNT_ID} transport={null}>
                      <ResourceOverlaysProvider>
                        <GlobalPlayerProvider>
                          <ResourceActionRuntimeProvider>
                            <ImportsProvider>
                              <ImportsPaneHost
                                initialHref={href}
                                isMobile={isMobile}
                                paneMounted={paneMounted}
                                fillsWindow={fillsWindow}
                              />
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
  );
}

function scrollport(): HTMLElement {
  const element = screen.getByTestId("pane-shell-body");
  if (!(element instanceof HTMLElement)) {
    throw new Error("The pane shell published no scrollport");
  }
  return element;
}

function paneLandmark(): HTMLElement {
  return screen.getByTestId("pane-shell-root");
}

/**
 * Records the place this visit owes the reader, the way leaving a pane does.
 * The capture is keyboard-modal, so the return owes them their focus too — and
 * focus landing on the pane landmark is what a spent memento looks like when
 * the list it was captured from is no longer there to scroll.
 */
function recordTheReadersPlace(href: string): void {
  const commands = mementoCommands.current;
  if (commands === null) throw new Error("The return memento never mounted");
  commands.capturePane({
    paneId: PANE_ID,
    visitId: VISIT_ID,
    routeKey: resolvePaneRouteIdentity(href).routeKey,
    modality: "Keyboard",
  });
}

afterEach(() => {
  mementoCommands.current = null;
  document.documentElement.style.removeProperty("--viewport-safe-bottom");
  vi.unstubAllGlobals();
});

describe("Imports pane", () => {
  it("gives the reader back the place they left only once the list is as tall as it was", async () => {
    const blocked = deferred<Response>();
    let pageReads = 0;
    installBff({
      summary: () => summaryBody(),
      page: () => {
        pageReads += 1;
        return pageReads === 1 ? pageBody() : blocked.promise;
      },
    });

    const view = render(<ImportsPane />);
    await screen.findByRole("button", { name: "A stalled report" });
    const listed = scrollport();
    await waitFor(() =>
      expect(
        listed.scrollHeight - listed.clientHeight,
        "the listed page never overflowed the pane, so there was no place to leave",
      ).toBeGreaterThan(CAPTURED_SCROLL_TOP_PX),
    );
    listed.scrollTop = CAPTURED_SCROLL_TOP_PX;
    recordTheReadersPlace(HREF_WITH_VIEW);

    view.rerender(<ImportsPane paneMounted={false} />);
    view.rerender(<ImportsPane />);

    await screen.findByText("Loading imports");
    expect(
      scrollport().scrollTop,
      "the pane spent its return memento on a list that had not been read yet",
    ).toBe(0);

    blocked.resolve(jsonResponse(pageBody()));

    await waitFor(() =>
      expect(
        scrollport().scrollTop,
        "the reader never got their place back once the list they left was read",
      ).toBe(CAPTURED_SCROLL_TOP_PX),
    );
  });

  it("gives the reader the pane back when the first read fails and no list can settle", async () => {
    installBff({
      summary: () =>
        jsonResponse(
          { error: { code: "E_UPSTREAM", message: "temporarily unavailable" } },
          503,
        ),
      page: () => pageBody(),
    });

    const view = render(<ImportsPane href={HREF_UNQUALIFIED} />);
    await screen.findByRole("button", { name: "Try again" });
    recordTheReadersPlace(HREF_UNQUALIFIED);

    view.rerender(<ImportsPane href={HREF_UNQUALIFIED} paneMounted={false} />);
    view.rerender(<ImportsPane href={HREF_UNQUALIFIED} />);

    await screen.findByRole("button", { name: "Try again" });
    await waitFor(() =>
      expect(
        paneLandmark(),
        "a failed first read withheld the pane's return token, so the reader was left waiting for a list that can never settle",
      ).toHaveFocus(),
    );
  });

  // The mobile chrome floats the switchboard's Nexus control over the bottom of
  // the window, and every mobile pane body reserves the band it covers through
  // `--mobile-content-bottom-clearance` so no row can come to rest under it. The
  // switchboard is app chrome and mounts outside this pane harness, so what is
  // asserted here is the reservation the Imports pane is owed: its scrollport
  // ends the list exactly the published band above its own bottom edge, which is
  // where the floating control begins.
  it("keeps the trailing row clear of the protected band under the mobile chrome", async () => {
    installBff({
      summary: () => summaryBody(),
      page: () => pageBody(),
    });
    document.documentElement.style.setProperty(
      "--viewport-safe-bottom",
      `${PROTECTED_BAND_PX}px`,
    );

    render(<ImportsPane isMobile fillsWindow />);
    await screen.findByRole("button", { name: "A stalled report" });
    const listed = scrollport();
    await waitFor(() =>
      expect(
        Number.parseFloat(getComputedStyle(listed).paddingBottom),
        "the Imports pane spent none of the band the mobile chrome protects",
      ).toBe(PROTECTED_BAND_PX),
    );

    // The consequence the reader gets: scrolled to its last rest position, the
    // trailing row — the `More actions` control it carries with it — has come
    // out from under the band the floating control occupies.
    listed.scrollTop = listed.scrollHeight;
    const trailingTitle = LISTED_ITEMS[LISTED_ITEMS.length - 1].title;
    const trailing = screen.getByRole("listitem", { name: trailingTitle });
    expect(
      within(trailing).getByRole("button", {
        name: `More actions for ${trailingTitle}`,
      }),
      "the trailing row carries no More actions control to be covered",
    ).toBeVisible();
    await waitFor(() =>
      expect(
        trailing.getBoundingClientRect().bottom,
        "the list has no rest position that brings its trailing row out from under the band the floating control covers",
      ).toBeLessThanOrEqual(
        listed.getBoundingClientRect().bottom - PROTECTED_BAND_PX,
      ),
    );
  });

  it("opens a deep-linked import in the inspector sheet and leaves the reader on the list when the sheet is dismissed", async () => {
    installBff({
      summary: () => summaryBody(),
      page: () => pageBody(),
    });

    render(
      <ImportsPane
        href={`${HREF_WITH_VIEW}&selected=${SELECTED_REF}`}
        isMobile
      />,
    );

    const sheet = await screen.findByTestId("mobile-secondary-host");
    expect(
      await within(sheet).findByText("A stalled report"),
      "the deep-linked import did not reach the inspector surface",
    ).toBeVisible();
    expect(
      screen.getByRole("listitem", { name: /A stalled report/ }),
      "the deep-linked row was not exposed as the current one",
    ).toHaveAttribute("aria-current", "true");

    await userEvent.click(
      within(sheet).getByRole("button", { name: "Close Import details" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("mobile-secondary-host"),
        "the dismissed sheet stayed over the list",
      ).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "A stalled report" }),
      "the dismissed sheet took the list with it",
    ).toBeVisible();
    expect(
      screen.getByRole("listitem", { name: /A stalled report/ }),
      "the dismissed sheet dropped the selection the URL still names, so the header could not reopen it",
    ).toHaveAttribute("aria-current", "true");
  });
});
