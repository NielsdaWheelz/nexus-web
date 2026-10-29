"use client";

import { useSyncExternalStore } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import { useWritingRuntime } from "@/lib/notes/hooks";
import type { ReaderAnnotation } from "../annotations";
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

/** Annotations without their source text: literal quotes and editable notes remain. */
export function AnnotationList({ annotations }: { readonly annotations: readonly ReaderAnnotation[] }) {
  if (!annotations.length) return null;
  return <section className={styles.annotationList} aria-label="your highlights">
    <ul>
      {annotations.map(annotation => <li key={annotation.ref}>
        <AnnotationQuote annotation={annotation} />
        <HighlightAnnotation highlightRef={annotation.ref} occurrenceKey={`unplaced:${annotation.ref}`} />
      </li>)}
    </ul>
  </section>;
}
