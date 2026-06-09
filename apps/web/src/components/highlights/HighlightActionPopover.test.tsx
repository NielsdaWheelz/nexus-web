import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { AnchoredHighlightRow } from "@/components/reader/useAnchoredHighlightProjection";
import HighlightActionPopover from "./HighlightActionPopover";

const highlight: AnchoredHighlightRow = { id: "h1", exact: "hello", color: "yellow" };

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPopover(overrides: Record<string, unknown> = {}) {
  const props = {
    onSelectColor: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onQuoteToNewChat: vi.fn(),
    onQuoteToExistingChat: vi.fn(),
    onToggleEditBounds: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(
    <FeedbackProvider>
      <HighlightActionPopover
        highlight={highlight}
        anchorRect={new DOMRect(100, 100, 80, 20)}
        canQuoteToChat
        isReflowable
        {...props}
      />
    </FeedbackProvider>,
  );
  return props;
}

describe("HighlightActionPopover", () => {
  it("anchors the shared action bar with the same options as the sidecar", () => {
    renderPopover();
    const group = screen.getByRole("group", { name: "Highlight actions" });
    expect(group).toBeInTheDocument();
    for (const name of [
      "Highlight color",
      "Quote to new chat",
      "Quote to existing chat",
      "Edit bounds",
      "Delete highlight",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("forwards the note action to the shared bar", async () => {
    const user = userEvent.setup();
    const onAddNote = vi.fn();
    renderPopover({ canAddNote: true, onAddNote });

    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onAddNote).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape and on outside pointerdown", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderPopover({ onDismiss });

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("dismisses on scroll", () => {
    const onDismiss = vi.fn();
    renderPopover({ onDismiss });

    fireEvent.scroll(window);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stays open while picking a color in the nested picker", async () => {
    const user = userEvent.setup();
    const onSelectColor = vi.fn(async () => {});
    const onDismiss = vi.fn();
    renderPopover({ onSelectColor, onDismiss });

    await user.click(screen.getByRole("button", { name: "Highlight color" }));
    await user.click(await screen.findByRole("button", { name: "Green" }));

    await waitFor(() => expect(onSelectColor).toHaveBeenCalledWith("green"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("toggles edit bounds", async () => {
    const user = userEvent.setup();
    const onToggleEditBounds = vi.fn();
    renderPopover({ onToggleEditBounds });

    await user.click(screen.getByRole("button", { name: "Edit bounds" }));
    expect(onToggleEditBounds).toHaveBeenCalledTimes(1);
  });
});
