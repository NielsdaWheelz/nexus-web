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
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";

const mobileChromeMock = vi.hoisted(() => ({
  setPaneChrome: vi.fn(),
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

const disabledNavigation = {
  canGoBack: false,
  canGoForward: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
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
  href: "/libraries",
  label: "Libraries",
  navigation: disabledNavigation,
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
    <PaneRuntimeProvider
      paneId={paneId}
      isActive
      href="/media/media-1"
      routeId="media"
      routeKey={routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
    >
      {children}
    </PaneRuntimeProvider>
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
      id: "document-map",
      label: "Document Map",
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
      name: "Document Map",
    });
    fireEvent.click(mapButton);
    expect(onMap).toHaveBeenCalledWith({ triggerEl: mapButton });

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim()),
    ).toEqual(["Copy pane link", "Credits…"]);
    expect(
      within(menu).queryByRole("menuitem", { name: "Document Map" }),
    ).not.toBeInTheDocument();
  });

  it("lifts primary actions into the active mobile Options projection", async () => {
    const mapAction = {
      kind: "command",
      id: "document-map",
      label: "Document Map",
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
              actions: [mapAction],
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
          options: expect.any(Array),
        }),
      );
    });
    const publication = mobileChromeMock.setPaneChrome.mock.calls
      .map(([value]) => value)
      .findLast((value) => value !== null);
    expect(
      publication?.options.map((option: ActionDescriptor) => option.label),
    ).toEqual(["Document Map", "Copy pane link", "Credits…"]);
    expect(screen.queryByRole("button", { name: "Document Map" })).toBeNull();
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
      groupId: "reader-tools",
      defaultSurfaceId: "reader-contents",
      surfaces: [
        {
          id: "reader-contents",
          body: <div>Contents secondary</div>,
        },
      ],
    } satisfies NonNullable<PaneProps["secondaryPublication"]>;
    const concurrentPane = (paneId: "pane-a" | "pane-b") => {
      const secondaryRegionId = paneSecondaryRegionId(paneId, "reader-tools");
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
              groupId: "reader-tools",
              activeSurfaceId: "reader-contents",
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
                      id: "document-map",
                      label: "Document Map",
                      icon: <span aria-hidden="true">map</span>,
                      state: {
                        kind: "disclosure",
                        expanded: true,
                        controls: secondaryRegionId,
                        menuLabels: {
                          collapsed: "Show Document Map",
                          expanded: "Hide Document Map",
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
        scoped.getAllByRole("button", { name: "Document Map" }),
      ).toHaveLength(1);
      expect(scoped.getAllByRole("button", { name: "Options" })).toHaveLength(
        1,
      );

      const secondaryRegion = scoped.getByTestId("workspace-secondary-pane");
      const secondaryRegionId = paneSecondaryRegionId(paneId, "reader-tools");
      expect(secondaryRegion).toHaveAttribute("id", secondaryRegionId);
      expect(
        scoped.getByRole("button", { name: "Document Map" }),
      ).toHaveAttribute("aria-controls", secondaryRegionId);
    }
    expect(paneSecondaryRegionId("pane-a", "reader-tools")).not.toBe(
      paneSecondaryRegionId("pane-b", "reader-tools"),
    );
  });

  it("retains a controlled desktop secondary region until its disclosure publication collapses", async () => {
    const secondaryRegionId = paneSecondaryRegionId("pane-a", "reader-tools");
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
        groupId: "reader-tools",
        defaultSurfaceId: "reader-contents",
        surfaces: [
          {
            id: "reader-contents",
            body: <div>Contents secondary</div>,
          },
        ],
      },
    };
    const expandedPublication: PanePrimaryChromePublication = {
      actions: [
        {
          kind: "command",
          id: "document-map",
          label: "Document Map",
          icon: <span aria-hidden="true">map</span>,
          state: {
            kind: "disclosure",
            expanded: true,
            controls: secondaryRegionId,
            menuLabels: {
              collapsed: "Show Document Map",
              expanded: "Hide Document Map",
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
          id: "document-map",
          label: "Document Map",
          icon: <span aria-hidden="true">map</span>,
          state: {
            kind: "disclosure",
            expanded: false,
            menuLabels: {
              collapsed: "Show Document Map",
              expanded: "Hide Document Map",
            },
          },
          onSelect: vi.fn(),
        },
      ],
    };
    const secondaryPane = (visibility: "visible" | "collapsed") => ({
      id: "secondary-a",
      parentPrimaryPaneId: "pane-a",
      groupId: "reader-tools" as const,
      activeSurfaceId: "reader-contents" as const,
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
        screen.getByRole("button", { name: "Document Map" }),
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
      screen.queryByRole("button", { name: "Document Map" }),
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
        screen.getByRole("button", { name: "Document Map" }),
      ).not.toHaveAttribute("aria-controls");
    });
  });

  it("keeps resize and pane navigation behavior with typed header identity", () => {
    const onResizePrimaryPane = vi.fn();
    const navigation = {
      canGoBack: true,
      canGoForward: true,
      onBack: vi.fn(),
      onForward: vi.fn(),
    };
    render(
      paneTree({
        navigation,
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
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Go forward in this pane" }),
    );

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 576);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 320);
    expect(navigation.onBack).toHaveBeenCalledTimes(1);
    expect(navigation.onForward).toHaveBeenCalledTimes(1);
  });
});
