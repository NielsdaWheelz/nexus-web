"use client";

import { Unlink } from "lucide-react";
import { ACTION_CATALOG } from "@/lib/actions/catalog";

// One highlight as reading writing: its verbatim quote, the truth about where it is
// in the mounted source, and each attached note as its own editable resource in
// endpoint order. Note editing saves on this device as it happens; unlink and delete
// address exactly one note and never the highlight.
import { FullResourceBody } from "@/components/resources/ExcerptDisclosure";
import { authoredItem } from "@/lib/notes/presentation";
import { useState } from "react";
import { FeedbackFailure, FeedbackStatus, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import ActionMenu from "@/components/ui/ActionMenu";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError, isAuthoredStorageFailure } from "@/lib/notes/runtime";
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
    <FullResourceBody item={authoredItem(annotation.projection, annotation.readingRef)} />
    {annotation.placement.kind === "unlocated" ? <FeedbackStatus content={{ tone: "Neutral", title: PLACEMENT_COPY.unlocated }} announcement="None" /> : null}
  </>;
}

function AttachedNoteRow({ note, editable }: { readonly note: AttachedNote; readonly editable: boolean }) {
  const writing = useWritingRuntime();
  const [failure, setFailure] = useState<{title: string; run(): Promise<unknown>} | null>(null);
  const [busy, setBusy] = useState(false);
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  const occurrence = useFeedbackOccurrence(failure !== null, note.ref);
  const perform = (title: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void run().then(() => setFailure(null), (error: unknown) => {
      if (error instanceof LocalCommitError) return;
      if (isAuthoredStorageFailure(error)) setFailure({title, run}); else setDefect({error});
    }).finally(() => setBusy(false));
  };
  const command = (title: string, run: () => Promise<unknown>) => () => perform(title, run);
  if (defect) throw defect.error;
  return <li className={styles.attachedNote}>
    <BoundNoteEditor noteRef={note.ref} label="attached note" editable={editable} compact />
    {editable && writing ? <ActionMenu label="attached note actions" source={{ kind: "Immediate", subjectKey: note.ref, title: "attached note",
      content: { sections: [{ id: "Note", label: null, options: [
        { kind: "command", id: "UnlinkNote", label: "Unlink", icon: <Unlink size={16} aria-hidden="true" />, onSelect: command("note wasn’t unlinked", () => deleteLink(writing, { linkId: note.linkId })) },
        { kind: "command", id: "DeleteNote", label: ACTION_CATALOG.DeleteNote.label, icon: <ACTION_CATALOG.DeleteNote.icon size={16} aria-hidden="true" />, tone: "danger", onSelect: command("note wasn’t deleted", () => deleteResource(writing, { ref: note.ref })) },
      ] }] } }} /> : null}
    {failure ? <FeedbackFailure scope="Local" occurrence={occurrence} content={{ tone: "Warning", title: failure.title }} announcement="Polite" actions={[{label: "retry", busy, onClick: () => perform(failure.title, failure.run)}]} /> : null}
  </li>;
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
