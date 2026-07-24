import { Component, type ComponentProps, type ReactNode } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneShell from "@/components/workspace/PaneShell";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { paneSecondaryRegionId } from "@/lib/panes/paneSecondaryModel";
import type {
  ActionDescriptor,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { routeShareTarget } from "@/lib/sharing/targets";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

const mobileChromeMock = vi.hoisted(() => ({
  setPaneChrome: vi.fn(),
}));
const shareControllerMock = vi.hoisted(() => ({
  openShare: vi.fn(),
}));

vi.mock("@/lib/workspace/mobileChrome", () => ({
  useMobileChrome: () => ({
    hidden: false,
    paneChrome: null,
    setPaneChrome: mobileChromeMock.setPaneChrome,
    onDocumentScroll: () => {},
    acquireVisibleLock: () => () => {},
  }),
  usePaneMobileChromeController: () => ({
    onDocumentScroll: () => {},
    acquireVisibleLock: () => () => {},
  }),
}));

vi.mock("@/lib/sharing/controller", () => ({
  useShareController: () => shareControllerMock,
}));

const runtimeNavigation = {
  back: vi.fn(),
  forward: vi.fn(),
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

const defaultPaneProps = {
  paneId: "pane-a",
  routeKey: "media:/media/media-1",
  routeHeader: sectionHeader,
  shareIdentity: routeShareTarget({ href: "/libraries", label: "Libraries" }),
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
}: {
  readonly children: ReactNode;
  readonly routeKey: string;
  readonly paneId?: string;
}) {
  return (
    <PaneReturnMementoProvider>
      <PaneRuntimeProvider
        paneId={paneId}
        visitId={TEST_VISIT_ID}
        isActive
        href="/media/media-1"
        routeId="media"
        routeKey={routeKey}
        canGoBack
        canGoForward
        onGoBackPane={runtimeNavigation.back}
        onGoForwardPane={runtimeNavigation.forward}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
      >
        {children}
      </PaneRuntimeProvider>
    </PaneReturnMementoProvider>
  );
}

function paneTree(overrides: Partial<PaneProps> = {}) {
  const { children = <div>Body content</div>, ...paneOverrides } = overrides;
  const props: PaneProps = {
    ...defaultPaneProps,
    ...paneOverrides,
    children,
  };
  return (
    <RuntimeRoute paneId={props.paneId} routeKey={props.routeKey}>
      <PaneShell {...props} />
    </RuntimeRoute>
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PaneShell", () => {
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
        label: "Media",
        children: (
          <PrimaryChromeProbe
            publication={{
              ...readyResource("Document title"),
              actions: [mapAction],
              options: [creditsOption],
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
    ).toEqual(["Share…", "Credits…"]);
    expect(
      within(menu).getAllByRole("menuitem", { name: "Share…" }),
    ).toHaveLength(1);
    expect(
      within(menu).queryByRole("menuitem", { name: "Companion" }),
    ).not.toBeInTheDocument();
  });

  it("publishes primary actions separately from mobile Options", async () => {
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
        label: "Media",
        isMobile: true,
        children: (
          <PrimaryChromeProbe
            publication={{
              ...readyResource("Document title"),
              actions: [companion],
              options: [
                {
                  kind: "command",
                  id: "credits",
                  label: "Credits…",
                  onSelect: vi.fn(),
                },
              ],
            }}
          />
        ),
      }),
    );

    await waitFor(() => {
      expect(mobileChromeMock.setPaneChrome).toHaveBeenCalledWith(
        expect.objectContaining({
          paneId: "pane-a",
          header: expect.objectContaining({ kind: "resource" }),
          actions: expect.any(Array),
          options: expect.any(Array),
        }),
      );
    });
    const publication = mobileChromeMock.setPaneChrome.mock.calls
      .map(([value]) => value)
      .findLast((value) => value !== null);
    expect(publication?.actions.map((action: PaneHeaderAction) => action.label)).toEqual([
      "Companion",
    ]);
    expect(
      publication?.options.map((option: ActionDescriptor) => option.label),
    ).toEqual(["Share…", "Credits…"]);
    expect(
      publication?.options.filter(
        (option: ActionDescriptor) => option.id === "share",
      ),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Companion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
  });

  it("does not republish equivalent mobile chrome after an unrelated render", async () => {
    const mobilePane = {
      routeHeader: resourceHeader,
      label: "Media",
      isMobile: true,
    } satisfies Partial<PaneProps>;
    const view = render(paneTree(mobilePane));

    await waitFor(() => {
      expect(mobileChromeMock.setPaneChrome).toHaveBeenCalledTimes(1);
    });
    const firstPublication = mobileChromeMock.setPaneChrome.mock.calls[0]?.[0];

    view.rerender(paneTree(mobilePane));
    await Promise.resolve();

    expect(mobileChromeMock.setPaneChrome).toHaveBeenCalledTimes(1);
    expect(mobileChromeMock.setPaneChrome.mock.calls[0]?.[0]).toBe(
      firstPublication,
    );
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
      const secondaryRegionId = paneSecondaryRegionId(paneId, "resource-inspector");
      return (
        <div data-pane-id={paneId} data-testid={paneId}>
          {paneTree({
            paneId,
            routeKey: "media:/media/media-1",
            routeHeader: resourceHeader,
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
                  options: [
                    {
                      kind: "command",
                      id: "credits",
                      label: "Credits…",
                      onSelect: vi.fn(),
                    },
                  ],
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
      expect(
        scoped.getAllByRole("button", { name: "Companion" }),
      ).toHaveLength(1);
      expect(scoped.getAllByRole("button", { name: "Options" })).toHaveLength(
        1,
      );

      const secondaryRegion = scoped.getByTestId("workspace-secondary-pane");
      const secondaryRegionId = paneSecondaryRegionId(paneId, "resource-inspector");
      expect(secondaryRegion).toHaveAttribute("id", secondaryRegionId);
      expect(
        scoped.getByRole("button", { name: "Companion" }),
      ).toHaveAttribute("aria-controls", secondaryRegionId);
    }
    expect(paneSecondaryRegionId("pane-a", "resource-inspector")).not.toBe(
      paneSecondaryRegionId("pane-b", "resource-inspector"),
    );
  });

  it("retains a controlled desktop secondary region until its disclosure publication collapses", async () => {
    const secondaryRegionId = paneSecondaryRegionId("pane-a", "resource-inspector");
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
      expect(
        screen.getByRole("button", { name: "Companion" }),
      ).toHaveAttribute("aria-controls", secondaryRegionId);
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
    expect(
      screen.queryByRole("button", { name: "Companion" }),
    ).toBeNull();

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
