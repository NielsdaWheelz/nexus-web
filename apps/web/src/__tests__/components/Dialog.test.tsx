import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import Dialog from "@/components/ui/Dialog";

// The panel carries role="dialog"; its parent is the scrim/backdrop div.
// eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the backdrop is role="presentation" (no queryable role); reach it via the panel's parent
const backdrop = () => screen.getByRole("dialog").parentElement!;

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
    expect(dialog).toHaveAttribute("aria-modal", "true");
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

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();

    render(
      <Dialog open={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Dialog>
    );

    fireEvent.click(backdrop());
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

  it("blocks Escape and backdrop dismissal when onDismissRequest returns 'blocked'", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDismissRequest = vi.fn(() => "blocked" as const);

    render(
      <Dialog open onClose={onClose} onDismissRequest={onDismissRequest} title="Test">
        <p>Content</p>
      </Dialog>
    );

    fireEvent.click(backdrop());
    expect(onDismissRequest).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onDismissRequest).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismisses via onClose when onDismissRequest returns 'accepted'", () => {
    const onClose = vi.fn();
    const onDismissRequest = vi.fn(() => "accepted" as const);

    render(
      <Dialog open onClose={onClose} onDismissRequest={onDismissRequest} title="Test">
        <p>Content</p>
      </Dialog>
    );

    fireEvent.click(backdrop());
    expect(onDismissRequest).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("routes the close button through onDismissRequest, blocking dismissal when vetoed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDismissRequest = vi.fn(() => "blocked" as const);

    render(
      <Dialog open onClose={onClose} onDismissRequest={onDismissRequest} title="Test">
        <p>Content</p>
      </Dialog>
    );

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onDismissRequest).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
