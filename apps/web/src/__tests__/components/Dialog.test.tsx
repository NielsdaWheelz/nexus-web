import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dialog from "@/components/ui/Dialog";

describe("Dialog", () => {
  it("renders nothing when open is false", () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Dialog>
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders accessible dialog with title when open", () => {
    render(
      <Dialog open={true} onClose={vi.fn()} title="Edit Library">
        <p>Dialog body</p>
      </Dialog>
    );

    const dialog = screen.getByRole("dialog", { name: "Edit Library" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Edit Library" })
    ).toBeInTheDocument();
    expect(screen.getByText("Dialog body")).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Dialog>
    );

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Dialog>
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Dialog>
    );

    const dialog = screen.getByRole("dialog");
    // Click on the dialog element itself (acts as backdrop)
    await user.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when dialog content is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose} title="Test">
        <p>Inner content</p>
      </Dialog>
    );

    await user.click(screen.getByText("Inner content"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
