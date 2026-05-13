import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "./LibraryTargetPicker";

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

describe("LibraryTargetPicker", () => {
  it("uses listbox and option semantics in selection mode", async () => {
    const handleSelectLibrary = vi.fn();

    render(
      <LibraryTargetPicker
        label="Choose library"
        libraries={libraries}
        allowNoLibrary
        noLibraryLabel="My Library only"
        selectedLibraryId="personal"
        onSelectLibrary={handleSelectLibrary}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Personal" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose library" });
    const listbox = within(dialog).getByRole("listbox", { name: "Choose library" });
    const noLibraryOption = within(listbox).getByRole("option", { name: "My Library only" });
    const personalOption = within(listbox).getByRole("option", { name: "Personal" });
    const workOption = within(listbox).getByRole("option", { name: "Work" });

    expect(noLibraryOption).toHaveAttribute("aria-selected", "false");
    expect(personalOption).toHaveAttribute("aria-selected", "true");
    expect(workOption).toHaveAttribute("aria-selected", "false");

    fireEvent.click(workOption);

    expect(handleSelectLibrary).toHaveBeenCalledWith("work");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Choose library" })).not.toBeInTheDocument();
    });
  });
});
