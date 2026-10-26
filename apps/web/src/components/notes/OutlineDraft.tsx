"use client";
/** One retained input bridges native writing to its canonical notes. Returns
 * freeze semantic segments; the same live editor immediately owns the suffix.
 * Each segment merges over the exact receipt baseline before its split commits. */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import * as Y from "yjs";
import { applyBodyEdits, bodyInline, encodeBytes, hydrateNote, readBody, sliceInline } from "@nexus/authored/documents";
import { bodyFromNode, bodyHasContent, docFromBody, emptyBody, parseBody, sameBody, type InlineNode, type NoteBody } from "@nexus/authored/body";
import { mergeVector } from "@nexus/authored/merge";
import { useEditorDraft } from "@/lib/notes/editorHost";
import { useWritingRuntime } from "@/lib/notes/hooks";
import type { CreatedOutlineNote, OutlineHistory } from "@/lib/notes/structure";
import type { DisplayedSplit, FocusSelection, NoteEdit } from "@/lib/notes/editorTypes";
import Button from "@/components/ui/Button";
import NoteEditor, { type NoteEditorHandle } from "./NoteEditor";

export interface OutlineInputPeer { body: NoteBody; note: CreatedOutlineNote | null; key: string | null; represented: boolean; ready?: Promise<CreatedOutlineNote> }
export interface OutlineBoundaryPlan { body: NoteBody; selection: FocusSelection; apply(note: CreatedOutlineNote, body_state: string, admission: number): Promise<CreatedOutlineNote | null> }
type Relocate = (note: CreatedOutlineNote, body_state: string, admission: number) => Promise<CreatedOutlineNote | null>;
type Segment = { body: NoteBody; left: NoteBody; right: NoteBody; from: number; to: number; typing: number | undefined; split: number; relocate?: Relocate; peer?: OutlineInputPeer };
type Progress = {note: CreatedOutlineNote; body: NoteBody; offset: number; consumed?: number};
type Draft = { progress: Progress | null; previous: OutlineInputPeer[]; body: NoteBody; segments: Segment[]; creation: number | null; typing: number | undefined; revision: number; searching: boolean; saving: boolean; error: unknown | null };
const risk = (draft: Draft) => ({ changed: bodyHasContent(draft.body) || draft.segments.length > 0, unconfirmed: draft.saving, stopsBrowserWork: false });
const subscribeNothing = () => () => {};
const noSave = () => null;
export default function OutlineDraft({ id, seed = emptyBody(), immediate = false, initialSelection, initialAdmission, initialEmptyEnter, previousPeer, history, create, split, emptyEnter, boundary, createFollowing, onCreated, onComplete, onFailure, onEditorReady, onSelectionChange, reference }: {
  id: string; seed?: NoteBody; immediate?: boolean; initialSelection?: FocusSelection; initialAdmission?: number; initialEmptyEnter?: number; history: OutlineHistory;
  create(body: NoteBody, admission: number): Promise<CreatedOutlineNote>;
  split(note: CreatedOutlineNote, displayed: DisplayedSplit, admission: number, peer?: OutlineInputPeer): Promise<CreatedOutlineNote>;
  previousPeer?: OutlineInputPeer | null;
  boundary(direction: "backward" | "forward", body: NoteBody, peer: OutlineInputPeer | null): OutlineBoundaryPlan | null;
  createFollowing(body: NoteBody, admission: number): Promise<CreatedOutlineNote>;
  emptyEnter?(): Relocate | null;
  onCreated(note: CreatedOutlineNote): Promise<void>;
  onComplete(note: CreatedOutlineNote | null, selection: FocusSelection): void;
  onFailure(error: unknown): void;
  onEditorReady?(editor: NoteEditorHandle | null): void;
  onSelectionChange?(selection: NoteEdit["selectionAfter"]): void;
  reference?: import("@/lib/resourceGraph/useReferenceInput").ReferenceInputHost;
}) {
  const runtime = useWritingRuntime();
  const save = useSyncExternalStore(runtime?.subscribe ?? subscribeNothing, runtime?.snapshot ?? noSave, noSave);
  const draft = useEditorDraft<Draft>(`Outline.Input:${id}`, () => ({ progress: null, previous: previousPeer ? [previousPeer] : [], body: seed, segments: [], creation: initialAdmission ?? null, typing: undefined, revision: 0, searching: false, saving: false, error: null }), risk);
  const started = useRef(false);
  const resumed = useRef<(() => void) | null>(null);
  const editor = useRef<NoteEditorHandle | null>(null);
  const latest = useRef({ create, createFollowing, split, onCreated, onComplete, onFailure });
  latest.current = { create, createFollowing, split, onCreated, onComplete, onFailure };
  const begin = () => {
    const value = draft.read();
    if (!runtime || started.current || value.saving || value.searching) return;
    started.current = true;
    const creation = value.creation ?? history.admit();
    draft.set(current => ({ ...current, creation, saving: true, error: null }));
    void (async () => {
      // Only preparation failures before a receipt may restart creation. A local
      // writer failure keeps waiting on its original exact-byte retry owner.
      const initial: Progress = draft.read().progress ?? await latest.current.create(value.segments[0]?.body ?? value.body, creation).then(note => ({note, body: value.segments[0]?.body ?? value.body, offset: note.input_offset}));
      draft.set(value => ({...value, progress: initial}));
      let note = initial.note;
      let document = await runtime.openDocument(note.ref);
      let held = document.retain();
      let clone = hydrateNote(note.body_state);
      let displayedBody = initial.body;
      let offset = initial.offset;
      let observed = note.observed_touch;
      const observe = () => {
        const ref = document.ref, origin = history.editor(document).origin;
        return document.onCommitted((receipt, source) => { if (source === origin) for (const patch of receipt.change.resources) if (patch.ref === ref) observed = mergeVector(observed, patch.touch_vv); });
      };
      let stopObserving = observe();
      try {
        while (editor.current && !editor.current.settleNativeInput()) await new Promise<void>(resolve => { resumed.current = resolve; });
        let ready: Promise<void> | null = null;
        if (initial.consumed !== undefined) flushSync(() => {
          draft.set(value => ({...value, segments: value.segments.filter(segment => segment.split !== initial.consumed)}));
          ready = latest.current.onCreated(note);
        });
        const complete = readBody(clone);
        if (offset !== 0 || !sameBody(complete, displayedBody)) {
          const length = docFromBody(displayedBody).firstChild!.content.size;
          const prefix = parseBody({type: "body", content: sliceInline(clone, 0, offset)});
          const suffix = parseBody({type: "body", content: sliceInline(clone, offset + length, bodyInline(clone).length)});
          const around = (body: NoteBody, before: NoteBody, after: NoteBody) => {
            const node = docFromBody(body).firstChild!;
            return bodyFromNode(node.copy(docFromBody(before).firstChild!.content.append(node.content).append(docFromBody(after).firstChild!.content)));
          };
          const caret = editor.current?.readSelection();
          const hadSegments = draft.read().segments.length > 0;
          // Adopt a join before hiding either canonical occurrence. Every queued
          // snapshot gains its real suffix; only the first gains the prefix.
          flushSync(() => draft.set(value => ({...value, revision: value.revision + 1,
            body: around(value.body, value.segments.length ? emptyBody() : prefix, suffix),
            segments: value.segments.map((segment, index) => ({...segment,
              body: around(segment.body, index === 0 ? prefix : emptyBody(), suffix),
              left: around(segment.left, index === 0 ? prefix : emptyBody(), emptyBody()),
              right: around(segment.right, emptyBody(), suffix),
              from: segment.from + (index === 0 ? offset : 0), to: segment.to + (index === 0 ? offset : 0)}))})));
          if (caret) editor.current?.focus({anchor: caret.anchor + (hadSegments ? 0 : offset), head: caret.head + (hadSegments ? 0 : offset)}, true);
          displayedBody = complete; offset = 0;
          draft.set(value => ({...value, progress: {note, body: displayedBody, offset}}));
        }
        ready ??= latest.current.onCreated(note);
        while (true) {
          while (editor.current && !editor.current.settleNativeInput()) await new Promise<void>(resolve => { resumed.current = resolve; });
          let current = draft.read();
          const segment = current.segments[0];
          const body = segment?.body ?? current.body;
          if (!sameBody(displayedBody, body)) {
            const before = docFromBody(displayedBody).firstChild!, after = docFromBody(body).firstChild!;
            const start = before.content.findDiffStart(after.content);
            const baseline = Y.encodeStateVector(clone);
            if (start !== null) {
              const end = before.content.findDiffEnd(after.content)!;
              const overlap = Math.max(0, start - Math.min(end.a, end.b));
              const content: InlineNode[] = [];
              after.content.cut(start, end.b + overlap).forEach(node => {
                // justify-type-assertion: both documents use the canonical note schema.
                content.push(node.toJSON() as InlineNode);
              });
              applyBodyEdits(clone, [{kind: "replace", from: start + offset, to: end.a + overlap + offset, content}]);
            }
            if (before.attrs.presentation !== after.attrs.presentation) applyBodyEdits(clone, [{kind: "presentation", value: after.attrs.presentation}]);
            const inputHistory = history.editor(document), releaseHistory = inputHistory.retain();
            try {
              Y.applyUpdate(document.doc, Y.encodeStateAsUpdate(clone, baseline), inputHistory.origin);
              const caret = segment ? {anchor: segment.from + 1, head: segment.to + 1} : editor.current?.readSelection() ?? {anchor: 1, head: 1};
              inputHistory.record({selectionBefore: {anchor: 1 + offset, head: 1 + offset}, selectionAfter: {anchor: caret.anchor + offset, head: caret.head + offset}}, segment?.typing ?? current.typing);
            } finally { releaseHistory(); }
          }
          displayedBody = body;
          await document.capture();
          note = {...note, body_state: encodeBytes(Y.encodeStateAsUpdate(clone)), observed_touch: observed};
          draft.set(value => ({...value, progress: {note: {...note, body_state: encodeBytes(Y.encodeStateAsUpdate(clone))}, body: displayedBody, offset}}));
          if (!segment && (draft.read().revision !== current.revision || draft.read().segments.length)) continue;
          if (segment) {
            const state = encodeBytes(Y.encodeStateAsUpdate(clone));
            let next = segment.relocate ? await segment.relocate(note, state, segment.split)
              : await latest.current.split(note, {body_state: state, from: segment.from + offset, to: segment.to + offset}, segment.split, segment.peer);
            let nextBody = segment.right;
            if (segment.peer && next) {
              const left = hydrateNote(state);
              applyBodyEdits(left, [{kind: "replace", from: segment.from + offset, to: bodyInline(left).length, content: []}]);
              segment.peer.note = {...note, body_state: encodeBytes(Y.encodeStateAsUpdate(left)), observed_touch: mergeVector(note.observed_touch, next.observed_touch), input_offset: 0};
              left.destroy();
            }
            if (!next) {
              draft.set(value => ({...value, progress: null, previous: [], segments: value.segments.slice(1)}));
              const remaining = draft.read();
              if (!remaining.segments.length && !bodyHasContent(remaining.body)) {
                latest.current.onComplete(null, {anchor: 1, head: 1});
                draft.set({...remaining, saving: false, creation: null});
                break;
              }
              nextBody = remaining.segments[0]?.body ?? remaining.body;
              next = await latest.current.createFollowing(nextBody, remaining.creation ?? history.admit());
            }
            const successor = next;
            const consumed = draft.read().segments[0] === segment ? segment.split : undefined;
            draft.set(value => ({...value, progress: {note: successor, body: nextBody, offset: successor.input_offset, consumed}}));
            const nextDocument = await runtime.openDocument(successor.ref);
            stopObserving(); held(); clone.destroy();
            note = successor; document = nextDocument; held = document.retain(); clone = hydrateNote(successor.body_state);
            observed = successor.observed_touch; stopObserving = observe();
            displayedBody = nextBody; offset = successor.input_offset;
            flushSync(() => {
              if (consumed !== undefined) draft.set(value => ({...value, segments: value.segments.slice(1)}));
              ready = latest.current.onCreated(successor);
            });
            draft.set(value => ({...value, progress: {note, body: displayedBody, offset}}));
            continue;
          }
          const complete = readBody(clone);
          if (!sameBody(complete, current.body)) {
            const caret = editor.current?.readSelection();
            // Adopt a join's prefix/suffix without replacing this input view.
            flushSync(() => draft.set(value => ({...value, body: complete, revision: value.revision + 1})));
            if (caret) editor.current?.focus({anchor: caret.anchor + offset, head: caret.head + offset}, true);
            offset = 0; current = draft.read(); displayedBody = complete;
            draft.set(value => ({...value, progress: {note: {...note, body_state: encodeBytes(Y.encodeStateAsUpdate(clone))}, body: displayedBody, offset}}));
          }
          await ready;
          if (editor.current && !editor.current.settleNativeInput()) continue;
          const caret = editor.current?.readSelection();
          if (draft.read().revision !== current.revision || draft.read().segments.length) continue;
          latest.current.onComplete(note, caret ? {anchor: caret.anchor + offset, head: caret.head + offset} : "end");
          draft.set({progress: null, previous: [], body: emptyBody(), segments: [], creation: null, typing: undefined, revision: current.revision + 1, searching: false, saving: false, error: null});
          break;
        }
      } finally { stopObserving(); held(); clone.destroy(); }
    })().catch(error => {
      draft.set(current => ({...current, saving: false, error}));
      started.current = false;
      latest.current.onFailure(error);
    });
  };
  const returnKey = (left: NoteBody, right: NoteBody) => {
    const at = editor.current?.readSelection() ?? {anchor: 1, head: 1};
    const peer: OutlineInputPeer = {body: left, note: null, key: null, represented: false};
    history.boundary();
    flushSync(() => draft.set(current => ({...current, previous: [...current.previous, peer], body: right, revision: current.revision + 1, typing: undefined,
      segments: [...current.segments, {body: current.body, left, right, from: Math.min(at.anchor, at.head) - 1, to: Math.max(at.anchor, at.head) - 1, typing: current.typing, split: history.admit(), peer}]})));
    editor.current?.focus({anchor: 1, head: 1}, true);
    begin();
  };
  const boundaryKey = (direction: "backward" | "forward") => {
    const current = draft.read(), peer = direction === "backward" ? current.previous.at(-1) ?? null : null;
    const plan = boundary(direction, current.body, peer);
    if (!plan) return;
    if (peer) peer.represented = true;
    history.boundary();
    flushSync(() => draft.set(value => ({...value, previous: peer ? value.previous.slice(0, -1) : value.previous, body: plan.body, revision: value.revision + 1, creation: null, typing: undefined,
      segments: [...value.segments, {body: value.body, left: emptyBody(), right: plan.body, from: 0, to: 0, typing: value.typing, split: history.admit(), relocate: plan.apply}]})));
    editor.current?.focus(plan.selection, true);
    begin();
  };
  useEffect(() => {
    if (initialEmptyEnter !== undefined) {
      const relocate = emptyEnter?.();
      if (relocate) draft.set(value => ({...value, segments: [...value.segments, {body: value.body, left: emptyBody(), right: emptyBody(), from: 0, to: 0, typing: undefined, split: initialEmptyEnter, relocate}]}));
    }
    if (immediate) begin();
    return () => { editor.current = null; resumed.current?.(); resumed.current = null; };
    // One admission and its captured draft belong to this mounted input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>
    {draft.value.segments.filter(segment => !segment.relocate && !segment.peer?.represented).map((segment, index) => <NoteEditor key={segment.split} editorKey={`outline-input:${id}:closed:${segment.split}`} containingNoteRef={null}
      body={segment.left} revision={0} editable={false} label={`pending note ${index + 1}`} compact history={null} onEdit={() => {}}/>)}
    <NoteEditor editorKey={`outline-input:${id}`} containingNoteRef={null} body={draft.value.body}
      revision={draft.value.revision} editable label="write a note" placeholder="write or @ to link" compact
      focus={immediate ? {selection: initialSelection ?? {anchor: 1, head: 1}, serial: 1} : null}
      history={{undo: () => {if (!draft.read().saving) history.undo();}, redo: () => {if (!draft.read().saving) history.redo();}, boundary: () => history.boundary()}} keys={{split: returnKey, emptyEnter: () => {
        const relocate = emptyEnter?.();
        if (!relocate) return;
        history.boundary();
        draft.set(current => ({...current, revision: current.revision + 1, typing: undefined,
          segments: [...current.segments, {body: current.body, left: emptyBody(), right: emptyBody(), from: 0, to: 0, typing: current.typing, split: history.admit(), relocate}]}));
        begin();
      }, emptyDelete: boundaryKey, join: boundaryKey}}
      onEditorReady={handle => { editor.current = handle; onEditorReady?.(handle); }}
      onSelectionChange={selection => { onSelectionChange?.(selection); if (editor.current?.canArrange() && resumed.current) {const resume = resumed.current; resumed.current = null; resume();} }}
      onEdit={edit => {
        draft.set(current => ({...current, body: edit.after, revision: current.revision + 1, creation: current.creation ?? history.admit(), typing: current.typing ?? history.admit()}));
        if (bodyHasContent(edit.after)) begin();
      }}
      reference={reference ? {...reference, onActiveChange: active => {
        draft.set(current => ({...current, searching: active})); reference.onActiveChange?.(active);
      }} : null}/>
    {draft.value.error ? <Button onClick={begin}>{draft.value.progress ? "retry finishing note" : "retry creating note"}</Button> : null}
    {save?.error ? <div role="alert"><p>couldn’t save this writing on this device.</p><Button onClick={() => { void runtime?.retry().catch(onFailure); }}>retry saving</Button></div> : null}
  </>;
}
