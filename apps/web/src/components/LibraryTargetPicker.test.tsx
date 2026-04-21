import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
    const user = userEvent.setup();
    const handleSelectLibrary = vi.fn();

    render(
      <LibraryTargetPicker
        label="Choose library"
        libraries={libraries}
        allowNoLibrary
        selectedLibraryId="personal"
        onSelectLibrary={handleSelectLibrary}
      />
    );

    await user.click(screen.getByRole("button", { name: "Personal" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose library" });
    const listbox = within(dialog).getByRole("listbox", { name: "Choose library" });
    const noLibraryOption = within(listbox).getByRole("option", { name: "No library" });
    const personalOption = within(listbox).getByRole("option", { name: "Personal" });
    const workOption = within(listbox).getByRole("option", { name: "Work" });

    expect(noLibraryOption).toHaveAttribute("aria-selected", "false");
    expect(personalOption).toHaveAttribute("aria-selected", "true");
    expect(workOption).toHaveAttribute("aria-selected", "false");

    await user.click(workOption);

    expect(handleSelectLibrary).toHaveBeenCalledWith("work");
    expect(screen.queryByRole("dialog", { name: "Choose library" })).not.toBeInTheDocument();
  });
});
