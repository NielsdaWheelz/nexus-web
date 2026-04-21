import { useState, type ComponentProps, type RefCallback } from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LibraryMembershipPanel from "./LibraryMembershipPanel";
import type { LibraryTargetPickerItem } from "./LibraryTargetPicker";

let isMobileViewport = false;

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => isMobileViewport,
}));

const libraries: LibraryTargetPickerItem[] = [
  {
    id: "personal",
    name: "Personal",
    color: "#0ea5e9",
    isInLibrary: true,
    canAdd: false,
    canRemove: true,
  },
  {
    id: "work",
    name: "Work",
    color: "#22c55e",
    isInLibrary: false,
    canAdd: true,
    canRemove: false,
  },
];

function Harness(props: Partial<ComponentProps<typeof LibraryMembershipPanel>>) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(true);

  return (
    <>
      <button ref={setAnchorEl as RefCallback<HTMLButtonElement>} type="button">
        Anchor
      </button>
      <LibraryMembershipPanel
        open={open}
        title="Libraries"
        anchorEl={anchorEl}
        libraries={libraries}
        onClose={() => setOpen(false)}
        onAddToLibrary={vi.fn()}
        onRemoveFromLibrary={vi.fn()}
        {...props}
      />
    </>
  );
}

describe("LibraryMembershipPanel", () => {
  afterEach(() => {
    isMobileViewport = false;
  });

  it("filters libraries and stays open after membership changes", async () => {
    const user = userEvent.setup();
    const handleAddToLibrary = vi.fn();
    const handleRemoveFromLibrary = vi.fn();

    render(
      <Harness
        onAddToLibrary={handleAddToLibrary}
        onRemoveFromLibrary={handleRemoveFromLibrary}
      />
    );

    await screen.findByRole("dialog", { name: "Libraries" });
    await user.type(screen.getByRole("searchbox", { name: "Search libraries" }), "work");

    expect(screen.queryByRole("button", { name: "Personal Remove from library" })).not.toBeInTheDocument();

    const workButton = screen.getByRole("button", { name: "Work Add to library" });
    await user.click(workButton);

    expect(handleAddToLibrary).toHaveBeenCalledWith("work");
    expect(screen.getByRole("dialog", { name: "Libraries" })).toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search libraries" }));
    await user.click(screen.getByRole("button", { name: "Personal Remove from library" }));

    expect(handleRemoveFromLibrary).toHaveBeenCalledWith("personal");
    expect(screen.getByRole("dialog", { name: "Libraries" })).toBeInTheDocument();
  });

  it("disables membership changes while busy", async () => {
    render(<Harness busy />);

    expect(await screen.findByRole("button", { name: "Personal Remove from library" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Work Add to library" })).toBeDisabled();
  });

  it("restores focus to the anchor when it closes", async () => {
    const user = userEvent.setup();

    render(<Harness />);

    const anchor = screen.getByRole("button", { name: "Anchor" });
    await screen.findByRole("dialog", { name: "Libraries" });
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Libraries" })).not.toBeInTheDocument();
      expect(anchor).toHaveFocus();
    });
  });

  it("uses the shared dialog on mobile", async () => {
    isMobileViewport = true;

    render(<Harness />);

    const dialog = await screen.findByRole("dialog", { name: "Libraries" });
    expect(dialog.tagName).toBe("DIALOG");
  });
});
