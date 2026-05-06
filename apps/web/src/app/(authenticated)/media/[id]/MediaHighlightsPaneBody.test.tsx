import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { Highlight } from "./mediaHighlights";
import MediaHighlightsPaneBody from "./MediaHighlightsPaneBody";

function buildHighlight(overrides: Partial<Highlight> & { id: string }): Highlight {
  return {
    id: overrides.id,
    anchor: {
      type: "fragment_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 10,
      end_offset: 22,
      ...(overrides.anchor ?? {}),
    },
    color: overrides.color ?? "yellow",
    exact: overrides.exact ?? "Quote text",
    prefix: overrides.prefix ?? "",
    suffix: overrides.suffix ?? "",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00Z",
    author_user_id: overrides.author_user_id ?? "user-1",
    is_owner: overrides.is_owner ?? true,
    linked_conversations: overrides.linked_conversations ?? [],
    linked_note_blocks: overrides.linked_note_blocks ?? [],
  };
}

const baseProps = {
  isPdf: false,
  isEpub: false,
  pdfPageHighlights: [] as PdfHighlightOut[],
  pdfActivePage: 1,
  canSendToChat: false,
  onSendToChat: vi.fn(),
  onColorChange: vi.fn(async () => undefined),
  onDelete: vi.fn(async () => undefined),
  onStartEditBounds: vi.fn(),
  onCancelEditBounds: vi.fn(),
  isEditingBounds: false,
  onNoteSave: vi.fn(async () => undefined),
  onNoteDelete: vi.fn(async () => undefined),
  onOpenConversation: vi.fn(),
} as const;

describe("MediaHighlightsPaneBody", () => {
  it("renders the highlights list as plain content (no anchored layout)", () => {
    render(
      <FeedbackProvider>
        <MediaHighlightsPaneBody
          {...baseProps}
          fragmentHighlights={[
            buildHighlight({ id: "h1", exact: "Hello world" }),
          ]}
          focusedId={null}
          onFocusHighlight={() => {}}
        />
      </FeedbackProvider>,
    );
    const row = screen.getByTestId("highlights-inspector-row-h1");
    expect(row).toBeTruthy();
    // No reader scroll-anchored absolute positioning is applied at the row.
    expect(row.style.transform).toBe("");
  });

  it("does not show edit actions for shared non-PDF highlights", async () => {
    render(
      <FeedbackProvider>
        <MediaHighlightsPaneBody
          {...baseProps}
          fragmentHighlights={[
            buildHighlight({ id: "h1", exact: "Shared quote", is_owner: false }),
          ]}
          focusedId="h1"
          onFocusHighlight={() => {}}
        />
      </FeedbackProvider>,
    );
    await screen.findByRole("button", { name: /Shared quote/ });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    });
  });

  it("invokes onJumpToHighlight when an item is clicked", async () => {
    const onFocusHighlight = vi.fn();
    const onJumpToHighlight = vi.fn();
    const user = userEvent.setup();
    render(
      <FeedbackProvider>
        <MediaHighlightsPaneBody
          {...baseProps}
          fragmentHighlights={[buildHighlight({ id: "h1", exact: "Pulse me" })]}
          focusedId={null}
          onFocusHighlight={onFocusHighlight}
          onJumpToHighlight={onJumpToHighlight}
        />
      </FeedbackProvider>,
    );
    const button = await screen.findByRole("button", { name: /Pulse me/ });
    await user.click(button);
    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
    expect(onJumpToHighlight).toHaveBeenCalledWith("h1");
  });
});
