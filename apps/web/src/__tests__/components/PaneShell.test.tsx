import {
  Component,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneShell from "@/components/workspace/PaneShell";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { dispatchPaneSearchRequest } from "@/lib/panes/paneSearchEvents";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
  findPaneSearchFocusTarget,
} from "@/lib/workspace/paneDom";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { routeShareTarget } from "@/lib/sharing/targets";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeReaderScrollport,
  useMobileChromeSurface,
  type MobilePaneChrome,
} from "@/lib/workspace/mobileChrome";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

const shareControllerMock = vi.hoisted(() => ({
  openShare: vi.fn(),
}));
const libraryPlacementControllerMock = vi.hoisted(() => ({
  openLibraryPlacement: vi.fn(),
}));

vi.mock("@/lib/sharing/controller", () => ({
  useShareController: () => shareControllerMock,
}));
vi.mock("@/lib/libraries/placementController", () => ({
  useLibraryPlacementController: () => libraryPlacementControllerMock,
}));

const runtimeNavigation = {
  back: vi.fn(),
  forward: vi.fn(),
  activateWorkspaceTarget: vi.fn(() => ({
    kind: "CreatedPane" as const,
    paneId: "pane-b",
  })),
};

const sectionHeader = {
  kind: "section",
  destinationId: "libraries",
  defaultFolio: "none",
} as const;

const resourceHeader = {
  kind: "resource",
  pendingLabel: "Loading media…",
} as const;

function paneSizing(input: {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  fixedChromeWidthPx?: number;
}): EffectivePaneSizing {
  const fixedChromeWidthPx = input.fixedChromeWidthPx ?? 0;
  const primaryWidthPx = Math.min(
    input.maxWidthPx,
    Math.max(input.minWidthPx, input.widthPx),
  );
  return {
    primaryWidthPx,
    primaryMinWidthPx: input.minWidthPx,
    primaryMaxWidthPx: input.maxWidthPx,
    renderedPrimarySlotWidthPx: primaryWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMinWidthPx: input.minWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMaxWidthPx: input.maxWidthPx + fixedChromeWidthPx,
    fixedChromeWidthPx,
    storedWidthCorrectionPx: null,
  };
}

type PaneProps = ComponentProps<typeof PaneShell>;

const testRouteShareIdentity = routeShareTarget({
  href: "/libraries",
  label: "Libraries",
});
if (testRouteShareIdentity.kind !== "Route") {
  throw new Error("routeShareTarget returned a resource target");
}
const defaultPaneProps = {
  paneId: "pane-a",
  routeKey: "media:/media/media-1",
  routeHeader: sectionHeader,
  routeShareIdentity: testRouteShareIdentity,
  label: "Libraries",
  returnMementoEnabled: false,
  sizing: paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 }),
  bodyMode: "standard",
  onResizePrimaryPane: vi.fn(),
} satisfies Omit<PaneProps, "children">;

function RuntimeRoute({
  children,
  routeKey,
  paneId = "pane-a",
  href = "/media/media-1",
}: {
  readonly children: ReactNode;
  readonly routeKey: string;
  readonly paneId?: string;
  readonly href?: string;
}) {
  return (
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <PaneRuntimeProvider
          paneId={paneId}
          visitId={TEST_VISIT_ID}
          isActive
          href={href}
          routeId="media"
          routeKey={routeKey}
          canGoBack
          canGoForward
          onGoBackPane={runtimeNavigation.back}
          onGoForwardPane={runtimeNavigation.forward}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={runtimeNavigation.activateWorkspaceTarget}
        >
          {children}
        </PaneRuntimeProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
  );
}

const mobileChromeObservation: {
  current: MobilePaneChrome | null;
} = { current: null };

function MobileChromeObservation() {
  const { motionPhase, paneChrome } = useMobileChrome();
  useLayoutEffect(() => {
    mobileChromeObservation.current = paneChrome;
    return () => {
      if (mobileChromeObservation.current === paneChrome) {
        mobileChromeObservation.current = null;
      }
    };
  }, [paneChrome]);
  return (
    <output data-testid="mobile-chrome-phase">{motionPhase.kind}</output>
  );
}

function MobileChromeReaderScrollport({ sourceKey }: { sourceKey: string }) {
  const registerScrollport = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey,
    enabled: true,
  });
  return (
    <div
      ref={registerScrollport}
      aria-hidden="true"
      data-testid="mobile-chrome-reader-scrollport"
      style={{
        height: 100,
        left: -1_000,
        overflowY: "auto",
        position: "fixed",
        top: 0,
        width: 100,
      }}
    >
      <div style={{ height: 1_000 }} />
    </div>
  );
}

function MobilePaneOptionsSurface({ paneId }: { paneId: string }) {
  const ref = useRef<HTMLElement>(null);
  useMobileChromeSurface(ref, "AppBar", true);
  return (
    <header ref={ref} data-pane-chrome-for={paneId}>
      <button type="button" data-pane-options-trigger={paneId}>
        Pane options
      </button>
    </header>
  );
}

interface PaneTreeHarnessOptions {
  readonly chromeSibling?: ReactNode;
  readonly readerScrollport?: boolean;
}

function paneTree(
  overrides: Partial<PaneProps> = {},
  runtimeHref = "/media/media-1",
  harness: PaneTreeHarnessOptions = {},
) {
  const { children = <div>Body content</div>, ...paneOverrides } = overrides;
  const props: PaneProps = {
    ...defaultPaneProps,
    ...paneOverrides,
    children,
  };
  return withRenderEnvironment(
    <MobileChromeProvider>
      <MobileChromeObservation />
      {harness.chromeSibling}
      {harness.readerScrollport ? (
        <MobileChromeReaderScrollport
          sourceKey={`${props.routeKey}:pane-shell-test`}
        />
      ) : null}
      <RuntimeRoute
        paneId={props.paneId}
        routeKey={props.routeKey}
        href={runtimeHref}
      >
        <PaneShell {...props} />
      </RuntimeRoute>
    </MobileChromeProvider>,
    { initialViewport: props.isMobile ? "mobile" : "desktop" },
  );
}

function PrimaryChromeProbe({
  publication,
}: {
  readonly publication: PanePrimaryChromePublication | null;
}) {
  usePanePrimaryChrome(publication);
  return <div>Published body</div>;
}

function latestMobilePaneSearchAction(): Extract<
  PaneHeaderAction,
  { kind: "command" }
> {
  const action = mobileChromeObservation.current?.actions.find(
    (candidate) =>
      candidate.kind === "command" && candidate.id === "Pane.Search",
  );
  if (action?.kind === "command") return action;
  throw new Error("Mobile Pane Search action was not published");
}

function latestMobilePaneChrome(): MobilePaneChrome {
  const chrome = mobileChromeObservation.current;
  if (chrome) return chrome;
  throw new Error("Mobile pane chrome was not published");
}

function scrollMobileChromeTo(top: number): HTMLElement {
  const scrollport = screen.getByTestId("mobile-chrome-reader-scrollport");
  scrollport.scrollTop = top;
  fireEvent.scroll(scrollport);
  return scrollport;
}

function dispatchTouch(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: readonly {
    readonly identifier: number;
    readonly clientX: number;
    readonly clientY: number;
  }[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  fireEvent(target, event);
  return event;
}

function readyResource(title: string): PanePrimaryChromePublication {
  return {
    header: {
      kind: "resource",
      resource: {
        status: "ready",
        title,
        creditGroups: [
          {
            kind: "authors",
            credits: [{ label: "Ada Lovelace" }],
          },
        ],
      },
    },
  };
}

function resourceMenu(
  actions: readonly ActionDescriptor[] = [],
): NonNullable<PanePrimaryChromePublication["menu"]> {
  return {
    kind: "ResourceMenu",
    target: routeResourceActionSubject({
      scheme: "media",
      id: "00000000-0000-4000-8000-000000000001",
      href: "/media/00000000-0000-4000-8000-000000000001",
    }),
    groups: {
      core: [],
      operations: actions,
      relationships: [],
      view: [],
    },
  };
}

class TestErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly message: string | null }
> {
  state = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : "Unknown render error",
    };
  }

  render() {
    return this.state.message ? (
      <div>{this.state.message}</div>
    ) : (
      this.props.children
    );
  }
}

let mobileViewportActive = false;

async function useMobileTestViewport() {
  await page.viewport(390, 844);
  mobileViewportActive = true;
}

beforeEach(() => {
  vi.clearAllMocks();
  mobileChromeObservation.current = null;
});

afterEach(async () => {
  if (!mobileViewportActive) return;
  await page.viewport(1_280, 720);
  mobileViewportActive = false;
});

describe("PaneShell", () => {
  it("opens and focuses the active pane Filter through its action and shared request", async () => {
    const onQueryChange = vi.fn();
    const onDismiss = vi.fn();
    const companion = {
      kind: "command",
      id: "resource-inspector-companion",
      label: "Companion",
      icon: <span aria-hidden="true">map</span>,
      onSelect: vi.fn(),
    } satisfies PaneHeaderAction;

    render(
      paneTree({
        isActive: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              actions: [companion],
              search: {
                kind: "FilterRows",
                query: "needle",
                inputLabel: "Filter items",
                placeholder: "Filter",
                onQueryChange,
                onDismiss,
                rowStatus: {
                  kind: "Complete",
                  visibleCount: 1,
                  totalCount: 1,
                  unit: { singular: "item", plural: "items" },
                },
                activeDomainControlCount: 0,
              },
            }}
          />
        ),
      }),
    );

    const paneActions = await screen.findByRole("group", {
      name: "Pane actions",
    });
    expect(
      within(paneActions)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Companion", "Filter"]);

    fireEvent.click(within(paneActions).getByRole("button", { name: "Filter" }));
    const input = await screen.findByRole("searchbox", {
      name: "Filter items",
    });
    await waitFor(() => expect(input).toHaveFocus());

    input.blur();
    expect(dispatchPaneSearchRequest()).toBe(true);
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: "next" } });
    expect(onQueryChange).toHaveBeenCalledWith("next");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("pane-search-toolbar")).toBeNull();
    await waitFor(() =>
      expect(
        within(paneActions).getByRole("button", { name: "Filter" }),
      ).toHaveFocus(),
    );
  });

  it("returns mobile shortcut-opened Filter focus to the Options trigger", async () => {
    await useMobileTestViewport();
    const onDismiss = vi.fn();
    render(
      paneTree(
        {
          isActive: true,
          isMobile: true,
          children: (
            <PrimaryChromeProbe
              publication={{
                search: {
                  kind: "FilterRows",
                  query: "",
                  inputLabel: "Filter items",
                  placeholder: "Filter",
                  onQueryChange: vi.fn(),
                  onDismiss,
                  rowStatus: {
                    kind: "Complete",
                    visibleCount: 1,
                    totalCount: 1,
                    unit: { singular: "item", plural: "items" },
                  },
                  activeDomainControlCount: 0,
                },
              }}
            />
          ),
        },
        "/media/media-1",
        {
          chromeSibling: <MobilePaneOptionsSurface paneId="pane-a" />,
        },
      ),
    );

    await waitFor(() =>
      expect(latestMobilePaneChrome().paneId).toBe("pane-a"),
    );
    expect(dispatchPaneSearchRequest()).toBe(true);
    const input = await screen.findByRole("searchbox", {
      name: "Filter items",
    });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pane options" }),
      ).toHaveFocus(),
    );
    expect(screen.getByTestId("mobile-chrome-phase")).toHaveTextContent(
      "Pinned",
    );
  });

  it("focuses a mobile shortcut-opened Filter after the row commits", async () => {
    await useMobileTestViewport();
    render(
      paneTree({
        isActive: true,
        isMobile: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              search: {
                kind: "FilterRows",
                query: "",
                inputLabel: "Filter items",
                placeholder: "Filter",
                onQueryChange: vi.fn(),
                onDismiss: vi.fn(),
                rowStatus: {
                  kind: "Complete",
                  visibleCount: 1,
                  totalCount: 1,
                  unit: { singular: "item", plural: "items" },
                },
                activeDomainControlCount: 0,
              },
            }}
          />
        ),
      }),
    );

    await waitFor(() => expect(dispatchPaneSearchRequest()).toBe(true));
    const input = await screen.findByRole("searchbox", {
      name: "Filter items",
    });
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("ignores a transient mobile menu row when closing Filter", async () => {
    await useMobileTestViewport();
    render(
      paneTree(
        {
          isActive: true,
          isMobile: true,
          children: (
            <PrimaryChromeProbe
              publication={{
                search: {
                  kind: "FilterRows",
                  query: "",
                  inputLabel: "Filter items",
                  placeholder: "Filter",
                  onQueryChange: vi.fn(),
                  onDismiss: vi.fn(),
                  rowStatus: {
                    kind: "Complete",
                    visibleCount: 1,
                    totalCount: 1,
                    unit: { singular: "item", plural: "items" },
                  },
                  activeDomainControlCount: 0,
                },
              }}
            />
          ),
        },
        "/media/media-1",
        {
          chromeSibling: <MobilePaneOptionsSurface paneId="pane-a" />,
        },
      ),
    );

    await waitFor(() => latestMobilePaneSearchAction());
    const transientMenuRow = document.createElement("button");
    act(() =>
      latestMobilePaneSearchAction().onSelect({
        triggerEl: transientMenuRow,
      }),
    );
    await screen.findByRole("searchbox", { name: "Filter items" });

    act(() =>
      latestMobilePaneSearchAction().onSelect({
        triggerEl: transientMenuRow,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pane options" }),
      ).toHaveFocus(),
    );
  });

  it("marks collapsed non-default Filter controls and restores the exact label after Close", async () => {
    render(
      paneTree({
        isActive: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              search: {
                kind: "FilterRows",
                query: "",
                inputLabel: "Filter items",
                placeholder: "Filter",
                onQueryChange: vi.fn(),
                onDismiss: vi.fn(),
                rowStatus: {
                  kind: "Complete",
                  visibleCount: 4,
                  totalCount: 4,
                  unit: { singular: "item", plural: "items" },
                },
                activeDomainControlCount: 2,
              },
            }}
          />
        ),
      }),
    );

    const paneActions = await screen.findByRole("group", {
      name: "Pane actions",
    });
    const collapsed = within(paneActions).getByRole("button", {
      name: "Filter, 2 controls active",
    });
    expect(screen.getByTestId("pane-filter-active-marker")).toBeVisible();

    fireEvent.click(collapsed);
    const expanded = within(paneActions).getByRole("button", {
      name: "Filter",
    });
    fireEvent.click(expanded);
    await waitFor(() =>
      expect(
        within(paneActions).getByRole("button", {
          name: "Filter, 2 controls active",
        }),
      ).toHaveFocus(),
    );
  });

  it("keeps an expanded Filter mounted and focused across in-place domain URL state", async () => {
    const onQueryChange = vi.fn();
    const onDismiss = vi.fn();
    const publication = (sort: "recent" | "alpha") =>
      ({
        search: {
          kind: "FilterRows",
          query: "needle",
          inputLabel: "Filter libraries",
          placeholder: "Filter",
          onQueryChange,
          onDismiss,
          rowStatus: {
            kind: "Complete",
            visibleCount: 1,
            totalCount: 2,
            unit: { singular: "library", plural: "libraries" },
          },
          activeDomainControlCount: Number(sort !== "recent"),
          filters: (
            <label>
              Sort
              <select aria-label="Sort" value={sort} onChange={() => {}}>
                <option value="recent">Recent</option>
                <option value="alpha">A-Z</option>
              </select>
            </label>
          ),
        },
      }) satisfies PanePrimaryChromePublication;
    const view = render(
      paneTree({
        routeKey: "libraries:/libraries",
        isActive: true,
        children: <PrimaryChromeProbe publication={publication("recent")} />,
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Filter" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", { name: "Filter libraries" }),
      ).toHaveFocus(),
    );
    const sort = await screen.findByRole("combobox", { name: "Sort" });
    sort.focus();
    expect(sort).toHaveFocus();

    view.rerender(
      paneTree({
        routeKey: "libraries:/libraries?sort=alpha",
        isActive: true,
        children: <PrimaryChromeProbe publication={publication("alpha")} />,
      }),
    );

    const retainedSort = await screen.findByRole("combobox", { name: "Sort" });
    expect(retainedSort).toBe(sort);
    expect(retainedSort).toHaveValue("alpha");
    expect(retainedSort).toHaveFocus();
    expect(
      screen.getByRole("searchbox", { name: "Filter libraries" }),
    ).toHaveValue("needle");

    view.rerender(
      paneTree(
        {
          routeKey: "libraries:/libraries/library-b",
          isActive: true,
          children: <PrimaryChromeProbe publication={publication("recent")} />,
        },
        "/libraries/library-b",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("searchbox", { name: "Filter libraries" }),
      ).toBeNull(),
    );
  });

  it("opens Find once before focus and only refocuses while already open", async () => {
    const onOpen = vi.fn(() => {
      expect(
        screen.queryByRole("searchbox", { name: "Find in document" }),
      ).toBeNull();
    });
    render(
      paneTree({
        isActive: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              search: {
                kind: "FindOccurrences",
                query: "needle",
                inputLabel: "Find in document",
                placeholder: "Find",
                onOpen,
                onQueryChange: vi.fn(),
                onDismiss: vi.fn(),
                result: { kind: "Idle" },
                scope: { kind: "EntireResource" },
                matchCase: false,
                wholeWord: false,
                onMatchCaseChange: vi.fn(),
                onWholeWordChange: vi.fn(),
                onStep: vi.fn(),
                onActivate: vi.fn(),
                onShowResults: vi.fn(),
                resultsExpanded: false,
                returnToReadingPosition: { kind: "Unavailable" },
              },
            }}
          />
        ),
      }),
    );

    const findAction = await screen.findByRole("button", { name: "Find" });
    fireEvent.click(findAction);
    const input = await screen.findByRole("searchbox", {
      name: "Find in document",
    });
    await waitFor(() => expect(input).toHaveFocus());
    expect(onOpen).toHaveBeenCalledTimes(1);

    input.blur();
    expect(dispatchPaneSearchRequest()).toBe(true);
    await waitFor(() => expect(input).toHaveFocus());
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    fireEvent.click(findAction);
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
  });

  it("keeps the reading-position action after Find and invokes Return once", async () => {
    const onReturn = vi.fn();
    render(
      paneTree({
        isActive: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              search: {
                kind: "FindOccurrences",
                query: "",
                inputLabel: "Find in document",
                placeholder: "Find",
                onOpen: vi.fn(),
                onQueryChange: vi.fn(),
                onDismiss: vi.fn(),
                result: { kind: "Idle" },
                scope: { kind: "EntireResource" },
                matchCase: false,
                wholeWord: false,
                onMatchCaseChange: vi.fn(),
                onWholeWordChange: vi.fn(),
                onStep: vi.fn(),
                onActivate: vi.fn(),
                onShowResults: vi.fn(),
                resultsExpanded: false,
                returnToReadingPosition: {
                  kind: "Available",
                  onReturn,
                },
              },
            }}
          />
        ),
      }),
    );

    const paneActions = await screen.findByRole("group", {
      name: "Pane actions",
    });
    expect(
      within(paneActions)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Find", "Go back to reading position"]);
    fireEvent.click(
      within(paneActions).getByRole("button", {
        name: "Go back to reading position",
      }),
    );
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("prepends one Refresh option and projects determinate progress plus the terminal announcement", async () => {
    let reportProgress:
      | ((progress: {
          readonly kind: "Determinate";
          readonly finishedCount: number;
          readonly requestedCount: number;
        }) => void)
      | null = null;
    let resolveRefresh:
      | ((result: {
          readonly kind: "Complete";
          readonly announcement: string;
        }) => void)
      | null = null;
    const execute = vi.fn(
      ({
        reportProgress: publishProgress,
      }: Parameters<
        NonNullable<PanePrimaryChromePublication["refresh"]>["execute"]
      >[0]) =>
        new Promise<{
          readonly kind: "Complete";
          readonly announcement: string;
        }>((resolve) => {
          reportProgress = publishProgress;
          resolveRefresh = resolve;
        }),
    );

    render(
      paneTree({
        isActive: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              refresh: { sourceKey: "libraries", execute },
              menu: {
                kind: "FlatMenu",
                actions: [
                  {
                    kind: "command",
                    id: "custom",
                    label: "Custom action",
                    onSelect: vi.fn(),
                  },
                ],
              },
            }}
          />
        ),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Options" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim()),
    ).toEqual(["Refresh", "Share…", "Custom action"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Refresh" }));
    expect(execute).toHaveBeenCalledTimes(1);

    act(() => {
      reportProgress?.({
        kind: "Determinate",
        finishedCount: 3,
        requestedCount: 8,
      });
    });
    expect(screen.getByText("Refreshing 3 of 8")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Refreshing 3 of 8" }),
    ).toHaveAttribute("aria-valuenow", "3");
    expect(
      screen.getByRole("progressbar", { name: "Refreshing 3 of 8" }),
    ).toHaveAttribute("aria-valuemax", "8");

    await act(async () => {
      resolveRefresh?.({
        kind: "Complete",
        announcement: "Libraries refreshed",
      });
    });
    expect(screen.getAllByText("Libraries refreshed")).toHaveLength(2);
    const liveRegion = screen.getByText("Libraries refreshed", {
      selector: '[aria-live="polite"]',
    });
    expect(liveRegion).toHaveAttribute("aria-atomic", "true");
    expect(liveRegion).toHaveTextContent("Libraries refreshed");
  });

  it("locks only a top-edge downward mobile gesture, arms at the exact resisted distance, and coalesces execution", async () => {
    await useMobileTestViewport();
    let resolveRefresh:
      | ((result: {
          readonly kind: "Complete";
          readonly announcement: string;
        }) => void)
      | null = null;
    const execute = vi.fn(
      () =>
        new Promise<{
          readonly kind: "Complete";
          readonly announcement: string;
        }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    render(
      paneTree({
        isActive: true,
        isMobile: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              refresh: { sourceKey: "libraries", execute },
            }}
          />
        ),
      }),
    );

    const body = screen.getByTestId("pane-shell-body");
    let scrollTop = 0;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    await waitFor(() =>
      expect(body).toHaveAttribute("data-pane-refresh-eligible", "true"),
    );
    expect(getComputedStyle(body).touchAction).toBe("pan-x pan-up");
    body.scrollTop = 1;
    dispatchTouch(body, "touchstart", [
      { identifier: 0, clientX: 40, clientY: 20 },
    ]);
    const scrolledMove = dispatchTouch(body, "touchmove", [
      { identifier: 0, clientX: 40, clientY: 220 },
    ]);
    expect(scrolledMove.defaultPrevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    body.scrollTop = 0;

    dispatchTouch(body, "touchstart", [
      { identifier: 1, clientX: 40, clientY: 20 },
    ]);
    const horizontalMove = dispatchTouch(body, "touchmove", [
      { identifier: 1, clientX: 100, clientY: 40 },
    ]);
    expect(horizontalMove.defaultPrevented).toBe(false);
    expect(screen.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );

    dispatchTouch(body, "touchstart", [
      { identifier: 2, clientX: 40, clientY: 20 },
    ]);
    const pullingMove = dispatchTouch(body, "touchmove", [
      { identifier: 2, clientX: 42, clientY: 120 },
    ]);
    expect(pullingMove.defaultPrevented).toBe(true);
    expect(screen.getByText("Pull to refresh")).toBeInTheDocument();
    dispatchTouch(body, "touchend", []);
    expect(execute).not.toHaveBeenCalled();

    dispatchTouch(body, "touchstart", [
      { identifier: 6, clientX: 40, clientY: 20 },
    ]);
    dispatchTouch(body, "touchmove", [
      { identifier: 6, clientX: 42, clientY: 120 },
    ]);
    expect(screen.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Pulling",
    );
    dispatchTouch(body, "touchcancel", []);
    expect(screen.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );
    expect(execute).not.toHaveBeenCalled();

    dispatchTouch(body, "touchstart", [
      { identifier: 4, clientX: 40, clientY: 20 },
    ]);
    dispatchTouch(body, "touchmove", [
      { identifier: 4, clientX: 42, clientY: 120 },
    ]);
    dispatchTouch(body, "touchstart", [
      { identifier: 4, clientX: 42, clientY: 120 },
      { identifier: 5, clientX: 80, clientY: 120 },
    ]);
    expect(screen.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );

    dispatchTouch(body, "touchstart", [
      { identifier: 3, clientX: 40, clientY: 20 },
    ]);
    const armedMove = dispatchTouch(body, "touchmove", [
      { identifier: 3, clientX: 42, clientY: 180 },
    ]);
    expect(armedMove.defaultPrevented).toBe(true);
    expect(screen.getByText("Release to refresh")).toBeInTheDocument();
    dispatchTouch(body, "touchend", []);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Refreshing")).toBeInTheDocument();

    const refreshOption = latestMobilePaneChrome().options[0];
    if (refreshOption?.kind !== "command") {
      throw new Error("Mobile Refresh option was not a command");
    }
    refreshOption.onSelect({ triggerEl: null });
    expect(execute).toHaveBeenCalledTimes(1);

    const session = cdp() as unknown as {
      send(
        method: string,
        params: Record<string, unknown>,
      ): Promise<unknown>;
    };
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      const refreshIndicator = screen.getByTestId("pane-refresh-indicator");
      expect(
        getComputedStyle(screen.getByText("Refreshing")).transitionDuration,
      ).toBe("0s");
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the decorative icon has no semantic query surface; its computed animation is the reduced-motion contract.
      const refreshIcon = refreshIndicator.querySelector("svg");
      expect(refreshIcon).not.toBeNull();
      expect(getComputedStyle(refreshIcon!).animationName).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "no-preference" },
        ],
      });
    }

    await act(async () => {
      resolveRefresh?.({
        kind: "Complete",
        announcement: "Libraries refreshed",
      });
    });
  });

  it("aborts and fences a stale completion when the published refresh source changes", async () => {
    let signal: AbortSignal | null = null;
    let resolveRefresh:
      | ((result: {
          readonly kind: "Complete";
          readonly announcement: string;
        }) => void)
      | null = null;
    const execute = vi.fn(
      ({ signal: executionSignal }: { readonly signal: AbortSignal }) => {
        signal = executionSignal;
        return new Promise<{
          readonly kind: "Complete";
          readonly announcement: string;
        }>((resolve) => {
          resolveRefresh = resolve;
        });
      },
    );
    const capturedSignal = () => signal as AbortSignal | null;
    const publication = (sourceKey: string): PanePrimaryChromePublication => ({
      refresh: { sourceKey, execute },
    });
    const { rerender } = render(
      paneTree({
        children: (
          <PrimaryChromeProbe publication={publication("libraries:a")} />
        ),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Options" }));
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Refresh",
      }),
    );
    expect(capturedSignal()?.aborted).toBe(false);

    rerender(
      paneTree({
        children: (
          <PrimaryChromeProbe publication={publication("libraries:b")} />
        ),
      }),
    );
    await waitFor(() => expect(capturedSignal()?.aborted).toBe(true));
    await act(async () => {
      resolveRefresh?.({
        kind: "Complete",
        announcement: "Stale refresh complete",
      });
    });
    expect(screen.queryByText("Stale refresh complete")).toBeNull();
    expect(screen.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );
  });

  it("keeps the routed content as the pane-return root when refresh is published", async () => {
    await useMobileTestViewport();
    render(
      paneTree({
        isActive: true,
        isMobile: true,
        returnMementoEnabled: true,
        children: (
          <div data-testid="routed-content-root">
            <PrimaryChromeProbe
              publication={{
                refresh: {
                  sourceKey: "libraries",
                  execute: async () => ({
                    kind: "Complete",
                    announcement: "Libraries refreshed",
                  }),
                },
              }}
            />
          </div>
        ),
      }),
    );

    const body = screen.getByTestId("pane-shell-body");
    await waitFor(() =>
      expect(body).toHaveAttribute("data-pane-refresh-eligible", "true"),
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: first-child identity is the pane-return scrollport capability contract.
    expect(body.firstElementChild).toBe(screen.getByTestId("routed-content-root"));
    expect(getComputedStyle(screen.getByTestId("pane-refresh-indicator")).order).toBe(
      "-1",
    );
  });

  it("fills the pane with one native-touch scroll owner while the bounded secondary pane still scrolls", () => {
    render(
      <div style={{ height: 640 }}>
        {paneTree({
          returnMementoEnabled: true,
          secondaryPane: {
            id: "secondary-a",
            parentPrimaryPaneId: "pane-a",
            groupId: "resource-inspector",
            activeSurfaceId: "resource-contents",
            widthPx: 360,
            visibility: "visible",
          },
          secondarySizing: {
            widthPx: 360,
            minWidthPx: 280,
            maxWidthPx: 720,
            storedWidthCorrectionPx: null,
          },
          secondaryPublication: {
            groupId: "resource-inspector",
            defaultSurfaceId: "resource-contents",
            surfaces: [
              {
                id: "resource-contents",
                body: <div>Long secondary content</div>,
              },
            ],
          },
          children: <div>Page or Note editor</div>,
        })}
      </div>,
    );

    const shell = screen.getByTestId("pane-shell-root");
    const primaryScrollport = screen.getByTestId("pane-shell-body");
    const primaryStyle = getComputedStyle(primaryScrollport);
    expect(primaryStyle.display).toBe("flex");
    expect(primaryStyle.flexDirection).toBe("column");
    expect(primaryStyle.minHeight).toBe("0px");
    expect(primaryStyle.overflowY).toBe("auto");
    expect(primaryStyle.overflowX).toBe("hidden");
    expect(primaryStyle.touchAction).toBe("auto");
    expect(primaryScrollport.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(primaryScrollport.getBoundingClientRect().bottom).toBeCloseTo(
      shell.getBoundingClientRect().bottom,
      0,
    );

    const secondaryScrollport = screen.getByRole("tabpanel", {
      name: "Contents",
    });
    const secondaryStyle = getComputedStyle(secondaryScrollport);
    expect(secondaryStyle.minHeight).toBe("0px");
    expect(secondaryStyle.overflowY).toBe("auto");
    expect(secondaryScrollport.getBoundingClientRect().height).toBeGreaterThan(
      0,
    );
  });

  it("names section landmarks from the route contract, independent of bodyMode", () => {
    render(
      paneTree({
        routeHeader: sectionHeader,
        label: "A document-shaped pane",
        bodyMode: "document",
      }),
    );

    expect(screen.getByRole("region", { name: "Libraries" })).toHaveAttribute(
      "data-header-kind",
      "section",
    );
    expect(
      screen.getByText("Libraries", { selector: "[data-running-head] p" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("gives a pending resource a non-empty busy identity and landmark name", () => {
    render(
      paneTree({
        routeHeader: resourceHeader,
        routeShareIdentity: null,
        label: "Media",
        bodyMode: "standard",
      }),
    );

    expect(
      screen.getByRole("region", { name: "Loading media…" }),
    ).toHaveAttribute("data-header-kind", "resource");
    expect(
      screen.getByRole("heading", { level: 1, name: "Loading media…" }),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("projects the current resource publication and clears it on unmount", async () => {
    const { rerender } = render(
      paneTree({
        routeHeader: resourceHeader,
        label: "Media",
        children: (
          <PrimaryChromeProbe
            publication={readyResource("Computing Machinery")}
          />
        ),
      }),
    );

    expect(
      await screen.findByRole("region", { name: "Computing Machinery" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();

    rerender(
      paneTree({
        routeHeader: resourceHeader,
        label: "Media",
        children: <div>Replacement body</div>,
      }),
    );

    expect(
      await screen.findByRole("region", { name: "Loading media…" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Computing Machinery")).not.toBeInTheDocument();
  });

  it("ignores an invalid stale-route publication before kind validation", async () => {
    render(
      paneTree({
        routeKey: "media:current",
        routeHeader: resourceHeader,
        label: "Media",
        children: (
          <>
            <PrimaryChromeProbe publication={readyResource("Current title")} />
            <RuntimeRoute routeKey="media:stale">
              <PrimaryChromeProbe
                publication={{
                  header: {
                    kind: "section",
                    folio: { kind: "title", value: "Invalid stale title" },
                    pending: false,
                  },
                }}
              />
            </RuntimeRoute>
          </>
        ),
      }),
    );

    expect(
      await screen.findByRole("region", { name: "Current title" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid stale title")).not.toBeInTheDocument();
  });

  it("does not let stale cleanup clear a newer publication", async () => {
    const oldPublisher = (
      <RuntimeRoute key="old" routeKey="media:old">
        <PrimaryChromeProbe publication={readyResource("Old title")} />
      </RuntimeRoute>
    );
    const currentPublisher = (
      <RuntimeRoute key="current" routeKey="media:current">
        <PrimaryChromeProbe publication={readyResource("Current title")} />
      </RuntimeRoute>
    );
    const { rerender } = render(
      paneTree({
        routeKey: "media:old",
        routeHeader: resourceHeader,
        label: "Media",
        children: oldPublisher,
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Old title" }),
    ).toBeInTheDocument();

    rerender(
      paneTree({
        routeKey: "media:current",
        routeHeader: resourceHeader,
        label: "Media",
        children: (
          <>
            {oldPublisher}
            {currentPublisher}
          </>
        ),
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Current title" }),
    ).toBeInTheDocument();

    rerender(
      paneTree({
        routeKey: "media:current",
        routeHeader: resourceHeader,
        label: "Media",
        children: currentPublisher,
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: "Current title" }),
      ).toBeInTheDocument();
    });
  });

  it("throws on a current route/header kind mismatch", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(
        <TestErrorBoundary>
          {paneTree({
            routeKey: "media:current",
            routeHeader: resourceHeader,
            label: "Media",
            children: (
              <PrimaryChromeProbe
                publication={{
                  header: {
                    kind: "section",
                    folio: { kind: "none" },
                    pending: false,
                  },
                }}
              />
            ),
          })}
        </TestErrorBoundary>,
      );

      expect(
        await screen.findByText(
          "Resource route received a section header publication.",
        ),
      ).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("projects primary actions separately from desktop overflow options", async () => {
    const onMap = vi.fn();
    const onCredits = vi.fn();
    const mapAction = {
      kind: "command",
      id: "resource-inspector-companion",
      label: "Companion",
      icon: <span aria-hidden="true">map</span>,
      onSelect: onMap,
    } satisfies PaneHeaderAction;
    const creditsOption = {
      kind: "command",
      id: "credits",
      label: "Credits…",
      onSelect: onCredits,
    } satisfies ActionDescriptor;

    render(
      paneTree({
        routeHeader: resourceHeader,
        routeShareIdentity: null,
        label: "Media",
        children: (
          <PrimaryChromeProbe
            publication={{
              ...readyResource("Document title"),
              actions: [mapAction],
              menu: resourceMenu([creditsOption]),
            }}
          />
        ),
      }),
    );

    const mapButton = await screen.findByRole("button", {
      name: "Companion",
    });
    fireEvent.click(mapButton);
    expect(onMap).toHaveBeenCalledWith({ triggerEl: mapButton });

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim()),
    ).toEqual(["Share…", "Chat about this resource", "Credits…", "Libraries…"]);
    expect(
      within(menu).getAllByRole("menuitem", { name: "Share…" }),
    ).toHaveLength(1);
    expect(
      within(menu).getAllByRole("menuitem", { name: "Libraries…" }),
    ).toHaveLength(1);
    const libraries = within(menu).getByRole("menuitem", {
      name: "Libraries…",
    });
    fireEvent.click(libraries);
    expect(
      libraryPlacementControllerMock.openLibraryPlacement,
    ).toHaveBeenCalledWith(
      {
        kind: "Media",
        id: "00000000-0000-4000-8000-000000000001",
      },
      expect.objectContaining({
        anchor: expect.any(Function),
        returnFocusFallback: expect.objectContaining({ kind: "Present" }),
      }),
    );
    expect(
      within(menu).queryByRole("menuitem", { name: "Companion" }),
    ).not.toBeInTheDocument();
  });

  it("publishes primary actions separately from mobile Options", async () => {
    await useMobileTestViewport();
    const companion = {
      kind: "command",
      id: "resource-inspector-companion",
      label: "Companion",
      icon: <span aria-hidden="true">map</span>,
      onSelect: vi.fn(),
    } satisfies PaneHeaderAction;

    render(
      paneTree({
        routeHeader: resourceHeader,
        routeShareIdentity: null,
        label: "Media",
        isMobile: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              ...readyResource("Document title"),
              actions: [companion],
              menu: resourceMenu([
                {
                  kind: "command",
                  id: "credits",
                  label: "Credits…",
                  onSelect: vi.fn(),
                },
              ]),
            }}
          />
        ),
      }),
    );

    await waitFor(() => {
      expect(latestMobilePaneChrome()).toEqual(
        expect.objectContaining({
          paneId: "pane-a",
          header: expect.objectContaining({ kind: "resource" }),
          actions: expect.any(Array),
          options: expect.any(Array),
        }),
      );
    });
    const publication = latestMobilePaneChrome();
    expect(
      publication.actions.map((action: PaneHeaderAction) => action.label),
    ).toEqual(["Companion"]);
    expect(
      publication.options.map((option: ActionDescriptor) => option.label),
    ).toEqual(["Share…", "Chat about this resource", "Credits…", "Libraries…"]);
    expect(
      publication.options.filter(
        (option: ActionDescriptor) => option.id === "ResourceAction.Share",
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Companion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
  });

  it("keeps projected mobile identity links inside pane navigation", async () => {
    await useMobileTestViewport();
    render(
      paneTree({
        routeHeader: resourceHeader,
        routeShareIdentity: null,
        label: "Media",
        isMobile: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              header: {
                kind: "resource",
                resource: {
                  status: "ready",
                  title: "Computing Machinery",
                  creditGroups: [
                    {
                      kind: "authors",
                      credits: [
                        {
                          label: "Ada Lovelace",
                          href: "/authors/ada-lovelace",
                        },
                      ],
                    },
                  ],
                },
              },
            }}
          />
        ),
      }),
    );

    await waitFor(() => {
      expect(latestMobilePaneChrome().paneId).toBe("pane-a");
    });
    const publication = latestMobilePaneChrome();

    render(
      <Link
        href="/authors/ada-lovelace"
        data-pane-label-hint="Ada Lovelace"
        onClick={(event) =>
          publication.activateIdentityAnchor(event, event.currentTarget)
        }
      >
        Ada Lovelace
      </Link>,
    );
    const link = screen.getByRole("link", { name: "Ada Lovelace" });

    fireEvent.click(link, { detail: 0 });
    expect(runtimeNavigation.activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-a",
      target: {
        href: "/authors/ada-lovelace",
        labelHint: "Ada Lovelace",
      },
      disposition: { kind: "Follow" },
      modality: "Keyboard",
    });

    fireEvent.click(link, { detail: 1, shiftKey: true });
    expect(runtimeNavigation.activateWorkspaceTarget).toHaveBeenLastCalledWith({
      originPaneId: "pane-a",
      target: {
        href: "/authors/ada-lovelace",
        labelHint: "Ada Lovelace",
      },
      disposition: { kind: "Fork" },
      modality: "Pointer",
    });
    expect(runtimeNavigation.activateWorkspaceTarget).toHaveBeenCalledTimes(2);
  });

  it("keeps the pane landmark available while the whole moving toolbar is noninteractive outside visible phases", async () => {
    await useMobileTestViewport();
    const mobileToolbar = {
      routeHeader: resourceHeader,
      routeShareIdentity: null,
      label: "Media",
      isMobile: true,
      children: (
        <PrimaryChromeProbe
          publication={{
            ...readyResource("Document title"),
            toolbar: <button type="button">Reader controls</button>,
          }}
        />
      ),
    } satisfies Partial<PaneProps>;
    render(
      paneTree(mobileToolbar, "/media/media-1", {
        readerScrollport: true,
      }),
    );

    const readerControls = await screen.findByRole("button", {
      name: "Reader controls",
    });
    const landmark = screen.getByTestId("pane-shell-root");
    const chrome = screen.getByTestId("pane-shell-chrome");
    const body = screen.getByTestId("pane-shell-body");
    const toolbar = screen.getByTestId("pane-shell-toolbar");
    expect(landmark).toHaveAttribute("data-pane-focus-landmark", "true");
    expect(landmark).toHaveAttribute("tabindex", "-1");
    expect(chrome).toHaveAttribute("data-mobile-chrome-phase", "Visible");
    expect(chrome).not.toHaveAttribute("aria-hidden");
    expect(chrome).not.toHaveAttribute("inert");
    expect(chrome).not.toHaveStyle({ pointerEvents: "none" });

    vi.useFakeTimers();
    try {
      scrollMobileChromeTo(32);
      expect(chrome).toHaveAttribute("data-mobile-chrome-phase", "Tracking");
      expect(chrome).toHaveAttribute("aria-hidden", "true");
      expect(chrome).toHaveAttribute("inert");
      expect(chrome).toHaveStyle({ pointerEvents: "none" });
      expect(readerControls).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Reader controls" }),
      ).toBeNull();

      act(() => vi.advanceTimersByTime(120));
      expect(chrome).toHaveAttribute("data-mobile-chrome-phase", "Settling");
      expect(chrome).toHaveAttribute("aria-hidden", "true");
      expect(chrome).toHaveAttribute("inert");
      expect(chrome).toHaveStyle({ pointerEvents: "none" });
      expect(
        screen.queryByRole("button", { name: "Reader controls" }),
      ).toBeNull();

      act(() => vi.advanceTimersByTime(500));
      expect(chrome).toHaveAttribute("data-mobile-chrome-phase", "Visible");
    } finally {
      vi.useRealTimers();
    }

    scrollMobileChromeTo(300);
    expect(chrome).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
    expect(chrome).toHaveAttribute("aria-hidden", "true");
    expect(chrome).toHaveAttribute("inert");
    expect(chrome).toHaveStyle({ pointerEvents: "none" });
    expect(toolbar).not.toHaveAttribute("aria-hidden");
    expect(toolbar).not.toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Reader controls" })).toBeNull();
    expect(screen.getByTestId("pane-shell-body")).toBe(body);
  });

  it("leaves the pane toolbar surface empty when the reader publishes no toolbar", async () => {
    await useMobileTestViewport();
    render(
      paneTree(
        {
          routeHeader: resourceHeader,
          routeShareIdentity: null,
          label: "Media",
          isMobile: true,
          children: (
            <PrimaryChromeProbe publication={readyResource("Document title")} />
          ),
        },
        "/media/media-1",
        { readerScrollport: true },
      ),
    );

    const chrome = screen.getByTestId("pane-shell-chrome");
    scrollMobileChromeTo(300);
    expect(chrome).toHaveAttribute("data-mobile-chrome-phase", "Hidden");
    expect(chrome).not.toHaveAttribute("aria-hidden");
    expect(chrome).not.toHaveAttribute("inert");
    expect(chrome).toBeEmptyDOMElement();
  });

  it("falls back to the pane chrome sentinel when the mobile Options trigger is inert", () => {
    render(
      <>
        <header data-pane-chrome-for="pane-a">
          <div inert>
            <button type="button" data-pane-options-trigger="pane-a">
              Pane options
            </button>
          </div>
        </header>
        <div data-pane-id="pane-a">
          <div
            data-testid="pane-chrome-sentinel"
            data-pane-chrome-focus="true"
            tabIndex={-1}
          />
        </div>
      </>,
    );

    const sentinel = screen.getByTestId("pane-chrome-sentinel");
    expect(findPaneChromeFocusTarget("pane-a")).toBe(sentinel);
  });

  it("resolves the stable named pane landmark independently of moving chrome", () => {
    render(
      <div data-pane-id="pane-a">
        <section
          aria-label="Document title"
          data-pane-focus-landmark="true"
          tabIndex={-1}
        />
        <div inert>
          <button type="button" data-pane-options-trigger>
            Pane options
          </button>
        </div>
      </div>,
    );

    const landmark = screen.getByRole("region", { name: "Document title" });
    expect(findPaneLandmarkFocusTarget("pane-a")).toBe(landmark);
    landmark.focus();
    expect(landmark).toHaveFocus();
  });

  it("resolves the expanded Filter input before the collapsed Filter action", () => {
    const view = render(
      <div data-pane-id="pane-a">
        <button type="button" data-action-id="Pane.Search">
          Filter
        </button>
        <input data-pane-search-input="true" aria-label="Filter items" />
      </div>,
    );

    const input = screen.getByRole("textbox", { name: "Filter items" });
    expect(findPaneSearchFocusTarget("pane-a")).toBe(input);
    view.rerender(
      <div data-pane-id="pane-a">
        <button type="button" data-action-id="Pane.Search">
          Filter
        </button>
      </div>,
    );
    expect(findPaneSearchFocusTarget("pane-a")).toBe(
      screen.getByRole("button", { name: "Filter" }),
    );
  });

  it("uses the mounted mobile Options trigger when Filter is folded into its menu", () => {
    render(
      <header data-pane-chrome-for="pane-a">
        <button type="button" data-pane-options-trigger="pane-a">
          Pane options
        </button>
      </header>,
    );

    const options = screen.getByRole("button", { name: "Pane options" });
    expect(findPaneSearchFocusTarget("pane-a")).toBe(options);
  });

  it("publishes keyed Chat busy state and guards rapid re-entry", async () => {
    const pendingFetch: {
      resolve?: (response: Response) => void;
    } = {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pendingFetch.resolve = resolve;
        }),
    );
    try {
      render(
        paneTree({
          routeHeader: resourceHeader,
          routeShareIdentity: null,
          label: "Media",
          children: (
            <PrimaryChromeProbe
              publication={{
                ...readyResource("Document title"),
                menu: resourceMenu(),
              }}
            />
          ),
        }),
      );

      fireEvent.click(await screen.findByRole("button", { name: "Options" }));
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: "Chat about this resource",
        }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "Options" }));
      const busyChat = await screen.findByRole("menuitem", {
        name: "Starting chat...",
      });
      expect(busyChat).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(busyChat);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const resolveFetch = pendingFetch.resolve;
      if (!resolveFetch) {
        // justify-defect: the selected Chat command must have reached fetch.
        throw new Error("Chat request was not pending");
      }
      resolveFetch(Response.json({ data: { id: "conversation-1" } }));
      await waitFor(() => {
        expect(runtimeNavigation.activateWorkspaceTarget).toHaveBeenCalledWith({
          originPaneId: "pane-a",
          target: {
            href: "/conversations/conversation-1",
            labelHint: "Chat",
          },
          disposition: { kind: "Adopt" },
          modality: "Programmatic",
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("scopes ready same-resource identity, actions, Options, and secondary regions per pane", async () => {
    const secondaryPublication = {
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-contents",
      surfaces: [
        {
          id: "resource-contents",
          body: <div>Contents secondary</div>,
        },
      ],
    } satisfies NonNullable<PaneProps["secondaryPublication"]>;
    const concurrentPane = (paneId: "pane-a" | "pane-b") => {
      const secondaryRegionId = paneSecondaryRegionId(
        paneId,
        "resource-inspector",
      );
      return (
        <div data-pane-id={paneId} data-testid={paneId}>
          {paneTree({
            paneId,
            routeKey: "media:/media/media-1",
            routeHeader: resourceHeader,
            routeShareIdentity: null,
            label: "Media",
            secondaryPane: {
              id: `secondary-${paneId}`,
              parentPrimaryPaneId: paneId,
              groupId: "resource-inspector",
              activeSurfaceId: "resource-contents",
              widthPx: 360,
              visibility: "visible",
            },
            secondarySizing: {
              widthPx: 360,
              minWidthPx: 280,
              maxWidthPx: 720,
              storedWidthCorrectionPx: null,
            },
            secondaryPublication,
            children: (
              <PrimaryChromeProbe
                publication={{
                  ...readyResource("Computing Machinery"),
                  actions: [
                    {
                      kind: "command",
                      id: "resource-inspector-companion",
                      label: "Companion",
                      icon: <span aria-hidden="true">map</span>,
                      state: {
                        kind: "disclosure",
                        expanded: true,
                        controls: secondaryRegionId,
                        menuLabels: {
                          collapsed: "Show Companion",
                          expanded: "Hide Companion",
                        },
                      },
                      onSelect: vi.fn(),
                    },
                  ],
                  menu: resourceMenu([
                    {
                      kind: "command",
                      id: "credits",
                      label: "Credits…",
                      onSelect: vi.fn(),
                    },
                  ]),
                }}
              />
            ),
          })}
        </div>
      );
    };

    render(
      <>
        {concurrentPane("pane-a")}
        {concurrentPane("pane-b")}
      </>,
    );

    const headings = await screen.findAllByRole("heading", {
      level: 1,
      name: "Computing Machinery",
    });
    expect(headings).toHaveLength(2);
    expect(headings[0]?.id).not.toBe(headings[1]?.id);

    expect(screen.getAllByTestId("pane-shell-root")).toHaveLength(2);
    for (const paneId of ["pane-a", "pane-b"] as const) {
      const scoped = within(screen.getByTestId(paneId));
      expect(
        scoped.getAllByRole("heading", {
          level: 1,
          name: "Computing Machinery",
        }),
      ).toHaveLength(1);
      expect(scoped.getAllByRole("button", { name: "Companion" })).toHaveLength(
        1,
      );
      expect(scoped.getAllByRole("button", { name: "Options" })).toHaveLength(
        1,
      );

      const secondaryRegion = scoped.getByTestId("workspace-secondary-pane");
      const secondaryRegionId = paneSecondaryRegionId(
        paneId,
        "resource-inspector",
      );
      expect(secondaryRegion).toHaveAttribute("id", secondaryRegionId);
      expect(scoped.getByRole("button", { name: "Companion" })).toHaveAttribute(
        "aria-controls",
        secondaryRegionId,
      );
    }
    expect(paneSecondaryRegionId("pane-a", "resource-inspector")).not.toBe(
      paneSecondaryRegionId("pane-b", "resource-inspector"),
    );
  });

  it("retains a controlled desktop secondary region until its disclosure publication collapses", async () => {
    const secondaryRegionId = paneSecondaryRegionId(
      "pane-a",
      "resource-inspector",
    );
    const props: Partial<PaneProps> = {
      routeHeader: sectionHeader,
      label: "Reader",
      secondarySizing: {
        widthPx: 360,
        minWidthPx: 280,
        maxWidthPx: 720,
        storedWidthCorrectionPx: null,
      },
      secondaryPublication: {
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-contents",
        surfaces: [
          {
            id: "resource-contents",
            body: <div>Contents secondary</div>,
          },
        ],
      },
    };
    const expandedPublication: PanePrimaryChromePublication = {
      actions: [
        {
          kind: "command",
          id: "resource-inspector-companion",
          label: "Companion",
          icon: <span aria-hidden="true">map</span>,
          state: {
            kind: "disclosure",
            expanded: true,
            controls: secondaryRegionId,
            menuLabels: {
              collapsed: "Show Companion",
              expanded: "Hide Companion",
            },
          },
          onSelect: vi.fn(),
        },
      ],
    };
    const collapsedPublication: PanePrimaryChromePublication = {
      actions: [
        {
          kind: "command",
          id: "resource-inspector-companion",
          label: "Companion",
          icon: <span aria-hidden="true">map</span>,
          state: {
            kind: "disclosure",
            expanded: false,
            menuLabels: {
              collapsed: "Show Companion",
              expanded: "Hide Companion",
            },
          },
          onSelect: vi.fn(),
        },
      ],
    };
    const secondaryPane = (visibility: "visible" | "collapsed") => ({
      id: "secondary-a",
      parentPrimaryPaneId: "pane-a",
      groupId: "resource-inspector" as const,
      activeSurfaceId: "resource-contents" as const,
      widthPx: 360,
      visibility,
    });
    const { rerender } = render(
      paneTree({
        ...props,
        secondaryPane: secondaryPane("visible"),
        children: <PrimaryChromeProbe publication={expandedPublication} />,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-secondary-pane")).toHaveAttribute(
        "id",
        secondaryRegionId,
      );
      expect(screen.getByRole("button", { name: "Companion" })).toHaveAttribute(
        "aria-controls",
        secondaryRegionId,
      );
    });

    rerender(
      paneTree({
        ...props,
        secondaryPane: secondaryPane("collapsed"),
        children: <PrimaryChromeProbe publication={expandedPublication} />,
      }),
    );
    expect(screen.getByTestId("workspace-secondary-pane")).toHaveAttribute(
      "id",
      secondaryRegionId,
    );

    rerender(
      paneTree({
        ...props,
        secondaryPublication: null,
        secondaryPane: secondaryPane("collapsed"),
        children: <PrimaryChromeProbe publication={expandedPublication} />,
      }),
    );
    expect(screen.queryByTestId("workspace-secondary-pane")).toBeNull();
    expect(screen.queryByRole("button", { name: "Companion" })).toBeNull();

    rerender(
      paneTree({
        ...props,
        secondaryPane: secondaryPane("collapsed"),
        children: <PrimaryChromeProbe publication={collapsedPublication} />,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-secondary-pane")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Companion" }),
      ).not.toHaveAttribute("aria-controls");
    });
  });

  it("keeps resize and pane navigation behavior with typed header identity", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      paneTree({
        onResizePrimaryPane,
        sizing: paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 }),
      }),
    );

    const handle = screen.getByRole("separator", {
      name: "Resize pane Libraries",
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.click(
      screen.getByRole("button", { name: "Go back in this pane" }),
      { detail: 1 },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Go forward in this pane" }),
    );

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 576);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 320);
    expect(runtimeNavigation.back).toHaveBeenCalledWith("pane-a", "Pointer");
    expect(runtimeNavigation.forward).toHaveBeenCalledWith(
      "pane-a",
      "Keyboard",
    );
  });
});
