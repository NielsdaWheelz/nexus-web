import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import ReaderHighlightsSurface from "./ReaderHighlightsSurface";
import type { AnchoredReaderRow } from "./useAnchoredReaderProjection";

vi.mock("@/components/notes/HighlightNoteEditor", () => ({
  default: function MockHighlightNoteEditor({
    highlightId,
    note,
    onSave,
  }: {
    highlightId: string;
    note: { note_block_id: string; body_text?: string } | null;
    onSave: (
      highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
    ) => Promise<{ note_block_id: string; body_text: string }>;
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
): AnchoredReaderRow {
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

function ReaderHighlightsSurfaceHarness({
  focusedId = null,
  onFocusHighlight = () => {},
  hoveredId = null,
  onHoverHighlight = () => {},
  canQuoteToChat = true,
  onQuoteToNewChat = () => {},
  onQuoteToExtantChat = () => {},
  isEditingBounds = false,
  onColorChange = async () => {},
  onDelete = async () => {},
  onStartEditBounds = () => {},
  onCancelEditBounds = () => {},
  linkedConversations,
  onOpenConversation = () => {},
  highlights,
  secondTargetMarginTop = 360,
}: {
  focusedId?: string | null;
  onFocusHighlight?: (highlightId: string) => void;
  hoveredId?: string | null;
  onHoverHighlight?: (highlightId: string | null) => void;
  canQuoteToChat?: boolean;
  onQuoteToNewChat?: (highlightId: string) => void;
  onQuoteToExtantChat?: (highlightId: string) => void;
  isEditingBounds?: boolean;
  onColorChange?: ReaderHighlightsSurfacePropsForTest["onColorChange"];
  onDelete?: ReaderHighlightsSurfacePropsForTest["onDelete"];
  onStartEditBounds?: () => void;
  onCancelEditBounds?: () => void;
  linkedConversations?: NonNullable<AnchoredReaderRow["linked_conversations"]>;
  onOpenConversation?: (conversationId: string, title: string) => void;
  highlights?: AnchoredReaderRow[];
  secondTargetMarginTop?: number;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const rows = highlights ?? [
    {
      ...highlight(
        "h1",
        "Visible quote",
        "Before visible context ",
        " after visible context.",
      ),
      linked_conversations: linkedConversations ?? [],
    },
    highlight(
      "h2",
      "Hidden quote",
      "Before hidden context ",
      " after hidden context.",
    ),
  ];

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
            style={{ display: "block", height: 24, marginTop: secondTargetMarginTop }}
          >
            Second target
          </span>
        </div>
      </div>
      <FeedbackProvider>
        <ReaderHighlightsSurface
          highlights={rows}
          contentRef={contentRef}
          focusedId={focusedId}
          onFocusHighlight={onFocusHighlight}
          hoveredId={hoveredId}
          onHoverHighlight={onHoverHighlight}
          measureKey="test"
          isMobile={false}
          isReflowable
          isEditingBounds={isEditingBounds}
          canQuoteToChat={canQuoteToChat}
          onQuoteToNewChat={onQuoteToNewChat}
          onQuoteToExtantChat={onQuoteToExtantChat}
          onColorChange={onColorChange}
          onDelete={onDelete}
          onStartEditBounds={onStartEditBounds}
          onCancelEditBounds={onCancelEditBounds}
          onNoteSave={async (_highlightId, _noteBlockId, createBlockId) => ({
            note_block_id: createBlockId,
            body_text: "",
          })}
          onNoteDelete={async () => {}}
          onOpenConversation={onOpenConversation}
          onOpenNoteLink={() => {}}
        />
      </FeedbackProvider>
    </div>
  );
}

type ReaderHighlightsSurfacePropsForTest = Parameters<typeof ReaderHighlightsSurface>[0];

function StableNoteKeyHarness({
  onNoteSave,
}: {
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string,
  ) => Promise<void>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [linkedNoteBlocks, setLinkedNoteBlocks] = useState<
    NonNullable<AnchoredReaderRow["linked_note_blocks"]>
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
        <ReaderHighlightsSurface
          highlights={[row]}
          contentRef={contentRef}
          focusedId={null}
          onFocusHighlight={() => {}}
          hoveredId={null}
          onHoverHighlight={() => {}}
          measureKey="stable-note-key-test"
          isMobile={false}
          isReflowable
          isEditingBounds={false}
          canQuoteToChat
          onQuoteToNewChat={() => {}}
          onQuoteToExtantChat={() => {}}
          onColorChange={async () => {}}
          onDelete={async () => {}}
          onStartEditBounds={() => {}}
          onCancelEditBounds={() => {}}
          onNoteSave={async (
            highlightId,
            noteBlockId,
            createBlockId,
            bodyPmJson,
            clientMutationId,
          ) => {
            await onNoteSave(
              highlightId,
              noteBlockId,
              createBlockId,
              bodyPmJson,
              clientMutationId,
            );
            const linkedNoteBlock = {
              note_block_id: createBlockId,
              body_pm_json: bodyPmJson,
              body_markdown: "saved",
              body_text: "saved",
            };
            setLinkedNoteBlocks([linkedNoteBlock]);
            return linkedNoteBlock;
          }}
          onNoteDelete={async () => {}}
          onOpenConversation={() => {}}
          onOpenNoteLink={() => {}}
        />
      </FeedbackProvider>
    </div>
  );
}

describe("ReaderHighlightsSurface", () => {
  it("renders only viewport-visible highlight rows", async () => {
    render(<ReaderHighlightsSurfaceHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("anchored-highlight-row-h1")).toBeTruthy();
    });
    expect(screen.getByText("Visible quote")).toBeVisible();
    expect(screen.queryByTestId("anchored-highlight-row-h2")).toBeNull();
    expect(screen.queryByText("Hidden quote")).toBeNull();
  });

  it("aligns a visible row to its source scanline", async () => {
    render(<ReaderHighlightsSurfaceHarness />);

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
    render(<ReaderHighlightsSurfaceHarness />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    expect(within(row).getByText("Visible quote")).toBeVisible();
    expect(within(row).queryByText("Before visible context")).toBeNull();
    expect(within(row).queryByText("after visible context.")).toBeNull();
    const trigger = within(row).getByRole("button", { name: "Highlight actions" });
    expect(trigger).toBeVisible();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(
      within(row).getByRole("textbox", { name: "Highlight note" }),
    ).toBeVisible();
  });

  it("shows a placeholder for a row with no selectable text and keeps it clickable", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    render(
      <ReaderHighlightsSurfaceHarness
        onFocusHighlight={onFocusHighlight}
        highlights={[highlight("h1", "", "Before visible context ", " after visible context.")]}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await waitFor(() => {
      expect(within(row).getByText("No selectable text")).toBeVisible();
    });

    await user.click(within(row).getByText("No selectable text"));
    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
  });

  it("exposes highlight actions behind one overflow menu on the row", async () => {
    const user = userEvent.setup();
    render(<ReaderHighlightsSurfaceHarness />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    const trigger = within(row).getByRole("button", { name: "Highlight actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    // None of the individual actions is directly present on the row; they live
    // behind the single overflow trigger.
    expect(within(row).queryByRole("button", { name: "Highlight color" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Quote to new chat" })).toBeNull();
    expect(
      within(row).queryByRole("button", { name: "Quote to existing chat" }),
    ).toBeNull();
    expect(within(row).queryByRole("button", { name: "Edit bounds" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete highlight" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();

    await user.click(trigger);
    // The menu is portaled to the body; query its contents via screen.
    expect(screen.getByRole("group", { name: "Highlight color" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Delete highlight" }),
    ).toBeVisible();
  });

  it("focuses the source highlight on row click without scrolling an in-view anchor", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    const scrollTo = vi.fn();
    const originalScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = scrollTo as typeof Element.prototype.scrollTo;
    render(<ReaderHighlightsSurfaceHarness onFocusHighlight={onFocusHighlight} />);

    await user.click(await screen.findByTestId("anchored-highlight-row-h1"));

    expect(onFocusHighlight).toHaveBeenCalledWith("h1");
    expect(scrollTo).not.toHaveBeenCalled();
    Element.prototype.scrollTo = originalScrollTo;
  });

  it("reports card hover through onHoverHighlight", async () => {
    const user = userEvent.setup();
    const onHoverHighlight = vi.fn();
    render(
      <ReaderHighlightsSurfaceHarness onHoverHighlight={onHoverHighlight} />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.hover(row);
    expect(onHoverHighlight).toHaveBeenCalledWith("h1");

    await user.unhover(row);
    expect(onHoverHighlight).toHaveBeenLastCalledWith(null);
  });

  it("quotes the highlight to a new or existing chat from the action menu", async () => {
    const user = userEvent.setup();
    const onQuoteToNewChat = vi.fn();
    const onQuoteToExtantChat = vi.fn();
    render(
      <ReaderHighlightsSurfaceHarness
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExtantChat={onQuoteToExtantChat}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");

    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Quote to new chat" }));
    expect(onQuoteToNewChat).toHaveBeenCalledTimes(1);
    expect(onQuoteToNewChat).toHaveBeenCalledWith("h1");
    expect(onQuoteToExtantChat).not.toHaveBeenCalled();

    // The menu closes on select, so reopen the trigger before the next action.
    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Quote to existing chat" }),
    );
    expect(onQuoteToExtantChat).toHaveBeenCalledTimes(1);
    expect(onQuoteToExtantChat).toHaveBeenCalledWith("h1");
    expect(onQuoteToNewChat).toHaveBeenCalledTimes(1);
  });

  it("hides the quote-to-chat actions when quoting is disabled", async () => {
    const user = userEvent.setup();
    render(<ReaderHighlightsSurfaceHarness canQuoteToChat={false} />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    expect(
      screen.queryByRole("menuitem", { name: "Quote to new chat" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Quote to existing chat" }),
    ).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Delete highlight" }),
    ).toBeVisible();
  });

  it("hides quote-to-chat actions for highlights without exact text", async () => {
    const user = userEvent.setup();
    render(
      <ReaderHighlightsSurfaceHarness
        highlights={[
          highlight(
            "h1",
            "   ",
            "Before visible context ",
            " after visible context.",
          ),
        ]}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    expect(
      screen.queryByRole("menuitem", { name: "Quote to new chat" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Quote to existing chat" }),
    ).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Delete highlight" }),
    ).toBeVisible();
  });

  it("applies a new highlight color from the color picker menu", async () => {
    const user = userEvent.setup();
    const onColorChange = vi.fn(async () => undefined);
    render(<ReaderHighlightsSurfaceHarness onColorChange={onColorChange} />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    // The color picker renders inline in the menu; the swatch is a direct button.
    await user.click(screen.getByRole("button", { name: "Green" }));

    expect(onColorChange).toHaveBeenCalledWith("h1", "green");
  });

  it("toggles cancel edit bounds from the focused row", async () => {
    const user = userEvent.setup();
    const onCancelEditBounds = vi.fn();
    const onStartEditBounds = vi.fn();
    render(
      <ReaderHighlightsSurfaceHarness
        focusedId="h1"
        isEditingBounds
        onCancelEditBounds={onCancelEditBounds}
        onStartEditBounds={onStartEditBounds}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Cancel edit bounds" }));

    expect(onCancelEditBounds).toHaveBeenCalledTimes(1);
    expect(onStartEditBounds).not.toHaveBeenCalled();
  });

  it("deletes a highlight from the danger action", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDelete = vi.fn(async () => undefined);
    render(<ReaderHighlightsSurfaceHarness onDelete={onDelete} />);

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(within(row).getByRole("button", { name: "Highlight actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete highlight" }));

    // The confirm copy is owned by HighlightActionBar's own test; here we only
    // assert the surface wires delete to this row's id.
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith("h1");
    });
    confirmSpy.mockRestore();
  });

  it("opens a linked conversation without focusing the card first", async () => {
    const user = userEvent.setup();
    const onOpenConversation = vi.fn();
    const onFocusHighlight = vi.fn();
    render(
      <ReaderHighlightsSurfaceHarness
        onFocusHighlight={onFocusHighlight}
        linkedConversations={[{ conversation_id: "c1", title: "Linked chat" }]}
        onOpenConversation={onOpenConversation}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(within(row).getByRole("button", { name: "Linked chat" }));
    expect(onOpenConversation).toHaveBeenCalledWith("c1", "Linked chat");
    expect(onFocusHighlight).not.toHaveBeenCalled();
  });

  it("expands a long highlight in place via show-more, without focusing it", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    render(
      <ReaderHighlightsSurfaceHarness
        onFocusHighlight={onFocusHighlight}
        highlights={[
          highlight("h1", "overflowing ".repeat(120).trim(), "before ", " after"),
        ]}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    const collapsedHeight = row.getBoundingClientRect().height;
    await user.click(await within(row).findByRole("button", { name: "Show more" }));

    const expandedRow = await screen.findByTestId("anchored-highlight-row-h1");
    expect(within(expandedRow).getByRole("button", { name: "Show less" })).toBeVisible();
    await waitFor(() => {
      expect(expandedRow.getBoundingClientRect().height).toBeGreaterThan(collapsedHeight);
    });
    expect(onFocusHighlight).not.toHaveBeenCalled();
  });

  it("leaves a focused highlight's snippet clamped — focus does not expand text", async () => {
    render(
      <ReaderHighlightsSurfaceHarness
        focusedId="h1"
        highlights={[
          highlight("h1", "overflowing ".repeat(120).trim(), "before ", " after"),
        ]}
      />,
    );

    const row = await screen.findByTestId("anchored-highlight-row-h1");
    expect(await within(row).findByRole("button", { name: "Show more" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Show less" })).toBeNull();
  });

  it("keeps one highlight expanded when another is expanded — multi-open", async () => {
    const user = userEvent.setup();
    render(
      <ReaderHighlightsSurfaceHarness
        secondTargetMarginTop={96}
        highlights={[
          highlight("h1", "overflowing ".repeat(120).trim(), "before ", " after"),
          highlight("h2", "spilling ".repeat(120).trim(), "before ", " after"),
        ]}
      />,
    );

    const row1 = await screen.findByTestId("anchored-highlight-row-h1");
    await user.click(await within(row1).findByRole("button", { name: "Show more" }));
    await user.click(
      await within(await screen.findByTestId("anchored-highlight-row-h2")).findByRole(
        "button",
        { name: "Show more" },
      ),
    );

    expect(
      within(await screen.findByTestId("anchored-highlight-row-h1")).getByRole("button", {
        name: "Show less",
      }),
    ).toBeVisible();
    expect(
      within(await screen.findByTestId("anchored-highlight-row-h2")).getByRole("button", {
        name: "Show less",
      }),
    ).toBeVisible();
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
