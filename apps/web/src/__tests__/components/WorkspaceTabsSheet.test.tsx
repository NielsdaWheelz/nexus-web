import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import WorkspaceTabsSheet from "@/components/workspace/WorkspaceTabsSheet";

function SheetHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onActivatePane = vi.fn();
  const onClosePane = vi.fn();

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open panes
      </button>
      <WorkspaceTabsSheet
        open={open}
        tabs={[
          { paneId: "pane-a", title: "Libraries", isActive: true },
          { paneId: "pane-b", title: "Search", isActive: false },
        ]}
        triggerRef={triggerRef}
        onActivatePane={(paneId) => {
          onActivatePane(paneId);
          setOpen(false);
        }}
        onClosePane={onClosePane}
        onRequestClose={() => setOpen(false)}
      />
    </>
  );
}

function EmptySheetHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open empty panes
      </button>
      <WorkspaceTabsSheet
        open={open}
        tabs={[]}
        triggerRef={triggerRef}
        onActivatePane={() => {}}
        onClosePane={() => {}}
        onRequestClose={() => setOpen(false)}
      />
    </>
  );
}

describe("WorkspaceTabsSheet", () => {
  it("renders pane switcher dialog semantics", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);

    await user.click(screen.getByRole("button", { name: "Open panes" }));

    const dialog = screen.getByRole("dialog", { name: "Workspace panes" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Libraries" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Search" })).toBeInTheDocument();
  });

  it("traps focus while open and returns focus to trigger on close", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);

    const trigger = screen.getByRole("button", { name: "Open panes" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Workspace panes" });
    const first = within(dialog).getByRole("button", { name: "Libraries" });
    const last = within(dialog).getByRole("button", { name: "Close panes" });

    expect(first).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(last).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(first).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Workspace panes" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps focus trapped when the dialog has no pane rows", async () => {
    const user = userEvent.setup();
    render(
      <>
        <EmptySheetHarness />
        <button type="button">Outside control</button>
      </>
    );

    await user.click(screen.getByRole("button", { name: "Open empty panes" }));

    const dialog = screen.getByRole("dialog", { name: "Workspace panes" });
    const close = within(dialog).getByRole("button", { name: "Close panes" });
    expect(close).toHaveFocus();

    await user.keyboard("{Tab}");
    expect(close).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(close).toHaveFocus();
  });
});
