import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Pane from "@/components/Pane";

describe("Pane", () => {
  it("renders children", () => {
    render(
      <Pane>
        <div>Test Content</div>
      </Pane>
    );

    expect(screen.getByText("Test Content")).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <Pane title="Test Title">
        <div>Content</div>
      </Pane>
    );

    expect(screen.getByText("Test Title")).toBeInTheDocument();
  });

  it("shows close button when onClose is provided", () => {
    const onClose = vi.fn();
    render(
      <Pane title="Test" onClose={onClose}>
        <div>Content</div>
      </Pane>
    );

    const closeButton = screen.getByLabelText("Close pane");
    expect(closeButton).toBeInTheDocument();

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not show close button when onClose is not provided", () => {
    render(
      <Pane title="Test">
        <div>Content</div>
      </Pane>
    );

    expect(screen.queryByLabelText("Close pane")).not.toBeInTheDocument();
  });

  it("applies default width", () => {
    const { container } = render(
      <Pane>
        <div>Content</div>
      </Pane>
    );

    const pane = container.firstChild as HTMLElement;
    expect(pane.style.width).toBe("480px");
  });

  it("applies custom default width", () => {
    const { container } = render(
      <Pane defaultWidth={600}>
        <div>Content</div>
      </Pane>
    );

    const pane = container.firstChild as HTMLElement;
    expect(pane.style.width).toBe("600px");
  });
});
