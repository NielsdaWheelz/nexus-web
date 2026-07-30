import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DesktopNexus from "./DesktopNexus";
import type { DesktopNexusController } from "./types";

function controller(
  overrides: Partial<DesktopNexusController> = {},
): DesktopNexusController {
  return {
    open: true,
    page: { kind: "Find" },
    query: "notes",
    entries: [{ key: "note:one", label: "Reading notes", icon: null, hasSecondaryActions: true }],
    activeEntryKey: "note:one",
    failures: new Set(), busy: false, focusKey: "Find",
    setQuery: vi.fn(), setActiveEntry: vi.fn(),
    selectEntry: vi.fn(), openActions: vi.fn(),
    runAction: vi.fn(), retry: vi.fn(), back: vi.fn(),
    escape: vi.fn(), shouldSuppressReturnFocusOnClose: () => false,
    ...overrides,
  };
}

describe("DesktopNexus", () => {
  it("keeps the selected entry's pointer Actions control available at narrow width", () => {
    const value = controller();
    render(<DesktopNexus controller={value} />);

    const actionButton = screen.getByRole("button", { name: "Actions for Reading notes" });
    fireEvent.click(actionButton);

    expect(value.openActions).toHaveBeenCalledOnce();
  });

  it("asks the controller dismissal guard to handle backdrop dismissal", () => {
    const value = controller();
    render(<DesktopNexus controller={value} />);
    screen.getByRole("dialog", { name: "Nexus" });

    fireEvent.click(screen.getByRole("presentation"));

    expect(value.escape).toHaveBeenCalledOnce();
  });

  it("publishes a concise live result state for screen readers", () => {
    render(<DesktopNexus controller={controller({ busy: true })} />);

    expect(screen.getByText("Searching…")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("keeps a controller-owned workflow panel inside the Nexus dialog", () => {
    render(
      <DesktopNexus
        controller={controller({
          workflow: <button data-nexus-workflow-initial-focus>Continue import</button>,
        })}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Nexus" })).toContainElement(
      screen.getByRole("button", { name: "Continue import" }),
    );
  });

  it("moves focus into the action menu and restores the input when the page returns", async () => {
    const actions = controller({
      page: {
        kind: "Actions",
        label: "Reading notes",
        actions: [{ id: "share", label: "Share", icon: null }],
      },
      focusKey: "Actions",
    });
    const view = render(<DesktopNexus controller={actions} />);

    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Share" })).toHaveFocus());

    view.rerender(<DesktopNexus controller={controller()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Find anything" })).toHaveFocus());
  });
});
