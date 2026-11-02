"use client";

import { FullResourceBody } from "@/components/resources/ExcerptDisclosure";
import { authoredItem } from "@/lib/notes/presentation";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import type { ReaderAnnotation } from "../annotations";
import styles from "./chrome.module.css";

export const PLACEMENT_COPY: Record<Exclude<ReaderAnnotation["placement"]["kind"], "placed">, string> = {
  unlocated: "couldn’t find this passage in this version.",
  unavailable: "this source can’t be shown here.",
};

/** The literal captured quote, never the current source text. */
export function AnnotationQuote({ annotation }: { readonly annotation: ReaderAnnotation }) {
  return <>
    <FullResourceBody item={authoredItem(annotation.projection, annotation.readingRef)} />
    {annotation.placement.kind === "unlocated" ? <p className={styles.placement}>{PLACEMENT_COPY.unlocated}</p> : null}
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
