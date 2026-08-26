import { describe, expect, it } from "vitest";
import { isCitationEventData } from "./citations";

describe("citation result wire", () => {
  it("accepts the canonical reader-apparatus retrieval result", () => {
    expect(
      isCitationEventData({
        type: "reader_apparatus_item",
        id: "apparatus-item-1",
        result_type: "reader_apparatus_item",
        source_id: "source-1",
        title: "Endnote 3",
        source_label: "Endnotes",
        snippet: "Supporting note text",
        deep_link: "/media/media-1?apparatus=apparatus-item-1",
        citation_target: null,
        apparatus_kind: "endnote",
        context_ref: {
          type: "reader_apparatus_item",
          id: "apparatus-item-1",
          evidence_span_ids: [],
        },
        locator: {
          type: "note_block_offsets",
          block_id: "apparatus-item-1",
          start_offset: 0,
          end_offset: 20,
        },
        media_id: "media-1",
        media_kind: "epub",
        score: 0.75,
        selected: true,
      }),
    ).toBe(true);
  });
});
