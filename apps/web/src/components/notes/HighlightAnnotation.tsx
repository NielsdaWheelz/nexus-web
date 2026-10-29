"use client";

/** A highlight's permanent body. First writing stays in an opening clone until
 * explicit save; subsequent writing uses the ordinary durable document owner. */
import {useCallback, useEffect, useRef, useState} from "react";
import * as Y from "yjs";
import {bodyHasContent, noteBodySchema, rawBodyText, type NoteBody} from "@nexus/authored/body";
import type {EditorHistory} from "@/lib/notes/structure";
import type {WritingDocument} from "@/lib/notes/runtime";
import {bodyInline, readBody} from "@nexus/authored/documents";
import Button from "@/components/ui/Button";
import {useAuthoredQuery, useWritingDocument, useWritingRuntime} from "@/lib/notes/hooks";
import {applyDraftBody} from "@/lib/notes/editorBinding";
import {useEditorDraft} from "@/lib/notes/editorHost";
import {LocalCommitError} from "@/lib/notes/runtime";
import {useWorkGuard} from "@/lib/unsavedWork";
import {getInteractionGeneration} from "@/lib/ui/overlay";
import {createLink, prepareLink, prepareTarget, type LinkTarget} from "@/lib/resourceGraph/links";
import {copyText} from "@/lib/ui/copyText";
import BoundNoteEditor from "./BoundNoteEditor";
import NoteEditor, {type NoteEditorHandle, type NoteInspection} from "./NoteEditor";

type Draft = {doc: Y.Doc; vector: Uint8Array; body: NoteBody; revision: number; reference: boolean; hyperlink: boolean; attachment: boolean; links: {target: LinkTarget; label: string}[]};
const risk = (value: Draft | null) => ({changed: value !== null && (bodyHasContent(value.body) || value.reference || value.hyperlink || value.links.length > 0), unconfirmed: false, stopsBrowserWork: value?.attachment === true});
export default function HighlightAnnotation({highlightRef, occurrenceKey, editable = true, focusRequest = null, onFocused, inspection = null, onEditorReady, mayFocus, onWorkOwners}: {
  onWorkOwners?: (owners: readonly string[]) => void;
  highlightRef: string; occurrenceKey: string; editable?: boolean; focusRequest?: number | null; onFocused?: () => void;
  mayFocus?: () => boolean; inspection?: NoteInspection | null; onEditorReady?: (handle: NoteEditorHandle | null) => void;
}) {
  const read = useAuthoredQuery({kind: "resource", ref: highlightRef});
  const resource = read.data?.rows[0]?.resource;
  const writing = useWritingRuntime();
  const opened = useWritingDocument(editable ? highlightRef : null);
  const guard = useWorkGuard();
  const [history, setHistory] = useState<{document: WritingDocument; value: EditorHistory} | null>(null);
  useEffect(() => {
    const document = opened.document;
    if (!document) return;
    const origin = Symbol("highlight annotation occurrence");
    const manager = new Y.UndoManager([document.doc.getXmlFragment("body"), bodyInline(document.doc)], {trackedOrigins: new Set([origin]), captureTimeout: 500});
    setHistory({document, value: {origin, retain: document.retain, undo: () => manager.undo(), redo: () => manager.redo(), boundary: () => manager.stopCapturing(), record: () => {}}});
    return () => {manager.clear(); manager.destroy();};
  }, [opened.document]);
  const ownHistory = history?.document === opened.document ? history.value : null;
  const draft = useEditorDraft<Draft | null>(`Highlight.Annotation:${occurrenceKey}`, () => null, risk, value => value?.body.body_text ?? null);
  const input = useEditorDraft(`Highlight.Input:${occurrenceKey}`, () => ({reference: false, hyperlink: false, attachment: false}), value => ({changed: value.reference || value.hyperlink, unconfirmed: false, stopsBrowserWork: value.attachment}));
  useEffect(() => {onWorkOwners?.([draft.owner, input.owner]);}, [onWorkOwners, draft.owner, input.owner]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{message: string; retry: (() => void) | null} | null>(null);
  const editor = useRef<NoteEditorHandle | null>(null);
  const pendingFocus = useRef<{token: number; generation: number} | null>(null);
  const consumed = useRef<number | null>(null);
  const value = draft.value;
  const readDraft = draft.read, setDraft = draft.set;
  const allowFocus = useRef(mayFocus); allowFocus.current = mayFocus;
  const hasBody = resource?.body_pm_json !== null && resource?.body_pm_json !== undefined;
  useEffect(() => {if (hasBody) setEditing(true);}, [hasBody]);
  const begin = useCallback(() => {
    if (!opened.document || readDraft() !== null) return;
    pendingFocus.current ??= {token: -1, generation: getInteractionGeneration()};
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(opened.document.doc));
    setDraft({doc, vector: Y.encodeStateVector(doc), body: readBody(doc), revision: 0, reference: false, hyperlink: false, attachment: false, links: []});
  }, [opened.document, readDraft, setDraft]);
  useEffect(() => {
    if (focusRequest === null || consumed.current === focusRequest) return;
    if (pendingFocus.current?.token !== focusRequest) pendingFocus.current = {token: focusRequest, generation: getInteractionGeneration()};
    if (hasBody || editing) setEditing(true); else begin();
    if (editor.current) {if (pendingFocus.current.generation === getInteractionGeneration() && (allowFocus.current?.() ?? true)) editor.current.focus("end"); consumed.current = focusRequest; pendingFocus.current = null; onFocused?.();}
  }, [focusRequest, hasBody, editing, begin, onFocused]);
  const ready = useCallback((handle: NoteEditorHandle | null) => {
    editor.current = handle; onEditorReady?.(handle);
    if (handle && pendingFocus.current !== null) {
      if (pendingFocus.current.generation === getInteractionGeneration() && (allowFocus.current?.() ?? true)) handle.focus("end"); consumed.current = pendingFocus.current.token; pendingFocus.current = null; onFocused?.();
    }
  }, [onEditorReady, onFocused]);
  const copyWriting = () => {
    const body = draft.read()?.body ?? (opened.document ? readBody(opened.document.doc) : null);
    return copyText(body ? rawBodyText(noteBodySchema.nodeFromJSON(body.body_pm_json)) : "");
  };
  const cancel = () => {
    if (!guard.confirmLoss({scopes: [], ownerIds: [draft.owner]})) return;
    draft.read()?.doc.destroy(); draft.set(null); setFailure(null);
  };
  const save = () => {
    const current = draft.read(), document = opened.document;
    if (!current || !document || !writing || !ownHistory || busy || current.reference || current.hyperlink || current.attachment || !editor.current?.settleNativeInput()) return;
    if (!resource) return;
    const submitted = draft.read()!;
    const delta = Y.encodeStateAsUpdate(submitted.doc, submitted.vector), revision = submitted.revision;
    const origin = ownHistory.origin;
    ownHistory.boundary();
    setBusy(true); setFailure(null);
    let admitted;
    try {admitted = writing.admitWriting({existing: [{document, origin}], notes: [], mutate: () => {Y.applyUpdate(document.doc, delta, origin);}, prepare: async () => {
      const intents = [];
      for (const link of submitted.links) {const target = await prepareTarget(writing, link.target); const prepared = await prepareLink(writing, {source_ref: highlightRef, target_ref: target.ref, source_label: null, target_label: link.label, after: null}); intents.push(...target.intents, ...prepared.intents);}
      return intents;
    }});
    } catch (error) {setBusy(false); draft.set(submitted); setFailure({message: error instanceof Error ? error.message : "couldn’t save this annotation", retry: null}); return;}
    ownHistory.boundary();
    const finish = () => {
      setBusy(false); setFailure(null); setEditing(true);
      const latest = draft.read();
      if (latest?.doc !== submitted.doc || latest.reference || latest.hyperlink || latest.attachment || !editor.current?.settleNativeInput()) return;
      const settled = draft.read();
      if (settled?.doc === submitted.doc && settled.revision === revision) {settled.doc.destroy(); draft.set(null);}
    };
    void admitted.result.then(finish, (error: unknown) => {
      setBusy(false);
      if (error instanceof LocalCommitError) {
        setFailure({message: "couldn’t save on this device", retry: () => {setBusy(true); void error.retry().catch(() => setBusy(false));}});
        void error.completion.then(finish, () => {});
      } else setFailure({message: error instanceof Error ? error.message : "couldn’t save this annotation", retry: null});
    });
  };
  if ((!resource?.authored_by_viewer || resource.kind !== "highlight") && value === null && !editing) return null;
  if (!editable) return resource?.body_pm_json ? <NoteEditor editorKey={`annotation-preview:${occurrenceKey}`} containingNoteRef={highlightRef} body={{body_pm_json: resource.body_pm_json, body_text: resource.body_text!}} revision={0} label="annotation" editable={false} history={null} onEdit={() => {}} atomicEmbeds/> : null;
  return <section aria-label="annotation" data-highlight-annotation={highlightRef}>
    {!resource && (value || editing) ? <p role="status">this highlight is unavailable. your writing is kept. <Button onClick={() => {void copyWriting();}}>copy</Button></p> : null}
    {value ? <>
      <NoteEditor editorKey={`annotation-draft:${occurrenceKey}`} containingNoteRef={highlightRef} body={value.body} revision={value.revision} label="annotation" placeholder="write an annotation…" editable compact history={null}
        reference={{source_ref: highlightRef, label: "annotation", onActiveChange: reference => draft.set(current => current && {...current, reference}), onSelected: (target, item) => draft.set(current => current && {...current, reference: false, links: [...current.links, {target, label: item.label}], revision: current.revision + 1})}}
        onEditorReady={ready} onSave={() => queueMicrotask(save)} onEdit={edit => {const current = draft.read(); if (!current) return; applyDraftBody(current.doc, edit.before, edit.after); draft.set({...current, body: edit.after, revision: current.revision + 1});}}
        onLinkInputActiveChange={hyperlink => draft.set(current => current && {...current, hyperlink})}
        onAttachmentActiveChange={attachment => draft.set(current => current && {...current, attachment})}/>
      <Button emphasis="strong" disabled={!resource || busy || value.reference || value.hyperlink || value.attachment} onClick={save}>save annotation</Button>
      <Button disabled={busy} onClick={cancel}>cancel</Button>
    </> : hasBody || editing ? <>
      <BoundNoteEditor noteRef={highlightRef} history={ownHistory ?? undefined} label="edit annotation" editable={resource !== undefined} onAttachmentActiveChange={attachment => input.set(value => ({...value, attachment}))} onLinkInputActiveChange={hyperlink => input.set(value => ({...value, hyperlink}))} document={opened.document ?? undefined} onEditorReady={ready} inspection={inspection} reference={writing ? {source_ref: highlightRef, label: "annotation", onActiveChange: reference => input.set(value => ({...value, reference})), onSelected: (target, item) => {void prepareTarget(writing, target).then(prepared => createLink(writing, {source_ref: highlightRef, target_ref: prepared.ref, source_label: null, target_label: item.label, after: null, prelude: prepared.intents})).catch((error: unknown) => {
        const notice = {message: error instanceof LocalCommitError ? "couldn’t save on this device" : error instanceof Error ? error.message : "couldn’t link this annotation", retry: error instanceof LocalCommitError ? () => {void error.retry().catch(() => {});} : null};
        setFailure(notice);
        if (error instanceof LocalCommitError) void error.completion.then(() => setFailure(current => current === notice ? null : current), () => {});
      });}} : null}/>
      <Button disabled={!hasBody} onClick={() => editor.current?.clear?.()}>clear annotation</Button>
    </> : <Button disabled={!opened.document} onClick={begin}>annotate</Button>}
    {opened.error ? <div role="alert">couldn’t open this annotation on this device. <Button onClick={opened.retry}>retry</Button></div> : null}
    {failure ? <div role="alert"><p>{failure.message}</p>{failure.retry ? <Button disabled={busy} onClick={failure.retry}>retry saving</Button> : null}<Button onClick={() => {void copyWriting();}}>copy</Button></div> : null}
  </section>;
}
