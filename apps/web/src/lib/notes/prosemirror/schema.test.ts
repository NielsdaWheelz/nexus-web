import { describe, expect, it } from "vitest";
import {
  createNoteBodyDoc,
  emptyNoteBody,
  noteBodySchema,
  noteBodyValueFromDoc,
  paragraphFromText,
} from "./schema";

describe("note body schema", () => {
  it("owns exactly one canonical body node", () => {
    const doc = createNoteBodyDoc({
      bodyPmJson: paragraphFromText("Hello").toJSON(),
    });
    expect(doc.type).toBe(noteBodySchema.nodes.note_body_doc);
    expect(doc.childCount).toBe(1);
    expect(noteBodyValueFromDoc(doc)).toEqual({
      bodyPmJson: {
        type: "paragraph",
        content: [{ type: "text", text: "Hello" }],
      },
      bodyText: "Hello",
    });
  });

  it("uses the explicit text projection when body JSON cannot render", () => {
    expect(
      noteBodyValueFromDoc(
        createNoteBodyDoc({
          bodyPmJson: { type: "removed_node" },
          fallbackBodyText: "Recovered",
        }),
      ),
    ).toEqual({
      bodyPmJson: {
        type: "paragraph",
        content: [{ type: "text", text: "Recovered" }],
      },
      bodyText: "Recovered",
    });
  });

  it("represents an empty note without structural placeholder identity", () => {
    expect(emptyNoteBody()).toEqual({
      bodyPmJson: { type: "paragraph" },
      bodyText: "",
    });
  });
});
