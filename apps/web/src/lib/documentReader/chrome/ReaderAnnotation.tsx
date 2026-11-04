"use client";

import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import { FullResourceBody } from "@/components/resources/ExcerptDisclosure";
import { localResourceHref } from "@/lib/resources/localResource";
import { authoredItem } from "@/lib/notes/presentation";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import type { ReaderAnnotation } from "../annotations";
import styles from "./chrome.module.css";

export const PLACEMENT_COPY: Record<Exclude<ReaderAnnotation["placement"]["kind"], "placed">, string> = {
  unlocated: "couldn’t find this passage in this version.",
  unavailable: "this source can’t be shown here.",
};

/** Where a highlight stands against the version shown, as row text beside it. */
export function PlacementNote({ kind }: { readonly kind: keyof typeof PLACEMENT_COPY }) {
  return <p className={styles.placement}>{PLACEMENT_COPY[kind]}</p>;
}

/** The literal captured quote, never the current source text. */
export function AnnotationQuote({ annotation }: { readonly annotation: ReaderAnnotation }) {
  const projection = annotation.display?.projection ?? annotation.projection;
  return <>
    <FullResourceBody item={authoredItem(projection, annotation.readingRef, localResourceHref(projection, { activationRef: annotation.readingRef }))} />
    {annotation.placement.kind === "unlocated" ? <PlacementNote kind="unlocated" /> : null}
  </>;
}

/** Annotations without their source text: literal quotes and owned annotations remain. */
export function AnnotationList({ annotations }: { readonly annotations: readonly ReaderAnnotation[] }) {
  if (!annotations.length) return null;
  return <section className={styles.annotationList} aria-label="your highlights">
    <ul>
      {annotations.map(annotation => annotation.display ? <PreparedResourcesContext key={annotation.ref} value={annotation.display.resources}><li>
        <AnnotationQuote annotation={annotation} />
        <HighlightAnnotation highlightRef={annotation.ref} resource={annotation.display.projection} occurrenceKey={`unplaced:${annotation.ref}`} />
      </li></PreparedResourcesContext> : null)}
    </ul>
  </section>;
}
