import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  PaneRuntimeProvider,
  usePaneRuntime,
  usePaneRouter,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type { PaneViewTransitionIntent } from "@/lib/ui/viewTransitions";

const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const LIBRARY_ID = "33333333-3333-4333-8333-333333333333";
const MEDIA_HREF_1 = `/media/${MEDIA_ID_1}`;
const LIBRARY_HREF = `/libraries/${LIBRARY_ID}`;

function Publisher({ title }: { title: string }) {
  useSetPaneTitle(title);
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
    router[action](MEDIA_HREF_1, { titleHint: "Library Row Title", viewTransition });
  }, [action, router, viewTransition]);
  return null;
}

function OpenInNewPaneOnMount() {
  const runtime = usePaneRuntime();
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.openInNewPane(
      MEDIA_HREF_1,
      "Library Row Title",
      "reader-evidence",
    );
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
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.requestSecondarySurface("reader-evidence");
    runtime.setSecondarySurface("reader-evidence");
    runtime.closeSecondaryPane();
  }, [runtime]);
  return null;
}

function RuntimeShapeProbe({ onValue }: { onValue: (value: unknown) => void }) {
  const runtime = usePaneRuntime();
  useEffect(() => {
    onValue(runtime);
  }, [onValue, runtime]);
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
  onSetPaneTitle: (input: {
    paneId: string;
    routeKey: string;
    title: string | null;
  }) => void,
) {
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      isActive={true}
      href={href}
      routeId={identity.routeId}
      routeKey={identity.routeKey}
      {...defaultNavigationProps}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
      onSetPaneTitle={onSetPaneTitle}
    >
      <Publisher title="Same title" />
    </PaneRuntimeProvider>
  );
}

describe("useSetPaneTitle", () => {
  it("does not republish the same title for the same route key", async () => {
    const onSetPaneTitle = vi.fn();
    const { rerender } = render(runtime(MEDIA_HREF_1, onSetPaneTitle));

    await waitFor(() => expect(onSetPaneTitle).toHaveBeenCalledTimes(1));

    rerender(runtime(MEDIA_HREF_1, onSetPaneTitle));

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onSetPaneTitle).toHaveBeenCalledTimes(1);
  });

  it("publishes again when the route key changes even if the title string matches", async () => {
    const onSetPaneTitle = vi.fn();
    const { rerender } = render(runtime(MEDIA_HREF_1, onSetPaneTitle));

    await waitFor(() => expect(onSetPaneTitle).toHaveBeenCalledTimes(1));

    const nextHref = `${MEDIA_HREF_1}?loc=chapter-2`;
    rerender(runtime(nextHref, onSetPaneTitle));

    await waitFor(() => expect(onSetPaneTitle).toHaveBeenCalledTimes(2));
    expect(onSetPaneTitle).toHaveBeenLastCalledWith({
      paneId: "pane-1",
      routeKey: resolvePaneRouteIdentity(nextHref).routeKey,
      title: "Same title",
    });
  });
});

describe("PaneRuntimeProvider", () => {
  it.each([
    ["push", "onNavigatePane"],
    ["replace", "onReplacePane"],
  ] as const)("passes title hints through router.%s", async (action, callbackName) => {
    const onNavigatePane = vi.fn();
    const onReplacePane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={onNavigatePane}
        onReplacePane={onReplacePane}
        onOpenInNewPane={vi.fn()}
      >
        <NavigateOnMount action={action} />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect({ onNavigatePane, onReplacePane }[callbackName]).toHaveBeenCalledWith(
        "pane-1",
        MEDIA_HREF_1,
        { titleHint: "Library Row Title" },
      );
    });
  });

  it("passes title hints through openInNewPane", async () => {
    const onOpenInNewPane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={onOpenInNewPane}
      >
        <OpenInNewPaneOnMount />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onOpenInNewPane).toHaveBeenCalledWith(
        MEDIA_HREF_1,
        "Library Row Title",
        "reader-evidence",
      );
    });
  });

  it("wraps explicit collection reflow navigation in a same-document View Transition", async () => {
    const startViewTransition = installStartViewTransition();
    installMatchMedia(false);
    const onReplacePane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={onReplacePane}
        onOpenInNewPane={vi.fn()}
      >
        <NavigateOnMount action="replace" viewTransition={{ kind: "collection-reflow" }} />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(startViewTransition).toHaveBeenCalledOnce();
      expect(onReplacePane).toHaveBeenCalledWith("pane-1", MEDIA_HREF_1, {
        titleHint: "Library Row Title",
      });
    });
  });

  it("runs explicit transition navigation directly under reduced motion", async () => {
    const startViewTransition = installStartViewTransition();
    installMatchMedia(true);
    const onReplacePane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={onReplacePane}
        onOpenInNewPane={vi.fn()}
      >
        <NavigateOnMount action="replace" viewTransition={{ kind: "collection-reflow" }} />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(startViewTransition).not.toHaveBeenCalled();
      expect(onReplacePane).toHaveBeenCalledWith("pane-1", MEDIA_HREF_1, {
        titleHint: "Library Row Title",
      });
    });
  });

  it("exposes pane Back and Forward through the scoped router", async () => {
    const onGoBackPane = vi.fn();
    const onGoForwardPane = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
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
        onOpenInNewPane={vi.fn()}
      >
        <GoBackForwardOnMount />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onGoBackPane).toHaveBeenCalledWith("pane-1");
      expect(onGoForwardPane).toHaveBeenCalledWith("pane-1");
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
      isActive: true,
      href: LIBRARY_HREF,
      routeId: identity.routeId,
      routeKey: identity.routeKey,
      ...defaultNavigationProps,
      onNavigatePane: vi.fn(),
      onReplacePane: vi.fn(),
      onOpenInNewPane: vi.fn(),
    };

    const { rerender } = render(
      <PaneRuntimeProvider {...stableProps} pathParams={{ id: LIBRARY_ID }}>
        <RouterIdentityProbe onRouter={onRouter} />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => expect(onRouter).toHaveBeenCalledTimes(1));

    rerender(
      <PaneRuntimeProvider {...stableProps} pathParams={{ id: LIBRARY_ID }}>
        <RouterIdentityProbe onRouter={onRouter} />
      </PaneRuntimeProvider>,
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onRouter).toHaveBeenCalledTimes(1);
  });

  it("keeps scoped router commands stable across navigation state changes", async () => {
    const onRouter = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);
    const stableProps = {
      paneId: "pane-1",
      isActive: true,
      href: LIBRARY_HREF,
      routeId: identity.routeId,
      routeKey: identity.routeKey,
      onNavigatePane: vi.fn(),
      onReplacePane: vi.fn(),
      onOpenInNewPane: vi.fn(),
      onGoBackPane: vi.fn(),
      onGoForwardPane: vi.fn(),
    };

    const { rerender } = render(
      <PaneRuntimeProvider
        {...stableProps}
        canGoBack={false}
        canGoForward={false}
      >
        <RouterStateProbe onRouter={onRouter} />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => expect(onRouter).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("router-state")).toHaveAttribute("data-can-go-back", "false");
    expect(screen.getByTestId("router-state")).toHaveAttribute(
      "data-can-go-forward",
      "false",
    );

    rerender(
      <PaneRuntimeProvider
        {...stableProps}
        canGoBack
        canGoForward
      >
        <RouterStateProbe onRouter={onRouter} />
      </PaneRuntimeProvider>,
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
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onSetPaneLayout={onSetPaneLayout}
      >
        <PublishLayoutOnMount />
      </PaneRuntimeProvider>,
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
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={MEDIA_HREF_1}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        secondaryPane={{
          id: "secondary-1",
          parentPrimaryPaneId: "pane-1",
          groupId: "reader-tools",
          activeSurfaceId: "reader-evidence",
          widthPx: 360,
          visibility: "visible",
        }}
        onRequestSecondarySurface={onRequestSecondarySurface}
        onCloseSecondaryPane={onCloseSecondaryPane}
        onSetSecondarySurface={onSetSecondarySurface}
      >
        <SecondaryCommandsOnMount />
      </PaneRuntimeProvider>,
    );

    await waitFor(() => {
      expect(onRequestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "reader-evidence",
      );
      expect(onSetSecondarySurface).toHaveBeenCalledWith(
        "secondary-1",
        "reader-evidence",
      );
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
    });
  });

  it("does not expose removed pane width setters", async () => {
    const onValue = vi.fn();
    const identity = resolvePaneRouteIdentity(LIBRARY_HREF);

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={LIBRARY_HREF}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
      >
        <RuntimeShapeProbe onValue={onValue} />
      </PaneRuntimeProvider>,
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
    expect(runtimeValue[`setPane${"Min"}Width`]).toBeUndefined();
    expect(runtimeValue[`setPane${"Extra"}Width`]).toBeUndefined();
  });
});
