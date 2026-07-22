import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteHighlightNote,
  patchHighlightLinkedNoteBlock,
  removeHighlightLinkedNoteBlock,
  saveHighlightNote,
  upsertHighlightSorted,
  type Highlight,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

function highlight(
  id: string,
  noteIds: string[] = [],
  overrides: Partial<{
    start: number | null;
    end: number | null;
    created_at: string;
  }> = {},
): Highlight {
  return {
    id,
    anchor: {
      type: "fragment_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: "start" in overrides ? overrides.start ?? null : 0,
      end_offset: "end" in overrides ? overrides.end ?? null : 10,
    },
    color: "yellow",
    exact: "quote",
    prefix: "",
    suffix: "",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_user_id: "user-1",
    is_owner: true,
    linked_note_blocks: noteIds.map((noteId) => ({
      note_block_id: noteId,
      body_pm_json: { type: "paragraph" },
      body_text: noteId,
    })),
  };
}

describe("media highlight note summary helpers", () => {
  it("saves highlight notes through the highlight product route", async () => {
    let requestBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/highlights/highlight-1/note");
      expect(init?.method).toBe("PUT");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          data: {
            note_block_id: "note-1",
            body_pm_json: { type: "paragraph" },
            body_text: "saved",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await saveHighlightNote(
      "highlight-1",
      null,
      "note-1",
      { type: "paragraph" },
      "mutation-1",
    );

    expect(requestBody).toEqual({
      note_block_id: "note-1",
      client_mutation_id: "mutation-1",
      body_pm_json: { type: "paragraph" },
    });
    expect(result.note_block_id).toBe("note-1");
  });

  it("deletes highlight notes through the highlight product route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await deleteHighlightNote("highlight-1", "note-1", "mutation-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/highlights/highlight-1/note?note_block_id=note-1&client_mutation_id=mutation-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("upserts a linked note block on the matching highlight only", () => {
    const original = [highlight("highlight-1", ["note-1"]), highlight("highlight-2")];
    const next = patchHighlightLinkedNoteBlock(original, "highlight-1", {
      note_block_id: "note-1",
      body_pm_json: { type: "paragraph", content: [{ type: "text", text: "updated" }] },
      body_text: "updated",
    });

    expect(next).not.toBe(original);
    expect(next[0]?.linked_note_blocks).toEqual([
      {
        note_block_id: "note-1",
        body_pm_json: {
          type: "paragraph",
          content: [{ type: "text", text: "updated" }],
        },
        body_text: "updated",
      },
    ]);
    expect(next[1]).toBe(original[1]);
  });

  it("appends a newly created linked note block without refetch state", () => {
    const original = [highlight("highlight-1")];
    const next = patchHighlightLinkedNoteBlock(original, "highlight-1", {
      note_block_id: "note-created",
      body_pm_json: { type: "paragraph" },
      body_text: "created",
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

describe("upsertHighlightSorted", () => {
  it("appends a new highlight in anchor order", () => {
    const a = highlight("a", [], { start: 0, end: 5 });
    const c = highlight("c", [], { start: 20, end: 25 });
    const b = highlight("b", [], { start: 10, end: 15 });
    expect(upsertHighlightSorted([a, c], b).map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("replaces an existing highlight by id and re-sorts", () => {
    const a = highlight("a", [], { start: 0, end: 5 });
    const b = highlight("b", [], { start: 10, end: 15 });
    const bMoved = highlight("b", [], { start: 30, end: 35 });
    expect(upsertHighlightSorted([a, b], bMoved).map((h) => h.id)).toEqual(["a", "b"]);
    expect(upsertHighlightSorted([a, b], bMoved)[1]?.anchor.start_offset).toBe(30);
  });

  it("breaks anchor ties by end_offset, then created_at, then id", () => {
    const earlier = highlight("z", [], {
      start: 0,
      end: 5,
      created_at: "2026-01-01T00:00:00Z",
    });
    const later = highlight("a", [], {
      start: 0,
      end: 5,
      created_at: "2026-02-01T00:00:00Z",
    });
    const wider = highlight("m", [], {
      start: 0,
      end: 8,
      created_at: "2026-01-15T00:00:00Z",
    });
    expect(upsertHighlightSorted([later, wider], earlier).map((h) => h.id)).toEqual([
      "z",
      "a",
      "m",
    ]);
  });

  it("sorts an unresolved highlight (null anchor offsets) after every resolved one", () => {
    const resolved = highlight("resolved", [], { start: 0, end: 5 });
    const unresolved = highlight("unresolved", [], { start: null, end: null });

    expect(
      upsertHighlightSorted([resolved], unresolved).map((h) => h.id),
    ).toEqual(["resolved", "unresolved"]);
    expect(
      upsertHighlightSorted([unresolved], resolved).map((h) => h.id),
    ).toEqual(["resolved", "unresolved"]);
  });

  it("breaks a tie between two unresolved highlights by created_at, then id", () => {
    const earlier = highlight("z", [], {
      start: null,
      end: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    const later = highlight("a", [], {
      start: null,
      end: null,
      created_at: "2026-02-01T00:00:00Z",
    });

    expect(upsertHighlightSorted([later], earlier).map((h) => h.id)).toEqual([
      "z",
      "a",
    ]);
  });
});
