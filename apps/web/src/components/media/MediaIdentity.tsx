"use client";

import * as Icon from "@/lib/ui/icons";
import IndexBibliography from "@/components/resources/IndexBibliography";
import type { MediaSubject, MediaSummary } from "@/lib/media/mediaSummary";
import { cx } from "@/lib/ui/cx";
import styles from "./MediaIdentity.module.css";

/** Canonical title phrasing, also safe inside an atomic reference link. */
export function MediaTitle({ subject, className }: { subject: MediaSubject; className?: string }) {
  return <span className={cx(styles.title, className)} dir="auto">{subject.kind === "Stored" ? subject.summary.title : subject.title}</span>;
}

/** Passive saved-position facts; authoritative state wins over percentage and time. */
export function MediaFacts({ summary }: { summary: MediaSummary }) {
  const { consumption: { state, progress }, duration } = summary;
  let consumptionText: string;
  switch (state) {
    case "Unread": consumptionText = "unread"; break;
    case "Finished": consumptionText = "finished"; break;
    case "InProgress": consumptionText = progress !== null
      ? `in progress; saved position ${Math.round(progress * 100)}%` : "in progress; percentage unavailable"; break;
  }
  let remaining: { readonly visible: string; readonly accessible: string } | null = null;
  if (state !== "Finished" && duration !== null && duration.estimate.remaining_minutes !== null) {
    const minutes = duration.estimate.remaining_minutes;
    // The estimate is a known nonnegative integer number of minutes.
    let visible = minutes > 9 * 525600 ? ">9y" : `${Math.ceil(minutes / 525600)}y`;
    for (const [unitMinutes, unit] of [[1, "m"], [60, "h"], [1440, "d"], [10080, "w"]] as const) {
      const count = Math.ceil(minutes / unitMinutes);
      if (count <= 99) { visible = `${count}${unit}`; break; }
    }
    remaining = {
      visible,
      accessible: `estimated ${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining to ${{ Read: "read", Listen: "listen at normal speed" }[duration.modality]}`,
    };
  }
  let sector: string | null = null;
  if (state === "InProgress" && progress !== null && progress > 0 && progress < 1) {
    const angle = 2 * Math.PI * progress;
    sector = `M 8 8 L ${8 + 6 * Math.sin(angle)} ${8 - 6 * Math.cos(angle)} A 6 6 0 ${progress < 0.5 ? 1 : 0} 1 8 2 Z`;
  }
  return <span className={styles.facts}>
    {remaining ? <span aria-hidden="true">{remaining.visible}</span> : null}
    {state === "Finished" ? <Icon.Check className={styles.glyph} aria-hidden="true" focusable="false" /> : <svg
      className={styles.glyph} viewBox="0 0 16 16" aria-hidden="true" focusable="false"
    >
      <circle cx="8" cy="8" r="6" fill={state === "Unread" || progress === 0 ? "currentColor" : "none"}
        stroke="currentColor" strokeWidth="1.5" strokeDasharray={state === "InProgress" && progress === null ? "2 2" : undefined} />
      {sector ? <path d={sector} fill="currentColor" /> : null}
    </svg>}
    <span className="sr-only">{consumptionText}{remaining ? `; ${remaining.accessible}` : ""}.</span>
  </span>;
}

/** Index bibliography and provenance. Only the matching show's episode list omits its show.
 * Rows own facts: MediaFacts goes in their trailing cell. */
export default function MediaIdentity({ subject, returnFocus, containingPodcastId = null }: {
  subject: MediaSubject;
  returnFocus: () => HTMLElement | null;
  containingPodcastId?: string | null;
}) {
  const summary = subject.kind === "Stored" ? subject.summary : null;
  return <span className={styles.support}>
    <IndexBibliography show={summary?.show?.podcast_id === containingPodcastId ? null : summary?.show ?? null}
      contributors={subject.kind === "Stored" ? subject.summary.contributors : subject.contributors}
      originalPublishedDate={summary?.original_published_date ?? null}
      publisherPublication={summary?.publisher_publication ?? null} returnFocus={returnFocus} />
    {summary?.part_source ? <span className={styles.provenance}>from {summary.part_source.title}</span> : null}
  </span>;
}
