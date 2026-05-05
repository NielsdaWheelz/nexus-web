import { act } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import HighlightNoteEditor, { highlightNoteBodyHasContent } from "./HighlightNoteEditor";

describe("HighlightNoteEditor persistence", () => {
  it("flushes the latest pending note doc on unmount while a save is in flight", async () => {
    const user = userEvent.setup();
    const firstSave = deferred();
    const onSave = vi.fn(async () => {
      if (onSave.mock.calls.length === 1) {
        await firstSave.promise;
      }
    });

    const { unmount } = render(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId="highlight-1"
          note={{
            note_block_id: "note-1",
            body_pm_json: paragraphFromText("").toJSON() as Record<string, unknown>,
            body_text: "",
          }}
          editable
          onSave={onSave}
          onDelete={vi.fn(async () => undefined)}
        />
      </FeedbackProvider>
    );

    const editor = await screen.findByRole("textbox", { name: "Highlight note" });
    await user.click(editor);
    await user.keyboard("first");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenNthCalledWith(
      1,
      "highlight-1",
      "note-1",
      "note-1",
      paragraphFromText("first").toJSON()
    );

    await user.keyboard("second");
    unmount();

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });

    expect(onSave).toHaveBeenNthCalledWith(
      2,
      "highlight-1",
      "note-1",
      "note-1",
      paragraphFromText("firstsecond").toJSON()
    );
  });

  it("uses the created draft block id for a queued save of a new note", async () => {
    const user = userEvent.setup();
    const firstSave = deferred();
    const onSave = vi.fn(async () => {
      if (onSave.mock.calls.length === 1) {
        await firstSave.promise;
      }
    });

    const { unmount } = render(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId="highlight-1"
          note={null}
          editable
          onSave={onSave}
          onDelete={vi.fn(async () => undefined)}
        />
      </FeedbackProvider>
    );

    const editor = await screen.findByRole("textbox", { name: "Highlight note" });
    const draftBlockId = noteBlockIdFromEditor(editor);
    await user.click(editor);
    await user.keyboard("first");

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave).toHaveBeenNthCalledWith(
      1,
      "highlight-1",
      null,
      draftBlockId,
      paragraphFromText("first").toJSON()
    );

    await user.keyboard("second");
    unmount();

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });

    expect(onSave).toHaveBeenNthCalledWith(
      2,
      "highlight-1",
      draftBlockId,
      draftBlockId,
      paragraphFromText("firstsecond").toJSON()
    );
  });

  it("treats object refs and images as note content", () => {
    const objectId = "11111111-1111-4111-8111-111111111111";

    expect(
      highlightNoteBodyHasContent({
        bodyText: "",
        bodyPmJson: {
          type: "paragraph",
          content: [
            {
              type: "object_ref",
              attrs: {
                objectType: "media",
                objectId,
                label: "Source media",
              },
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      highlightNoteBodyHasContent({
        bodyText: "",
        bodyPmJson: {
          type: "paragraph",
          content: [
            {
              type: "image",
              attrs: { src: "/image.png", alt: "diagram", title: null },
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      highlightNoteBodyHasContent({
        bodyText: "",
        bodyPmJson: { type: "paragraph" },
      }),
    ).toBe(false);
  });
});

function noteBlockIdFromEditor(editor: HTMLElement): string {
  const blockId = within(editor)
    .getByRole("button", { name: "Open note block" })
    .getAttribute("data-note-block-open");
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
