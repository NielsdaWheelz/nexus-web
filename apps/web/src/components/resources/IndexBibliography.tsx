"use client";

import { Fragment, useRef, type ReactNode } from "react";
import { ContributorName, CreditLink } from "@/components/contributors/ContributorCredits";
import type { Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import { creditName, selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./IndexBibliography.module.css";

/** Who the line credits: an episode's show, or a work's authors. */
export type IndexByline =
  | { readonly kind: "Show"; readonly show: Schema<"MediaShowOut"> }
  | { readonly kind: "Authors"; readonly contributors: readonly ContributorCredit[] };

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
  readonly show: Schema<"MediaShowOut">;
  readonly returnFocus: () => HTMLElement | null;
}) {
  const name = useRef<HTMLSpanElement>(null);
  useActionFocusRecovery(name, returnFocus);
  return <span ref={name} className={styles.credit}>
    <CreditLink href={`/podcasts/${show.podcast_id}`} label={show.title} title={show.title} className={styles.name} />
  </span>;
}

/** Compact index-only byline/year; names shrink proportionally toward 1em,
 * while punctuation and year stay whole. Container width hides whole name links;
 * complete credited spelling and calendar precision survive. A null byline leaves
 * the slot empty. The adapter supplies the same row's surviving more/title focus destination. */
export default function IndexBibliography({ byline, originalPublishedDate, returnFocus }: {
  readonly byline: IndexByline | null;
  readonly originalPublishedDate: string | null;
  readonly returnFocus: () => HTMLElement | null;
}) {
  let lead: ReactNode = null;
  if (byline !== null) switch (byline.kind) {
    case "Show": lead = <IndexShow show={byline.show} returnFocus={returnFocus} />; break;
    case "Authors": {
      const authors = selectMediaAuthors(byline.contributors).filter((credit) => creditName(credit) !== null);
      if (authors.length > 0) lead = <IndexAuthors authors={authors} returnFocus={returnFocus} />;
      break;
    }
    default: assertNever(byline);
  }
  if (lead === null && originalPublishedDate === null) return null;
  return <span className={styles.bibliography}>
    {lead}
    {originalPublishedDate !== null ? <>
      {lead !== null ? <span className={styles.separator} aria-hidden="true">·</span> : null}
      <time className={styles.year} dateTime={originalPublishedDate}>{originalPublishedDate.slice(0, 4)}</time>
    </> : null}
  </span>;
}
