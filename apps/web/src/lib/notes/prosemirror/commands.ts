import { type Command, type EditorState } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import {
  noteBodySchema,
  noteBodyValueFromDoc,
  type NoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
export interface NoteBodySplit {
  left: NoteBodyValue;
  right: NoteBodyValue;
}

export type NoteBodyFormat = "strong" | "em" | "underline" | "strikethrough" | "code";
export const noteBodyEditSourceMeta = "noteBodyEditSource";

export function toggleNoteBodyFormat(
  format: NoteBodyFormat,
  state: EditorState,
  dispatch?: (transaction: EditorState["tr"]) => void,
): boolean {
  const mark = noteBodySchema.marks[format];
  if (!mark || state.selection.$from.parent.type.spec.code) return false;
  const { from, to, empty, $from } = state.selection;
  const transaction = state.tr.setMeta(noteBodyEditSourceMeta, "format");
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    if (mark.isInSet(marks)) transaction.removeStoredMark(mark);
    else transaction.addStoredMark(mark.create());
  } else if (state.doc.rangeHasMark(from, to, mark)) {
    transaction.removeMark(from, to, mark);
  } else {
    transaction.addMark(from, to, mark.create());
  }
  dispatch?.(transaction);
  return true;
}

export const insertHardBreak: Command = (state, dispatch) => {
  const hardBreak = noteBodySchema.nodes.hard_break;
  if (!hardBreak || state.selection.$from.parent.type.spec.code) {
    return false;
  }
  dispatch?.(
    state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView(),
  );
  return true;
};

export const insertCodeNewline: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.type.spec.code) {
    return false;
  }
  dispatch?.(state.tr.insertText("\n").scrollIntoView());
  return true;
};

export function splitNoteBodyAtSelection(
  state: EditorState,
): NoteBodySplit | null {
  if (!state.selection.empty) state = state.apply(state.tr.deleteSelection());
  if (
    state.selection.$from.parent !== state.doc.firstChild ||
    state.selection.$from.parent.type !== noteBodySchema.nodes.paragraph
  ) {
    return null;
  }

  const body = state.doc.firstChild;
  if (!body) {
    return null;
  }
  const offset = state.selection.$from.parentOffset;
  const leftDoc = noteBodySchema.nodes.note_body_doc!.create(
    null,
    body.copy(body.content.cut(0, offset)),
  );
  const rightDoc = noteBodySchema.nodes.note_body_doc!.create(
    null,
    body.copy(body.content.cut(offset, body.content.size)),
  );
  return {
    left: noteBodyValueFromDoc(leftDoc),
    right: noteBodyValueFromDoc(rightDoc),
  };
}

export function createNoteBodyKeymap(actions: {
  format: (format: NoteBodyFormat) => boolean;
  link: () => boolean;
  undo: () => void;
  redo: () => void;
}) {
  const enter: Command = (state, dispatch, view) =>
    insertCodeNewline(state, dispatch, view) ||
    insertHardBreak(state, dispatch, view);
  const format = (name: NoteBodyFormat): Command => (_state, _dispatch, view) =>
    !view?.composing && actions.format(name);
  const action = (run: () => void): Command => (_state, _dispatch, view) => {
    if (view?.composing) return false;
    run();
    return true;
  };
  return keymap({
    Enter: enter,
    "Shift-Enter": enter,
    "Mod-b": format("strong"),
    "Mod-i": format("em"),
    "Mod-u": format("underline"),
    "Shift-Mod-s": format("strikethrough"),
    "Mod-e": format("code"),
    "Mod-k": (_state, _dispatch, view) =>
      !view?.composing && actions.link(),
    "Mod-z": action(actions.undo),
    "Mod-y": action(actions.redo),
    "Shift-Mod-z": action(actions.redo),
  });
}
