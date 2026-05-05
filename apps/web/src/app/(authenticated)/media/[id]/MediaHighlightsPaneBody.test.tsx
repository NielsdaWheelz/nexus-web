import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { Highlight } from "./mediaHighlights";
import MediaHighlightsPaneBody from "./MediaHighlightsPaneBody";

describe("MediaHighlightsPaneBody", () => {
  it("does not show edit actions for shared non-PDF highlights", async () => {
    const scrollHost = document.createElement("div");
    scrollHost.style.height = "320px";
    scrollHost.style.overflowY = "auto";
    Object.defineProperty(scrollHost, "clientHeight", {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(scrollHost, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    vi.spyOn(scrollHost, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 100, 400, 320),
    );

    const content = document.createElement("div");
    const segment = document.createElement("span");
    segment.dataset.activeHighlightIds = "shared-highlight";
    segment.textContent = "Shared quote";
    vi.spyOn(segment, "getClientRects").mockImplementation(
      () => [] as unknown as DOMRectList,
    );
    vi.spyOn(segment, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 140, 100, 16),
    );
    content.append(segment);
    scrollHost.append(content);
    document.body.append(scrollHost);

    render(
      <FeedbackProvider>
        <MediaHighlightsPaneBody
          isPdf={false}
          isEpub={false}
          isMobile={false}
          fragmentHighlights={[highlight({ id: "shared-highlight", is_owner: false })]}
          pdfPageHighlights={[]}
          highlightsVersion={1}
          pdfHighlightsVersion={0}
          pdfActivePage={1}
          contentRef={{ current: content }}
          focusedId="shared-highlight"
          onFocusHighlight={() => {}}
          onClearFocus={() => {}}
          canSendToChat={false}
          onSendToChat={() => {}}
          onColorChange={async () => {}}
          onDelete={async () => {}}
          onStartEditBounds={vi.fn()}
          onCancelEditBounds={vi.fn()}
          isEditingBounds={false}
          onNoteSave={async () => {}}
          onNoteDelete={async () => {}}
          onOpenConversation={() => {}}
        />
      </FeedbackProvider>
    );

    await screen.findByRole("button", { name: /Shared quote/ });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    });
    scrollHost.remove();
  });
});

function highlight(input: { id: string; is_owner: boolean }): Highlight {
  return {
    id: input.id,
    anchor: {
      type: "fragment_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 10,
      end_offset: 22,
    },
    color: "yellow",
    exact: "Shared quote",
    prefix: "",
    suffix: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_user_id: "user-2",
    is_owner: input.is_owner,
    linked_conversations: [],
    linked_note_blocks: [],
  };
}
