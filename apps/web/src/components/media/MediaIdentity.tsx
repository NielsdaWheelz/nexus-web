import IndexBibliography from "@/components/resources/IndexBibliography";
import {
  collectionActivityText,
  collectionConsumptionText,
} from "@/components/collections/collectionRowFormatting";
import type { MediaSubject, MediaSummary } from "@/lib/media/mediaSummary";
import styles from "./MediaIdentity.module.css";

/** Canonical title phrasing, also safe inside an atomic reference link. */
export function MediaTitle({ subject }: { subject: MediaSubject }) {
  return <span className={styles.title} dir="auto">{subject.kind === "Stored" ? subject.summary.title : subject.title}</span>;
}

export function MediaFacts({ summary }: { summary: MediaSummary }) {
  const minutes = summary.duration?.estimate.remaining_minutes;
  const remaining = summary.consumption.state !== "Finished" && summary.duration !== null && minutes != null
    ? collectionActivityText({ kind: "RemainingTime", modality: summary.duration.modality, minutes }) : null;
  return <span className={styles.facts}>
    <span className={styles.consumption}>{collectionConsumptionText(summary.consumption)}
      {remaining ? <span className={styles.separator} aria-hidden="true">·</span> : null}
    </span>
    {remaining ? <span>
      <span aria-hidden="true">{remaining.visible}</span>
      <span className="sr-only">{remaining.accessible}</span>
    </span> : null}
  </span>;
}

/** Index bibliography has first claim on space; routine reading facts demote by width. */
export default function MediaIdentity({ subject, returnFocus }: {
  subject: MediaSubject;
  returnFocus: () => HTMLElement | null;
}) {
  const summary = subject.kind === "Stored" ? subject.summary : null;
  return <span className={styles.support}>
    <IndexBibliography contributors={subject.kind === "Stored" ? subject.summary.contributors : subject.contributors}
      originalPublishedDate={summary?.original_published_date ?? null} returnFocus={returnFocus} />
    {summary ? <MediaFacts summary={summary} /> : null}
  </span>;
}
