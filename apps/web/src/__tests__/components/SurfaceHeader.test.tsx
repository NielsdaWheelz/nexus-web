import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { ComponentProps } from "react";
import SurfaceHeader from "@/components/ui/SurfaceHeader";

function navigation(
  overrides: Partial<ComponentProps<typeof SurfaceHeader>["navigation"]> = {}
) {
  return {
    canGoBack: false,
    canGoForward: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    ...overrides,
  };
}

describe("SurfaceHeader", () => {
  it("renders the running head standing head + folio and the options menu", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <SurfaceHeader
        standingHead="Libraries"
        folio={{ kind: "count", value: 37, unit: "source" }}
        navigation={navigation()}
        options={[{ id: "delete", label: "Delete", onSelect: onDelete, tone: "danger" }]}
      />
    );

    expect(screen.getByText("Libraries")).toBeInTheDocument();
    expect(screen.getByText("37 sources")).toBeInTheDocument();
    // The standing head is a supplementary label, not the page heading.
    expect(screen.queryByRole("heading")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("exposes an accessible loading label while the folio resolves", () => {
    render(<SurfaceHeader standingHead="Libraries" folioPending navigation={navigation()} />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("loops tab focus inside the options menu", async () => {
    const user = userEvent.setup();

    render(
      <SurfaceHeader
        standingHead="Libraries"
        navigation={navigation()}
        options={[
          { id: "open", label: "Open source", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" },
        ]}
      />
    );

    const optionsToggle = screen.getByRole("button", { name: "Options" });
    await user.click(optionsToggle);

    const openSourceOption = screen.getByRole("menuitem", { name: "Open source" });
    const deleteOption = screen.getByRole("menuitem", { name: "Delete" });
    await waitFor(() => {
      expect(openSourceOption).toHaveFocus();
    });

    await user.tab();
    expect(deleteOption).toHaveFocus();

    await user.tab();
    expect(openSourceOption).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(optionsToggle).toHaveFocus();
    });
  });

  it("keeps disabled link options non-interactive", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <SurfaceHeader
        standingHead="Libraries"
        navigation={navigation()}
        options={[
          {
            id: "open-source",
            label: "Open source",
            href: "https://example.com",
            disabled: true,
            onSelect,
          },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Options" }));
    const item = screen.getByRole("menuitem", { name: "Open source" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Options" })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders pane Back and Forward controls with disabled states", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onForward = vi.fn();

    render(
      <SurfaceHeader
        standingHead="Libraries"
        navigation={navigation({
          canGoBack: true,
          canGoForward: false,
          onBack,
          onForward,
        })}
      />
    );

    const back = screen.getByRole("button", { name: "Go back in this pane" });
    const forward = screen.getByRole("button", {
      name: "Go forward in this pane",
    });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    await user.click(back);
    fireEvent.click(forward);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).not.toHaveBeenCalled();
  });
});
