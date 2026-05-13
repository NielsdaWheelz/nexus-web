import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Chip from "@/components/ui/Chip";

describe("Chip", () => {
  it("renders label with default size", () => {
    render(<Chip data-testid="chip">Label</Chip>);
    const el = screen.getByTestId("chip");
    expect(el).toHaveTextContent("Label");
    expect(el.className).toMatch(/sizeSm/);
  });

  it("applies md size", () => {
    render(
      <Chip data-testid="chip" size="md">
        Label
      </Chip>
    );
    expect(screen.getByTestId("chip").className).toMatch(/sizeMd/);
  });

  it("marks selected state", () => {
    render(
      <Chip data-testid="chip" selected>
        Label
      </Chip>
    );
    expect(screen.getByTestId("chip").className).toMatch(/selected/);
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

  it("applies truncate class to label when truncate is true", () => {
    render(<Chip truncate>truncated label content</Chip>);
    const labelSpan = screen.getByText("truncated label content");
    expect(labelSpan.className).toMatch(/labelTruncate/);
  });

  it("omits truncate class when truncate is false", () => {
    render(<Chip>plain label</Chip>);
    const labelSpan = screen.getByText("plain label");
    expect(labelSpan.className).not.toMatch(/labelTruncate/);
  });
});
