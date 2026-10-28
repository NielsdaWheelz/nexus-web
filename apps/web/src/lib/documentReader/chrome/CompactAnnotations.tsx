"use client";

// Annotation for hosts without the workspace composer: the downloaded shelf and saved
// episode transcripts. One admitted selection becomes a new independent highlight,
// optionally with a plain note; a mark opens its highlight with every attached note
// editable in place. Commits are local; a failed commit keeps the typed note.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useAuthoredStore } from "@/lib/authored/provider";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { deleteResource } from "@/lib/resourceGraph/links";
import { bodyHasContent, emptyBody, type NoteBody } from "@nexus/authored/body";
import NoteEditor from "@/components/notes/NoteEditor";
import { attachNote, captureSelection, createHighlight, createReaderAnnotations, type Capture, type SourceLabel } from "../annotations";
import { useReaderState, type Decorations, type MarkEvent, type SelectionNotice } from "../DocumentReader";
import type { Reader } from "../runtime";
import { AnnotationList, AnnotationQuote, AttachedNotes, LocalWritingError, PLACEMENT_COPY } from "./ReaderAnnotation";
import styles from "./chrome.module.css";

const NO_SUBSCRIPTION = () => () => {};

type Open =
  | { readonly kind: "selection"; readonly capture: Capture }
  | { readonly kind: "annotation"; readonly id: string }
  | { readonly kind: "choose"; readonly ids: readonly string[] };

/** What the reader view takes from the annotation layer; stable while nothing changes. */
export interface ReaderAnnotationProps {
  readonly decorations: Decorations | undefined;
  readonly onSelection: (notice: SelectionNotice) => void;
  readonly onMarks: (event: MarkEvent) => void;
}

/** `available` false: this host has no source text (missing or failed); annotations still list. */
export function useCompactAnnotations(reader: Reader, mediaId: string, source: SourceLabel, available: boolean) {
  const store = useAuthoredStore();
  const writing = useWritingRuntime();
  const [annotations] = useState(() => createReaderAnnotations(store, mediaId));
  const document = useReaderState(reader, state => state.document);
  const doc = available && document.status === "ready" ? document.doc : null;
  const missing = !available || document.status === "failed";
  useEffect(() => { if (doc) annotations.bind(doc); else if (missing) annotations.bind(null); }, [annotations, doc, missing]);
  const state = useSyncExternalStore(annotations.subscribe, annotations.getState, annotations.getState);
  const [open, setOpen] = useState<Open | null>(null);
  // the unsubmitted note is the same ephemeral content editor the workspace composer uses.
  const [note, setNoteBody] = useState<{ body: NoteBody; revision: number }>(() => ({ body: emptyBody(), revision: 0 }));
  const setNote = (body: NoteBody) => setNoteBody(current => ({ body, revision: current.revision + 1 }));
  const hasNote = bodyHasContent(note.body);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<{ readonly title: string; readonly retry: (() => void) | null } | null>(null);
  // one failed frame holds the account's writing; it retries from LocalWritingError, never resaves.
  const blocked = useSyncExternalStore(writing?.subscribe ?? NO_SUBSCRIPTION, () => writing?.snapshot().error != null, () => false);
  const [focused, setFocused] = useState<string | null>(null);
  const close = () => { setOpen(null); setNote(emptyBody()); setIssue(null); setFocused(null); };
  const decorations = useMemo<Decorations | undefined>(() => doc ? { identity: doc.identity, marks: state.marks, noteRefs: [], focused, hovered: null } : undefined,
    [doc, focused, state.marks]);

  /** Runs one local commit; the typed note clears only once its commit is durable. */
  const commit = (run: () => Promise<unknown>, done: () => void) => {
    setBusy(true); setIssue(null);
    void run().then(() => { setNote(emptyBody()); done(); }, (error: unknown) => {
      // the same frozen frame retries here or from the layer notice; the typed note is already in it.
      setIssue(error instanceof LocalCommitError
        ? { title: "couldn’t save on this device", retry: () => { void error.retry().then(() => { setIssue(null); setNote(emptyBody()); done(); }, () => {}); } }
        : { title: "couldn’t save this annotation", retry: null });
    }).finally(() => setBusy(false));
  };
  const save = (capture: Capture, withNote: boolean) => {
    if (!writing) return;
    const id = crypto.randomUUID();
    commit(() => createHighlight(writing, { id, capture, color: "yellow", note: withNote && hasNote ? note.body : null,
      source: capture.sourceRef === `media:${mediaId}` ? source : null }), () => setOpen({ kind: "annotation", id }));
  };
  const annotation = open?.kind === "annotation" ? annotations.annotation(open.id) : null;
  const editor = (placeholder: string, onSave: () => void) => <NoteEditor editorKey={`reader-annotation:${mediaId}`} containingNoteRef={null}
    body={note.body} revision={note.revision} label="note on passage" placeholder={placeholder} compact editable={!busy}
    history={null} onEdit={edit => setNote(edit.after)} onSave={onSave} />;
  const issueNotice = issue ? <FeedbackNotice content={{ tone: "Danger", title: issue.title,
    message: issue.retry ? "keep this page open. retry saving." : "nothing was saved. try again." }} announcement="Assertive"
    actions={issue.retry ? [{ label: "retry", onClick: issue.retry }] : undefined} /> : null;
  const panel = <>
    <Dialog open={open?.kind === "selection"} title="annotate passage" onClose={close}>
      {open?.kind === "selection" ? <div className={styles.compactAnnotation}>
        <mark className={styles.annotationQuote} data-color="yellow">{open.capture.selection.quote_exact}</mark>
        {editor("write a note…", () => save(open.capture, true))}
        <div className={styles.compactActions}>
          <Button emphasis="strong" disabled={busy || blocked} onClick={() => save(open.capture, true)}>{hasNote ? "save note" : "save highlight"}</Button>
          <Button onClick={close}>cancel</Button>
        </div>
      </div> : null}
      {issueNotice}
    </Dialog>
    <Dialog open={open?.kind === "choose"} title="choose highlight" onClose={close}>
      {open?.kind === "choose" ? <ul className={styles.attachedNotes}>
        {open.ids.flatMap(id => { const entry = annotations.annotation(id); return entry ? [<li key={id}>
          <Button onClick={() => { setFocused(id); setOpen({ kind: "annotation", id }); }}>{entry.selection.quote_exact}</Button>
        </li>] : []; })}
      </ul> : null}
    </Dialog>
    <Dialog open={open?.kind === "annotation"} title="highlight" onClose={close}>
      {annotation ? <div className={styles.compactAnnotation}>
        <AnnotationQuote annotation={annotation} />
        <AttachedNotes annotation={annotation} />
        {editor(annotation.notes.length ? "add another note…" : "write a note…", () => { if (hasNote && writing && !blocked) commit(() => attachNote(writing, annotation, note.body), () => {}); })}
        <div className={styles.compactActions}>
          <Button emphasis="strong" disabled={busy || blocked || !hasNote || !writing} onClick={() => commit(() => attachNote(writing!, annotation, note.body), () => {})}>save note</Button>
          <Button tone="danger" disabled={busy || blocked || !writing} onClick={() => commit(() => deleteResource(writing!, { ref: annotation.ref }), close)}>delete highlight</Button>
        </div>
        {issueNotice}
      </div> : open?.kind === "annotation" ? <FeedbackStatus content={{ tone: "Neutral", title: "opening highlight…" }} announcement="Polite" /> : null}
    </Dialog>
  </>;
  /** Annotations this publication cannot place, or every annotation when its text is unavailable. */
  const unplaced = state.annotations.filter(entry => entry.placement.kind !== "placed");
  const list = <>
    <LocalWritingError />
    {unplaced.length ? <section aria-label="unplaced highlights">
    {missing ? <FeedbackStatus content={{ tone: "Neutral", title: PLACEMENT_COPY.unavailable }} announcement="None" /> : null}
    <AnnotationList annotations={unplaced} />
  </section> : null}
  </>;
  const current = useRef({ doc, mediaId });
  current.current = { doc, mediaId };
  const onSelection = useCallback((notice: SelectionNotice) => {
    const { doc } = current.current;
    if (notice.kind !== "Admitted" || notice.selection.kind !== "Captured" || !doc || notice.selection.identity !== doc.identity) return;
    const capture = captureSelection(doc, current.current.mediaId, notice.selection.anchor);
    if (capture) { setIssue(null); setOpen({ kind: "selection", capture }); }
  }, []);
  const onMarks = useCallback((event: MarkEvent) => {
    if (event.kind !== "activate" || !event.marks.length) return;
    setIssue(null);
    if (event.marks.length === 1) { setFocused(event.marks[0]!.id); setOpen({ kind: "annotation", id: event.marks[0]!.id }); }
    else setOpen({ kind: "choose", ids: event.marks.map(mark => mark.id) });
  }, []);
  return { decorations, onSelection, onMarks, panel, list };
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
