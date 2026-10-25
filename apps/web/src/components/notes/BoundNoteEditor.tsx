"use client";
import { useMemo, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import { useWritingDocument, useWritingRuntime } from "@/lib/notes/hooks";
import { readBody } from "@nexus/authored/documents";
import type { OutlineHistory } from "@/lib/notes/structure";
import type { NoteInspection, StructuralKeys } from "./NoteEditor";
import AuthoredNoteEditor from "./AuthoredNoteEditor";
export default function BoundNoteEditor({ noteRef, label = "edit note", editable = true, onSplit, onJoinPrevious, session, structuralKeys, inspection }: {
  noteRef: string;
  label?: string;
  editable?: boolean;
  compact?: boolean;
  onSplit?: (position: number) => void;
  onJoinPrevious?: () => void;
  session?: OutlineHistory; structuralKeys?: StructuralKeys; inspection?: NoteInspection | null;
}) {
  const { document, error } = useWritingDocument(noteRef);
  const runtime = useWritingRuntime();
  const state = useSyncExternalStore(runtime?.subscribe ?? (() => () => {}), runtime?.snapshot ?? (() => EMPTY), () => EMPTY);
  const history = useMemo(() => document && session ? session.editor(document) : undefined, [document, session]);
  if (error) return <p role="alert">couldn’t open this note on this device.</p>;
  return <>
    {document ? <AuthoredNoteEditor document={document} label={label} editable={editable} onSplit={onSplit} onJoinPrevious={onJoinPrevious} history={history} structuralKeys={structuralKeys} inspection={inspection} /> : <p>opening note…</p>}
    {state.error !== null && state.error_refs.includes(noteRef) ? <div role="alert"><p>couldn’t save on this device. keep this page open. retry saving.</p><Button onClick={() => { void runtime?.retry().catch(() => {}); }}>retry</Button><Button onClick={() => { void navigator.clipboard.writeText(document ? readBody(document.doc).body_text : ""); }}>copy</Button></div> : null}
  </>;
}
const EMPTY = { saving: false, error: null, error_refs: [], revision: 0 };
