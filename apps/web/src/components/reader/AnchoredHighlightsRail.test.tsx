import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import AnchoredHighlightsRail, {
  type AnchoredHighlightRow,
} from "./AnchoredHighlightsRail";

function highlight(
  id: string,
  exact: string,
  prefix: string,
  suffix: string,
): AnchoredHighlightRow {
  return {
    id,
    exact,
    prefix,
    suffix,
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
            highlight(
              "h1",
              "Visible quote",
              "Before visible context ",
              " after visible context.",
            ),
            highlight(
              "h2",
              "Hidden quote",
              "Before hidden context ",
              " after hidden context.",
            ),
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
  it("renders only viewport-visible highlight rows", async () => {
    render(<AnchoredHighlightsRailHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("anchored-highlight-row-h1")).toBeTruthy();
    });
    expect(screen.getByText("Visible quote")).toBeVisible();
    expect(screen.queryByTestId("anchored-highlight-row-h2")).toBeNull();
    expect(screen.queryByText("Hidden quote")).toBeNull();
  });

  it("shows the final visible row UI without requiring focus first", async () => {
    render(<AnchoredHighlightsRailHarness />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    expect(within(row).getByText("Before visible context")).toBeVisible();
    expect(within(row).getByText("Visible quote")).toBeVisible();
    expect(within(row).getByText("after visible context.")).toBeVisible();
    expect(
      within(row).queryByRole("button", { name: "Yellow (selected)" }),
    ).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Ask in chat" }),
    ).toBeVisible();
    expect(within(row).getByRole("button", { name: "Actions" })).toBeVisible();
    expect(
      within(row).getByRole("textbox", { name: "Highlight note" }),
    ).toBeVisible();
  });

  it("focuses the source highlight when the row is clicked", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    render(<AnchoredHighlightsRailHarness onFocusHighlight={onFocusHighlight} />);

    await user.click(await screen.findByTestId("anchored-highlight-row-h1"));
    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
  });
});
