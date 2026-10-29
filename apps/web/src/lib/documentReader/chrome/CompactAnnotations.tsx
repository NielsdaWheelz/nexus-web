"use client";
import { CommandTooLargeError } from "@nexus/authored/types";
import ReaderExcerpt from "@/components/resources/ReaderExcerpt";
import { ExcerptCaptureError, excerptView, excerptTextParts } from "@nexus/authored/excerpt";

// Compact readers share highlight body ownership with the workspace. Explicit
// creation retains unsubmitted input until local commit; existing bodies autosave.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import {copyText} from "@/lib/ui/copyText";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import Dialog from "@/components/ui/Dialog";
import { useAuthoredStore } from "@/lib/authored/provider";
import { assumeReaderSelectionKey, readerHighlightChatIntentHref } from "@/lib/chat/readerIntent";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { deleteResource } from "@/lib/resourceGraph/links";
import { bodyHasContent, emptyBody, type NoteBody } from "@nexus/authored/body";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useEditorDraft } from "@/lib/notes/editorHost";
import NoteEditor, {type NoteEditorHandle} from "@/components/notes/NoteEditor";
import { captureSelection, createHighlight, createReaderAnnotations, type Capture, type SourceLabel } from "../annotations";
import { useReaderState, type Decorations, type Mark, type MarkEvent, type SelectionNotice } from "../DocumentReader";
import type { Reader } from "../runtime";
import { AnnotationList, AnnotationQuote, LocalWritingError, PLACEMENT_COPY } from "./ReaderAnnotation";
import styles from "./chrome.module.css";

const NO_SUBSCRIPTION = () => () => {};

type Open =
  | { readonly kind: "selection"; readonly capture: Capture; readonly identity: string }
  | { readonly kind: "annotation"; readonly id: string; readonly mark: Mark | null }
  | { readonly kind: "choose"; readonly marks: readonly Mark[] };

/** What the reader view takes from the annotation layer; stable while nothing changes. */
export interface ReaderAnnotationProps {
  readonly decorations: Decorations | undefined;
  readonly onSelection: (notice: SelectionNotice) => void;
  readonly onMarks: (event: MarkEvent) => void;
}

/** `available` false: this host has no source text (missing or failed); annotations still list. */
export function useCompactAnnotations(reader: Reader, mediaId: string, source: SourceLabel, available: boolean, showPlaced = false) {
  const store = useAuthoredStore();
  const writing = useWritingRuntime();
  const [annotations] = useState(() => createReaderAnnotations(store, mediaId));
  const document = useReaderState(reader, state => state.document);
  const doc = available && document.status === "ready" ? document.doc : null;
  const missing = !available || document.status === "failed";
  useEffect(() => { if (doc) annotations.bind(doc); else if (missing) annotations.bind(null); }, [annotations, doc, missing]);
  const state = useSyncExternalStore(annotations.subscribe, annotations.getState, annotations.getState);
  const [open, setOpen] = useState<Open | null>(null);
  // New selections own ephemeral writing; existing highlights own their body.
  const draft = useEditorDraft<{body: NoteBody; revision: number; attachment: boolean; hyperlink: boolean}>(`Compact.Annotation:${mediaId}`, () => ({body: emptyBody(), revision: 0, attachment: false, hyperlink: false}), value => ({changed: bodyHasContent(value.body) || value.hyperlink, unconfirmed: false, stopsBrowserWork: value.attachment}));
  const note = draft.value, setNoteBody = draft.set;
  const guard = useWorkGuard();
  const annotationOwners = useRef<readonly string[]>([]);
  const protectOwners = useCallback((owners: readonly string[]) => {annotationOwners.current = owners;}, []);
  const setNote = (body: NoteBody) => setNoteBody(current => ({ ...current, body, revision: current.revision + 1 }));
  const hasNote = bodyHasContent(note.body);
  const [busy, setBusy] = useState(false);
  const selectionEditor = useRef<NoteEditorHandle | null>(null);
  const selectionReady = useCallback((handle: NoteEditorHandle | null) => {selectionEditor.current = handle;}, []);
  const [issue, setIssue] = useState<{ readonly title: string; readonly retry: (() => void) | null } | null>(null);
  // one failed frame holds the account's writing; it retries from LocalWritingError, never resaves.
  const blocked = useSyncExternalStore(writing?.subscribe ?? NO_SUBSCRIPTION, () => writing?.snapshot().error != null, () => false);
  const [focused, setFocused] = useState<string | null>(null);
  const close = () => { if (!guard.confirmLoss({scopes: [], ownerIds: [draft.owner, ...annotationOwners.current]})) return; setOpen(null); setNote(emptyBody()); setIssue(null); setFocused(null); };
  const decorations = useMemo<Decorations | undefined>(() => doc ? { identity: doc.identity, marks: state.marks, noteRefs: [], focused, hovered: null } : undefined,
    [doc, focused, state.marks]);

  /** Runs one local commit; the typed note clears only once its commit is durable. */
  const commit = (run: () => Promise<unknown>, done: () => void) => {
    setBusy(true); setIssue(null);
    const revision = note.revision;
    let failed = false;
    let notice: typeof issue = null;
    const finish = () => {
      setIssue(current => current === notice ? null : current);
      const current = draft.read();
      if (current.hyperlink || current.attachment || failed && open?.kind === "selection" && !selectionEditor.current?.settleNativeInput()) return;
      if (draft.read().revision === revision) {setNote(emptyBody()); done();}
    };
    void run().then(finish, (error: unknown) => {
      failed = true;
      // the same frozen frame retries here or from the layer notice; the typed note is already in it.
      if (error instanceof LocalCommitError) void error.completion.then(finish, () => {});
      notice = error instanceof CommandTooLargeError ? { title: "this selection is too large to save. select a shorter passage.", retry: null } : error instanceof LocalCommitError
        ? { title: "couldn’t save on this device", retry: () => { void error.retry().catch(() => {}); } }
        : { title: "couldn’t save this annotation", retry: null };
      setIssue(notice);
    }).finally(() => setBusy(false));
  };
  const sourceChanged = open?.kind === "selection" && (doc === null || open.identity !== doc.identity);
  const save = (capture: Capture, withNote: boolean) => {
    if (!writing || sourceChanged || blocked || busy || note.hyperlink || note.attachment) return;
    const id = crypto.randomUUID();
    commit(() => createHighlight(writing, { id, capture, color: "yellow", annotation: withNote && hasNote ? note.body : null,
      source: capture.sourceRef === `media:${mediaId}` || capture.sourceRef.startsWith("fragment:") ? source : null }), () => setOpen({ kind: "annotation", id, mark: null }));
  };
  const annotation = open?.kind === "annotation" ? annotations.annotation(open.id) : null;
  const lastAnnotation = useRef(annotation);
  if (annotation) lastAnnotation.current = annotation;
  const shownAnnotation = annotation ?? (open?.kind === "annotation" && lastAnnotation.current?.id === open.id ? lastAnnotation.current : null);
  const activeMark = open?.kind === "annotation" ? open.mark : null;
  const editor = (placeholder: string, onSave: () => void) => <NoteEditor editorKey={`reader-annotation:${mediaId}`} containingNoteRef={null}
    body={note.body} revision={note.revision} label="annotation" placeholder={placeholder} compact editable={!busy}
    history={null} onEditorReady={selectionReady} onEdit={edit => setNote(edit.after)} onSave={onSave}
    onAttachmentActiveChange={attachment => draft.set(value => ({...value, attachment}))} onLinkInputActiveChange={hyperlink => draft.set(value => ({...value, hyperlink}))} />;
  const issueNotice = issue ? <FeedbackNotice content={{ tone: "Danger", title: issue.title,
    message: issue.retry ? "keep this page open. retry saving." : "nothing was saved. try again." }} announcement="Assertive"
    actions={issue.retry ? [{label: "retry saving", onClick: issue.retry}, {label: "copy", onClick: () => {void copyText(draft.read().body.body_text);}}] : [{label: "copy", onClick: () => {void copyText(draft.read().body.body_text);}}]} /> : null;
  const panel = <>
    {open === null ? issueNotice : null}
    <Dialog open={open?.kind === "selection"} title="annotate passage" onClose={close}>
      {open?.kind === "selection" ? <div className={styles.compactAnnotation}>
        <ReaderExcerpt excerpt={excerptView(open.capture.selection.excerpt, "full", { kind: "capture" })} color="yellow" full />
        {sourceChanged ? <p role="status">the source changed. your writing is kept.</p> : null}
        {editor("write an annotation…", () => save(open.capture, true))}
        <div className={styles.compactActions}>
          <Button emphasis="strong" disabled={sourceChanged || busy || blocked || note.hyperlink || note.attachment} onClick={() => save(open.capture, true)}>{hasNote ? "save annotation" : "save highlight"}</Button>
          <Button onClick={close}>cancel</Button>
        </div>
      </div> : null}
      {issueNotice}
    </Dialog>
    <Dialog open={open?.kind === "choose"} title="choose highlight" onClose={close}>
      {open?.kind === "choose" ? <ul className={styles.highlightChoices}>
        {open.marks.flatMap(mark => { const id = mark.id; const entry = annotations.annotation(id); return entry ? [<li key={id}>
          <Button onClick={() => { setFocused(id); setOpen({ kind: "annotation", id, mark }); }}>{entry.excerpt.kind === "content" ? excerptTextParts(entry.excerpt.body).exact : "table excerpt"}</Button>
        </li>] : []; })}
      </ul> : null}
    </Dialog>
    <Dialog open={open?.kind === "annotation"} title="highlight" onClose={close}>
      {shownAnnotation ? <div className={styles.compactAnnotation}>
        <AnnotationQuote annotation={shownAnnotation} />
        {activeMark ? <Button onClick={() => { const anchor = activeMark.anchor; close(); void reader.inspect({ target: anchor.kind === "text" ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end } : { kind: "quads", page: anchor.page, quads: anchor.quads }, signal: new AbortController().signal }); }}>view in source</Button> : null}
        {!annotation ? <p role="status">this highlight is no longer available. your writing is kept.</p> : null}
        <HighlightAnnotation highlightRef={shownAnnotation.ref} occurrenceKey={`compact:${shownAnnotation.ref}`} onWorkOwners={protectOwners} />
        <div className={styles.compactActions}>
          {shownAnnotation.selection.publication?.kind === "x_capture" ? <a href={readerHighlightChatIntentHref({ destination: { kind: "New" }, key: assumeReaderSelectionKey({ captureId: shownAnnotation.selection.publication.capture_id, highlightId: shownAnnotation.id }) })}>ask about this passage</a> : null}

          <Button tone="danger" disabled={!annotation || busy || blocked || !writing} onClick={() => commit(() => deleteResource(writing!, { ref: shownAnnotation.ref }), close)}>delete highlight</Button>
        </div>
        {issueNotice}
      </div> : open?.kind === "annotation" ? <FeedbackStatus content={{ tone: "Neutral", title: "opening highlight…" }} announcement="Polite" /> : null}
    </Dialog>
  </>;
  /** Annotations this publication cannot place, or every annotation when its text is unavailable. */
  const unplaced = state.annotations.filter(entry => entry.placement.kind !== "placed");
  const list = <>
    <LocalWritingError />
    {showPlaced && state.annotations.length ? <ResourceOutlineList scope={`capture-highlights:${mediaId}`} ariaLabel="your highlights">
      {state.annotations.map(entry => <ResourceOutlineRow key={entry.ref} resourceRef={entry.ref} incoming={null} occurrenceKey={`capture-highlight:${entry.ref}`} occurrenceLabel="highlight" />)}
    </ResourceOutlineList> : null}
    {!showPlaced && unplaced.length ? <section aria-label="unplaced highlights">
    {missing ? <FeedbackStatus content={{ tone: "Neutral", title: PLACEMENT_COPY.unavailable }} announcement="None" /> : null}
    <AnnotationList annotations={unplaced} />
  </section> : null}
  </>;
  const current = useRef({ doc, mediaId });
  current.current = { doc, mediaId };
  const onSelection = useCallback((notice: SelectionNotice) => {
    const { doc } = current.current;
    if (notice.kind !== "Admitted" || !doc || notice.selection.identity !== doc.identity) return;
    if (notice.selection.kind === "Rejected") { setIssue({ title: notice.selection.reason === "UnsupportedExcerpt" ? "this passage contains text that can’t be captured faithfully yet." : "select within one text section.", retry: null }); return; }
    let capture: Capture | null;
    try { capture = captureSelection(doc, current.current.mediaId, notice.selection.anchor, notice.selection.excerpt, notice.selection.excerpt_start, notice.selection.excerpt_end); }
    catch (error) {
      if (!(error instanceof ExcerptCaptureError)) throw error;
      setIssue({ title: "this passage contains text that can’t be captured faithfully yet.", retry: null });
      return;
    }
    if (capture && guard.confirmLoss({scopes: [], ownerIds: [draft.owner, ...annotationOwners.current]})) { setIssue(null); setNoteBody(value => ({...value, body: emptyBody(), revision: value.revision + 1})); setOpen({ kind: "selection", capture, identity: doc.identity }); }
  }, [guard, draft.owner, setNoteBody]);
  const onMarks = useCallback((event: MarkEvent) => {
    if (event.kind !== "activate" || !event.marks.length || !guard.confirmLoss({scopes: [], ownerIds: [draft.owner, ...annotationOwners.current]})) return;
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
