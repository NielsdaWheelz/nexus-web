import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  PaneRuntimeProvider,
  usePaneRuntime,
  usePaneRouter,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";

function Publisher({ title }: { title: string }) {
  useSetPaneTitle(title);
  return null;
}

function NavigateOnMount({ action }: { action: "push" | "replace" }) {
  const router = usePaneRouter();
  useEffect(() => {
    router[action]("/media/media-1", { titleHint: "Library Row Title" });
  }, [action, router]);
  return null;
}

function OpenInNewPaneOnMount() {
  const runtime = usePaneRuntime();
  useEffect(() => {
    if (!runtime) {
      throw new Error("Pane runtime missing");
    }
    runtime.openInNewPane(
      "/media/media-1",
      "Library Row Title",
      "reader-highlights",
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
    runtime.requestSecondarySurface("reader-highlights");
    runtime.setSecondarySurface("reader-doc-chat");
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

function runtime(
  href: string,
  onSetPaneTitle: (input: {
    paneId: string;
    resourceKey: string;
    title: string | null;
  }) => void,
) {
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId={identity.routeId}
      resourceRef={identity.resourceRef}
      resourceKey={identity.resourceKey}
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
  it("does not republish the same title for the same resource", async () => {
    const onSetPaneTitle = vi.fn();
    const { rerender } = render(runtime("/media/media-1", onSetPaneTitle));

    await waitFor(() => expect(onSetPaneTitle).toHaveBeenCalledTimes(1));

    rerender(runtime("/media/media-1?loc=chapter-2", onSetPaneTitle));

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(onSetPaneTitle).toHaveBeenCalledTimes(1);
  });

  it("publishes again when the resource changes even if the title string matches", async () => {
    const onSetPaneTitle = vi.fn();
    const { rerender } = render(runtime("/media/media-1", onSetPaneTitle));

    await waitFor(() => expect(onSetPaneTitle).toHaveBeenCalledTimes(1));

    rerender(runtime("/media/media-2", onSetPaneTitle));

    await waitFor(() => expect(onSetPaneTitle).toHaveBeenCalledTimes(2));
    expect(onSetPaneTitle).toHaveBeenLastCalledWith({
      paneId: "pane-1",
      resourceKey: resolvePaneRouteIdentity("/media/media-2").resourceKey,
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
    const identity = resolvePaneRouteIdentity("/libraries/library-1");

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/libraries/library-1"
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
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
        "/media/media-1",
        { titleHint: "Library Row Title" },
      );
    });
  });

  it("passes title hints through openInNewPane", async () => {
    const onOpenInNewPane = vi.fn();
    const identity = resolvePaneRouteIdentity("/libraries/library-1");

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/libraries/library-1"
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
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
        "/media/media-1",
        "Library Row Title",
        "reader-highlights",
      );
    });
  });

  it("exposes pane Back and Forward through the scoped router", async () => {
    const onGoBackPane = vi.fn();
    const onGoForwardPane = vi.fn();
    const identity = resolvePaneRouteIdentity("/libraries/library-1");

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/libraries/library-1"
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
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

  it("publishes pane layout with pane and resource identity", async () => {
    const onSetPaneLayout = vi.fn();
    const identity = resolvePaneRouteIdentity("/libraries/library-1");

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/libraries/library-1"
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
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
        resourceKey: identity.resourceKey,
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
    const identity = resolvePaneRouteIdentity("/media/media-1");

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/media/media-1"
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
        {...defaultNavigationProps}
        onNavigatePane={vi.fn()}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        secondaryPane={{
          id: "secondary-1",
          parentPrimaryPaneId: "pane-1",
          groupId: "reader-tools",
          activeSurfaceId: "reader-highlights",
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
        "reader-highlights",
      );
      expect(onSetSecondarySurface).toHaveBeenCalledWith(
        "secondary-1",
        "reader-doc-chat",
      );
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
    });
  });

  it("does not expose legacy pane width setters", async () => {
    const onValue = vi.fn();
    const identity = resolvePaneRouteIdentity("/libraries/library-1");

    render(
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/libraries/library-1"
        routeId={identity.routeId}
        resourceRef={identity.resourceRef}
        resourceKey={identity.resourceKey}
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
    expect(runtimeValue[`setPane${"Sizing"}`]).toBeUndefined();
    expect(runtimeValue.setPaneLayout).toEqual(expect.any(Function));
    expect(runtimeValue.requestSecondarySurface).toEqual(expect.any(Function));
    expect(runtimeValue.closeSecondaryPane).toEqual(expect.any(Function));
    expect(runtimeValue.setSecondarySurface).toEqual(expect.any(Function));
    expect(runtimeValue[`setPane${"Min"}Width`]).toBeUndefined();
    expect(runtimeValue[`setPane${"Extra"}Width`]).toBeUndefined();
  });
});
