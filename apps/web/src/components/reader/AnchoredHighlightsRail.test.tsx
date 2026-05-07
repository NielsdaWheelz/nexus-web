import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import AnchoredHighlightsRail, {
  type AnchoredHighlightRow,
} from "./AnchoredHighlightsRail";

function highlight(id: string, exact: string): AnchoredHighlightRow {
  return {
    id,
    exact,
    color: "yellow",
    anchor: {
      start_offset: id === "h1" ? 10 : 400,
      end_offset: id === "h1" ? 20 : 420,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    is_owner: true,
    linked_conversations: [],
    linked_note_blocks: [],
  };
}

function AnchoredHighlightsRailHarness({
  focusedId = null,
  onFocusHighlight = () => {},
}: {
  focusedId?: string | null;
  onFocusHighlight?: (highlightId: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", height: 320 }}>
      <div style={{ height: 200, overflowY: "auto" }}>
        <div ref={contentRef} style={{ height: 700 }}>
          <span
            data-active-highlight-ids="h1"
            style={{ display: "block", height: 24, marginTop: 48 }}
          >
            First target
          </span>
          <span
            data-active-highlight-ids="h2"
            style={{ display: "block", height: 24, marginTop: 360 }}
          >
            Second target
          </span>
        </div>
      </div>
      <FeedbackProvider>
        <AnchoredHighlightsRail
          highlights={[
            highlight("h1", "Visible quote"),
            highlight("h2", "Hidden quote"),
          ]}
          contentRef={contentRef}
          focusedId={focusedId}
          onFocusHighlight={onFocusHighlight}
          measureKey="test"
          isMobile={false}
          isEditingBounds={false}
          canSendToChat
          onSendToChat={() => {}}
          onColorChange={async () => {}}
          onDelete={async () => {}}
          onStartEditBounds={() => {}}
          onCancelEditBounds={() => {}}
          onNoteSave={async () => {}}
          onNoteDelete={async () => {}}
          onOpenConversation={() => {}}
        />
      </FeedbackProvider>
    </div>
  );
}

describe("AnchoredHighlightsRail", () => {
  it("renders viewport-visible highlight rows and omits offscreen rows", async () => {
    render(<AnchoredHighlightsRailHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("linked-item-row-h1")).toBeTruthy();
    });
    expect(screen.queryByTestId("linked-item-row-h2")).toBeNull();
  });

  it("focuses a row when its preview is clicked", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    render(<AnchoredHighlightsRailHarness onFocusHighlight={onFocusHighlight} />);

    await user.click(await screen.findByText("Visible quote"));
    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
  });
});
