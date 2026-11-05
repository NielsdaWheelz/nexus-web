"use client";

import { Fragment, useRef } from "react";
import { ContributorName, CreditLink } from "@/components/contributors/ContributorCredits";
import { creditName, selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import type { MediaSummary } from "@/lib/media/mediaSummary";
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
      {authors.slice(0, 3).map((credit, index) => <Fragment
        key={`${credit.contributor_handle ?? credit.credited_name}-${index}`}
      >
        {index > 0 ? <span className={styles.comma} aria-hidden="true">, </span> : null}
        <span className={styles.credit}><ContributorName credit={credit} className={styles.name} /></span>
      </Fragment>)}
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

// A show is credited like an author: one name that shrinks toward 1em and opens its page.
function IndexShow({ show, returnFocus }: {
  readonly show: NonNullable<MediaSummary["show"]>;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const name = useRef<HTMLSpanElement>(null);
  useActionFocusRecovery(name, returnFocus);
  return <span ref={name} className={styles.credit}>
    <CreditLink href={`/podcasts/${show.podcast_id}`} label={show.title} title={show.title} className={styles.name} />
  </span>;
}

/** Compact index-only show/authors/year; names shrink proportionally toward 1em,
 * while punctuation and year stay whole. Container width hides whole name links;
 * complete credited spelling and calendar precision survive.
 * The adapter supplies the same row's surviving more/title focus destination. */
export default function IndexBibliography({ show, contributors, originalPublishedDate, returnFocus }: {
  readonly show: MediaSummary["show"];
  readonly contributors: readonly ContributorCredit[];
  readonly originalPublishedDate: string | null;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const authors = selectMediaAuthors(contributors).filter((credit) => creditName(credit) !== null);
  if (show === null && authors.length === 0 && originalPublishedDate === null) return null;
  return <span className={styles.bibliography}>
    {show !== null ? <IndexShow show={show} returnFocus={returnFocus} /> : null}
    {show !== null && authors.length > 0 ? <span className={styles.separator} aria-hidden="true">·</span> : null}
    {authors.length > 0 ? <IndexAuthors authors={authors} returnFocus={returnFocus} /> : null}
    {originalPublishedDate !== null ? <>
      {show !== null || authors.length > 0 ? <span className={styles.separator} aria-hidden="true">·</span> : null}
      <time className={styles.year} dateTime={originalPublishedDate}>{originalPublishedDate.slice(0, 4)}</time>
    </> : null}
  </span>;
}
