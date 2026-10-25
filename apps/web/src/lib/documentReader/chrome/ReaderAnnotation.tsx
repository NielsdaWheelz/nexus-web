"use client";

// One highlight as reading writing: its verbatim quote, the truth about where it is
// in the mounted source, and each attached note as its own editable resource in
// endpoint order. Note editing saves on this device as it happens; unlink and delete
// address exactly one note and never the highlight.
import { useState, useSyncExternalStore } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import ActionMenu from "@/components/ui/ActionMenu";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { deleteLink, deleteResource } from "@/lib/resourceGraph/links";
import type { AttachedNote, ReaderAnnotation } from "../annotations";
import styles from "./chrome.module.css";

export const PLACEMENT_COPY: Record<Exclude<ReaderAnnotation["placement"]["kind"], "placed">, string> = {
  unlocated: "passage couldn’t be located in this version",
  unavailable: "source isn’t available on this device",
};

/** The literal captured quote, never the current source text. */
export function AnnotationQuote({ annotation }: { readonly annotation: ReaderAnnotation }) {
  return <>
    <mark className={styles.annotationQuote} data-color={annotation.color}>{annotation.selection.quote_exact}</mark>
    {annotation.placement.kind === "unlocated" ? <FeedbackStatus content={{ tone: "Neutral", title: PLACEMENT_COPY.unlocated }} announcement="None" /> : null}
  </>;
}

function AttachedNoteRow({ note, editable }: { readonly note: AttachedNote; readonly editable: boolean }) {
  const writing = useWritingRuntime();
  const [failure, setFailure] = useState<string | null>(null);
  const command = (title: string, run: () => Promise<unknown>) => () => {
    setFailure(null);
    // an uncommitted frame is retried from the writing error notice; nothing else is lost.
    void run().catch((error: unknown) => { if (!(error instanceof LocalCommitError)) setFailure(title); });
  };
  return <li className={styles.attachedNote}>
    <BoundNoteEditor noteRef={note.ref} label="attached note" editable={editable} compact />
    {editable && writing ? <ActionMenu label="attached note actions" source={{ kind: "Immediate", subjectKey: note.ref, title: "attached note",
      content: { sections: [{ id: "Note", label: null, options: [
        { kind: "command", id: "UnlinkNote", label: "unlink", onSelect: command("note wasn’t unlinked", () => deleteLink(writing, { linkId: note.linkId })) },
        { kind: "command", id: "DeleteNote", label: "delete note", tone: "danger", onSelect: command("note wasn’t deleted", () => deleteResource(writing, { ref: note.ref })) },
      ] }] } }} /> : null}
    {failure ? <FeedbackNotice content={{ tone: "Warning", title: failure }} announcement="Polite" onDismiss={() => setFailure(null)} /> : null}
  </li>;
}

const NO_SUBSCRIPTION = () => () => {};

/** An uncommitted reading command holds the account's writing until it is retried. Note
 * editors report their own text's failure; this names every other one. */
export function LocalWritingError() {
  const writing = useWritingRuntime();
  const snapshot = useSyncExternalStore(writing?.subscribe ?? NO_SUBSCRIPTION, () => writing?.snapshot() ?? null, () => null);
  if (!writing || snapshot === null || snapshot.error === null ||
    snapshot.error_refs.length > 0 && snapshot.error_refs.every(ref => ref.startsWith("note_block:"))) return null;
  return <FeedbackNotice content={{ tone: "Danger", title: "couldn’t save on this device", message: "keep this page open. retry saving." }} announcement="Assertive"
    actions={[{ label: "retry saving", onClick: () => { void writing.retry().catch(() => {}); } }]} />;
}

/** Every attached note, independently, in the highlight's endpoint order. */
export function AttachedNotes({ annotation, editable = true }: { readonly annotation: ReaderAnnotation; readonly editable?: boolean }) {
  if (!annotation.notes.length) return null;
  return <ul className={styles.attachedNotes} aria-label="attached notes">
    {annotation.notes.map(note => <AttachedNoteRow key={note.ref} note={note} editable={editable} />)}
  </ul>;
}

/** Annotations without their source text: literal quotes and editable notes remain. */
export function AnnotationList({ annotations }: { readonly annotations: readonly ReaderAnnotation[] }) {
  if (!annotations.length) return null;
  return <section className={styles.annotationList} aria-label="your highlights">
    <ul>
      {annotations.map(annotation => <li key={annotation.ref}>
        <AnnotationQuote annotation={annotation} />
        <AttachedNotes annotation={annotation} />
      </li>)}
    </ul>
  </section>;
}
