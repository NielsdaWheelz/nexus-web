import {
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Activity, Settings } from "lucide-react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import MobilePaneBar from "@/components/appnav/MobilePaneBar";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import {
  useMobileViewport,
  type MobileBottomSurfaceId,
} from "@/lib/mobileViewport/MobileViewportProvider";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type {
  PaneRefreshExecute,
  PaneRefreshPublication,
} from "@/lib/panes/panePublications";
import type {
  PaneFindOccurrencesPublication,
  PaneSearchPublication,
} from "@/lib/panes/paneSearch";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import PaneShell from "./PaneShell";
import { usePanePrimaryChrome } from "./PanePrimaryChrome";

// The active mobile pane body is the registered content surface, so its terminal
// padding is the *local* projection of the protected band — the part that still
// overlaps this surface. A normal-flow MiniPlayer below the pane already spent
// its own band in layout and must never be charged to the reader a second time
// (docs/cutovers/mobile-reader-bottom-geometry-hard-cutover.md).

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const CONTENT_BOTTOM_CLEARANCE = "--mobile-content-bottom-clearance";
/** Android three-button navigation bar, published as the safe bottom inset. */
const ANDROID_BAR_PX = 37;
/** Android gesture navigation bar. */
const GESTURE_BAR_PX = 24;
const PLAYER_HEIGHT_PX = 64;
const NEXUS_GAP_PX = 12;
const NEXUS_CONTROL_HEIGHT_PX = 56;
const noop = () => {};

/** The element-local clearance the provider publishes on a registered surface. */
function elementLocalClearance(element: HTMLElement): string {
  return element.style.getPropertyValue(CONTENT_BOTTOM_CLEARANCE);
}

/**
 * Published lengths are plain pixels, so they are parsed directly. A probe
 * element would mutate the DOM inside `waitFor`, whose MutationObserver would
 * re-enter the callback on the probe's own mutation and spin the page.
 */
function readLength(cssLength: string): number {
  return Number.parseFloat(cssLength);
}

/** The full-window value, read off the root rather than a registered surface. */
function readRootLength(property: string): number {
  return Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(property),
  );
}

function paddingBottomPx(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).paddingBottom);
}

/** Stand-in for MobileMiniPlayer / NexusButton: only the registration matters. */
function MobileBottomSurface({
  id,
  testId,
  style,
}: {
  id: MobileBottomSurfaceId;
  testId: string;
  style: CSSProperties;
}) {
  const mobileViewport = useMobileViewport();
  const elementRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) throw new Error(`Bottom surface ${id} did not mount`);
    return mobileViewport.registerBottomSurface(id, element);
  }, [id, mobileViewport]);
  return <div ref={elementRef} data-testid={testId} style={style} />;
}

function FlowMiniPlayer() {
  return (
    <MobileBottomSurface
      id="Player"
      testId="flow-mini-player"
      style={{ flex: "0 0 auto", height: PLAYER_HEIGHT_PX }}
    />
  );
}

function FixedNexusReservation() {
  return (
    <MobileBottomSurface
      id="Nexus"
      testId="nexus-reservation"
      style={{
        position: "fixed",
        insetInlineEnd: 16,
        bottom: `calc(var(--mobile-nexus-bottom-offset) + ${NEXUS_GAP_PX}px)`,
        width: NEXUS_CONTROL_HEIGHT_PX,
        height: NEXUS_CONTROL_HEIGHT_PX,
      }}
    />
  );
}

function withPaneProviders(children: ReactNode) {
  return (
    <MobileChromeProvider>
      <FeedbackProvider>
        <ShareControllerProvider>
          <LibraryPlacementControllerProvider>
            <PaneReturnMementoProvider>{children}</PaneReturnMementoProvider>
          </LibraryPlacementControllerProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>
  );
}

function PaneUnderTest({
  isMobile,
  isActive,
  refresh,
  search,
  menuActions,
}: {
  isMobile: boolean;
  isActive: boolean;
  refresh?: PaneRefreshPublication;
  search?: PaneSearchPublication;
  menuActions?: readonly ActionDescriptor[];
}) {
  return (
    <PaneRuntimeProvider
      paneId="pane-a"
      visitId={TEST_VISIT_ID}
      isActive={isActive}
      href="/media/document-a"
      routeId="media"
      routeKey="media:/media/document-a"
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={noop}
      onReplacePane={noop}
      onActivateWorkspaceTarget={() => ({
        kind: "CreatedPane",
        paneId: "pane-b",
      })}
      onGoBackPane={noop}
      onGoForwardPane={noop}
    >
      <div
        data-pane-id="pane-a"
        data-active={isActive ? "true" : "false"}
        style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}
      >
        <PaneShell
          paneId="pane-a"
          routeKey="media:/media/document-a"
          routeHeader={{ kind: "Resource", pendingLabel: "Loading document…" }}
          routeShareIdentity={null}
          label="Document title"
          returnMementoEnabled={false}
          sizing={{
            primaryWidthPx: 390,
            primaryMinWidthPx: 320,
            primaryMaxWidthPx: 1_400,
            renderedPrimarySlotWidthPx: 390,
            renderedPrimarySlotMinWidthPx: 320,
            renderedPrimarySlotMaxWidthPx: 1_400,
            fixedChromeWidthPx: 0,
            storedWidthCorrectionPx: null,
          }}
          bodyMode="standard"
          onResizePrimaryPane={noop}
          isActive={isActive}
          isMobile={isMobile}
        >
          {refresh || search || menuActions ? (
            <ChromePublisher
              refresh={refresh}
              search={search}
              menuActions={menuActions}
            />
          ) : null}
          <div style={{ minHeight: 1_200 }}>Terminal reader content</div>
        </PaneShell>
      </div>
    </PaneRuntimeProvider>
  );
}

function ChromePublisher({
  refresh,
  search,
  menuActions,
}: {
  readonly refresh?: PaneRefreshPublication;
  readonly search?: PaneSearchPublication;
  readonly menuActions?: readonly ActionDescriptor[];
}) {
  const publication = useMemo(
    () => ({ refresh, search, menuActions }),
    [menuActions, refresh, search],
  );
  usePanePrimaryChrome(publication);
  return null;
}

function dispatchTouches(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  touches: readonly {
    readonly identifier: number;
    readonly clientX: number;
    readonly clientY: number;
  }[],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
}

function refreshPublication(execute: PaneRefreshExecute): PaneRefreshPublication {
  return { kind: "Refreshable", sourceKey: "finite-collection", execute };
}

// The reader pane's own sibling entries, in their published order. They are the
// ones a late Find used to hide behind: the CI read of a media pane header came
// back starting at "consumption-activity" because Pane.Search was not there yet.
const READER_MENU_ACTIONS: readonly ActionDescriptor[] = [
  {
    kind: "link",
    id: "consumption-activity",
    label: "Activity: Reading",
    icon: <Activity size={16} aria-hidden="true" />,
    href: "/stats",
  },
  {
    kind: "command",
    id: "ViewAction.Reader.Settings",
    label: "Reader settings",
    icon: <Settings size={16} aria-hidden="true" />,
    onSelect: noop,
  },
];

function findPublication(
  onOpen: () => void,
): PaneFindOccurrencesPublication {
  return {
    kind: "FindOccurrences",
    query: "",
    inputLabel: "Find in document",
    placeholder: "Find in document",
    onOpen,
    onQueryChange: noop,
    onDismiss: noop,
    result: { kind: "Idle" },
    scope: { kind: "EntireResource" },
    matchCase: false,
    wholeWord: false,
    onMatchCaseChange: noop,
    onWholeWordChange: noop,
    onStep: noop,
    onActivate: noop,
    onShowResults: noop,
    resultsExpanded: false,
    returnToReadingPosition: { kind: "Unavailable" },
  };
}

describe("PaneShell mobile content-surface clearance", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--viewport-safe-bottom");
  });

  it("spends only the protected band that still overlaps the active mobile pane body, and releases it on unmount", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.setProperty(
      "--viewport-safe-bottom",
      `${ANDROID_BAR_PX}px`,
    );
    // The workspace shell ends above the window bottom, so part of the Android
    // bar is already outside the pane's own coordinate space.
    const shellLiftPx = 20;
    const { unmount } = render(
      withRenderEnvironment(
        withPaneProviders(
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: shellLiftPx,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <PaneUnderTest isMobile isActive />
          </div>,
        ),
        { initialViewport: "mobile" },
      ),
    );

    const body = await screen.findByTestId("pane-shell-body");
    await waitFor(() => {
      expect(elementLocalClearance(body)).not.toBe("");
    });
    expect(body.getBoundingClientRect().bottom).toBeCloseTo(
      window.innerHeight - shellLiftPx,
      0,
    );

    // 37px of Android bar measured from the window bottom, of which this surface
    // already clears 20px by ending early: 17px remains for terminal content.
    const expectedLocalPx = ANDROID_BAR_PX - shellLiftPx;
    expect(readLength(elementLocalClearance(body))).toBe(expectedLocalPx);
    expect(paddingBottomPx(body)).toBe(expectedLocalPx);
    expect(getComputedStyle(body).scrollPaddingBottom).toBe(
      `${expectedLocalPx}px`,
    );
    // Full-window consumers keep the whole bar on the root contract.
    expect(readRootLength(CONTENT_BOTTOM_CLEARANCE)).toBe(ANDROID_BAR_PX);

    unmount();
    expect(elementLocalClearance(body)).toBe("");
  });

  it("charges a normal-flow Player once by shortening the pane, so terminal padding is the Nexus reservation alone", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.setProperty(
      "--viewport-safe-bottom",
      `${GESTURE_BAR_PX}px`,
    );
    render(
      withRenderEnvironment(
        withPaneProviders(
          <>
            <FixedNexusReservation />
            <div
              style={{
                position: "fixed",
                inset: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <PaneUnderTest isMobile isActive />
              <FlowMiniPlayer />
            </div>
          </>,
        ),
        { initialViewport: "mobile" },
      ),
    );

    const body = await screen.findByTestId("pane-shell-body");
    const player = screen.getByTestId("flow-mini-player");
    const nexus = screen.getByTestId("nexus-reservation");
    // Settle: the fixed Nexus has taken the published offset and rests one gap
    // above the flow Player.
    await waitFor(() => {
      expect(nexus.getBoundingClientRect().bottom).toBeCloseTo(
        player.getBoundingClientRect().top - NEXUS_GAP_PX,
        0,
      );
    });

    const bodyRect = body.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    const nexusRect = nexus.getBoundingClientRect();
    expect(playerRect.bottom).toBeCloseTo(window.innerHeight, 0);
    // Flow layout already ended the reader where the Player begins.
    expect(bodyRect.bottom).toBeCloseTo(playerRect.top, 0);

    const nexusOverlapPx = bodyRect.bottom - nexusRect.top;
    const fullWindowBandPx = window.innerHeight - nexusRect.top;
    expect(nexusOverlapPx).toBeCloseTo(
      NEXUS_GAP_PX + NEXUS_CONTROL_HEIGHT_PX,
      0,
    );

    // The terminal content clears the Nexus reservation that overlaps it — gap
    // plus control — and nothing else.
    expect(paddingBottomPx(body)).toBeCloseTo(nexusOverlapPx, 0);
    expect(readLength(elementLocalClearance(body))).toBeCloseTo(
      nexusOverlapPx,
      0,
    );
    // The only difference from the full-window band is the Player, counted once.
    expect(fullWindowBandPx - paddingBottomPx(body)).toBeCloseTo(
      playerRect.height,
      0,
    );
    expect(readRootLength(CONTENT_BOTTOM_CLEARANCE)).toBeCloseTo(
      fullWindowBandPx,
      0,
    );
  });

  it("registers no content surface for a desktop pane or an inactive mobile pane", async () => {
    await page.viewport(390, 844);
    document.documentElement.style.setProperty(
      "--viewport-safe-bottom",
      `${ANDROID_BAR_PX}px`,
    );
    const { unmount: unmountDesktopPane } = render(
      withRenderEnvironment(
        withPaneProviders(
          <div
            style={{
              position: "fixed",
              inset: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <PaneUnderTest isMobile={false} isActive />
          </div>,
        ),
      ),
    );

    const desktopBody = await screen.findByTestId("pane-shell-body");
    expect(elementLocalClearance(desktopBody)).toBe("");
    // The desktop pane spends no mobile clearance even under a 37px Android bar.
    expect(getComputedStyle(desktopBody).paddingBottom).toBe("0px");
    unmountDesktopPane();

    render(
      withRenderEnvironment(
        withPaneProviders(
          <>
            <FixedNexusReservation />
            <div
              style={{
                position: "fixed",
                inset: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <PaneUnderTest isMobile isActive={false} />
              <div
                data-testid="flow-spacer"
                style={{ flex: "0 0 auto", height: PLAYER_HEIGHT_PX }}
              />
            </div>
          </>,
        ),
        { initialViewport: "mobile" },
      ),
    );

    const inactiveBody = await screen.findByTestId("pane-shell-body");
    const nexus = screen.getByTestId("nexus-reservation");
    await waitFor(() => {
      expect(nexus.getBoundingClientRect().bottom).toBeCloseTo(
        window.innerHeight - ANDROID_BAR_PX - NEXUS_GAP_PX,
        0,
      );
    });

    const inactiveRect = inactiveBody.getBoundingClientRect();
    const nexusRect = nexus.getBoundingClientRect();
    expect(inactiveRect.bottom).toBeCloseTo(
      window.innerHeight - PLAYER_HEIGHT_PX,
      0,
    );
    expect(elementLocalClearance(inactiveBody)).toBe("");
    // Unregistered, so it keeps the full-window band instead of the shorter
    // local projection a registration would have published.
    const fullWindowBandPx = window.innerHeight - nexusRect.top;
    const localProjectionPx = inactiveRect.bottom - nexusRect.top;
    expect(fullWindowBandPx).toBeGreaterThan(localProjectionPx);
    expect(paddingBottomPx(inactiveBody)).toBeCloseTo(fullWindowBandPx, 0);
  });
});

describe("PaneShell mobile refresh", () => {
  it("uses one fenced refresh operation from More and a downward top-edge pull", async () => {
    await page.viewport(390, 844);
    const execute = vi.fn<PaneRefreshExecute>(async () => ({
      kind: "Complete",
      announcement: "Collection refreshed",
    }));
    render(
      withRenderEnvironment(
        withPaneProviders(
          <div
            style={{
              position: "fixed",
              inset: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <MobilePaneBar />
            <PaneUnderTest
              isMobile
              isActive
              refresh={refreshPublication(execute)}
            />
          </div>,
        ),
        { initialViewport: "mobile" },
      ),
    );

    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(execute.mock.calls[0]?.[0].reportProgress).toBeTypeOf("function");
    expect(await screen.findByText("Collection refreshed")).toBeTruthy();
    const body = await screen.findByTestId("pane-shell-body");
    await waitFor(() =>
      expect(body).toHaveAttribute("data-pane-refresh-eligible", "true"),
    );

    dispatchTouches(body, "touchstart", [
      { identifier: 1, clientX: 20, clientY: 20 },
    ]);
    dispatchTouches(body, "touchmove", [
      { identifier: 1, clientX: 20, clientY: 220 },
    ]);
    expect(await screen.findByText("Release to refresh")).toBeTruthy();
    dispatchTouches(body, "touchend", []);

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });

  // A pane whose refresh eligibility is still loading keeps ONE menu shape: the
  // entry is present and blocked with its reason, then becomes available where
  // it already stood. A menu that grows an entry as data lands reflows under a
  // reader's finger and makes any one-shot read of it a race.
  it("holds Refresh in place, blocked with its reason, while eligibility resolves", async () => {
    await page.viewport(390, 844);
    const execute = vi.fn<PaneRefreshExecute>(async () => ({
      kind: "Complete",
      announcement: "Collection refreshed",
    }));
    const tree = (refresh: PaneRefreshPublication) =>
      withRenderEnvironment(
        withPaneProviders(
          <div
            style={{
              position: "fixed",
              inset: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <MobilePaneBar />
            <PaneUnderTest isMobile isActive refresh={refresh} />
          </div>,
        ),
        { initialViewport: "mobile" },
      );
    const { rerender } = render(tree({ kind: "Resolving" }));

    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu");
    const resolvingIds = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("data-action-id"));
    expect(resolvingIds).toContain("Pane.Refresh");
    const resolving = within(menu).getByRole("menuitem", { name: "Refresh" });
    expect(resolving).toHaveAttribute("data-action-availability", "Blocked");
    expect(resolving).toHaveAttribute("aria-disabled", "true");
    expect(resolving).toHaveAccessibleDescription(
      "Available when this pane finishes loading.",
    );
    // Blocked means inert, not decorative: neither a delivered tap nor the
    // pull gesture can start an operation the pane cannot yet name.
    fireEvent.click(resolving);
    expect(execute).not.toHaveBeenCalled();
    const body = await screen.findByTestId("pane-shell-body");
    expect(body).not.toHaveAttribute("data-pane-refresh-eligible");

    rerender(tree(refreshPublication(execute)));

    const resolved = await within(screen.getByRole("menu")).findByRole(
      "menuitem",
      { name: "Refresh" },
    );
    expect(
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("data-action-id")),
    ).toEqual(resolvingIds);
    expect(resolved).toHaveAttribute("data-action-availability", "Available");
    await userEvent.click(resolved);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });
});

describe("PaneShell pane search", () => {
  // A reader's Find rides its parsed source, which lands after the pane already
  // has a header and its other entries. A CI read of a media pane header caught
  // exactly that window and came back
  // ["consumption-activity", "ViewAction.Reader.Settings", …] — Find absent, and
  // every following entry shifted up one place. Find now stands in its own place
  // from the first paint, blocked with a reason until its source lands.
  it("holds Find at the head of the local order, blocked, while its source resolves", async () => {
    await page.viewport(390, 844);
    const onOpen = vi.fn();
    const tree = (search: PaneSearchPublication) =>
      withRenderEnvironment(
        withPaneProviders(
          <div
            style={{
              position: "fixed",
              inset: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <MobilePaneBar />
            <PaneUnderTest
              isMobile
              isActive
              search={search}
              menuActions={READER_MENU_ACTIONS}
            />
          </div>,
        ),
        { initialViewport: "mobile" },
      );
    const { rerender } = render(tree({ kind: "Resolving", control: "Find" }));

    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    const actionIds = () =>
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("data-action-id"));
    await waitFor(() =>
      expect(actionIds()).toEqual([
        "Pane.Search",
        "consumption-activity",
        "ViewAction.Reader.Settings",
      ]),
    );
    const pending = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "Find",
    });
    expect(pending).toHaveAttribute("data-action-availability", "Blocked");
    expect(pending).toHaveAccessibleDescription(
      "Available when this pane finishes loading.",
    );
    // A resolving pane owns no row to disclose and no session to open.
    expect(pending).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pending);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("searchbox")).toBeNull();

    rerender(tree(findPublication(onOpen)));

    await waitFor(() =>
      expect(
        within(screen.getByRole("menu")).getByRole("menuitem", {
          name: "Find",
        }),
      ).toHaveAttribute("data-action-availability", "Available"),
    );
    expect(actionIds()).toEqual([
      "Pane.Search",
      "consumption-activity",
      "ViewAction.Reader.Settings",
    ]);

    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Find" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("searchbox", { name: "Find in document" }),
    ).toBeTruthy();
  });
});
