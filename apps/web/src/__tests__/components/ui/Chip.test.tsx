import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Chip from "@/components/ui/Chip";

describe("Chip", () => {
  it("renders label with default size", () => {
    render(<Chip>Label</Chip>);
    expect(screen.getByText("Label")).toBeVisible();
  });

  it("renders leading icon when provided", () => {
    render(
      <Chip leadingIcon={<span data-testid="leading">L</span>}>Label</Chip>
    );
    expect(screen.getByTestId("leading")).toBeInTheDocument();
  });

  it("renders remove button when removable and triggers onRemove", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    render(
      <Chip removable onRemove={onRemove}>
        Tag
      </Chip>
    );

    const removeButton = screen.getByRole("button", { name: "Remove" });
    await user.click(removeButton);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("does not render remove button when not removable", () => {
    render(<Chip>Label</Chip>);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

});
