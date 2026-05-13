import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HighlightColorPicker from "./HighlightColorPicker";

describe("HighlightColorPicker", () => {
  it("marks the selected color and emits selected swatches", () => {
    const onSelectColor = vi.fn();

    render(<HighlightColorPicker selectedColor="green" onSelectColor={onSelectColor} />);

    expect(screen.getByRole("button", { name: "Green (selected)" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    fireEvent.click(screen.getByRole("button", { name: "Blue" }));

    expect(onSelectColor).toHaveBeenCalledWith("blue");
  });

  it("disables all colors when disabled", () => {
    const onSelectColor = vi.fn();

    render(<HighlightColorPicker selectedColor="yellow" onSelectColor={onSelectColor} disabled />);

    fireEvent.click(screen.getByRole("button", { name: "Yellow (selected)" }));

    expect(screen.getByRole("button", { name: "Yellow (selected)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Purple" })).toBeDisabled();
    expect(onSelectColor).not.toHaveBeenCalled();
  });

  it("disables specific colors", () => {
    const onSelectColor = vi.fn();

    render(
      <HighlightColorPicker
        selectedColor="yellow"
        onSelectColor={onSelectColor}
        disabledColors={["blue"]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Pink" }));

    expect(screen.getByRole("button", { name: "Blue" })).toBeDisabled();
    expect(onSelectColor).toHaveBeenCalledTimes(1);
    expect(onSelectColor).toHaveBeenCalledWith("pink");
  });
});
