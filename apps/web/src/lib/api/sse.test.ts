import { describe, it, expect } from "vitest";
import { toWireContextItem } from "./sse";
import type { ContextItem } from "./sse";

describe("toWireContextItem", () => {
  it("strips enriched fields from a fully hydrated context item", () => {
    const item: ContextItem = {
      type: "highlight",
      id: "abc-123",
      color: "blue",
      preview: "selected text",
      mediaId: "m1",
      mediaTitle: "Article",
      // Enriched fields that must NOT appear in wire format
      prefix: "before ",
      suffix: " after",
      annotationBody: "my note",
      mediaKind: "web_article",
      hydrated: true,
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      type: "highlight",
      id: "abc-123",
      color: "blue",
      preview: "selected text",
      mediaId: "m1",
      mediaTitle: "Article",
    });

    // Verify enriched fields are absent
    expect("prefix" in wire).toBe(false);
    expect("suffix" in wire).toBe(false);
    expect("annotationBody" in wire).toBe(false);
    expect("mediaKind" in wire).toBe(false);
    expect("hydrated" in wire).toBe(false);
  });

  it("omits undefined optional display fields", () => {
    const item: ContextItem = {
      type: "media",
      id: "m2",
    };

    const wire = toWireContextItem(item);

    expect(wire).toEqual({
      type: "media",
      id: "m2",
    });

    // Undefined optional fields should not be present as keys
    expect("color" in wire).toBe(false);
    expect("preview" in wire).toBe(false);
    expect("mediaId" in wire).toBe(false);
    expect("mediaTitle" in wire).toBe(false);
  });
});
