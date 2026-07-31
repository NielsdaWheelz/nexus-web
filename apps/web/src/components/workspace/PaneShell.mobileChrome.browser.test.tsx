import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Profiler } from "react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import MobilePaneBar from "@/components/appnav/MobilePaneBar";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  MobileChromeProvider,
  useMobileChromeReaderScrollport,
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
  usePanePrimaryChrome({
    header: {
      kind: "resource",
      resource: {
        status: "ready",
        title: "Document title",
        creditGroups: [],
      },
    },
    toolbar: <button type="button">Reader controls</button>,
    search: {
      kind: "FindOccurrences",
      query: "",
      inputLabel: "Find in document",
      placeholder: "Find",
      onOpen: noop,
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
      <div style={{ height: 1_200 }}>Reader document</div>
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
  it("keeps real chrome render-stable while Tracking, then pins Find and rebaselines after Close", async () => {
    await page.viewport(390, 800);
    let appBarRenders = 0;
    let paneShellRenders = 0;
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
                          <Reader />
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
    const paneToolbar = screen.getByTestId("pane-shell-toolbar");
    const options = screen.getByRole("button", { name: "Pane options" });

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
    expect(screen.getByTestId("pane-search-toolbar")).not.toHaveAttribute(
      "inert",
    );

    await scrollReaderTo(360);
    await waitFor(() => {
      expect(appBar).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
      expect(paneChrome).toHaveAttribute("data-mobile-chrome-phase", "Pinned");
      expect(collapseProgress(appBar)).toBe(0);
      expect(collapseProgress(paneChrome)).toBe(0);
    });
    expect(paneToolbar).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("searchbox", { name: "Find in document" }),
      ).not.toBeInTheDocument();
      expect(options).toHaveFocus();
    });
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
  });
});
