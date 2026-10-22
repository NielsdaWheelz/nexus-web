import ResourceMetadata from "@/components/resources/ResourceMetadata";
import { bibliographyMetadata } from "@/lib/resources/metadata";
import {
  collectionActivityText,
  collectionConsumptionText,
} from "@/components/collections/collectionRowFormatting";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import type { MediaSubject, MediaSummary } from "@/lib/media/mediaSummary";
import styles from "./MediaIdentity.module.css";

/** Canonical title phrasing, also safe inside an atomic reference link. */
export function MediaTitle({ subject }: { subject: MediaSubject }) {
  return (
    <span className={styles.title} dir="auto">
      {subject.kind === "Stored" ? subject.summary.title : subject.title}
    </span>
  );
}

export function MediaFacts({ summary }: { summary: MediaSummary }) {
  const minutes = summary.duration?.estimate.remaining_minutes;
  const remaining = summary.consumption.state !== "Finished" &&
    summary.duration !== null && minutes != null
    ? collectionActivityText({
        kind: "RemainingTime",
        modality: summary.duration.modality,
        minutes,
      })
    : null;
  return <span className={styles.facts}>
    {collectionConsumptionText(summary.consumption)}
    {remaining ? <>
      <span className={styles.separator} aria-hidden="true">·</span>
      <span aria-hidden="true">{remaining.visible}</span>
      <span className="sr-only">, {remaining.accessible}</span>
    </> : null}
  </span>;
}

/** Canonical index support, composed from bibliography and independent reading facts. */
export default function MediaIdentity({ subject }: { subject: MediaSubject }) {
  const summary = subject.kind === "Stored" ? subject.summary : null;
  const contributors = selectMediaAuthors(subject.kind === "Stored" ? subject.summary.contributors : subject.contributors);
  const date = subject.kind === "Stored" ? subject.summary.original_published_date : subject.publication_date;
  return <div className={styles.support}>
    <span className={styles.bibliography}><ResourceMetadata parts={bibliographyMetadata(contributors, date)} linkSource={false} /></span>
    {summary ? <MediaFacts summary={summary} /> : null}
    {summary?.processing_status === "failed" ? <span className={styles.failure}>processing failed</span> : null}
  </div>;
}
