import { describe, expect, it } from "vitest";
import {
  toPdfAnchoredHighlightRow,
  toTextAnchoredHighlightRow,
} from "./toAnchoredHighlightRow";

const baseHighlight = {
  id: "h-1",
  exact: "matter",
  source_version: "v1",
  color: "yellow" as const,
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: "2026-05-01T00:00:00.000Z",
  prefix: "no ",
  suffix: " here",
  is_owner: true,
  linked_conversations: undefined,
  linked_note_blocks: undefined,
};

describe("toPdfAnchoredHighlightRow", () => {
  it("derives a deterministic stable_order_key from the first quad's coordinates", () => {
    const row = toPdfAnchoredHighlightRow(baseHighlight, 7, [
      { x1: 12.345, y1: 67.891, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0 },
    ]);
    expect(row).toEqual({
      ...baseHighlight,
      page_number: 7,
      quads: [{ x1: 12.345, y1: 67.891, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0 }],
      stable_order_key:
        "000007:00000067.891:00000012.345:2026-05-01T00:00:00.000Z:h-1",
    });
  });

  it("falls back to zero coordinates when the quad list is empty", () => {
    const row = toPdfAnchoredHighlightRow(baseHighlight, 1, []);
    expect(row.stable_order_key).toBe(
      "000001:00000000.000:00000000.000:2026-05-01T00:00:00.000Z:h-1",
    );
  });
});

describe("toTextAnchoredHighlightRow", () => {
  it("includes fragment timing fields when a fragment is supplied", () => {
    const row = toTextAnchoredHighlightRow(
      baseHighlight,
      { fragment_id: "frag-1", start_offset: 12, end_offset: 34 },
      { t_start_ms: 1000, t_end_ms: 2000 },
    );
    expect(row.anchor).toEqual({
      fragment_id: "frag-1",
      start_offset: 12,
      end_offset: 34,
      t_start_ms: 1000,
      t_end_ms: 2000,
    });
    expect(row.stable_order_key).toBe(
      "000000000012:000000000034:2026-05-01T00:00:00.000Z:h-1",
    );
  });

  it("omits timing fields when no fragment is supplied", () => {
    const row = toTextAnchoredHighlightRow(
      baseHighlight,
      { fragment_id: "frag-1", start_offset: 0, end_offset: 5 },
      null,
    );
    expect(row.anchor).toEqual({
      fragment_id: "frag-1",
      start_offset: 0,
      end_offset: 5,
    });
  });
});
