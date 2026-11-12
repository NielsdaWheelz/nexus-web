"use client";
import { CommandTooLargeError } from "@nexus/authored/types";
import ReaderExcerpt from "@/components/resources/ReaderExcerpt";
import { ExcerptCaptureError, excerptView } from "@nexus/authored/excerpt";

// Compact readers share highlight body ownership with the workspace. Explicit
// creation retains unsubmitted input until local commit; existing bodies autosave.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Fact, Field } from "@/components/feedback/Fact";
import type { Verb } from "@/components/feedback/stage";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import Dialog from "@/components/ui/Dialog";
import { useAuthoredStore } from "@/lib/authored/provider";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError, isAuthoredStorageFailure } from "@/lib/notes/runtime";
import { deleteResource } from "@/lib/resourceGraph/links";
import { localResourceLabel } from "@/lib/resources/localResource";
import { bodyHasContent, emptyBody, type NoteBody } from "@nexus/authored/body";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useEditorDraft } from "@/lib/notes/editorHost";
import NoteEditor, {type NoteEditorHandle} from "@/components/notes/NoteEditor";
import { captureSelection, createHighlight, createReaderAnnotations, type Capture, type ReaderAnnotation, type SourceLabel } from "../annotations";
import { rejectedSelectionFact, useReaderState, type Decorations, type Mark, type MarkAnchor, type MarkEvent, type SelectionNotice } from "../DocumentReader";
import type { Reader } from "../runtime";
import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import { AnnotationList, AnnotationQuote, PLACEMENT_COPY } from "./ReaderAnnotation";
import styles from "./chrome.module.css";

const NO_SUBSCRIPTION = () => () => {};

type Open =
  | { readonly kind: "selection"; readonly capture: Capture; readonly identity: string; readonly anchor: MarkAnchor }
  | { readonly kind: "annotation"; readonly id: string; readonly mark: Mark | null }
  | { readonly kind: "choose"; readonly marks: readonly Mark[] };

/** A commit that didn't land: too large to save, or held unsaved until a retry lands. */
type Issue = { readonly kind: "TooLarge" } | { readonly kind: "Unsaved"; readonly retry: () => void };

/** What the reader view takes from the annotation layer; stable while nothing changes. */
export interface ReaderAnnotationProps {
  readonly decorations: Decorations | undefined;
  readonly onSelection: (notice: SelectionNotice) => void;
  readonly onMarks: (event: MarkEvent) => void;
}
export interface CompactReaderQuestion {
  readonly identity: string;
  readonly anchor: MarkAnchor | null;
  readonly capture: Capture | null;
  readonly annotation: ReaderAnnotation | null;
  readonly question: NoteBody;
}
export interface CompactReaderChat {
  submit(input: CompactReaderQuestion): boolean;
}

/** `available` false: this host has no source text (missing or failed); annotations still list. */
export function useCompactAnnotations(reader: Reader, mediaId: string, source: SourceLabel, available: boolean, showPlaced = false, chat: CompactReaderChat | null = null) {
  const store = useAuthoredStore();
  const writing = useWritingRuntime();
  const [annotations] = useState(() => createReaderAnnotations(store, mediaId));
  const document = useReaderState(reader, state => state.document);
  const doc = available && document.status === "ready" ? document.doc : null;
  const missing = !available || document.status === "failed";
  useEffect(() => { if (doc) annotations.bind(doc); else if (missing) annotations.bind(null); }, [annotations, doc, missing]);
  const state = useSyncExternalStore(annotations.subscribe, annotations.getState, annotations.getState);
  const [open, setOpen] = useState<Open | null>(null);
  const skipReturn = useRef(false);
  // New selections own ephemeral writing; existing highlights own their body.
  const draft = useEditorDraft<{body: NoteBody; revision: number; attachment: boolean; hyperlink: boolean}>(`Compact.Annotation:${mediaId}`, () => ({body: emptyBody(), revision: 0, attachment: false, hyperlink: false}), value => ({changed: bodyHasContent(value.body) || value.hyperlink, unconfirmed: false, stopsBrowserWork: value.attachment}));
  const note = draft.value, setNoteBody = draft.set;
  const guard = useWorkGuard();
  const annotationOwners = useRef<readonly string[]>([]);
  const protectOwners = useCallback((owners: readonly string[]) => {annotationOwners.current = owners;}, []);
  const setNote = (body: NoteBody) => setNoteBody(current => ({ ...current, body, revision: current.revision + 1 }));
  const hasNote = bodyHasContent(note.body);
  const [busy, setBusy] = useState(false);
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  const copied = useCopyFeedback(open);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const copyWriting = () => {const text = draft.read().body.body_text; void copied.copy(text).catch(error => {if (error instanceof ClipboardWriteUnavailableError) setManualCopy(text); else setDefect({error});});};
  const selectionEditor = useRef<NoteEditorHandle | null>(null);
  const selectionReady = useCallback((handle: NoteEditorHandle | null) => {selectionEditor.current = handle;}, []);
  const [issue, setIssue] = useState<Issue | null>(null);
  const issueId = useId();
  const changedId = useId();
  const { say } = useOutcome();
  // A failed frame retries through the account writing owner, never a new save.
  const blocked = useSyncExternalStore(writing?.subscribe ?? NO_SUBSCRIPTION, () => writing?.snapshot().error != null, () => false);
  const currentInput = useRef({open, mounted: true});
  currentInput.current.open = open;
  useEffect(() => {const current = currentInput.current; current.mounted = true; return () => {current.mounted = false;};}, []);
  const [focused, setFocused] = useState<string | null>(null);
  const close = () => { if (!guard.confirmLoss({scopes: [], ownerIds: [draft.owner, ...annotationOwners.current]})) return false; setOpen(null); setNote(emptyBody()); setIssue(null); setFocused(null); return true; };
  const decorations = useMemo<Decorations | undefined>(() => doc ? { identity: doc.identity, marks: state.marks, noteRefs: [], focused, hovered: null } : undefined,
    [doc, focused, state.marks]);

  /** Runs one local commit; the typed annotation clears only once its commit is durable. */
  const commit = (run: () => Promise<unknown>, done: () => void, op: "Save" | "Delete", recovery: Issue | null = issue): void => {
    const submitted = {open, revision: draft.read().revision};
    let failed = false;
    const finish = () => {
      if (!currentInput.current.mounted || currentInput.current.open !== submitted.open) return;
      const current = draft.read();
      if (current.hyperlink || current.attachment || failed && submitted.open?.kind === "selection" && !selectionEditor.current?.settleNativeInput()) return;
      if (draft.read().revision === submitted.revision) {setIssue(null); setNote(emptyBody()); done();}
    };
    setBusy(true);
    void run().then(finish, (error: unknown) => {
      failed = true;
      if (error instanceof LocalCommitError) {setIssue(current => current === recovery ? null : current); void error.completion.then(finish, () => {}); return;}
      // a dialog closed while its commit ran leaves no input to stand beneath: its refusal is said.
      const closed = currentInput.current.open !== submitted.open;
      if (error instanceof CommandTooLargeError) {if (closed) say({fact: "this passage is too long to save."}); else setIssue({kind: "TooLarge"}); return;}
      if (!isAuthoredStorageFailure(error)) {setDefect({error}); return;}
      if (op === "Delete") {
        say({fact: "couldn’t delete the highlight."}, [{label: "retry", commandKey: "RetryHighlightDelete", run: () => commit(run, done, "Delete")}]);
        return;
      }
      const failure: Issue = {kind: "Unsaved", retry: () => commit(run, done, "Save", failure)};
      if (closed) say({fact: "couldn’t save the highlight."}, [{label: "retry", commandKey: "RetryAnnotationSave", run: failure.retry}]);
      else setIssue(failure);
    }).finally(() => {if (currentInput.current.mounted) setBusy(false);});
  };
  const sourceChanged = open?.kind === "selection" && (doc === null || open.identity !== doc.identity);
  const save = (capture: Capture, withNote: boolean) => {
    if (!writing || sourceChanged || blocked || busy || note.hyperlink || note.attachment) return;
    const id = crypto.randomUUID();
    commit(() => createHighlight(writing, { id, capture, color: "yellow", annotation: withNote && hasNote ? note.body : null,
      source: capture.sourceRef === `media:${mediaId}` || capture.sourceRef.startsWith("fragment:") ? source : null }), () => setOpen({ kind: "annotation", id, mark: null }), "Save");
  };
  const annotation = open?.kind === "annotation" ? annotations.annotation(open.id) : null;
  const lastAnnotation = useRef(annotation);
  if (annotation) lastAnnotation.current = annotation;
  const shownAnnotation = annotation ?? (open?.kind === "annotation" && lastAnnotation.current?.id === open.id ? lastAnnotation.current : null);
  const activeMark = open?.kind === "annotation" ? open.mark : null;
  const ask = () => {
    if (!chat || !open || open.kind === "choose" || busy) return;
    if (open.kind === "selection" && !selectionEditor.current?.settleNativeInput()) return;
    const submitted = draft.read();
    const current = reader.getState().document;
    if (submitted.hyperlink || submitted.attachment || current.status !== "ready") return;
    const selectedAnnotation = open.kind === "annotation" && shownAnnotation?.id === open.id ? shownAnnotation : null;
    const anchor = open.kind === "selection" ? open.anchor : selectedAnnotation?.placement.kind === "placed" ? selectedAnnotation.placement.anchor : null;
    if (open.kind === "selection" && open.identity !== current.doc.identity || open.kind === "annotation" && !selectedAnnotation?.display) return;
    // Asking never submits the independent saved-annotation editor as a question.
    if (!guard.confirmLoss({ scopes: [], ownerIds: annotationOwners.current })) return;
    if (chat.submit({ identity: current.doc.identity, anchor, capture: open.kind === "selection" ? open.capture : null,
      annotation: selectedAnnotation, question: open.kind === "selection" ? submitted.body : emptyBody() })) {
      skipReturn.current = true;
      setOpen(null); setNote(emptyBody()); setIssue(null); setFocused(null);
    }
  };
  const editor = (placeholder: string, onSave: () => void) => <NoteEditor editorKey={`reader-annotation:${mediaId}`} containingNoteRef={null}
    body={note.body} revision={note.revision} label="annotation" placeholder={placeholder} editable={!busy && !blocked && issue?.kind !== "Unsaved"}
    history={null} onEditorReady={selectionReady} onEdit={edit => setNote(edit.after)} onSave={onSave}
    onAttachmentActiveChange={attachment => draft.set(value => ({...value, attachment}))} onLinkInputActiveChange={hyperlink => draft.set(value => ({...value, hyperlink}))} />;
  if (defect) throw defect.error;
  const retry: Verb | null = issue?.kind === "Unsaved" ? {label: "retry", commandKey: "RetryAnnotationSave", run: issue.retry, busy} : null;
  const issueField = issue?.kind === "TooLarge" || retry !== null && !hasNote;
  const issueNotice = issue?.kind === "TooLarge" ? <Field id={issueId} line={{ fact: "this passage is too long to save." }} />
    : retry === null ? null
    : hasNote ? <Hold id={`compact-annotation:${mediaId}`} risk line={{ fact: "this note isn’t saved yet." }}
      verbs={[retry, {label: "copy text", commandKey: "CopyUnsavedAnnotation", run: copyWriting, copied: copied.occurrence ?? undefined}]} />
    : <Field id={issueId} line={{ fact: "couldn’t save the highlight." }} verbs={[retry]} />;
  // the save the field refuses is what it describes; NoteEditor takes no description of its own.
  const saveDescribedBy = [sourceChanged ? changedId : null, issueField ? issueId : null].filter(Boolean).join(" ") || undefined;
  const panel = <>
    <Dialog open={manualCopy !== null} title="copy unsaved writing" onClose={() => setManualCopy(null)} initialFocus={panel => panel.querySelector("textarea")}>
      <textarea aria-label="unsaved writing" readOnly value={manualCopy ?? ""} onFocus={event => event.currentTarget.select()} />
    </Dialog>
    <Dialog open={open?.kind === "selection"} title={chat ? "selected passage" : "annotate passage"} onClose={close} skipReturnFocus={() => skipReturn.current}>
      {open?.kind === "selection" ? <div className={styles.compactAnnotation}>
        <ReaderExcerpt excerpt={excerptView(open.capture.selection.excerpt, "full", { kind: "capture" })} color={chat ? null : "yellow"} full />
        {sourceChanged ? <Field id={changedId} line={{ fact: "the text changed.", reason: "your words are kept." }} /> : null}
        {editor(chat ? "write an annotation or ask a question…" : "write an annotation…", () => save(open.capture, true))}
        <div className={styles.compactActions}>
          <Button emphasis="strong" aria-busy={busy} aria-describedby={saveDescribedBy} disabled={sourceChanged || busy || blocked || note.hyperlink || note.attachment} onClick={() => save(open.capture, true)}>{hasNote ? "save annotation" : "save highlight"}</Button>
          {chat ? <Button disabled={sourceChanged || busy || note.hyperlink || note.attachment} onClick={ask}>ask librarian</Button> : null}
          <Button onClick={close}>cancel</Button>
        </div>
      </div> : null}
      {issueNotice}
    </Dialog>
    <Dialog open={open?.kind === "choose"} title="choose highlight" onClose={close}>
      {open?.kind === "choose" ? <ul className={styles.highlightChoices}>
        {open.marks.flatMap(mark => { const id = mark.id; const entry = annotations.annotation(id); return entry ? [<li key={id}>
          <Button onClick={() => { setFocused(id); setOpen({ kind: "annotation", id, mark }); }}><span className={styles.highlightChoiceLabel}>{localResourceLabel(entry.projection)}</span></Button>
        </li>] : []; })}
      </ul> : null}
    </Dialog>
    <Dialog open={open?.kind === "annotation"} title="highlight" onClose={close} skipReturnFocus={() => skipReturn.current}>
      {shownAnnotation ? <div className={styles.compactAnnotation}>
        <AnnotationQuote annotation={shownAnnotation} />
        {activeMark ? <Button onClick={() => { const anchor = activeMark.anchor; if (!close()) return; void reader.inspect({ target: anchor.kind === "text" ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end } : { kind: "quads", page: anchor.page, quads: anchor.quads }, signal: new AbortController().signal }); }}>view in source</Button> : null}
        {!annotation ? <Field id={changedId} line={{ fact: "this highlight isn’t available.", reason: "your words are kept." }} /> : null}
        {!annotation || annotation.display ? <PreparedResourcesContext value={annotation?.display?.resources ?? null}>
          <HighlightAnnotation highlightRef={shownAnnotation.ref} resource={annotation?.display?.projection ?? null} occurrenceKey={`compact:${shownAnnotation.ref}`} onWorkOwners={protectOwners} />
        </PreparedResourcesContext> : null}
        <div className={styles.compactActions}>
          {chat ? <Button disabled={!annotation?.display || busy} onClick={ask}>ask librarian</Button> : null}

          <Button tone="danger" aria-busy={busy} aria-describedby={!annotation ? changedId : undefined} disabled={!annotation || busy || blocked || !writing} onClick={() => commit(() => deleteResource(writing!, { ref: shownAnnotation.ref }), close, "Delete")}>delete highlight</Button>
        </div>
        {issueNotice}
      </div> : null}
    </Dialog>
  </>;
  /** Annotations this publication cannot place, or every annotation when its text is unavailable. */
  const unplaced = state.annotations.filter(entry => entry.placement.kind !== "placed");
  const list = <>
    {showPlaced && state.annotations.length ? <ResourceOutlineList scope={`capture-highlights:${mediaId}`} ariaLabel="your highlights">
      {state.annotations.map(entry => entry.display ? <PreparedResourcesContext key={entry.ref} value={entry.display.resources}>
        <ResourceOutlineRow resource={entry.display.projection} incoming={null} occurrenceKey={`capture-highlight:${entry.ref}`} occurrenceLabel="highlight" />
      </PreparedResourcesContext> : null)}
    </ResourceOutlineList> : null}
    {!showPlaced && unplaced.length ? <section aria-label="unplaced highlights">
    {missing ? <Fact line={{ fact: PLACEMENT_COPY.unavailable }} /> : null}
    <AnnotationList annotations={unplaced} />
  </section> : null}
  </>;
  const current = useRef({ doc, mediaId });
  current.current = { doc, mediaId };
  const onSelection = useCallback((notice: SelectionNotice) => {
    const { doc } = current.current;
    if (notice.kind !== "Admitted" || !doc || notice.selection.identity !== doc.identity) return;
    if (notice.selection.kind === "Rejected") {
      say({ fact: rejectedSelectionFact(notice.selection.reason, doc) });
      return;
    }
    let capture: Capture | null;
    try { capture = captureSelection(doc, current.current.mediaId, notice.selection.anchor, notice.selection.excerpt, notice.selection.excerpt_start, notice.selection.excerpt_end); }
    catch (error) {
      if (!(error instanceof ExcerptCaptureError)) throw error;
      say({ fact: rejectedSelectionFact("UnsupportedExcerpt", doc) });
      return;
    }
    if (capture && guard.confirmLoss({scopes: [], ownerIds: [draft.owner, ...annotationOwners.current]})) { skipReturn.current = false; setIssue(null); setNoteBody(value => ({...value, body: emptyBody(), revision: value.revision + 1})); setOpen({ kind: "selection", capture, identity: doc.identity, anchor: notice.selection.anchor }); }
  }, [guard, draft.owner, say, setNoteBody]);
  const onMarks = useCallback((event: MarkEvent) => {
    if (event.kind !== "activate" || !event.marks.length || !guard.confirmLoss({scopes: [], ownerIds: [draft.owner, ...annotationOwners.current]})) return;
    skipReturn.current = false;
    setIssue(null);
    setNoteBody(value => ({...value, body: emptyBody(), revision: value.revision + 1}));
    if (event.marks.length === 1) { setFocused(event.marks[0]!.id); setOpen({ kind: "annotation", id: event.marks[0]!.id, mark: event.marks[0]! }); }
    else setOpen({ kind: "choose", marks: event.marks });
  }, [guard, draft.owner, setNoteBody]);
  return {decorations, onSelection, onMarks, panel, list};
}

/** The annotation layer beside a reader that never waits on it: it renders its own list and
 * dialogs inside the account provider and reports the reader's props while mounted. */
export function CompactAnnotationLayer({ reader, mediaId, source, available, report }: {
  readonly reader: Reader;
  readonly mediaId: string;
  readonly source: SourceLabel;
  readonly available: boolean;
  readonly report: (props: ReaderAnnotationProps | null) => void;
}) {
  const { decorations, onSelection, onMarks, list, panel } = useCompactAnnotations(reader, mediaId, source, available);
  useEffect(() => { report({ decorations, onSelection, onMarks }); }, [decorations, onMarks, onSelection, report]);
  useEffect(() => () => report(null), [report]);
  return <>{list}{panel}</>;
}
