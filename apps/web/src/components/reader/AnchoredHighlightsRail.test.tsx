import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import AnchoredHighlightsRail from "./AnchoredHighlightsRail";
import type { AnchoredHighlightRow } from "./useAnchoredHighlightProjection";

vi.mock("@/components/notes/HighlightNoteEditor", () => ({
  default: function MockHighlightNoteEditor({
    highlightId,
    note,
    onSave,
  }: {
    highlightId: string;
    note: { note_block_id: string; body_text?: string; revision: number } | null;
    onSave: (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      baseRevision: number | null,
    ) => Promise<{ note_block_id: string; body_text: string; revision: number }>;
  }) {
    const noteBlockId = note?.note_block_id ?? null;
    const createBlockId = noteBlockId ?? `${highlightId}-draft-block`;
    return (
      <div>
        <div
          aria-label="Highlight note"
          contentEditable
          role="textbox"
          suppressContentEditableWarning
        >
          {note?.body_text ?? ""}
        </div>
        <button
          type="button"
          onClick={() => {
            void onSave(
              highlightId,
              noteBlockId,
              createBlockId,
              { type: "paragraph" },
              note?.revision ?? null,
            );
          }}
        >
          Mock save note
        </button>
      </div>
    );
  },
}));

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
          onNoteSave={async (_highlightId, _noteBlockId, createBlockId) => ({
            note_block_id: createBlockId,
            body_text: "",
            revision: 1,
          })}
          onNoteDelete={async () => {}}
          onOpenConversation={() => {}}
        />
      </FeedbackProvider>
    </div>
  );
}

function StableNoteKeyHarness({
  onNoteSave,
}: {
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    baseRevision: number | null,
  ) => Promise<void>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [linkedNoteBlocks, setLinkedNoteBlocks] = useState<
    NonNullable<AnchoredHighlightRow["linked_note_blocks"]>
  >([]);
  const row = {
    ...highlight(
      "h1",
      "Visible quote",
      "Before visible context ",
      " after visible context.",
    ),
    linked_note_blocks: linkedNoteBlocks,
  };

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
        </div>
      </div>
      <FeedbackProvider>
        <AnchoredHighlightsRail
          highlights={[row]}
          contentRef={contentRef}
          focusedId={null}
          onFocusHighlight={() => {}}
          measureKey="stable-note-key-test"
          isMobile={false}
          isEditingBounds={false}
          canSendToChat
          onSendToChat={() => {}}
          onColorChange={async () => {}}
          onDelete={async () => {}}
          onStartEditBounds={() => {}}
          onCancelEditBounds={() => {}}
          onNoteSave={async (
            highlightId,
            noteBlockId,
            createBlockId,
            bodyPmJson,
            baseRevision,
          ) => {
            await onNoteSave(highlightId, noteBlockId, createBlockId, bodyPmJson, baseRevision);
            const linkedNoteBlock = {
              note_block_id: createBlockId,
              body_pm_json: bodyPmJson,
              body_markdown: "saved",
              body_text: "saved",
              revision: 1,
            };
            setLinkedNoteBlocks([linkedNoteBlock]);
            return linkedNoteBlock;
          }}
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

  it("aligns a visible row to its source scanline", async () => {
    render(<AnchoredHighlightsRailHarness />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    const target = screen.getByText("First target");
    await waitFor(() => {
      expect(row.getBoundingClientRect().top).toBeCloseTo(
        target.getBoundingClientRect().top,
        0,
      );
    });
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

  it("keeps the note editor key stable after a first linked-note save", async () => {
    const user = userEvent.setup();
    const onNoteSave = vi.fn(async () => undefined);
    render(<StableNoteKeyHarness onNoteSave={onNoteSave} />);

    await screen.findByRole("textbox", { name: "Highlight note" });
    const initialNoteEditor = screen.getByTestId(
      "highlight-note-editor-draft-note-h1",
    );
    expect(initialNoteEditor).toHaveAttribute(
      "data-note-editor-key",
      "draft-note-h1",
    );

    await user.click(screen.getByRole("button", { name: "Mock save note" }));

    await waitFor(() => {
      expect(onNoteSave).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("highlight-note-editor-draft-note-h1"),
      ).toHaveAttribute("data-note-editor-key", "draft-note-h1");
    });
  });
});
