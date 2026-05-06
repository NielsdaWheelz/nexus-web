import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import ReaderChatOverlay from "@/components/chat/ReaderChatOverlay";

afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({
  initialOpen,
  onClose,
}: {
  initialOpen: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
      >
        Open chat
      </button>
      <ReaderChatOverlay
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
      >
        <div>
          <button type="button">Inside chat</button>
        </div>
      </ReaderChatOverlay>
    </>
  );
}

describe("ReaderChatOverlay", () => {
  it("renders nothing when closed", () => {
    render(<Harness initialOpen={false} />);
    expect(screen.queryByRole("dialog", { name: "Reader chat" })).toBeNull();
    expect(screen.queryByTestId("reader-chat-overlay-backdrop")).toBeNull();
  });

  it("opens with role=dialog, aria-modal, and a backdrop", () => {
    render(<Harness initialOpen />);
    const dialog = screen.getByRole("dialog", { name: "Reader chat" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("reader-chat-overlay-backdrop")).toBeInTheDocument();
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(<Harness initialOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId("reader-chat-overlay-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(<Harness initialOpen onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns focus to the trigger when the overlay closes", async () => {
    render(<Harness initialOpen={false} />);

    const trigger = screen.getByRole("button", { name: "Open chat" });
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const insideButton = await screen.findByRole("button", { name: "Inside chat" });
    await waitFor(() => {
      expect(insideButton).toHaveFocus();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});
