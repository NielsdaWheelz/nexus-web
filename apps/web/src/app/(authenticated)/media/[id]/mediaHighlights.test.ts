import { describe, expect, it } from "vitest";
import {
  patchHighlightLinkedNoteBlock,
  removeHighlightLinkedNoteBlock,
  type Highlight,
} from "./mediaHighlights";

function highlight(id: string, noteIds: string[] = []): Highlight {
  return {
    id,
    anchor: {
      type: "fragment_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 0,
      end_offset: 10,
    },
    color: "yellow",
    exact: "quote",
    prefix: "",
    suffix: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_user_id: "user-1",
    is_owner: true,
    linked_note_blocks: noteIds.map((noteId) => ({
      note_block_id: noteId,
      body_pm_json: { type: "paragraph" },
      body_markdown: noteId,
      body_text: noteId,
      revision: 1,
    })),
  };
}

describe("media highlight note summary helpers", () => {
  it("upserts a linked note block on the matching highlight only", () => {
    const original = [highlight("highlight-1", ["note-1"]), highlight("highlight-2")];
    const next = patchHighlightLinkedNoteBlock(original, "highlight-1", {
      note_block_id: "note-1",
      body_pm_json: { type: "paragraph", content: [{ type: "text", text: "updated" }] },
      body_markdown: "updated",
      body_text: "updated",
      revision: 2,
    });

    expect(next).not.toBe(original);
    expect(next[0]?.linked_note_blocks).toEqual([
      {
        note_block_id: "note-1",
        body_pm_json: {
          type: "paragraph",
          content: [{ type: "text", text: "updated" }],
        },
        body_markdown: "updated",
        body_text: "updated",
        revision: 2,
      },
    ]);
    expect(next[1]).toBe(original[1]);
  });

  it("appends a newly created linked note block without refetch state", () => {
    const original = [highlight("highlight-1")];
    const next = patchHighlightLinkedNoteBlock(original, "highlight-1", {
      note_block_id: "note-created",
      body_pm_json: { type: "paragraph" },
      body_markdown: "created",
      body_text: "created",
      revision: 1,
    });

    expect(next[0]?.linked_note_blocks?.map((note) => note.note_block_id)).toEqual([
      "note-created",
    ]);
  });

  it("removes a linked note block locally", () => {
    const original = [highlight("highlight-1", ["note-1", "note-2"])];
    const next = removeHighlightLinkedNoteBlock(original, "note-1");

    expect(next[0]?.linked_note_blocks?.map((note) => note.note_block_id)).toEqual([
      "note-2",
    ]);
  });
});
