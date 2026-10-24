"use client";

import { useRef } from "react";
import { ContributorName } from "@/components/contributors/ContributorCredits";
import { creditName, selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./IndexBibliography.module.css";

// Mount focus recovery with the names, including when metadata arrives later.
function IndexAuthors({ authors, returnFocus }: {
  readonly authors: readonly ContributorCredit[];
  readonly returnFocus: () => HTMLElement | null;
}) {
  const names = useRef<HTMLSpanElement>(null);
  useActionFocusRecovery(names, returnFocus);
  return <>
    <span ref={names} className={styles.names}>
      {authors.slice(0, 3).map((credit, index) => <span
        className={styles.credit}
        key={`${credit.contributor_handle ?? credit.credited_name}-${index}`}
      >
        {index > 0 ? <span className={styles.comma} aria-hidden="true">, </span> : null}
        <ContributorName credit={credit} className={styles.name} />
      </span>)}
    </span>
    {authors.length > 3 ? <span className={styles.wideOverflow}>
      <span aria-hidden="true">, +{authors.length - 3}</span>
      <span className="sr-only">, {authors.length - 3} more {authors.length === 4 ? "author" : "authors"}</span>
    </span> : null}
    {authors.length > 1 ? <span className={styles.compactOverflow}>
      <span aria-hidden="true">, +{authors.length - 1}</span>
      <span className="sr-only">, {authors.length - 1} more {authors.length === 2 ? "author" : "authors"}</span>
    </span> : null}
  </>;
}

/** Index-only author names and first-publication year. Container width hides
 * whole name links; complete credited spelling and calendar precision survive.
 * The adapter supplies the same row's surviving more/title focus destination. */
export default function IndexBibliography({ contributors, originalPublishedDate, returnFocus }: {
  readonly contributors: readonly ContributorCredit[];
  readonly originalPublishedDate: string | null;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const authors = selectMediaAuthors(contributors).filter((credit) => creditName(credit) !== null);
  if (authors.length === 0 && originalPublishedDate === null) return null;
  return <span className={styles.bibliography}>
    {authors.length > 0 ? <IndexAuthors authors={authors} returnFocus={returnFocus} /> : null}
    {originalPublishedDate !== null ? <>
      {authors.length > 0 ? <span className={styles.separator} aria-hidden="true">·</span> : null}
      <time className={styles.year} dateTime={originalPublishedDate}>{originalPublishedDate.slice(0, 4)}</time>
    </> : null}
  </span>;
}
