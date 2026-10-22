import { Fragment } from "react";
import { ContributorCreditList } from "@/components/contributors/ContributorCredits";
import {
  collectionActivityText,
  collectionConsumptionText,
  collectionPublicationYear,
} from "@/components/collections/collectionRowFormatting";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import styles from "./MediaIdentity.module.css";

/** Canonical title phrasing, also safe inside an atomic reference link. */
export function MediaTitle({ subject }: { subject: MediaSubject }) {
  return (
    <span className={styles.title} dir="auto">
      {subject.kind === "Stored" ? subject.summary.title : subject.title}
    </span>
  );
}

/** Bibliography and consumption are shared by live collection and outline rows. */
export default function MediaIdentity({ subject }: { subject: MediaSubject }) {
  const summary = subject.kind === "Stored" ? subject.summary : null;
  const contributors = selectMediaAuthors(
    summary?.contributors ?? (subject.kind === "External" ? subject.contributors : []),
  );
  const date = summary?.original_published_date ??
    (subject.kind === "External" ? subject.publication_date : null);
  const bibliography = [
    contributors.length ? (
      <ContributorCreditList
        key="authors"
        credits={contributors}
        maxVisible={subject.kind === "External" ? contributors.length : 2}
        overflowNoun="authors"
      />
    ) : null,
    date !== null ? (
      <time key="date" dateTime={date}>{collectionPublicationYear(date)}</time>
    ) : null,
  ].filter((part) => part !== null);
  const minutes = summary?.duration?.estimate.remaining_minutes;
  const remaining = summary !== null &&
    summary.consumption.state !== "Finished" &&
    summary.duration !== null && minutes != null
    ? collectionActivityText({
        kind: "RemainingTime",
        modality: summary.duration.modality,
        minutes,
      })
    : null;
  return (
    <div className={styles.support}>
      {bibliography.length ? (
        <span className={styles.bibliography}>
          {bibliography.map((part, index) => (
            <Fragment key={index}>
              {index ? <span className={styles.separator} aria-hidden="true">·</span> : null}
              {part}
            </Fragment>
          ))}
        </span>
      ) : null}
      {summary ? (
        <span className={styles.facts}>
          {collectionConsumptionText(summary.consumption)}
          {remaining ? (
            <>
              <span className={styles.separator} aria-hidden="true">·</span>
              <span aria-hidden="true">{remaining.visible}</span>
              <span className="sr-only">, {remaining.accessible}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {summary?.processing_status === "failed" ? (
        <span className={styles.failure}>processing failed</span>
      ) : null}
    </div>
  );
}
