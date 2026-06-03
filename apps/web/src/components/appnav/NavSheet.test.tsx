import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookOpen, Settings } from "lucide-react";
import NavSheet from "@/components/appnav/NavSheet";
import type { NavGroup, NavItem } from "@/components/appnav/navModel";

const groups: NavGroup[] = [
  {
    id: "primary",
    label: "Library",
    items: [{ id: "libraries", label: "Libraries", href: "/libraries", icon: BookOpen }],
  },
];

const account: NavItem = { id: "settings", label: "Settings", href: "/settings", icon: Settings };

function renderSheet(overrides?: { open?: boolean; onClose?: () => void }) {
  const onClose = overrides?.onClose ?? vi.fn();
  const view = render(
    <NavSheet
      open={overrides?.open ?? true}
      onClose={onClose}
      groups={groups}
      account={account}
      activeId="libraries"
      settingsActive={false}
      commandHint="⌘K"
      onOpenCommand={vi.fn()}
      onOpenAdd={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
  return { ...view, onClose };
}

describe("NavSheet", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("locks body scroll while open and restores it on close", async () => {
    const { rerender } = renderSheet({ open: true });
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    rerender(
      <NavSheet
        open={false}
        onClose={vi.fn()}
        groups={groups}
        account={account}
        activeId="libraries"
        settingsActive={false}
        commandHint="⌘K"
        onOpenCommand={vi.fn()}
        onOpenAdd={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus into the sheet on open", async () => {
    renderSheet({ open: true });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Nexus — Home" })).toHaveFocus(),
    );
  });

  it("dismisses on Escape", () => {
    const { onClose } = renderSheet({ open: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked but not when the panel is", () => {
    const { onClose } = renderSheet({ open: true });

    fireEvent.click(screen.getByRole("dialog", { name: "Navigation" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener on close", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Menu";
    document.body.append(opener);
    opener.focus();

    const { unmount } = renderSheet({ open: true });
    await waitFor(() => expect(opener).not.toHaveFocus());

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
