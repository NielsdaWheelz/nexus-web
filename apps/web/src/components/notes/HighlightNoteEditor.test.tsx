import { act } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import HighlightNoteEditor from "./HighlightNoteEditor";

describe("HighlightNoteEditor persistence", () => {
  it("flushes the latest pending note doc on unmount while a save is in flight", async () => {
    const user = userEvent.setup();
    const firstSave = deferred();
    const onSave = vi.fn(
      async (
        _highlightId: string,
        _noteBlockId: string | null,
        createBlockId: string,
        bodyPmJson: Record<string, unknown>
      ) => {
      if (onSave.mock.calls.length === 1) {
        await firstSave.promise;
      }
        return {
          note_block_id: createBlockId,
          body_pm_json: bodyPmJson,
          body_text: "",
          revision: onSave.mock.calls.length + 1,
        };
      }
    );

    const { unmount } = render(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId="highlight-1"
          note={{
            note_block_id: "note-1",
            body_pm_json: paragraphFromText("").toJSON() as Record<string, unknown>,
            body_text: "",
            revision: 1,
          }}
          editable
          onSave={onSave}
          onDelete={vi.fn(async () => undefined)}
          onOpenLink={() => {}}
        />
      </FeedbackProvider>
    );

    const editor = await screen.findByRole("textbox", { name: "Highlight note" });
    await user.click(editor);
    await user.keyboard("first");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(onSave).toHaveBeenNthCalledWith(
      1,
      "highlight-1",
      "note-1",
      "note-1",
      paragraphFromText("first").toJSON(),
      1
    );

    await user.keyboard("second");
    unmount();

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });

    expect(onSave).toHaveBeenNthCalledWith(
      2,
      "highlight-1",
      "note-1",
      "note-1",
      paragraphFromText("firstsecond").toJSON(),
      2
    );
  });

  it("uses the created draft block id for a queued save of a new note", async () => {
    const user = userEvent.setup();
    const firstSave = deferred();
    const onSave = vi.fn(
      async (
        _highlightId: string,
        _noteBlockId: string | null,
        createBlockId: string,
        bodyPmJson: Record<string, unknown>
      ) => {
      if (onSave.mock.calls.length === 1) {
        await firstSave.promise;
      }
        return {
          note_block_id: createBlockId,
          body_pm_json: bodyPmJson,
          body_text: "",
          revision: onSave.mock.calls.length,
        };
      }
    );

    const { unmount } = render(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId="highlight-1"
          note={null}
          editable
          onSave={onSave}
          onDelete={vi.fn(async () => undefined)}
          onOpenLink={() => {}}
        />
      </FeedbackProvider>
    );

    const editor = await screen.findByRole("textbox", { name: "Highlight note" });
    const draftBlockId = noteBlockIdFromEditor(editor);
    await user.click(editor);
    await user.keyboard("first");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(onSave).toHaveBeenNthCalledWith(
      1,
      "highlight-1",
      null,
      draftBlockId,
      paragraphFromText("first").toJSON(),
      null
    );

    await user.keyboard("second");
    unmount();

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });

    expect(onSave).toHaveBeenNthCalledWith(
      2,
      "highlight-1",
      draftBlockId,
      draftBlockId,
      paragraphFromText("firstsecond").toJSON(),
      1
    );
  });

  it("keeps focus when a new note save is echoed back by parent props", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(
      async (
        _highlightId: string,
        _noteBlockId: string | null,
        createBlockId: string,
        bodyPmJson: Record<string, unknown>
      ) => ({
        note_block_id: createBlockId,
        body_pm_json: bodyPmJson,
        body_text: "first",
        revision: 1,
      })
    );
    const onDelete = vi.fn(async () => undefined);

    const { rerender } = render(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId="highlight-1"
          note={null}
          editable
          onSave={onSave}
          onDelete={onDelete}
          onOpenLink={() => {}}
        />
      </FeedbackProvider>
    );

    const editor = await screen.findByRole("textbox", { name: "Highlight note" });
    const draftBlockId = noteBlockIdFromEditor(editor);
    await user.click(editor);
    await user.keyboard("first");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });

    rerender(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId="highlight-1"
          note={{
            note_block_id: draftBlockId,
            body_pm_json: paragraphFromText("first").toJSON() as Record<string, unknown>,
            body_text: "first",
            revision: 1,
          }}
          editable
          onSave={onSave}
          onDelete={onDelete}
          onOpenLink={() => {}}
        />
      </FeedbackProvider>
    );

    expect(screen.getByRole("textbox", { name: "Highlight note" })).toBe(editor);
    expect(editor).toHaveFocus();

    await user.keyboard("second");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });
    expect(onSave).toHaveBeenNthCalledWith(
      2,
      "highlight-1",
      draftBlockId,
      draftBlockId,
      paragraphFromText("firstsecond").toJSON(),
      1
    );
  });
});

function noteBlockIdFromEditor(editor: HTMLElement): string {
  // Compact highlight notes hide the "Open note block" handle (display:none),
  // which drops its accessible name, so read the id from the block list item.
  const blockId = within(editor)
    .getByRole("listitem")
    .getAttribute("data-note-block-id");
  if (!blockId) {
    throw new Error("Expected the editor to render a note block id");
  }
  return blockId;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
