"use client";
/** Saved notes reuse the existing contextual formatting, references and attachment
 * UI. Each surface's Yjs origin keeps its undo separate from other appearances. */
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { docFromBody } from "@nexus/authored/body";
import { bodyInline, readBody } from "@nexus/authored/documents";
import type { WritingDocument } from "@/lib/notes/runtime";
import type { EditorHistory } from "@/lib/notes/structure";
import type { NoteInspection, StructuralKeys } from "./NoteEditor";
import NoteEditor from "./NoteEditor";
export default function AuthoredNoteEditor({ document, label, editable = true, onSplit, onJoinPrevious, history, structuralKeys, inspection }: {
  document: WritingDocument; label: string; editable?: boolean;
  onSplit?: (position: number) => void; onJoinPrevious?: () => void;
  history?: EditorHistory; structuralKeys?: StructuralKeys; inspection?: NoteInspection | null;
}) {
  const [body, setBody] = useState(() => readBody(document.doc));
  const own = useMemo(() => {
    const origin = Symbol("note occurrence typing");
    return { origin, manager: new Y.UndoManager([document.doc.getXmlFragment("body"), bodyInline(document.doc)], { trackedOrigins: new Set([origin]), captureTimeout: 500 }) };
  }, [document]);
  useEffect(() => () => own.manager.destroy(), [own]);
  useEffect(() => {
    const update = () => setBody(readBody(document.doc));
    document.doc.on("update", update); update();
    return () => document.doc.off("update", update);
  }, [document]);
  return <NoteEditor writingDocument={document} writingOrigin={history?.origin ?? own.origin} body={body} revision={0} editorKey={document.ref}
    containingNoteRef={document.ref} inspection={inspection} label={label} editable={editable} compact
    history={history ?? { undo: () => own.manager.undo(), redo: () => own.manager.redo(), boundary: () => own.manager.stopCapturing() }}
    keys={{ ...structuralKeys, ...(onSplit ? { split: left => onSplit(docFromBody(left).firstChild!.content.size + 1) } : {}), ...(onJoinPrevious ? { join: direction => { if (direction === "backward") onJoinPrevious(); }, emptyBackspace: onJoinPrevious } : {}) }}
    onEdit={() => history?.record()} />;
}
