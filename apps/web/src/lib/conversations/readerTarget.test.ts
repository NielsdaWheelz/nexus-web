import { describe, expect, it } from "vitest";
import { readerTargetFromRetrieval } from "./readerTarget";
import type { MessageRetrieval } from "./types";

const mediaRetrieval = {
  id: "retrieval-1",
  tool_call_id: "tool-call-1",
  ordinal: 0,
  result_type: "fragment",
  source_id: "fragment-1",
  media_id: "media-1",
  evidence_span_id: "span-1",
  context_ref: { type: "fragment", id: "fragment-1" },
  result_ref: {} as MessageRetrieval["result_ref"],
  deep_link: null,
  locator: {
    type: "web_text_offsets",
    media_id: "media-1",
    fragment_id: "fragment-1",
    start_offset: 10,
    end_offset: 24,
  },
  score: 0.8,
  selected: true,
  exact_snippet: "matched source text",
  retrieval_status: "retrieved",
} satisfies MessageRetrieval;

const noteRetrieval = {
  id: "retrieval-2",
  tool_call_id: "tool-call-1",
  ordinal: 1,
  result_type: "note_block",
  source_id: "block-9",
  media_id: null,
  context_ref: { type: "note_block", id: "block-9" },
  result_ref: {} as MessageRetrieval["result_ref"],
  deep_link: null,
  locator: {
    type: "note_block_offsets",
    page_id: "page-3",
    block_id: "block-9",
    start_offset: 4,
    end_offset: 19,
  },
  score: 0.7,
  selected: true,
  source_title: "My note",
  exact_snippet: "a cited note span",
  retrieval_status: "retrieved",
} satisfies MessageRetrieval;

describe("readerTargetFromRetrieval", () => {
  it("builds a media target tagged kind=media", () => {
    const target = readerTargetFromRetrieval(mediaRetrieval);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("media");
    if (target?.kind !== "media") throw new Error("expected media target");
    expect(target.media_id).toBe("media-1");
    expect(target.href).toBe("/media/media-1#evidence-span-1");
  });

  it("builds a note target from a note_block retrieval with null media_id", () => {
    const target = readerTargetFromRetrieval(noteRetrieval);
    expect(target).not.toBeNull();
    expect(target?.kind).toBe("note");
    if (target?.kind !== "note") throw new Error("expected note target");
    expect(target.page_id).toBe("page-3");
    expect(target.block_id).toBe("block-9");
    expect(target.start_offset).toBe(4);
    expect(target.end_offset).toBe(19);
    expect(target.snippet).toBe("a cited note span");
    expect(target.href).toBe("/notes/block-9");
  });

  it("prefers an explicit deep_link for a note target", () => {
    const target = readerTargetFromRetrieval({
      ...noteRetrieval,
      deep_link: "/notes/block-9#custom",
    });
    if (target?.kind !== "note") throw new Error("expected note target");
    expect(target.href).toBe("/notes/block-9#custom");
  });

  it("returns null when the locator is absent or invalid", () => {
    expect(
      readerTargetFromRetrieval({ ...mediaRetrieval, locator: null }),
    ).toBeNull();
  });
});
