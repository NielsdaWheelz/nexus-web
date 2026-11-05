"use client";

/** A highlight's permanent body. First writing stays in an opening clone until
 * explicit save; subsequent writing uses the ordinary durable document owner. */
import {useCallback, useEffect, useRef, useState} from "react";
import * as Y from "yjs";
import {bodyHasContent, noteBodySchema, rawBodyText, type NoteBody} from "@nexus/authored/body";
import type {EditorHistory} from "@/lib/notes/structure";
import type {WritingDocument} from "@/lib/notes/runtime";
import {bodyInline, readBody} from "@nexus/authored/documents";
import {assertNever} from "@/lib/assertNever";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import {useCopyFeedback} from "@/components/ui/useCopyFeedback";
import {useOutcome} from "@/components/feedback/Feedback";
import {Fact} from "@/components/feedback/Fact";
import AuthoredReadFailure from "./AuthoredReadFailure";
import {useWritingDocument, useWritingRuntime} from "@/lib/notes/hooks";
import {applyDraftBody} from "@/lib/notes/editorBinding";
import {useEditorDraft} from "@/lib/notes/editorHost";
import {LocalCommitError, isAuthoredStorageFailure} from "@/lib/notes/runtime";
import {useWorkGuard} from "@/lib/unsavedWork";
import {getInteractionGeneration, interactionOwnedElsewhere, useInteractionOwner} from "@/lib/ui/overlay";
import {usePointerGesture} from "@/lib/ui/pointerGesture";
import {createLink, prepareLink, prepareTarget, LinkInputRefusal, type LinkTarget} from "@/lib/resourceGraph/links";
import {ClipboardWriteUnavailableError} from "@/lib/ui/copyText";
import type {ResourceProjection} from "@nexus/authored/types";
import BoundNoteEditor from "./BoundNoteEditor";
import NoteEditor, {type NoteEditorHandle, type NoteInspection} from "./NoteEditor";

type Draft = {committing: boolean; doc: Y.Doc; vector: Uint8Array; body: NoteBody; revision: number; reference: boolean; hyperlink: boolean; attachment: boolean; links: {target: LinkTarget; label: string}[]};
const risk = (value: Draft | null) => ({changed: value !== null && (bodyHasContent(value.body) || value.reference || value.hyperlink || value.links.length > 0), unconfirmed: false, stopsBrowserWork: value?.attachment === true});
export default function HighlightAnnotation({highlightRef, resource, rest = true, occurrenceKey, editable = true, offerBlank = true, focusRequest = null, onFocused, inspection = null, onEditorReady, mayFocus, onWorkOwners}: {
  onWorkOwners?: (owners: readonly string[]) => void;
  /** The host's read of the highlight; null is read and absent, so hosts mount this only once their read has data. */
  resource: ResourceProjection | null;
  /** The host has come to rest: a bodied annotation may open its document. */
  rest?: boolean;
  highlightRef: string; occurrenceKey: string; editable?: boolean; offerBlank?: boolean; focusRequest?: number | null; onFocused?: () => void;
  mayFocus?: () => boolean; inspection?: NoteInspection | null; onEditorReady?: (handle: NoteEditorHandle | null) => void;
}) {
  const writing = useWritingRuntime();
  const owned = useRef<string | null>(null);
  if (resource?.authored_by_viewer && resource.kind === "highlight") owned.current = highlightRef;
  const draft = useEditorDraft<Draft | null>(`Highlight.Annotation:${occurrenceKey}`, () => null, risk, value => value?.body.body_text ?? null);
  const [editing, setEditing] = useState(false);
  // a click before the document opened; the effect below finishes it.
  const [asked, setAsked] = useState(false);
  const hasBody = resource?.body_pm_json !== null && resource?.body_pm_json !== undefined;
  // a blank row opens no document until asked; opening is one way, so emptying never closes it.
  const wanted = asked || focusRequest !== null || draft.value !== null || (hasBody || editing) && rest;
  const opening = useRef(false); opening.current ||= wanted;
  const opened = useWritingDocument(editable && owned.current === highlightRef && opening.current ? highlightRef : null);
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
  const input = useEditorDraft(`Highlight.Input:${occurrenceKey}`, () => ({reference: false, hyperlink: false, attachment: false}), value => ({changed: value.reference || value.hyperlink, unconfirmed: false, stopsBrowserWork: value.attachment}));
  useEffect(() => {onWorkOwners?.([draft.owner, input.owner]);}, [onWorkOwners, draft.owner, input.owner]);
  const [busy, setBusy] = useState(false);
  const {say} = useOutcome();
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const copied = useCopyFeedback(occurrenceKey);
  const editor = useRef<NoteEditorHandle | null>(null);
  const pendingFocus = useRef<({kind: "Internal"; generation: number} | {kind: "External"; highlightRef: string; token: number; generation: number}) | null>(null);
  const consumed = useRef<{highlightRef: string; token: number} | null>(null);
  const value = draft.value;
  const readDraft = draft.read, setDraft = draft.set;
  const section = useRef<HTMLElement>(null);
  const within = (target: EventTarget | null) => target instanceof Node && section.current?.contains(target) === true;
  const settle = useRef<(next: EventTarget | null) => void>(() => {});
  // No `within`: the field's own press counts too, because one that light-dismisses a held
  // menu closes it at pointerdown, before focus is back in the field.
  const {active} = usePointerGesture({enabled: value === null && editing && !hasBody, onComplete: () => settle.current(null)});
  const interaction = useInteractionOwner();
  settle.current = next => {
    const doc = opened.document?.doc, current = input.read();
    if (hasBody || !doc || active() || interactionOwnedElsewhere(section.current) || current.reference || current.hyperlink || current.attachment) return;
    if (within(next) || within(document.activeElement)) return;
    if (editor.current?.settleNativeInput() === false) return;
    if (!bodyHasContent(readBody(doc))) setEditing(false);
  };
  const open = input.value.reference || input.value.hyperlink || input.value.attachment;
  useEffect(() => {
    if (hasBody) {setEditing(true); return;}
    const doc = opened.document?.doc, update = () => settle.current(null);
    update(); doc?.on("update", update);
    return () => doc?.off("update", update);
  }, [hasBody, open, interaction, opened.document]);
  const begin = useCallback(() => {
    if (!opened.document || readDraft() !== null) return;
    pendingFocus.current ??= {kind: "Internal", generation: getInteractionGeneration()};
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(opened.document.doc));
    setDraft({committing: false, doc, vector: Y.encodeStateVector(doc), body: readBody(doc), revision: 0, reference: false, hyperlink: false, attachment: false, links: []});
  }, [opened.document, readDraft, setDraft]);
  // `begin` has no body guard, so this check keeps a stand-in click from becoming a composer.
  useEffect(() => {if (asked && opened.document) {setAsked(false); if (!hasBody && !editing) begin();}}, [asked, opened.document, hasBody, editing, begin]);
  const deliverFocus = useCallback((handle: NoteEditorHandle) => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    pendingFocus.current = null;
    switch (pending.kind) {
      case "Internal": break;
      case "External":
        if (pending.highlightRef !== highlightRef || pending.token !== focusRequest) return;
        // focusing blurs the invoker, which may cancel this request at its host.
        consumed.current = {highlightRef: pending.highlightRef, token: pending.token};
        break;
      default: return assertNever(pending);
    }
    if (pending.generation === getInteractionGeneration() && (mayFocus?.() ?? true)) handle.focus("end");
    if (pending.kind === "External") onFocused?.();
  }, [highlightRef, focusRequest, mayFocus, onFocused]);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending?.kind === "External" && (pending.highlightRef !== highlightRef || pending.token !== focusRequest)) pendingFocus.current = null;
    if (focusRequest === null || consumed.current?.highlightRef === highlightRef && consumed.current.token === focusRequest) return;
    if (pendingFocus.current?.kind !== "External" || pendingFocus.current.highlightRef !== highlightRef || pendingFocus.current.token !== focusRequest)
      pendingFocus.current = {kind: "External", highlightRef, token: focusRequest, generation: getInteractionGeneration()};
    if (hasBody || editing) setEditing(true); else begin();
    if (editor.current) deliverFocus(editor.current);
  }, [highlightRef, focusRequest, hasBody, editing, begin, deliverFocus]);
  const ready = useCallback((handle: NoteEditorHandle | null) => {
    editor.current = handle; onEditorReady?.(handle);
    if (handle) deliverFocus(handle);
  }, [onEditorReady, deliverFocus]);
  const copyText = () => {
    const body = draft.read()?.body ?? (opened.document ? readBody(opened.document.doc) : null);
    return body ? rawBodyText(noteBodySchema.nodeFromJSON(body.body_pm_json)) : "";
  };
  const copyWriting = () => {
    void copied.copy(copyText()).then(() => setManualCopy(null), (error: unknown) => {
      if (error instanceof ClipboardWriteUnavailableError) setManualCopy(copyText());
      else setDefect({error});
    });
  };
  const link = (target: LinkTarget, label: string) => {
    if (!writing) return;
    let pending = false;
    let retract = () => {};
    const attempt = () => {
      if (pending) return;
      pending = true;
      void prepareTarget(writing, target).then(prepared => createLink(writing, {source_ref: highlightRef, target_ref: prepared.ref,
        source_label: null, target_label: label, after: null, prelude: prepared.intents})).then(() => retract(), (error: unknown) => {
        // A failed local commit is words at risk: the account holds it.
        if (error instanceof LocalCommitError) retract();
        else if (error instanceof LinkInputRefusal) retract = say({fact: error.message});
        else if (isAuthoredStorageFailure(error)) retract = say({fact: "couldn’t link this annotation."}, [{label: "retry", commandKey: "RetryAnnotationLink", run: attempt}]);
        else setDefect({error});
      }).finally(() => {pending = false;});
    };
    attempt();
  };
  const cancel = () => {
    if (draft.read()?.committing) return;
    if (!guard.confirmLoss({scopes: [], ownerIds: [draft.owner]})) return;
    draft.read()?.doc.destroy(); draft.set(null);
  };
  const save = () => {
    const current = draft.read(), document = opened.document;
    if (!current || !document || !writing || !ownHistory || busy || current.committing || current.reference || current.hyperlink || current.attachment || !editor.current?.settleNativeInput()) return;
    if (!resource) return;
    const submitted = draft.read()!;
    const delta = Y.encodeStateAsUpdate(submitted.doc, submitted.vector), revision = submitted.revision;
    const origin = ownHistory.origin;
    ownHistory.boundary();
    setBusy(true);
    let admitted;
    try {admitted = writing.admitWriting({existing: [{document, origin}], notes: [], mutate: () => {Y.applyUpdate(document.doc, delta, origin);}, prepare: async () => {
      const intents = [];
      for (const link of submitted.links) {const target = await prepareTarget(writing, link.target); const prepared = await prepareLink(writing, {source_ref: highlightRef, target_ref: target.ref, source_label: null, target_label: link.label, after: null}); intents.push(...target.intents, ...prepared.intents);}
      return intents;
    }});
    } catch (error) {setBusy(false); setDefect({error}); return;}
    draft.set(current => current?.doc === submitted.doc ? {...current, committing: true} : current);
    ownHistory.boundary();
    const finish = () => {
      setBusy(false); setEditing(bodyHasContent(readBody(document.doc)));
      const latest = draft.read();
      if (latest?.doc !== submitted.doc) return;
      if (latest.revision === revision) {latest.doc.destroy(); draft.set(null);}
      else draft.set({...latest, committing: false});
    };
    void admitted.result.then(finish, (error: unknown) => {
      setBusy(false);
      if (error instanceof LocalCommitError) {
        void error.completion.then(finish, () => {});
      } else setDefect({error});
    });
  };
  if (defect) throw defect.error;
  // The host owns the projection read; a failed document open stays beside its annotation.
  const coldFailure = opened.error !== null ? opened : null;
  const feedback = <>
    {coldFailure ? <AuthoredReadFailure error={coldFailure.error} pending={coldFailure.pending} retry={coldFailure.retry} noun="this annotation"/> : null}
    <Dialog open={manualCopy !== null} title="copy text" onClose={() => setManualCopy(null)}>
      <p>select the text and copy it.</p><textarea readOnly value={manualCopy ?? ""} aria-label="annotation text"/>
    </Dialog>
  </>;
  if ((!resource?.authored_by_viewer || resource.kind !== "highlight") && value === null && !editing) return feedback;
  if (!offerBlank && !hasBody && !editing && value === null) return feedback;
  if (!editable) return <>{feedback}{resource?.body_pm_json ? <NoteEditor editorKey={`annotation-preview:${occurrenceKey}`} containingNoteRef={highlightRef} body={{body_pm_json: resource.body_pm_json, body_text: resource.body_text!}} revision={0} label="annotation" editable={false} history={null} onEdit={() => {}} atomicEmbeds/> : null}</>;
  return <section ref={section} aria-label="annotation" data-highlight-annotation={highlightRef} onBlur={event => settle.current(event.relatedTarget)}>
    {feedback}
    {!resource && (value || editing) ? <Fact line={{fact: "this highlight is unavailable.", reason: "your writing is still here."}}
      verbs={[{label: "copy text", commandKey: "CopyAnnotation", copied: copied.occurrence ?? undefined, run: copyWriting}]}/> : null}
    {value ? <>
      <NoteEditor editorKey={`annotation-draft:${occurrenceKey}`} containingNoteRef={highlightRef} body={value.body} revision={value.revision} label="annotation" placeholder="write an annotation…" editable={!value.committing} history={null}
        reference={{source_ref: highlightRef, label: "annotation", onActiveChange: reference => draft.set(current => current && {...current, reference}), onSelected: (target, item) => draft.set(current => current && {...current, reference: false, links: [...current.links, {target, label: item.label}], revision: current.revision + 1})}}
        onEditorReady={ready} onSave={() => queueMicrotask(save)} onEdit={edit => {const current = draft.read(); if (!current || current.committing) return; applyDraftBody(current.doc, edit.before, edit.after); draft.set({...current, body: edit.after, revision: current.revision + 1});}}
        onLinkInputActiveChange={hyperlink => draft.set(current => current && {...current, hyperlink})}
        onAttachmentActiveChange={attachment => draft.set(current => current && {...current, attachment})}/>
      <Button emphasis="strong" aria-busy={busy} disabled={!resource || busy || value.committing || value.reference || value.hyperlink || value.attachment} onClick={save}>save annotation</Button>
      <Button disabled={busy || value.committing} onClick={cancel}>cancel</Button>
    </> : (hasBody || editing) && ownHistory ? <BoundNoteEditor noteRef={highlightRef} history={ownHistory} label="edit annotation" editable={resource !== null} onAttachmentActiveChange={attachment => input.set(value => ({...value, attachment}))} onLinkInputActiveChange={hyperlink => input.set(value => ({...value, hyperlink}))} document={opened.document ?? undefined} onEditorReady={ready} inspection={inspection} reference={writing ? {source_ref: highlightRef, label: "annotation", onActiveChange: reference => input.set(value => ({...value, reference})), onSelected: (target, item) => link(target, item.label)} : null}/>
    : resource?.body_pm_json ? (
      // the bound editor's height at first commit, until its document opens. a click on it asks for the document,
      // and `ready` then places the caret. only a completed press counts: a touch that becomes a scroll never
      // clicks, so a flick across moving rows opens nothing. the preview's own links keep their press.
      <div onClick={event => {
        if (event.target instanceof Element && event.target.closest("a[href], button")) return;
        setAsked(true); pendingFocus.current ??= {kind: "Internal", generation: getInteractionGeneration()};
      }}>
        <NoteEditor editorKey={`annotation-preview:${occurrenceKey}`} containingNoteRef={highlightRef} body={{body_pm_json: resource.body_pm_json, body_text: resource.body_text!}} revision={0} label="annotation" editable={false} history={null} onEdit={() => {}}/>
      </div>
    ) : editing ? null : <Button onClick={() => opened.document ? begin() : setAsked(true)}>annotate</Button>}
  </section>;
}
