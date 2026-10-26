"use client";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import { useWritingDocument, useWritingRuntime } from "@/lib/notes/hooks";
import { writingStoreStopped, type WritingDocument } from "@/lib/notes/runtime";
import { readBody } from "@nexus/authored/documents";
import type { EditorHistory, OutlineHistory } from "@/lib/notes/structure";
import type { NoteInspection, StructuralKeys, NoteEditorHandle, NoteEditorProps } from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
export default function BoundNoteEditor({ noteRef, document: suppliedDocument, label = "edit note", editable = true, onSplit, onJoin, session, structuralKeys, inspection, reference, focus, onSelectionChange, onEditorReady }: {
  document?: WritingDocument;
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
  const { document: opened, error, retry } = useWritingDocument(suppliedDocument ? null : noteRef);
  const document = suppliedDocument ?? opened;
  const runtime = useWritingRuntime();
  const state = useSyncExternalStore(runtime?.subscribe ?? (() => () => {}), runtime?.snapshot ?? (() => EMPTY), () => EMPTY);
  const [openedHistory,setHistory]=useState<{document:typeof document;session:typeof session;history:EditorHistory}|null>(null);
  useLayoutEffect(()=>{
    if(!document||!session)return;
    const history=session.editor(document),release=history.retain();
    setHistory({document,session,history});
    return release;
  },[document,session]);
  const history=openedHistory?.document===document&&openedHistory.session===session?openedHistory.history:undefined;
  if (error) return <div role="alert"><p>couldn’t open this note on this device.</p><Button onClick={retry}>retry</Button></div>;
  return <>
    {document && (!session || history) ? <AuthoredNoteEditor focus={focus} onSelectionChange={onSelectionChange} onEditorReady={onEditorReady} document={document} label={label} editable={editable} onSplit={onSplit} onJoin={onJoin} history={history} structuralKeys={structuralKeys} inspection={inspection} reference={reference} /> : <p>opening note…</p>}
    {state.error !== null && state.error_refs.includes(noteRef) ? <div role="alert"><p>{writingStoreStopped(state.error)?"the local store stopped. copy your writing before restarting nexus.":"couldn’t save on this device. keep this page open. retry saving."}</p>{writingStoreStopped(state.error) ? <Button onClick={()=>window.location.reload()}>restart nexus</Button> : <Button onClick={() => { void runtime?.retry().catch(() => {}); }}>retry</Button>}<Button onClick={() => { void navigator.clipboard.writeText(document ? readBody(document.doc).body_text : ""); }}>copy</Button></div> : null}
  </>;
}
const EMPTY = { saving: false, error: null, error_refs: [], revision: 0 };
