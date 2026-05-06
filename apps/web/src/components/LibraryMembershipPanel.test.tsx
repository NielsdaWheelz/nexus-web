import { useState, type ComponentProps, type RefCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LibraryMembershipPanel from "./LibraryMembershipPanel";
import type { LibraryTargetPickerItem } from "./LibraryTargetPicker";

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

const defaultViewportWidth = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

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
    setViewportWidth(defaultViewportWidth);
  });

  it("filters libraries and stays open after membership changes", async () => {
    const handleAddToLibrary = vi.fn();
    const handleRemoveFromLibrary = vi.fn();

    render(
      <Harness
        onAddToLibrary={handleAddToLibrary}
        onRemoveFromLibrary={handleRemoveFromLibrary}
      />
    );

    await screen.findByRole("dialog", { name: "Libraries" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search libraries" }), {
      target: { value: "work" },
    });

    expect(
      screen.queryByRole("button", { name: "Personal Remove from this library" })
    ).not.toBeInTheDocument();

    const workButton = screen.getByRole("button", { name: "Work Add to library" });
    fireEvent.click(workButton);

    expect(handleAddToLibrary).toHaveBeenCalledWith("work");
    expect(screen.getByRole("dialog", { name: "Libraries" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search libraries" }), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Personal Remove from this library" })
    );

    expect(handleRemoveFromLibrary).toHaveBeenCalledWith("personal");
    expect(screen.getByRole("dialog", { name: "Libraries" })).toBeInTheDocument();
  });

  it("disables membership changes while busy", async () => {
    render(<Harness busy />);

    expect(
      await screen.findByRole("button", { name: "Personal Remove from this library" })
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Work Add to library" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("restores focus to the anchor when it closes", async () => {
    render(<Harness />);

    const anchor = screen.getByRole("button", { name: "Anchor" });
    await screen.findByRole("dialog", { name: "Libraries" });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Libraries" })).not.toBeInTheDocument();
      expect(anchor).toHaveFocus();
    });
  });

  it("uses the shared dialog on mobile", async () => {
    setViewportWidth(480);

    render(<Harness />);

    expect(await screen.findByRole("dialog", { name: "Libraries" })).toBeInTheDocument();
  });
});
