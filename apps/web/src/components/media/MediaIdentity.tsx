import { Check } from "lucide-react";
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

/** Passive saved-position facts; authoritative state wins over percentage and time. */
export function MediaFacts({ summary }: { summary: MediaSummary }) {
  const { consumption, duration } = summary;
  const { state, progress } = consumption;
  const remaining = state !== "Finished" && duration !== null && duration.estimate.remaining_minutes !== null
    ? collectionActivityText({ kind: "RemainingTime", modality: duration.modality, minutes: duration.estimate.remaining_minutes }) : null;
  let sector: string | null = null;
  if (state === "InProgress" && progress !== null && progress > 0 && progress < 1) {
    const angle = 2 * Math.PI * progress;
    sector = `M 8 8 L ${8 + 6 * Math.sin(angle)} ${8 - 6 * Math.cos(angle)} A 6 6 0 ${progress < 0.5 ? 1 : 0} 1 8 2 Z`;
  }
  return <span className={styles.facts}>
    {remaining ? <span aria-hidden="true">{remaining.visible}</span> : null}
    {state === "Finished" ? <Check className={styles.glyph} aria-hidden="true" focusable="false" /> : <svg
      className={styles.glyph} viewBox="0 0 16 16" aria-hidden="true" focusable="false"
    >
      <circle cx="8" cy="8" r="6" fill={state === "Unread" || progress === 0 ? "currentColor" : "none"}
        stroke="currentColor" strokeWidth="1.5" strokeDasharray={state === "InProgress" && progress === null ? "2 2" : undefined} />
      {sector ? <path d={sector} fill="currentColor" /> : null}
    </svg>}
    <span className="sr-only">{collectionConsumptionText(consumption)}{remaining ? `; ${remaining.accessible}` : ""}.</span>
  </span>;
}

/** Bibliography truncates and demotes while the trailing saved-position facts persist. */
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
