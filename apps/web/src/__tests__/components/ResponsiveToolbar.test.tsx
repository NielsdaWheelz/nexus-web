import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ResponsiveToolbar, { type ToolbarItem } from "@/components/ui/ResponsiveToolbar";

function stubMobile() {
  vi.stubGlobal("innerWidth", 390);
  window.dispatchEvent(new Event("resize"));
}

function stubDesktop() {
  vi.stubGlobal("innerWidth", 1024);
  window.dispatchEvent(new Event("resize"));
}

/** Fresh items per test so vi.fn() call counts never leak across tests. */
function makeSampleItems(): ToolbarItem[] {
  return [
    { id: "prev", label: "Previous page", icon: <span data-testid="icon-prev">←</span>, onClick: vi.fn(), priority: "primary" },
    { id: "next", label: "Next page", icon: <span data-testid="icon-next">→</span>, onClick: vi.fn(), priority: "primary" },
    { id: "highlight", label: "Highlight selection", icon: <span data-testid="icon-highlight">✨</span>, onClick: vi.fn(), priority: "primary" },
    { id: "zoom-out", label: "Zoom out", icon: <span data-testid="icon-zoom-out">−</span>, onClick: vi.fn(), priority: "secondary" },
    { id: "zoom-in", label: "Zoom in", icon: <span data-testid="icon-zoom-in">+</span>, onClick: vi.fn(), priority: "secondary" },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResponsiveToolbar", () => {
  describe("desktop viewport", () => {
    it("renders all items as text-labeled buttons", () => {
      stubDesktop();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      expect(screen.getByRole("button", { name: "Previous page" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next page" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Highlight selection" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    });

    it("shows text labels for buttons on desktop", () => {
      stubDesktop();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      expect(screen.getByRole("button", { name: "Previous page" })).toHaveTextContent("Previous page");
      expect(screen.getByRole("button", { name: "Zoom out" })).toHaveTextContent("Zoom out");
    });

    it("does not show overflow menu button on desktop", () => {
      stubDesktop();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    });

    it("fires onClick when a button is clicked", async () => {
      stubDesktop();
      const onClick = vi.fn();
      render(
        <ResponsiveToolbar
          items={[{ id: "action", label: "Do thing", onClick, priority: "primary" }]}
        />
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Do thing" }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("disables buttons when disabled flag is set", () => {
      stubDesktop();
      render(
        <ResponsiveToolbar
          items={[{ id: "x", label: "Disabled action", onClick: vi.fn(), disabled: true, priority: "primary" }]}
        />
      );

      expect(screen.getByRole("button", { name: "Disabled action" })).toBeDisabled();
    });

    it("renders display items inline", () => {
      stubDesktop();
      render(
        <ResponsiveToolbar
          items={[
            { id: "prev", label: "Previous", onClick: vi.fn(), priority: "primary" },
          ]}
          displays={<span>Page 2 of 10</span>}
        />
      );

      expect(screen.getByText("Page 2 of 10")).toBeInTheDocument();
    });
  });

  describe("mobile viewport", () => {
    it("renders primary items as icon-only buttons with aria-labels", () => {
      stubMobile();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      const prevBtn = screen.getByRole("button", { name: "Previous page" });
      const nextBtn = screen.getByRole("button", { name: "Next page" });
      const highlightBtn = screen.getByRole("button", { name: "Highlight selection" });

      // Icons should be rendered
      expect(within(prevBtn).getByTestId("icon-prev")).toBeInTheDocument();
      expect(within(nextBtn).getByTestId("icon-next")).toBeInTheDocument();
      expect(within(highlightBtn).getByTestId("icon-highlight")).toBeInTheDocument();

      // Accessible name comes from aria-label, not visible text
      expect(prevBtn).toHaveAttribute("aria-label", "Previous page");
      expect(nextBtn).toHaveAttribute("aria-label", "Next page");
    });

    it("hides secondary items from the inline toolbar", () => {
      stubMobile();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      // Secondary items should NOT appear as standalone buttons
      const allButtons = screen.getAllByRole("button");
      const buttonNames = allButtons.map((b) => b.getAttribute("aria-label") || b.textContent);
      expect(buttonNames).not.toContain("Zoom out");
      expect(buttonNames).not.toContain("Zoom in");
    });

    it("shows overflow menu button when secondary items exist", () => {
      stubMobile();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    });

    it("does not show overflow menu when no secondary items exist", () => {
      stubMobile();
      const primaryOnly: ToolbarItem[] = [
        { id: "prev", label: "Previous", icon: <span>←</span>, onClick: vi.fn(), priority: "primary" },
      ];
      render(<ResponsiveToolbar items={primaryOnly} />);

      expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    });

    it("opens overflow menu and shows secondary items as menu items", async () => {
      stubMobile();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More actions" }));

      expect(screen.getByRole("menuitem", { name: "Zoom out" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Zoom in" })).toBeInTheDocument();
    });

    it("fires onClick when overflow menu item is clicked", async () => {
      stubMobile();
      const onZoomOut = vi.fn();
      const items: ToolbarItem[] = [
        { id: "prev", label: "Prev", icon: <span>←</span>, onClick: vi.fn(), priority: "primary" },
        { id: "zoom-out", label: "Zoom out", onClick: onZoomOut, priority: "secondary" },
      ];
      render(<ResponsiveToolbar items={items} />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(screen.getByRole("menuitem", { name: "Zoom out" }));
      expect(onZoomOut).toHaveBeenCalledTimes(1);
    });

    it("disables overflow menu items when disabled flag is set", async () => {
      stubMobile();
      const items: ToolbarItem[] = [
        { id: "prev", label: "Prev", icon: <span>←</span>, onClick: vi.fn(), priority: "primary" },
        { id: "zoom-out", label: "Zoom out", onClick: vi.fn(), disabled: true, priority: "secondary" },
      ];
      render(<ResponsiveToolbar items={items} />);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      expect(screen.getByRole("menuitem", { name: "Zoom out" })).toHaveAttribute("disabled");
    });

    it("renders display items on mobile too", () => {
      stubMobile();
      render(
        <ResponsiveToolbar
          items={[
            { id: "prev", label: "Prev", icon: <span>←</span>, onClick: vi.fn(), priority: "primary" },
          ]}
          displays={<span>Page 2 of 10</span>}
        />
      );

      expect(screen.getByText("Page 2 of 10")).toBeInTheDocument();
    });
  });

  describe("default priority", () => {
    it("treats items without explicit priority as primary", () => {
      stubMobile();
      render(
        <ResponsiveToolbar
          items={[
            { id: "action", label: "My action", icon: <span data-testid="icon-action">★</span>, onClick: vi.fn() },
          ]}
        />
      );

      // Should render as inline button, not in overflow
      expect(screen.getByRole("button", { name: "My action" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("renders toolbar with toolbar role", () => {
      stubDesktop();
      render(<ResponsiveToolbar items={makeSampleItems()} />);

      expect(screen.getByRole("toolbar")).toBeInTheDocument();
    });

    it("provides accessible label for toolbar", () => {
      stubDesktop();
      render(<ResponsiveToolbar items={makeSampleItems()} ariaLabel="PDF controls" />);

      expect(screen.getByRole("toolbar")).toHaveAttribute("aria-label", "PDF controls");
    });
  });
});
