import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Profiler, useCallback, useEffect, useRef, useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import MobilePaneBar from "@/components/appnav/MobilePaneBar";
import NexusButton from "@/components/switchboard/NexusButton";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
  useMobileChromeVisibleLocks,
} from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { usePanePrimaryChrome } from "./PanePrimaryChrome";
import PaneShell from "./PaneShell";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const noop = () => {};

function Reader() {
  const [title, setTitle] = useState("Document title");
  const visibleLocks = useMobileChromeVisibleLocks();
  const releaseFindLockRef = useRef<(() => void) | null>(null);
  const openFind = useCallback(() => {
    releaseFindLockRef.current ??= visibleLocks.acquire("pane-find");
  }, [visibleLocks]);
  const dismissFind = useCallback(() => {
    releaseFindLockRef.current?.();
    releaseFindLockRef.current = null;
  }, []);
  useEffect(() => dismissFind, [dismissFind]);
  usePanePrimaryChrome({
    header: {
      kind: "resource",
      resource: {
        status: "ready",
        title,
        creditGroups: [],
      },
    },
    instrument: {
      label: "Reader controls",
      content: <button type="button">Reader controls</button>,
    },
    search: {
      kind: "FindOccurrences",
      query: "",
      inputLabel: "Find in document",
      placeholder: "Find",
      onOpen: openFind,
      onQueryChange: noop,
      onDismiss: dismissFind,
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
    },
  });
  const scrollportRef = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey: "media:document-a",
    enabled: true,
  });
  return (
    <div
      ref={scrollportRef}
      data-mobile-reader-interaction-root="true"
      data-testid="reader-scrollport"
      style={{ height: 120, overflowY: "auto" }}
    >
      <div style={{ height: 1_200 }}>
        Reader document
        <button
          type="button"
          onClick={() => setTitle("Updated document title")}
        >
          Update reader title
        </button>
      </div>
    </div>
  );
}

async function scrollReaderTo(scrollTop: number) {
  const scrollport = screen.getByTestId("reader-scrollport");
  expect(scrollport.scrollHeight).toBeGreaterThan(scrollport.clientHeight);
  await act(async () => {
    const scrolled = new Promise<void>((resolve) => {
      scrollport.addEventListener("scroll", () => resolve(), { once: true });
    });
    scrollport.scrollTo({ top: scrollTop });
    await scrolled;
  });
}

function collapseProgress(surface: HTMLElement): number {
  return Number.parseFloat(
    window
      .getComputedStyle(surface)
      .getPropertyValue("--mobile-chrome-collapse"),
  );
}

describe("PaneShell mobile Find chrome composition", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--viewport-safe-left");
    document.documentElement.style.removeProperty("--viewport-safe-right");
  });

  it("keeps asymmetric safe sides while real chrome tracks, pins Find, and rebaselines after Close", async () => {
    await page.viewport(640, 360);
    const safeLeft = 96;
    const safeRight = 28;
    document.documentElement.style.setProperty(
      "--viewport-safe-left",
      `${safeLeft}px`,
    );
    document.documentElement.style.setProperty(
      "--viewport-safe-right",
      `${safeRight}px`,
    );
    let appBarRenders = 0;
    let paneShellRenders = 0;
    let nexusRenders = 0;
    let readerRenders = 0;
    render(
      withRenderEnvironment(
        <MobileChromeProvider>
          <FeedbackProvider>
            <ShareControllerProvider>
              <LibraryPlacementControllerProvider>
                <PaneReturnMementoProvider>
                  <Profiler
                    id="MobilePaneBar"
                    onRender={() => {
                      appBarRenders += 1;
                    }}
                  >
                    <MobilePaneBar />
                  </Profiler>
                  <Profiler
                    id="NexusButton"
                    onRender={() => {
                      nexusRenders += 1;
                    }}
                  >
                    <NexusButton
                      paneCount={1}
                      switchboardOpen={false}
                      onOpen={noop}
                    />
                  </Profiler>
                  <PaneRuntimeProvider
                    paneId="pane-a"
                    visitId={TEST_VISIT_ID}
                    isActive
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
                    <div data-pane-id="pane-a" data-active="true">
                      <Profiler
                        id="PaneShell"
                        onRender={() => {
                          paneShellRenders += 1;
                        }}
                      >
                        <PaneShell
                          paneId="pane-a"
                          routeKey="media:/media/document-a"
                          routeHeader={{
                            kind: "resource",
                            pendingLabel: "Loading document…",
                          }}
                          routeShareIdentity={null}
                          label="Document"
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
                          bodyMode="document"
                          onResizePrimaryPane={noop}
                          isActive
                          isMobile
                        >
                          <Profiler
                            id="Reader"
                            onRender={() => {
                              readerRenders += 1;
                            }}
                          >
                            <Reader />
                          </Profiler>
                        </PaneShell>
                      </Profiler>
                    </div>
                  </PaneRuntimeProvider>
                </PaneReturnMementoProvider>
              </LibraryPlacementControllerProvider>
            </ShareControllerProvider>
          </FeedbackProvider>
        </MobileChromeProvider>,
        { initialViewport: "mobile" },
      ),
    );

    await screen.findByRole("button", { name: "Reader controls" });
    const appBar = screen.getByRole("banner");
    const paneChrome = screen.getByTestId("pane-shell-chrome");
    const contextualRow = screen.getByTestId("pane-contextual-row");
    expect(
      screen.getByRole("group", { name: "Reader controls" }),
    ).toBe(contextualRow);
    const options = screen.getByRole("button", { name: "Pane options" });

    const paneShell = screen.getByTestId("pane-shell-root");
    const paneBody = screen.getByTestId("pane-shell-body");
    const reader = screen.getByTestId("reader-scrollport");
    const paneRect = paneShell.getBoundingClientRect();
    const expectFullPanePaint = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      expect(rect.left).toBeCloseTo(paneRect.left, 0);
      expect(rect.right).toBeCloseTo(paneRect.right, 0);
    };
    const expectInsideSafeSides = (
      element: HTMLElement,
      owner: HTMLElement,
    ) => {
      const rect = element.getBoundingClientRect();
      const ownerRect = owner.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(
        ownerRect.left + safeLeft - 1,
      );
      expect(rect.right).toBeLessThanOrEqual(
        ownerRect.right - safeRight + 1,
      );
    };
    expectFullPanePaint(paneBody);
    expectFullPanePaint(paneChrome);
    expectInsideSafeSides(reader, paneBody);
    expectInsideSafeSides(contextualRow, paneChrome);

    const appBarRect = appBar.getBoundingClientRect();
    expect(appBarRect.left).toBeCloseTo(0, 0);
    expect(appBarRect.right).toBeCloseTo(window.innerWidth, 0);
    for (const controls of screen.getAllByTestId("top-bar-controls")) {
      expectInsideSafeSides(controls, appBar);
    }
    expectInsideSafeSides(
      within(appBar).getByRole("heading", { name: "Document title" }),
      appBar,
    );
    expectInsideSafeSides(options, appBar);

    await scrollReaderTo(24);
    await waitFor(() => {
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Tracking");
      expect(paneChrome).toHaveAttribute(
        "data-mobile-chrome-phase",
        "Tracking",
      );
      expect(collapseProgress(appBar)).toBe(0.25);
      expect(collapseProgress(paneChrome)).toBe(0.25);
    });
    const rendersAtFirstTrackingSample = {
      appBar: appBarRenders,
      paneShell: paneShellRenders,
      nexus: nexusRenders,
      reader: readerRenders,
    };

    const scrollport = screen.getByTestId("reader-scrollport");
    for (const scrollTop of [32, 40, 48]) {
      scrollport.scrollTop = scrollTop;
      fireEvent.scroll(scrollport);
    }
    await waitFor(() => {
      expect(collapseProgress(appBar)).toBe(0.625);
      expect(collapseProgress(paneChrome)).toBe(0.625);
    });
    expect(appBarRenders).toBe(rendersAtFirstTrackingSample.appBar);
    expect(paneShellRenders).toBe(rendersAtFirstTrackingSample.paneShell);
    expect(nexusRenders).toBe(rendersAtFirstTrackingSample.nexus);
    expect(readerRenders).toBe(rendersAtFirstTrackingSample.reader);

    await scrollReaderTo(160);
    await waitFor(() => {
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
      expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
      expect(collapseProgress(appBar)).toBe(1);
      expect(collapseProgress(paneChrome)).toBe(1);
    });
    for (const movingRoot of [appBar, paneChrome]) {
      expect(movingRoot).toHaveAttribute("aria-hidden", "true");
      expect(movingRoot).toHaveAttribute("inert");
    }

    act(() => {
      expect(dispatchPaneSearchRequest()).toBe(true);
    });
    const input = await screen.findByRole("searchbox", {
      name: "Find in document",
    });
    await waitFor(() => {
      expect(input).toHaveFocus();
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
      expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
      expect(collapseProgress(appBar)).toBe(0);
      expect(collapseProgress(paneChrome)).toBe(0);
    });
    expect(appBar).not.toHaveAttribute("aria-hidden");
    expect(appBar).not.toHaveAttribute("inert");
    expect(paneChrome).not.toHaveAttribute("aria-hidden");
    expect(paneChrome).not.toHaveAttribute("inert");
    expect(screen.getByTestId("pane-contextual-row")).not.toHaveAttribute(
      "inert",
    );
    expect(
      screen.queryByRole("group", { name: "Reader controls" }),
    ).not.toBeInTheDocument();

    await scrollReaderTo(360);
    await waitFor(() => {
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
      expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
      expect(collapseProgress(appBar)).toBe(0);
      expect(collapseProgress(paneChrome)).toBe(0);
    });
    expect(contextualRow).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("searchbox", { name: "Find in document" }),
      ).not.toBeInTheDocument();
      expect(options).toHaveFocus();
    });
    expect(
      await screen.findByRole("group", { name: "Reader controls" }),
    ).toBe(contextualRow);
    fireEvent.pointerDown(screen.getByTestId("reader-scrollport"), {
      button: 0,
      isPrimary: true,
    });
    await waitFor(() => {
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Visible");
      expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Visible");
      expect(collapseProgress(appBar)).toBe(0);
      expect(collapseProgress(paneChrome)).toBe(0);
    });

    await scrollReaderTo(520);
    await waitFor(() => {
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
      expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
      expect(collapseProgress(appBar)).toBe(1);
      expect(collapseProgress(paneChrome)).toBe(1);
    });
    expect(appBar).toHaveAttribute("aria-hidden", "true");
    expect(appBar).toHaveAttribute("inert");
    expect(paneChrome).toHaveAttribute("aria-hidden", "true");
    expect(paneChrome).toHaveAttribute("inert");

    fireEvent.click(
      screen.getByRole("button", { name: "Update reader title" }),
    );
    await waitFor(() => {
      expect(screen.getAllByText("Updated document title")).toHaveLength(2);
    });
    expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
    expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
    expect(collapseProgress(appBar)).toBe(1);
    expect(collapseProgress(paneChrome)).toBe(1);
  });
});
