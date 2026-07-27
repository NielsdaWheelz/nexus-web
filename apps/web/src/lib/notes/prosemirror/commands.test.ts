import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { insertCodeNewline, splitNoteBodyAtSelection } from "./commands";
import {
  createNoteBodyDoc,
  noteBodySchema,
  paragraphFromText,
} from "./schema";

describe("note body commands", () => {
  it("projects a caret split into canonical left and right bodies", () => {
    const doc = createNoteBodyDoc({
      bodyPmJson: paragraphFromText("calm editor").toJSON(),
    });
    const state = EditorState.create({
      schema: noteBodySchema,
      doc,
      selection: TextSelection.create(doc, 5),
    });
    expect(splitNoteBodyAtSelection(state)).toEqual({
      left: {
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: "calm" }],
        },
        bodyText: "calm",
      },
      right: {
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: " editor" }],
        },
        bodyText: "editor",
      },
    });
  });

  it("does not intercept code-block Enter", () => {
    const doc = createNoteBodyDoc({
      bodyPmJson: {
        type: "code_block",
        content: [{ type: "text", text: "const x = 1" }],
      },
    });
    const state = EditorState.create({
      schema: noteBodySchema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    expect(splitNoteBodyAtSelection(state)).toBeNull();
    let nextState = state;
    expect(
      insertCodeNewline(state, (transaction) => {
        nextState = state.apply(transaction);
      }),
    ).toBe(true);
    expect(nextState.doc.textContent).toBe("co\nnst x = 1");
  });
});
