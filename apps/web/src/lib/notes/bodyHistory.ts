import { sameBody } from "@/lib/notes/noteBody";
import type { NoteEdit } from "@/lib/notes/useOutline";

export type NoteBodyHistory = {
  undo: Array<NoteEdit & { group: number }>;
  redo: Array<NoteEdit & { group: number }>;
  group: number;
};

export function emptyNoteBodyHistory(): NoteBodyHistory {
  return { undo: [], redo: [], group: 0 };
}

/** Contiguous typing shares a group; selection, composition and commands break it. */
export function recordNoteBodyEdit(history: NoteBodyHistory, edit: NoteEdit): NoteBodyHistory {
  const last = history.undo.at(-1);
  if (edit.source === "input" && last?.source === "input" && last.group === history.group &&
      sameBody(last.after, edit.before)) {
    return { ...history, redo: [], undo: [...history.undo.slice(0, -1),
      { ...last, after: edit.after, selectionAfter: edit.selectionAfter }] };
  }
  return { undo: [...history.undo, { ...edit, group: history.group }], redo: [],
    group: history.group + (edit.source === "input" ? 0 : 1) };
}
