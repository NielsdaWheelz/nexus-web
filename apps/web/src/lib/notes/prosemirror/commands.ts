import { Fragment, type Node as ProseMirrorNode } from "prosemirror-model";
import { Plugin, type Command, type EditorState } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  noteBodySchema,
  noteBodyValueFromDoc,
  type NoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
import { isResourceScheme } from "@/lib/resourceGraph/resourceRef";
import { resourceCanBeNoteReferenceTarget } from "@/lib/resources/resourceCapabilities";

const OBJECT_REF_PATTERN =
  /\[\[([a-z_]+):([0-9a-fA-F-]{36})(?:\|([^\]]+))?\]\]/g;

export interface NoteBodySplit {
  left: NoteBodyValue;
  right: NoteBodyValue;
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
  if (
    !state.selection.empty ||
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

export function createNoteBodyKeymap() {
  const enter: Command = (state, dispatch, view) =>
    insertCodeNewline(state, dispatch, view) ||
    insertHardBreak(state, dispatch, view);
  return keymap({
    Enter: enter,
    "Shift-Enter": enter,
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,
  });
}

export function createObjectRefSyntaxPlugin() {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) {
        return null;
      }

      const replacements: {
        from: number;
        to: number;
        nodes: ProseMirrorNode[];
      }[] = [];

      newState.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) {
          return true;
        }

        const nodes: ProseMirrorNode[] = [];
        let lastIndex = 0;
        for (const match of node.text.matchAll(OBJECT_REF_PATTERN)) {
          const index = match.index ?? 0;
          const objectType = match[1]!;
          if (
            !isResourceScheme(objectType) ||
            !resourceCanBeNoteReferenceTarget(objectType)
          ) {
            continue;
          }
          if (index > lastIndex) {
            nodes.push(
              noteBodySchema.text(
                node.text.slice(lastIndex, index),
                node.marks,
              ),
            );
          }
          const objectId = match[2]!.toLowerCase();
          const label = (match[3] ?? `${objectType}:${objectId}`).trim();
          nodes.push(
            noteBodySchema.nodes.object_ref!.create({
              objectType,
              objectId,
              label,
            }),
          );
          lastIndex = index + match[0].length;
        }

        if (nodes.length === 0) {
          return true;
        }
        if (lastIndex < node.text.length) {
          nodes.push(
            noteBodySchema.text(node.text.slice(lastIndex), node.marks),
          );
        }
        replacements.push({ from: pos, to: pos + node.nodeSize, nodes });
        return true;
      });

      if (replacements.length === 0) {
        return null;
      }
      const tr = newState.tr;
      for (const replacement of replacements.reverse()) {
        tr.replaceWith(
          replacement.from,
          replacement.to,
          Fragment.fromArray(replacement.nodes),
        );
      }
      return tr.docChanged ? tr : null;
    },
  });
}
