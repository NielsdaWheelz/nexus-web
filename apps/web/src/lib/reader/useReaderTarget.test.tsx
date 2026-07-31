import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  PaneRuntimeProvider,
  type PaneNavigationCommandOptions,
} from "@/lib/panes/paneRuntime";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

const defaultNavigationProps = {
  canGoBack: false,
  canGoForward: false,
  onNavigatePane: vi.fn(),
  onActivateWorkspaceTarget: vi.fn(() => ({ kind: "ActivatedExisting" as const, paneId: "pane" })),
  onGoBackPane: vi.fn(),
  onGoForwardPane: vi.fn(),
};

function Runtime({
  href,
  onReplacePane,
  children,
}: {
  href: string;
  onReplacePane: (
    paneId: string,
    href: string,
    options: PaneNavigationCommandOptions,
  ) => void;
  children: ReactNode;
}) {
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      visitId={TEST_VISIT_ID}
      isActive={true}
      href={href}
      routeId={identity.routeId}
      routeKey={identity.routeKey}
      {...defaultNavigationProps}
      onReplacePane={onReplacePane}
    >
      {children}
    </PaneRuntimeProvider>
  );
}

function Probe() {
  const readerTarget = useReaderTarget("media-1");
  return (
    <button
      type="button"
      data-testid="target"
      data-kind={readerTarget.target?.kind ?? ""}
      data-value={readerTarget.target?.value ?? ""}
      data-status={readerTarget.status}
      onClick={readerTarget.markActive}
    />
  );
}

describe("useReaderTarget", () => {
  it("reads one-shot hash targets from the pane href before the browser URL mirror catches up", async () => {
    window.history.replaceState(null, "", "/search");

    render(
      <Runtime href="/media/media-1#evidence-span-1" onReplacePane={vi.fn()}>
        <Probe />
      </Runtime>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("target")).toHaveAttribute("data-kind", "evidence"),
    );
    expect(screen.getByTestId("target")).toHaveAttribute("data-value", "span-1");
    expect(screen.getByTestId("target")).toHaveAttribute("data-status", "pending");
  });

  it("strips consumed hash targets through the pane router without clearing active focus state", async () => {
    const onReplacePane = vi.fn();
    const { rerender } = render(
      <Runtime href="/media/media-1#evidence-span-1" onReplacePane={onReplacePane}>
        <Probe />
      </Runtime>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("target")).toHaveAttribute("data-status", "pending"),
    );

    fireEvent.click(screen.getByTestId("target"));

    await waitFor(() =>
      expect(onReplacePane).toHaveBeenCalledWith("pane-1", "/media/media-1", {
        modality: "Programmatic",
      }),
    );
    expect(screen.getByTestId("target")).toHaveAttribute("data-status", "active");

    rerender(
      <Runtime href="/media/media-1" onReplacePane={onReplacePane}>
        <Probe />
      </Runtime>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("target")).toHaveAttribute("data-kind", "evidence"),
    );
    expect(screen.getByTestId("target")).toHaveAttribute("data-status", "active");
  });

  it("ignores stale address-bar hashes when the pane href has no reader target", async () => {
    window.history.replaceState(null, "", "/media/media-1#evidence-stale");

    render(
      <Runtime href="/media/media-1" onReplacePane={vi.fn()}>
        <Probe />
      </Runtime>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("target")).toHaveAttribute("data-kind", "");
    expect(screen.getByTestId("target")).toHaveAttribute("data-status", "idle");
  });

  it("adopts a reader pulse dispatched before the target pane mounts", async () => {
    dispatchReaderPulse({
      mediaId: "media-1",
      evidenceSpanId: "span-before-mount",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 4,
        end_offset: 12,
      },
      snippet: "evidence",
      highlightBehavior: "pulse",
      focusBehavior: "scroll_into_view",
    });

    const view = render(
      <Runtime href="/media/media-1" onReplacePane={vi.fn()}>
        <Probe />
      </Runtime>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("target")).toHaveAttribute(
        "data-kind",
        "evidence",
      ),
    );
    expect(screen.getByTestId("target")).toHaveAttribute(
      "data-value",
      "span-before-mount",
    );
    expect(screen.getByTestId("target")).toHaveAttribute(
      "data-status",
      "pending",
    );

    view.unmount();
    render(
      <Runtime href="/media/media-1" onReplacePane={vi.fn()}>
        <Probe />
      </Runtime>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("target")).toHaveAttribute("data-kind", "");
    expect(screen.getByTestId("target")).toHaveAttribute("data-status", "idle");
  });
});
