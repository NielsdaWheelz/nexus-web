import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppliedFilters, { type AppliedFilterChip } from "./AppliedFilters";

const CHIPS: AppliedFilterChip[] = [
  { id: "format:pdf", label: "PDFs" },
  { id: "role:author", label: "Role: author" },
];

describe("AppliedFilters", () => {
  it("renders nothing when there are no chips", () => {
    const { container } = render(
      <AppliedFilters chips={[]} onRemove={() => {}} onClearAll={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("group", { name: "Applied filters" }),
    ).not.toBeInTheDocument();
  });

  it("renders one removable chip per item inside the Applied filters group", () => {
    render(
      <AppliedFilters chips={CHIPS} onRemove={() => {}} onClearAll={() => {}} />,
    );
    const group = screen.getByRole("group", { name: "Applied filters" });
    expect(within(group).getByText("PDFs")).toBeInTheDocument();
    expect(within(group).getByText("Role: author")).toBeInTheDocument();
    // One Remove control per chip.
    expect(within(group).getAllByRole("button", { name: "Remove" })).toHaveLength(
      2,
    );
  });

  it("calls onRemove with the chip id when its Remove control is clicked", async () => {
    const onRemove = vi.fn();
    render(
      <AppliedFilters chips={CHIPS} onRemove={onRemove} onClearAll={() => {}} />,
    );
    // The first Remove control corresponds to the first chip (format:pdf).
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await userEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("format:pdf");
  });

  it("calls onClearAll when Clear all is clicked", async () => {
    const onClearAll = vi.fn();
    render(
      <AppliedFilters chips={CHIPS} onRemove={() => {}} onClearAll={onClearAll} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
