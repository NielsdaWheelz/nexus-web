"use client";
import { useLayoutEffect, useState } from "react";
import { useWritingDocument } from "@/lib/notes/hooks";
import { type WritingDocument } from "@/lib/notes/runtime";
import {Ruling} from "@/components/feedback/Ruling";
import AuthoredReadFailure from "./AuthoredReadFailure";
import type { EditorHistory, OutlineHistory } from "@/lib/notes/structure";
import type { NoteInspection, StructuralKeys, NoteEditorHandle, NoteEditorProps } from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
export default function BoundNoteEditor({ noteRef, document: suppliedDocument, history: suppliedHistory, label = "edit note", editable = true, onSplit, onJoin, session, structuralKeys, inspection, reference, focus, onSelectionChange, onEditorReady, onAttachmentActiveChange, onLinkInputActiveChange }: {
  document?: WritingDocument; history?: EditorHistory;
  onAttachmentActiveChange?: NoteEditorProps["onAttachmentActiveChange"]; onLinkInputActiveChange?: NoteEditorProps["onLinkInputActiveChange"];
  focus?: NoteEditorProps["focus"]; onSelectionChange?: NoteEditorProps["onSelectionChange"]; onEditorReady?: (editor: NoteEditorHandle | null) => void;
  reference?: import("@/lib/resourceGraph/useReferenceInput").ReferenceInputHost | null;
  noteRef: string;
  label?: string;
  editable?: boolean;
  compact?: boolean;
  onSplit?: (displayed: import("@/lib/notes/editorTypes").DisplayedSplit) => void;
  onJoin?: (direction:"backward"|"forward",displayed:Promise<import("@/lib/notes/runtime").WritingSnapshot>) => void;
  session?: OutlineHistory; structuralKeys?: StructuralKeys; inspection?: NoteInspection | null;
}) {
  const kind = noteRef.startsWith("highlight:") ? "annotation" : "note";
  const { document: opened, error, pending, retry } = useWritingDocument(suppliedDocument ? null : noteRef);
  const document = suppliedDocument ?? opened;
  const [openedHistory,setHistory]=useState<{document:typeof document;session:typeof session;history:EditorHistory}|null>(null);
  useLayoutEffect(()=>{
    if(!document||!session)return;
    const history=session.editor(document),release=history.retain();
    setHistory({document,session,history});
    return release;
  },[document,session]);
  const history=suppliedHistory ?? (openedHistory?.document===document&&openedHistory.session===session?openedHistory.history:undefined);
  return <>
    {pending && !document ? <Ruling/> : null}
    <AuthoredReadFailure error={error} pending={pending} retry={retry} noun={`this ${kind}`}/>
    {document && (!session || history) ? <AuthoredNoteEditor focus={focus} onAttachmentActiveChange={onAttachmentActiveChange} onLinkInputActiveChange={onLinkInputActiveChange} onSelectionChange={onSelectionChange} onEditorReady={onEditorReady} document={document} label={label} editable={editable} onSplit={onSplit} onJoin={onJoin} history={history} structuralKeys={structuralKeys} inspection={inspection} reference={reference} /> : null}
  </>;
}
