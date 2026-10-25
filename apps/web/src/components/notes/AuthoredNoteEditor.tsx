"use client";
/** Saved notes reuse the existing contextual formatting, references and attachment
 * UI. Each surface's Yjs origin keeps its undo separate from other appearances. */
import { useEffect, useState } from "react";
import * as Y from "yjs";
import { bodyInline, readBody } from "@nexus/authored/documents";
import type { WritingDocument } from "@/lib/notes/runtime";
import type { EditorHistory } from "@/lib/notes/structure";
import type { NoteInspection, StructuralKeys } from "./NoteEditor";
import NoteEditor from "./NoteEditor";
export default function AuthoredNoteEditor({ document, label, editable = true, onSplit, onJoinPrevious, history, structuralKeys, inspection, reference }: {
  reference?: import("@/lib/resourceGraph/useReferenceInput").ReferenceInputHost | null;
  document: WritingDocument; label: string; editable?: boolean;
  onSplit?: (displayed: import("@/lib/notes/editorTypes").DisplayedSplit) => void; onJoinPrevious?: () => void;
  history?: EditorHistory; structuralKeys?: StructuralKeys; inspection?: NoteInspection | null;
}) {
  const [body, setBody] = useState(() => readBody(document.doc));
  const [own,setOwn]=useState<{document:WritingDocument;origin:symbol;manager:Y.UndoManager}|null>(null);
  useEffect(()=>{
    if(history)return;
    const origin=Symbol("note occurrence typing");
    const manager=new Y.UndoManager([document.doc.getXmlFragment("body"),bodyInline(document.doc)],{trackedOrigins:new Set([origin]),captureTimeout:500});
    setOwn({document,origin,manager});
    return()=>{manager.clear();manager.destroy();};
  },[document,history]);
  useEffect(() => {
    const update = () => setBody(readBody(document.doc));
    document.doc.on("update", update); update();
    return () => document.doc.off("update", update);
  }, [document]);
  if(!history && own?.document!==document)return <p>opening note…</p>;
  return <NoteEditor reference={reference} writingDocument={document} writingOrigin={history?.origin ?? own!.origin} body={body} revision={0} editorKey={document.ref}
    containingNoteRef={document.ref} inspection={inspection} label={label} editable={editable} compact
    history={history ?? { undo: () => own!.manager.undo(), redo: () => own!.manager.redo(), boundary: () => own!.manager.stopCapturing() }}
    keys={{ ...structuralKeys, ...(onSplit ? { split: (_left,_right,displayed) => {if(!displayed)throw new Error("bound note split requires its displayed baseline");onSplit(displayed);} } : {}), ...(onJoinPrevious ? { join: direction => { if (direction === "backward") onJoinPrevious(); }, emptyBackspace: onJoinPrevious } : {}) }}
    onEdit={() => history?.record()} />;
}
