"use client";

import { FullResourceBody } from "@/components/resources/ExcerptDisclosure";
import { authoredItem } from "@/lib/notes/presentation";
import { FeedbackStatus } from "@/components/feedback/Feedback";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import type { ReaderAnnotation } from "../annotations";
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

/** Annotations without their source text: literal quotes and owned annotations remain. */
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
