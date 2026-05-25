import { describe, expect, it } from "vitest";
import { toWireContextItem, type ContextItem } from "./requests";

describe("toWireContextItem", () => {
  it("strips non-wire display detail from a context item", () => {
    const item: ContextItem = {
      kind: "object_ref",
      type: "highlight",
      id: "abc-123",
      color: "blue",
      preview: "selected text",
      mediaId: "m1",
      mediaTitle: "Article",
      // Enriched fields that must NOT appear in wire format
      prefix: "before ",
      suffix: " after",
      mediaKind: "web_article",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      kind: "object_ref",
      type: "highlight",
      id: "abc-123",
    });

    // Verify display and enriched fields are absent
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
    expect("mediaId" in wire).toBe(false);
    expect("mediaTitle" in wire).toBe(false);
    expect("prefix" in wire).toBe(false);
    expect("suffix" in wire).toBe(false);
    expect("mediaKind" in wire).toBe(false);
  });

  it("preserves evidence span ids for content chunk context", () => {
    const wire = toWireContextItem({
      kind: "object_ref",
      type: "content_chunk",
      id: "chunk-123",
      evidence_span_ids: ["span-1", "span-2"],
      preview: "selected text",
    });

    expect(wire).toEqual({
      kind: "object_ref",
      type: "content_chunk",
      id: "chunk-123",
      evidence_span_ids: ["span-1", "span-2"],
    });
  });

  it("omits undefined optional display fields", () => {
    const item: ContextItem = {
      kind: "object_ref",
      type: "media",
      id: "m2",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      kind: "object_ref",
      type: "media",
      id: "m2",
    });

    // Undefined optional fields should not be present as keys
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
    expect("mediaId" in wire).toBe(false);
    expect("mediaTitle" in wire).toBe(false);
  });

  it("keeps reader selection wire fields", () => {
    const wire = toWireContextItem({
      kind: "reader_selection",
      client_context_id: "selection-1",
      media_id: "media-1",
      media_kind: "article",
      media_title: "Article",
      exact: "Selected quote",
      prefix: "Before ",
      suffix: " after",
      preview: "Selected quote",
      color: "yellow",
      source_version: "fragment:fragment-1:v1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 10,
        end_offset: 24,
      },
    });

    expect(wire).toEqual({
      kind: "reader_selection",
      client_context_id: "selection-1",
      media_id: "media-1",
      media_kind: "article",
      media_title: "Article",
      exact: "Selected quote",
      prefix: "Before ",
      suffix: " after",
      source_version: "fragment:fragment-1:v1",
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 10,
        end_offset: 24,
      },
    });
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
  });
});
