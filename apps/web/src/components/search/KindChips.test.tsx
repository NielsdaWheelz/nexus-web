import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KindChips from "./KindChips";
import { SEARCH_KINDS, type SearchKind } from "@/lib/search/kinds";

describe("KindChips", () => {
  it("renders six pressable chips, all active by default (null selection)", () => {
    render(
      <KindChips
        selected={null}
        disabled={new Set()}
        disabledReason={null}
        onToggle={() => {}}
      />,
    );
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(SEARCH_KINDS.length);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("shows an explicit subset as pressed/unpressed", () => {
    render(
      <KindChips
        selected={new Set<SearchKind>(["documents"])}
        disabled={new Set()}
        disabledReason={null}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Documents" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Notes" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("calls onToggle when a chip is clicked", async () => {
    const onToggle = vi.fn();
    render(
      <KindChips
        selected={null}
        disabled={new Set()}
        disabledReason={null}
        onToggle={onToggle}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(onToggle).toHaveBeenCalledWith("notes");
  });

  it("disables incompatible kinds with a reason (implied-kind)", () => {
    render(
      <KindChips
        selected={null}
        disabled={new Set<SearchKind>(["notes", "highlights", "conversations", "web"])}
        disabledReason="Formats apply to documents"
        onToggle={() => {}}
      />,
    );
    const notes = screen.getByRole("button", { name: "Notes" });
    expect(notes).toBeDisabled();
    expect(notes).toHaveAttribute("title", "Formats apply to documents");
    expect(screen.getByRole("button", { name: "Documents" })).toBeEnabled();
  });
});
