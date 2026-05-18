import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SessionRestorePrompt from "./SessionRestorePrompt";
import type { WorkspaceStateV4 } from "@/lib/workspace/schema";

function makeState(paneCount: number): WorkspaceStateV4 {
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    id: `pane-${index}`,
    href: `/libraries/${index}`,
    widthPx: 480,
    visibility: "visible" as const,
  }));
  return {
    schemaVersion: 4,
    activePaneId: panes[0].id,
    panes,
  };
}

describe("SessionRestorePrompt", () => {
  it("offers to reopen the user's own session", () => {
    render(
      <SessionRestorePrompt
        offer={{ source: "own", state: makeState(3) }}
        onReopen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText("Reopen your last 3 tabs?")).toBeInTheDocument();
  });

  it("offers to pick up a session from another device", () => {
    render(
      <SessionRestorePrompt
        offer={{ source: "other-device", state: makeState(2) }}
        onReopen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(
      screen.getByText("Pick up 2 tabs from another device?")
    ).toBeInTheDocument();
  });

  it("uses the singular noun for a single tab", () => {
    render(
      <SessionRestorePrompt
        offer={{ source: "own", state: makeState(1) }}
        onReopen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText("Reopen your last 1 tab?")).toBeInTheDocument();
  });

  it("invokes the action callbacks when the buttons are clicked", () => {
    const handleReopen = vi.fn();
    const handleDismiss = vi.fn();

    render(
      <SessionRestorePrompt
        offer={{ source: "own", state: makeState(2) }}
        onReopen={handleReopen}
        onDismiss={handleDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(handleReopen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(handleDismiss).toHaveBeenCalledTimes(1);
  });
});
