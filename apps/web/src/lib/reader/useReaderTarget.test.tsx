import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const defaultNavigationProps = {
  canGoBack: false,
  canGoForward: false,
  onNavigatePane: vi.fn(),
  onOpenInNewPane: vi.fn(),
  onGoBackPane: vi.fn(),
  onGoForwardPane: vi.fn(),
};

function Runtime({
  href,
  onReplacePane,
  children,
}: {
  href: string;
  onReplacePane: (paneId: string, href: string) => void;
  children: ReactNode;
}) {
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
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
      expect(onReplacePane).toHaveBeenCalledWith("pane-1", "/media/media-1", undefined),
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
});
