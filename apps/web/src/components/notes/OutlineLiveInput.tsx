"use client";
/** A reparent keeps the existing shared document and active input alive until
 * its new occurrence has an editor. No body is copied or persisted twice. */
import {useLayoutEffect, useMemo} from "react";
import type {WritingDocument} from "@/lib/notes/runtime";
import type {OutlineHistory, OutlineBookmark} from "@/lib/notes/structure";
import type {NoteEditorHandle, StructuralKeys} from "./NoteEditor";
import type {DisplayedSplit} from "@/lib/notes/editorTypes";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
import BoundPageTitleEditor from "./BoundPageTitleEditor";
export default function OutlineLiveInput({document, history, before, onReady, onSelectionChange, onSplit, onEnter, keys}: {
  document: WritingDocument; history: OutlineHistory; before: OutlineBookmark;
  onReady(editor: NoteEditorHandle | null): void;
  onSelectionChange(selection: {anchor: number; head: number}): void;
  onSplit(split: DisplayedSplit): void; onEnter(): void; keys: StructuralKeys;
}) {
  const editing = useMemo(() => history.editor(document), [history, document]);
  useLayoutEffect(() => editing.retain(), [editing]);
  const ready = (editor: NoteEditorHandle | null) => {onReady(editor); if (editor) editor.focus(before.resolve ?? before.selection ?? "end", true);};
  return document.ref.startsWith("page:")
    ? <BoundPageTitleEditor document={document} pageRef={document.ref} session={history} label="edit page title" onEditorReady={ready} onSelectionChange={onSelectionChange} onEnter={onEnter} structuralKeys={keys}/>
    : <AuthoredNoteEditor document={document} history={editing} label="edit note" onEditorReady={ready} onSelectionChange={onSelectionChange} onSplit={onSplit} structuralKeys={keys}/>;
}
