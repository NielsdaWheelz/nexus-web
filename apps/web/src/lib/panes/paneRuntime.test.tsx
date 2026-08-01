import {
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  PaneRuntimeProvider,
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneIsActive,
  usePaneRuntime,
  usePaneRouter,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import type { PaneViewTransitionIntent } from "@/lib/ui/viewTransitions";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { PaneEntryDelivery } from "@/lib/workspace/targetActivation";

const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const LIBRARY_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_HREF_1 = `/media/${MEDIA_ID_1}`;
const LIBRARY_HREF = `/libraries/${LIBRARY_ID}`;
const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);
const PANE_ENTRY_A: PaneEntryDelivery = {
  activationId: "activation-a",
  paneId: "pane-1",
  visitId: TEST_VISIT_ID,
  entry: {
    kind: "AppendNote",
    noteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    clientMutationId: "mutation-a",
    initialText: "Alpha",
  },
};
const PANE_ENTRY_B: PaneEntryDelivery = {
  activationId: "activation-b",
  paneId: "pane-1",
  visitId: TEST_VISIT_ID,
  entry: {
    kind: "AppendNote",
    noteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    clientMutationId: "mutation-b",
    initialText: "Beta",
  },
};

it("keeps a missing required pane runtime as an owner defect", () => {
  expect(() => requirePaneRuntime(null, "LibraryPaneBody")).toThrow(
    "LibraryPaneBody requires a pane runtime",
  );
});

function TestPaneRuntimeProvider(
  props: ComponentProps<typeof PaneRuntimeProvider>,
) {
  return (
    <PaneReturnMementoProvider>
      <PaneRuntimeProvider {...props} />
    </PaneReturnMementoProvider>
  );
}

function Publisher({ label }: { label: string }) {
  useSetPaneLabel(label);
  return null;
}

const ORIGINAL_START_VIEW_TRANSITION = (
  document as Document & { startViewTransition?: unknown }
).startViewTransition;
const ORIGINAL_MATCH_MEDIA = window.matchMedia;

function NavigateOnMount({
  action,
  viewTransition,
}: {
  action: "push" | "replace";
  viewTransition?: PaneViewTransitionIntent;
}) {
  const router = usePaneRouter();
  useEffect(() => {
    router[action](MEDIA_HREF_1, { labelHint: "Library Row Label", viewTransition });
  }, [action, router, viewTransition]);
  return null;
}

function ActivateForkOnMount() {
  const runtime = usePaneRuntime();
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.activateTarget({
      target: {
        href: MEDIA_HREF_1,
        labelHint: "Library Row Label",
        secondaryActivation: { kind: "Surface", surfaceId: "resource-evidence" },
      },
      disposition: { kind: "Fork" },
    });
  }, [runtime]);
  return null;
}

function PublishLayoutOnMount() {
  const runtime = usePaneRuntime();
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.setPaneLayout({
      primaryWidth: { kind: "intrinsic", widthPx: 640 },
    });
  }, [runtime]);
  return null;
}

function SecondaryCommandsOnMount() {
  const runtime = usePaneRuntime();
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.requestSecondarySurface("resource-evidence", {
      returnFocusTo: triggerRef.current,
    });
    runtime.setSecondarySurface("resource-evidence");
    runtime.closeSecondaryPane();
  }, [runtime]);
  return <button ref={triggerRef}>Options</button>;
}

function TransientSecondaryCommandsOnMount() {
  const runtime = usePaneRuntime();
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.requestTransientSecondarySurface("resource-search", {
      returnFocusTo: triggerRef.current,
    });
    runtime.previewTransientSecondaryResult();
    runtime.closeTransientSecondarySurface();
  }, [runtime]);
  return <button ref={triggerRef}>Show results</button>;
}

function RuntimeShapeProbe({ onValue }: { onValue: (value: unknown) => void }) {
  const runtime = usePaneRuntime();
  useEffect(() => {
    onValue(runtime);
  }, [onValue, runtime]);
  return null;
}

function RuntimeActivityProbe({
  onRuntime,
  onActivity,
}: {
  onRuntime: (value: unknown) => void;
  onActivity: (value: boolean) => void;
}) {
  const runtime = usePaneRuntime();
  const isActive = usePaneIsActive();
  useEffect(() => {
    onRuntime(runtime);
  }, [onRuntime, runtime]);
  useEffect(() => {
    onActivity(isActive);
  }, [isActive, onActivity]);
  return null;
}

function PaneEntryProbe({
  onValue,
}: {
  onValue: (value: {
    delivery: PaneEntryDelivery;
    acknowledge: () => void;
  }) => void;
}) {
  const { delivery, acknowledge } = usePaneEntryDelivery();
  useEffect(() => {
    if (delivery) {
      onValue({
        delivery,
        acknowledge: () => acknowledge(delivery),
      });
    }
  }, [acknowledge, delivery, onValue]);
  return null;
}

function RouterIdentityProbe({ onRouter }: { onRouter: (value: unknown) => void }) {
  const router = usePaneRouter();
  useEffect(() => {
    onRouter(router);
  }, [onRouter, router]);
  return null;
}

function RouterStateProbe({ onRouter }: { onRouter: (value: unknown) => void }) {
  const router = usePaneRouter();
  useEffect(() => {
    onRouter(router);
  }, [onRouter, router]);
  return (
    <div
      data-testid="router-state"
      data-can-go-back={router.canGoBack ? "true" : "false"}
      data-can-go-forward={router.canGoForward ? "true" : "false"}
    />
  );
}

function GoBackForwardOnMount() {
  const router = usePaneRouter();
  useEffect(() => {
    router.back();
    router.forward();
  }, [router]);
  return (
    <div
      data-testid="router-navigation-state"
      data-can-go-back={router.canGoBack ? "true" : "false"}
      data-can-go-forward={router.canGoForward ? "true" : "false"}
    />
  );
}

const defaultNavigationProps = {
  canGoBack: false,
  canGoForward: false,
  onGoBackPane: vi.fn(),
  onGoForwardPane: vi.fn(),
  onActivateWorkspaceTarget: vi.fn(),
};

function installStartViewTransition() {
  const startViewTransition = vi.fn((callback: () => void | Promise<void>) => {
    const done = Promise.resolve().then(callback).then(() => undefined);
    return {
      ready: done,
      updateCallbackDone: done,
      finished: done,
      skipTransition: vi.fn(),
    };
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: startViewTransition,
  });
  return startViewTransition;
}

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  if (ORIGINAL_START_VIEW_TRANSITION === undefined) {
    Reflect.deleteProperty(document, "startViewTransition");
  } else {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: ORIGINAL_START_VIEW_TRANSITION,
    });
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
});

function runtime(
  href: string,
  onSetPaneLabel: (input: {
    paneId: string;
    routeKey: string;
    label: string | null;
  }) => void,
) {
  const identity = resolvePaneRouteIdentity(href);
  return (
    <TestPaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive={true}
      href={href}
      routeId={identity.routeId}
      routeKey={identity.routeKey}
      {...defaultNavigationProps}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onSetPaneLabel={onSetPaneLabel}
    >
      <Publisher label="Same label" />
    </TestPaneRuntimeProvider>
  );
}

function paneEntryRuntime(
  delivery: PaneEntryDelivery,
  children: ReactNode,
  onAcknowledgePaneEntryDelivery: (delivery: PaneEntryDelivery) => void,
) {
  const identity = resolvePaneRouteIdentity(LIBRARY_HREF);
  return (
    <TestPaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive
      href={LIBRARY_HREF}
      routeId={identity.routeId}
      routeKey={identity.routeKey}
      {...defaultNavigationProps}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      paneEntryDelivery={delivery}
      onAcknowledgePaneEntryDelivery={onAcknowledgePaneEntryDelivery}
    >
      {children}
    </TestPaneRuntimeProvider>
  );
}

describe("useSetPaneLabel", () => {
  it("does not republish the same label for the same route key", async () => {
    const onSetPaneLabel = vi.fn();
    const { rerender } = render(runtime(MEDIA_HREF_1, onSetPaneLabel));

    await waitFor(() => expect(onSetPaneLabel).toHaveBeenCalledTimes(1));

    rerender(runtime(MEDIA_HREF_1, onSetPaneLabel));

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onSetPaneLabel).toHaveBeenCalledTimes(1);
  });

  it("publishes again when the route key changes even if the label string matches", async () => {
    const onSetPaneLabel = vi.fn();
    const { rerender } = render(runtime(MEDIA_HREF_1, onSetPaneLabel));

    await waitFor(() => expect(onSetPaneLabel).toHaveBeenCalledTimes(1));

    const nextHref = `${MEDIA_HREF_1}?loc=chapter-2`;
    rerender(runtime(nextHref, onSetPaneLabel));

    await waitFor(() => expect(onSetPaneLabel).toHaveBeenCalledTimes(2));
    expect(onSetPaneLabel).toHaveBeenLastCalledWith({
      paneId: "pane-1",
      routeKey: resolvePaneRouteIdentity(nextHref).routeKey,
      label: "Same label",
    });
  });
});

describe("PaneRuntimeProvider", () => {
  it("keeps pane activity changes out of the stable runtime contract", async () => {
    const onRuntime = vi.fn();
    const onActivity = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);
    const pathParams = { id: LIBRARY_ID };
    const stableProps = {
      paneId: "pane-1",
      visitId: TEST_VISIT_ID,
      href: LIBRARY_HREF,
      routeId: identity.routeId,
      routeKey: identity.routeKey,
      pathParams,
      ...defaultNavigationProps,
      onNavigatePane: vi.fn(),
      onReplacePane: vi.fn(),
    };

    const { rerender } = render(
      <TestPaneRuntimeProvider {...stableProps} isActive>
        <RuntimeActivityProbe
          onRuntime={onRuntime}
          onActivity={onActivity}
        />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => expect(onActivity).toHaveBeenCalledWith(true));

    rerender(
      <TestPaneRuntimeProvider {...stableProps} isActive={false}>
        <RuntimeActivityProbe
          onRuntime={onRuntime}
          onActivity={onActivity}
        />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => expect(onActivity).toHaveBeenCalledWith(false));
    expect(onRuntime).toHaveBeenCalledTimes(1);
  });

  it("delivers a queued pane entry when its visit consumer mounts later", async () => {
    const onAcknowledgePaneEntryDelivery = vi.fn();
    const onValue = vi.fn();
    const { rerender } = render(
      paneEntryRuntime(
        PANE_ENTRY_A,
        <div>Pane body loading</div>,
        onAcknowledgePaneEntryDelivery,
      ),
    );

    expect(onValue).not.toHaveBeenCalled();
    rerender(
      paneEntryRuntime(
        PANE_ENTRY_A,
        <PaneEntryProbe onValue={onValue} />,
        onAcknowledgePaneEntryDelivery,
      ),
    );

    await waitFor(() =>
      expect(onValue).toHaveBeenCalledWith(
        expect.objectContaining({ delivery: PANE_ENTRY_A }),
      ),
    );
  });

  it("acknowledges the exact delivery claimed before a newer one arrived", async () => {
    const onAcknowledgePaneEntryDelivery = vi.fn();
    const claims: Array<{
      delivery: PaneEntryDelivery;
      acknowledge: () => void;
    }> = [];
    const onValue = vi.fn((claim: (typeof claims)[number]) => {
      claims.push(claim);
    });
    const { rerender } = render(
      paneEntryRuntime(
        PANE_ENTRY_A,
        <PaneEntryProbe onValue={onValue} />,
        onAcknowledgePaneEntryDelivery,
      ),
    );
    await waitFor(() => expect(claims).toHaveLength(1));

    rerender(
      paneEntryRuntime(
        PANE_ENTRY_B,
        <PaneEntryProbe onValue={onValue} />,
        onAcknowledgePaneEntryDelivery,
      ),
    );
    await waitFor(() => expect(claims).toHaveLength(2));

    claims[0]!.acknowledge();

    expect(onAcknowledgePaneEntryDelivery).toHaveBeenCalledOnce();
    expect(onAcknowledgePaneEntryDelivery).toHaveBeenCalledWith(PANE_ENTRY_A);
  });

  it.each([
    ["push", "onNavigatePane"],
    ["replace", "onReplacePane"],
  ] as const)("passes label hints through router.%s", async (action, callbackName) => {
    const onNavigatePane = vi.fn();
    const onReplacePane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={onNavigatePane}
        onReplacePane={onReplacePane}
      >
        <NavigateOnMount action={action} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect({ onNavigatePane, onReplacePane }[callbackName]).toHaveBeenCalledWith(
        "pane-1",
        MEDIA_HREF_1,
        { labelHint: "Library Row Label", modality: "Programmatic" },
      );
    });
  });

  it("binds origin and modality for target activation", async () => {
    const onActivateWorkspaceTarget = vi.fn(() => ({ kind: "CreatedPane" as const, paneId: "pane-2" }));
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onActivateWorkspaceTarget={onActivateWorkspaceTarget}
      >
        <ActivateForkOnMount />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onActivateWorkspaceTarget).toHaveBeenCalledWith({
        originPaneId: "pane-1",
        target: {
          href: MEDIA_HREF_1,
          labelHint: "Library Row Label",
          secondaryActivation: { kind: "Surface", surfaceId: "resource-evidence" },
        },
        disposition: { kind: "Fork" },
        modality: "Programmatic",
      });
    });
  });

  it("wraps explicit collection reflow navigation in a same-document View Transition", async () => {
    const startViewTransition = installStartViewTransition();
    installMatchMedia(false);
    const onReplacePane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={onReplacePane}
      >
        <NavigateOnMount action="replace" viewTransition={{ kind: "collection-reflow" }} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(startViewTransition).toHaveBeenCalledOnce();
      expect(onReplacePane).toHaveBeenCalledWith("pane-1", MEDIA_HREF_1, {
        labelHint: "Library Row Label",
        modality: "Programmatic",
      });
    });
  });

  it("runs explicit transition navigation directly under reduced motion", async () => {
    const startViewTransition = installStartViewTransition();
    installMatchMedia(true);
    const onReplacePane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={onReplacePane}
      >
        <NavigateOnMount action="replace" viewTransition={{ kind: "collection-reflow" }} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(startViewTransition).not.toHaveBeenCalled();
      expect(onReplacePane).toHaveBeenCalledWith("pane-1", MEDIA_HREF_1, {
        labelHint: "Library Row Label",
        modality: "Programmatic",
      });
    });
  });

  it("exposes pane Back and Forward through the scoped router", async () => {
    const onGoBackPane = vi.fn();
    const onGoForwardPane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        canGoBack
        canGoForward
        onGoBackPane={onGoBackPane}
        onGoForwardPane={onGoForwardPane}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onActivateWorkspaceTarget={vi.fn()}
      >
        <GoBackForwardOnMount />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onGoBackPane).toHaveBeenCalledWith("pane-1", "Programmatic");
      expect(onGoForwardPane).toHaveBeenCalledWith("pane-1", "Programmatic");
    });
    const state = screen.getByTestId("router-navigation-state");
    expect(state).toHaveAttribute("data-can-go-back", "true");
    expect(state).toHaveAttribute("data-can-go-forward", "true");
  });

  it("keeps the scoped router stable across unrelated runtime value changes", async () => {
    const onRouter = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);
    const stableProps = {
      paneId: "pane-1",
      visitId: TEST_VISIT_ID,
      isActive: true,
      href: LIBRARY_HREF,
      routeId: identity.routeId,
      routeKey: identity.routeKey,
      ...defaultNavigationProps,
      onNavigatePane: vi.fn(),
      onReplacePane: vi.fn(),
    };

    const { rerender } = render(
      <TestPaneRuntimeProvider {...stableProps} pathParams={{ id: LIBRARY_ID }}>
        <RouterIdentityProbe onRouter={onRouter} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => expect(onRouter).toHaveBeenCalledTimes(1));

    rerender(
      <TestPaneRuntimeProvider {...stableProps} pathParams={{ id: LIBRARY_ID }}>
        <RouterIdentityProbe onRouter={onRouter} />
      </TestPaneRuntimeProvider>,
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onRouter).toHaveBeenCalledTimes(1);
  });

  it("keeps scoped router commands stable across navigation state changes", async () => {
    const onRouter = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);
    const stableProps = {
      paneId: "pane-1",
      visitId: TEST_VISIT_ID,
      isActive: true,
      href: LIBRARY_HREF,
      routeId: identity.routeId,
      routeKey: identity.routeKey,
      onNavigatePane: vi.fn(),
      onReplacePane: vi.fn(),
      onGoBackPane: vi.fn(),
      onGoForwardPane: vi.fn(),
      onActivateWorkspaceTarget: vi.fn(),
    };

    const { rerender } = render(
      <TestPaneRuntimeProvider
        {...stableProps}
        canGoBack={false}
        canGoForward={false}
      >
        <RouterStateProbe onRouter={onRouter} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => expect(onRouter).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("router-state")).toHaveAttribute("data-can-go-back", "false");
    expect(screen.getByTestId("router-state")).toHaveAttribute(
      "data-can-go-forward",
      "false",
    );

    rerender(
      <TestPaneRuntimeProvider
        {...stableProps}
        canGoBack
        canGoForward
      >
        <RouterStateProbe onRouter={onRouter} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("router-state")).toHaveAttribute("data-can-go-back", "true");
    });
    expect(screen.getByTestId("router-state")).toHaveAttribute(
      "data-can-go-forward",
      "true",
    );
    expect(onRouter).toHaveBeenCalledTimes(1);
  });

  it("publishes pane layout with pane and route identity", async () => {
    const onSetPaneLayout = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onSetPaneLayout={onSetPaneLayout}
      >
        <PublishLayoutOnMount />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onSetPaneLayout).toHaveBeenCalledWith({
        paneId: "pane-1",
        routeKey: identity.routeKey,
        layout: {
          primaryWidth: { kind: "intrinsic", widthPx: 640 },
        },
      });
    });
  });

  it("passes secondary commands with pane identity", async () => {
    const onRequestSecondarySurface = vi.fn();
    const onCloseSecondaryPane = vi.fn();
    const onSetSecondarySurface = vi.fn();
    const identity = resolvePaneRouteIdentity(MEDIA_HREF_1);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={MEDIA_HREF_1}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        secondaryPane={{
          id: "secondary-1",
          parentPrimaryPaneId: "pane-1",
          groupId: "resource-inspector",
          activeSurfaceId: "resource-evidence",
          widthPx: 360,
          visibility: "visible",
        }}
        onRequestSecondarySurface={onRequestSecondarySurface}
        onCloseSecondaryPane={onCloseSecondaryPane}
        onSetSecondarySurface={onSetSecondarySurface}
      >
        <SecondaryCommandsOnMount />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onRequestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "resource-evidence",
        screen.getByRole("button", { name: "Options" }),
      );
      expect(onSetSecondarySurface).toHaveBeenCalledWith(
        "secondary-1",
        "resource-evidence",
      );
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
    });
  });

  it("passes route-keyed transient secondary commands and projects expansion", async () => {
    const onRequestTransientSecondarySurface = vi.fn();
    const onPreviewTransientSecondaryResult = vi.fn();
    const onCloseTransientSecondarySurface = vi.fn();
    const onValue = vi.fn();
    const identity = resolvePaneRouteIdentity(MEDIA_HREF_1);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive
        href={MEDIA_HREF_1}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        transientSecondarySurface={{
          id: "resource-search",
          expanded: true,
        }}
        onRequestTransientSecondarySurface={
          onRequestTransientSecondarySurface
        }
        onPreviewTransientSecondaryResult={
          onPreviewTransientSecondaryResult
        }
        onCloseTransientSecondarySurface={onCloseTransientSecondarySurface}
      >
        <RuntimeShapeProbe onValue={onValue} />
        <TransientSecondaryCommandsOnMount />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onRequestTransientSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        identity.routeKey,
        "resource-search",
        screen.getByRole("button", { name: "Show results" }),
      );
      expect(onPreviewTransientSecondaryResult).toHaveBeenCalledWith(
        "pane-1",
        identity.routeKey,
      );
      expect(onCloseTransientSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        identity.routeKey,
      );
    });
    const runtimeValue = onValue.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(runtimeValue.transientSecondarySurface).toEqual({
      id: "resource-search",
      expanded: true,
    });
  });

  it("does not expose removed pane width setters", async () => {
    const onValue = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <TestPaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
      >
        <RuntimeShapeProbe onValue={onValue} />
      </TestPaneRuntimeProvider>,
    );

    await waitFor(() => expect(onValue).toHaveBeenCalled());
    const runtimeValue = onValue.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(runtimeValue.routeKey).toBe(identity.routeKey);
    expect(runtimeValue.resourceItem).toBeNull();
    expect(runtimeValue.resourceRef).toBeNull();
    expect(runtimeValue.resourceKey).toBeNull();
    expect(runtimeValue.resourceStatus).toBe("none");
    expect(runtimeValue[`setPane${"Sizing"}`]).toBeUndefined();
    expect(runtimeValue.setPaneLayout).toEqual(expect.any(Function));
    expect(runtimeValue.requestSecondarySurface).toEqual(expect.any(Function));
    expect(runtimeValue.closeSecondaryPane).toEqual(expect.any(Function));
    expect(runtimeValue.setSecondarySurface).toEqual(expect.any(Function));
    expect(runtimeValue.requestTransientSecondarySurface).toEqual(
      expect.any(Function),
    );
    expect(runtimeValue.closeTransientSecondarySurface).toEqual(
      expect.any(Function),
    );
    expect(runtimeValue.previewTransientSecondaryResult).toEqual(
      expect.any(Function),
    );
    expect(runtimeValue[`setPane${"Min"}Width`]).toBeUndefined();
    expect(runtimeValue[`setPane${"Extra"}Width`]).toBeUndefined();
  });
});
