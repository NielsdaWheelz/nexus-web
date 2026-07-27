import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActionMenu from "@/components/ui/ActionMenu";
import { ResourceCache, ResourceCacheContext } from "@/lib/api/resourceCache";
import {
  PaneRuntimeProvider,
  type PaneNavigationCommandOptions,
} from "@/lib/panes/paneRuntime";
import type {
  WorkspaceTargetActivationRequest,
  WorkspaceTargetActivationResult,
} from "@/lib/workspace/targetActivation";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import ReaderCitation from "@/components/ui/ReaderCitation";
import PaneRouteBoundary from "./PaneRouteBoundary";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

// preloadPane dynamically imports the real pane body (ProseMirror, the reader stack, …);
// stub that chunk-warm side effect — the same documented heavy-chunk exception
// paneWarm.test.tsx uses — so these tests exercise only the intent delegate's routing +
// data-prefetch path. The fetch boundary stays real: the prefetch hits the global fetch spy.
const preloadPane = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/panes/paneRenderRegistry", () => ({ preloadPane }));

type NavigatePane = (
  paneId: string,
  href: string,
  options: PaneNavigationCommandOptions,
) => void;

type ActivateWorkspaceTarget = (
  request: WorkspaceTargetActivationRequest,
) => WorkspaceTargetActivationResult;

function unchangedActivation(): WorkspaceTargetActivationResult {
  return { kind: "Unchanged", paneId: "pane-1" };
}

function renderBoundary(input: {
  navigatePane?: NavigatePane;
  activateWorkspaceTarget?: ActivateWorkspaceTarget;
  disabled?: boolean;
}) {
  render(
    <PaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive={true}
      href="/settings"
      routeId="settings"
      routeKey="settings:/settings"
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onNavigatePane={input.navigatePane ?? vi.fn<NavigatePane>()}
      onReplacePane={vi.fn()}
      onActivateWorkspaceTarget={
        input.activateWorkspaceTarget ?? vi.fn(unchangedActivation)
      }
    >
      <PaneRouteBoundary>
        <ActionMenu
          options={[
            {
              kind: "link",
              id: "reader-settings",
              label: "Reader settings",
              href: "/settings/reader",
              disabled: input.disabled,
            },
          ]}
        />
      </PaneRouteBoundary>
    </PaneRuntimeProvider>,
  );
}

// Wraps the same PaneRuntime harness the click tests use in a REAL ResourceCache so the
// prefetch-on-intent data path is actually exercised (the click-only harness above renders
// without a cache, leaving usePaneWarm's context null — the data path would be a silent
// no-op). The child is a concrete in-pane anchor: hover/focus on it must reach the
// capture-phase intent delegate via closest("a[href]").
function renderIntentBoundary(input: {
  href: string;
  cache?: ResourceCache;
}): { cache: ResourceCache } {
  const cache = input.cache ?? new ResourceCache({});
  render(
    <ResourceCacheContext.Provider value={cache}>
      <PaneRuntimeProvider
        paneId="pane-1"
        visitId={TEST_VISIT_ID}
        isActive={true}
        href="/settings"
        routeId="settings"
        routeKey="settings:/settings"
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        onNavigatePane={vi.fn<NavigatePane>()}
        onReplacePane={vi.fn()}
        onActivateWorkspaceTarget={vi.fn(unchangedActivation)}
      >
        <PaneRouteBoundary>
          <a href={input.href}>Go</a>
          <span data-testid="non-anchor">plain region</span>
        </PaneRouteBoundary>
      </PaneRuntimeProvider>
    </ResourceCacheContext.Provider>,
  );
  return { cache };
}

describe("PaneRouteBoundary — prefetch-on-intent delegate", () => {
  beforeEach(() => {
    preloadPane.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    preloadPane.mockClear();
  });

  it("warms an in-pane link's chunk and prefetches its data on hover (into the cache)", async () => {
    // web_article with can_read:false ⇒ shouldLoadInitialMediaFragments is false, so the
    // media loader fires exactly one request: /api/media/m1 (no fragments follow-up).
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ data: { id: "m1", kind: "web_article", capabilities: { can_read: false } } }),
      );
    const { cache } = renderIntentBoundary({ href: "/media/m1" });

    fireEvent.mouseOver(screen.getByRole("link", { name: "Go" }));

    // Chunk warm is immediate; the data prefetch waits out the 70ms debounce.
    expect(preloadPane).toHaveBeenCalledWith("media");
    expect(cache.peek("m1")).toBeNull();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/media/m1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    // The prefetched payload landed in the provided cache — the pane will open warm.
    await waitFor(() => expect(cache.peek("m1")).not.toBeNull());
  });

  it("warms an in-pane link's chunk on keyboard focus", () => {
    const { cache } = renderIntentBoundary({ href: "/libraries" });

    fireEvent.focus(screen.getByRole("link", { name: "Go" }));

    expect(preloadPane).toHaveBeenCalledWith("libraries");
    expect(cache).toBeInstanceOf(ResourceCache);
  });

  it("does not warm a same-document fragment link (#href guard)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderIntentBoundary({ href: "#section" });

    fireEvent.mouseOver(screen.getByRole("link", { name: "Go" }));
    fireEvent.focus(screen.getByRole("link", { name: "Go" }));

    expect(preloadPane).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not warm when the intent target is not an anchor", () => {
    renderIntentBoundary({ href: "/media/m1" });

    fireEvent.mouseOver(screen.getByTestId("non-anchor"));
    fireEvent.focus(screen.getByTestId("non-anchor"));

    expect(preloadPane).not.toHaveBeenCalled();
  });
});

describe("PaneRouteBoundary", () => {
  it("leaves a rich citation to its bubble owner after capture", () => {
    const activateWorkspaceTarget = vi.fn(unchangedActivation);
    const onActivate = vi.fn();
    render(
      <PaneReturnMementoProvider>
        <FeedbackProvider>
          <PaneRuntimeProvider
            paneId="pane-1"
            visitId={TEST_VISIT_ID}
            isActive={true}
            href="/settings"
            routeId="settings"
            routeKey="settings:/settings"
            canGoBack={false}
            canGoForward={false}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
            onNavigatePane={vi.fn<NavigatePane>()}
            onReplacePane={vi.fn()}
            onActivateWorkspaceTarget={activateWorkspaceTarget}
          >
            <PaneRouteBoundary>
              <ReaderCitation
                index={1}
                preview={{ title: "Citation" }}
                activation={{
                  resourceRef: "media:media-1",
                  kind: "route",
                  href: "/media/media-1",
                  unresolvedReason: null,
                }}
                target={null}
                onActivate={onActivate}
              />
            </PaneRouteBoundary>
          </PaneRuntimeProvider>
        </FeedbackProvider>
      </PaneReturnMementoProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open citation 1" }));

    expect(activateWorkspaceTarget).toHaveBeenCalledOnce();
    expect(activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/media/media-1" },
      disposition: { kind: "Follow" },
      modality: "Keyboard",
    });
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("activates portaled menu links from the current pane", async () => {
    const user = userEvent.setup();
    const activateWorkspaceTarget = vi.fn(unchangedActivation);
    renderBoundary({ activateWorkspaceTarget });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Reader settings" }));

    expect(activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/settings/reader", labelHint: "Reader settings" },
      disposition: { kind: "Follow" },
      modality: "Pointer",
    });
  });

  it("activates Shift-clicked portaled menu links as Fork", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    const activateWorkspaceTarget = vi.fn(unchangedActivation);
    renderBoundary({ navigatePane, activateWorkspaceTarget });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reader settings" }), {
      shiftKey: true,
      detail: 1,
    });

    expect(activateWorkspaceTarget).toHaveBeenCalledWith({
      originPaneId: "pane-1",
      target: { href: "/settings/reader", labelHint: "Reader settings" },
      disposition: { kind: "Fork" },
      modality: "Pointer",
    });
    expect(navigatePane).not.toHaveBeenCalled();
  });

  it("leaves disabled portaled menu links alone", async () => {
    const user = userEvent.setup();
    const navigatePane = vi.fn();
    const activateWorkspaceTarget = vi.fn(unchangedActivation);
    renderBoundary({ navigatePane, activateWorkspaceTarget, disabled: true });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reader settings" }));

    expect(navigatePane).not.toHaveBeenCalled();
    expect(activateWorkspaceTarget).not.toHaveBeenCalled();
  });
});
