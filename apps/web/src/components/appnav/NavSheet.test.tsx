import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, MouseEvent } from "react";
import { BookOpen, Settings } from "lucide-react";
import NavSheet from "@/components/appnav/NavSheet";
import type { NavItem } from "@/components/appnav/navModel";

const items: NavItem[] = [
  {
    id: "lectern",
    label: "Lectern",
    href: "/lectern",
    icon: BookOpen,
    presentation: "default",
  },
  {
    id: "libraries",
    label: "Libraries",
    href: "/libraries",
    icon: BookOpen,
    presentation: "default",
  },
];

const home: NavItem = {
  id: "lectern",
  label: "Lectern",
  href: "/lectern",
  icon: BookOpen,
  presentation: "default",
};
const account: NavItem = {
  id: "settings",
  label: "Settings",
  href: "/settings",
  icon: Settings,
  presentation: "default",
};

function renderSheet(overrides?: {
  open?: boolean;
  activeHref?: string;
  onClose?: () => void;
  onNavigate?: ComponentProps<typeof NavSheet>["onNavigate"];
}) {
  const onClose = overrides?.onClose ?? vi.fn();
  const onNavigate =
    overrides?.onNavigate ?? vi.fn(() => "handled-destination-focus" as const);
  const view = render(
    <NavSheet
      open={overrides?.open ?? true}
      onClose={onClose}
      items={items}
      home={home}
      account={account}
      activeId="libraries"
      activeHref={overrides?.activeHref ?? "/libraries"}
      settingsActive={false}
      commandHint="⌘K"
      onOpenCommand={vi.fn()}
      onOpenAdd={vi.fn()}
      onNavigate={onNavigate}
    />,
  );
  return { ...view, onClose, onNavigate };
}

describe("NavSheet", () => {
  // Keep synthetic overlay-history entries local to each test. Real browser
  // history traversal is asynchronous and can otherwise deliver one test's
  // deferred popstate to the next sheet instance.
  let fakeState: unknown = null;

  beforeEach(() => {
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });

  afterEach(() => {
    document.body.style.overflow = "";
    vi.restoreAllMocks();
  });

  it("locks body scroll while open and restores it on close", async () => {
    const { rerender } = renderSheet({ open: true });
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    rerender(
      <NavSheet
        open={false}
        onClose={vi.fn()}
        items={items}
        home={home}
        account={account}
        activeId="libraries"
        activeHref="/libraries"
        settingsActive={false}
        commandHint="⌘K"
        onOpenCommand={vi.fn()}
        onOpenAdd={vi.fn()}
        onNavigate={vi.fn(() => "handled-destination-focus" as const)}
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

  it("exposes a visible close control", () => {
    const { onClose } = renderSheet({ open: true });
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked but not when the panel is", () => {
    const { onClose } = renderSheet({ open: true });

    fireEvent.click(screen.getByRole("dialog", { name: "Navigation" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("history dismissal", () => {
    // The synthetic-entry pop is deferred to a microtask (useHistoryDismiss); flush it.
    const flushMicrotasks = async () => {
      await act(async () => {
        await Promise.resolve();
      });
    };

    it("back button (popstate) dismisses exactly once and does not pop again", async () => {
      const { onClose } = renderSheet({ open: true });
      expect(history.pushState).toHaveBeenCalledTimes(1);

      act(() => window.dispatchEvent(new PopStateEvent("popstate")));
      await flushMicrotasks();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(history.back).not.toHaveBeenCalled(); // the browser already removed the entry
    });

    it("UI close pops the synthetic entry", async () => {
      const { rerender, onClose } = renderSheet({ open: true });
      expect(history.pushState).toHaveBeenCalledTimes(1);

      rerender(
        <NavSheet
          open={false}
          onClose={onClose}
          items={items}
          home={home}
          account={account}
          activeId="libraries"
          activeHref="/libraries"
          settingsActive={false}
          commandHint="⌘K"
          onOpenCommand={vi.fn()}
          onOpenAdd={vi.fn()}
          onNavigate={vi.fn(() => "handled-destination-focus" as const)}
        />,
      );
      await flushMicrotasks();

      expect(history.back).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });
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

  it("does not steal focus back after a handled destination activation", async () => {
    const opener = document.createElement("button");
    const destination = document.createElement("button");
    document.body.append(opener, destination);
    opener.focus();

    const onNavigate = vi.fn((event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      destination.focus();
      return "handled-destination-focus" as const;
    });
    const { rerender } = renderSheet({ open: true, onNavigate });
    await waitFor(() => expect(opener).not.toHaveFocus());

    fireEvent.click(screen.getByRole("link", { name: "Libraries" }));
    rerender(
      <NavSheet
        open={false}
        onClose={vi.fn()}
        items={items}
        home={home}
        account={account}
        activeId="libraries"
        activeHref="/libraries"
        settingsActive={false}
        commandHint="⌘K"
        onOpenCommand={vi.fn()}
        onOpenAdd={vi.fn()}
        onNavigate={onNavigate}
      />,
    );

    expect(destination).toHaveFocus();
    opener.remove();
    destination.remove();
  });

  it("hands focus to a destination when the active pane changes outside the sheet", async () => {
    const opener = document.createElement("button");
    const destination = document.createElement("button");
    document.body.append(opener, destination);
    opener.focus();

    const { rerender, onClose } = renderSheet({ open: true });
    await waitFor(() => expect(opener).not.toHaveFocus());
    destination.focus();

    rerender(
      <NavSheet
        open
        onClose={onClose}
        items={items}
        home={home}
        account={account}
        activeId="notes"
        activeHref="/notes"
        settingsActive={false}
        commandHint="⌘K"
        onOpenCommand={vi.fn()}
        onOpenAdd={vi.fn()}
        onNavigate={vi.fn(() => "handled-destination-focus" as const)}
      />,
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    rerender(
      <NavSheet
        open={false}
        onClose={onClose}
        items={items}
        home={home}
        account={account}
        activeId="notes"
        activeHref="/notes"
        settingsActive={false}
        commandHint="⌘K"
        onOpenCommand={vi.fn()}
        onOpenAdd={vi.fn()}
        onNavigate={vi.fn(() => "handled-destination-focus" as const)}
      />,
    );
    expect(destination).toHaveFocus();
    opener.remove();
    destination.remove();
  });
});
