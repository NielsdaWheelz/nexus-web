import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LibrarySettingsDialog, {
  type LibraryForSettings,
} from "./LibrarySettingsDialog";

const library: LibraryForSettings = {
  id: "lib-1",
  name: "Research",
  canRename: true,
  canDelete: false,
};

function renderDialog(onRename = vi.fn(async () => undefined)) {
  render(
    <LibrarySettingsDialog
      open
      onClose={() => undefined}
      library={library}
      onRename={onRename}
      onDelete={async () => undefined}
    />,
  );
  return onRename;
}

describe("LibrarySettingsDialog", () => {
  it("blocks saving the reserved All name and shows the reason", () => {
    renderDialog();
    const input = screen.getByLabelText("Library name");

    fireEvent.change(input, { target: { value: "All" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "All is reserved for the All view.",
    );
  });

  it("treats the reserved name case- and whitespace-insensitively", () => {
    renderDialog();
    const input = screen.getByLabelText("Library name");

    fireEvent.change(input, { target: { value: "  all  " } });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "All is reserved for the All view.",
    );
  });

  it("enables saving and clears the reason for an ordinary new name", () => {
    renderDialog();
    const input = screen.getByLabelText("Library name");

    fireEvent.change(input, { target: { value: "Reading" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
