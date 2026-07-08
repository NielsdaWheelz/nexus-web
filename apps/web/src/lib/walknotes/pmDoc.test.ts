import { describe, expect, it } from "vitest";
import { pmDocFromText } from "./pmDoc";

describe("pmDocFromText", () => {
  it("returns a paragraph node with a single text node", () => {
    const doc = pmDocFromText("hello world");
    expect(doc).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "hello world" }],
    });
  });

  it("round-trips text via content[0].text (text node is direct child)", () => {
    const input = "interesting argument about emergence";
    const doc = pmDocFromText(input) as {
      content: Array<{ type: string; text: string }>;
    };
    // The paragraph has one text node as a direct child; spec §4.3 defines the shape.
    expect(doc.content[0]?.text).toBe(input);
  });

  it("handles an empty string", () => {
    const doc = pmDocFromText("");
    expect(doc).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "" }],
    });
  });
});
