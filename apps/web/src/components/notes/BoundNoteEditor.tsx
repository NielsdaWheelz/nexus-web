"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import { useWritingDocument, useWritingRuntime } from "@/lib/notes/hooks";
import { writingStoreStopped } from "@/lib/notes/runtime";
import { readBody } from "@nexus/authored/documents";
import type { EditorHistory, OutlineHistory } from "@/lib/notes/structure";
import type { NoteInspection, StructuralKeys } from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
export default function BoundNoteEditor({ noteRef, label = "edit note", editable = true, onSplit, onJoinPrevious, session, structuralKeys, inspection }: {
  noteRef: string;
  label?: string;
  editable?: boolean;
  compact?: boolean;
  onSplit?: (displayed: import("@/lib/notes/editorTypes").DisplayedSplit) => void;
  onJoinPrevious?: () => void;
  session?: OutlineHistory; structuralKeys?: StructuralKeys; inspection?: NoteInspection | null;
}) {
  const { document, error, retry } = useWritingDocument(noteRef);
  const runtime = useWritingRuntime();
  const state = useSyncExternalStore(runtime?.subscribe ?? (() => () => {}), runtime?.snapshot ?? (() => EMPTY), () => EMPTY);
  const [openedHistory,setHistory]=useState<{document:typeof document;session:typeof session;history:EditorHistory}|null>(null);
  useEffect(()=>{
    if(!document||!session)return;
    const history=session.editor(document),release=history.retain();
    setHistory({document,session,history});
    return release;
  },[document,session]);
  const history=openedHistory?.document===document&&openedHistory.session===session?openedHistory.history:undefined;
  if (error) return <div role="alert"><p>couldn’t open this note on this device.</p><Button onClick={retry}>retry</Button></div>;
  return <>
    {document && (!session || history) ? <AuthoredNoteEditor document={document} label={label} editable={editable} onSplit={onSplit} onJoinPrevious={onJoinPrevious} history={history} structuralKeys={structuralKeys} inspection={inspection} /> : <p>opening note…</p>}
    {state.error !== null && state.error_refs.includes(noteRef) ? <div role="alert"><p>{writingStoreStopped(state.error)?"the local store stopped. copy your writing before restarting nexus.":"couldn’t save on this device. keep this page open. retry saving."}</p>{writingStoreStopped(state.error) ? <Button onClick={()=>window.location.reload()}>restart nexus</Button> : <Button onClick={() => { void runtime?.retry().catch(() => {}); }}>retry</Button>}<Button onClick={() => { void navigator.clipboard.writeText(document ? readBody(document.doc).body_text : ""); }}>copy</Button></div> : null}
  </>;
}
const EMPTY = { saving: false, error: null, error_refs: [], revision: 0 };
