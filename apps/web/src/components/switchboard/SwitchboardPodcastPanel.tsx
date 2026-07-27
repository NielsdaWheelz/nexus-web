"use client";

import { ArrowLeft, RotateCw } from "lucide-react";
import type { BrowseResult } from "@/lib/browse/types";
import styles from "./switchboard.module.css";

type PodcastResult = Extract<
  BrowseResult,
  { type: "podcasts" | "podcast_episodes" }
>;

export default function SwitchboardPodcastPanel({
  query,
  results,
  busy,
  subscribingId,
  failed,
  onBack,
  onQuery,
  onSelect,
  onRetry,
}: {
  query: string;
  results: readonly PodcastResult[];
  busy: boolean;
  subscribingId: string | null;
  failed: boolean;
  onBack: () => void;
  onQuery: (query: string) => void;
  onSelect: (result: PodcastResult) => void;
  onRetry: () => void;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          <span className={styles.srOnly}>Back</span>
        </button>
        <h2 tabIndex={-1} data-switchboard-heading>
          Find a podcast
        </h2>
      </header>
      <label className={styles.findInput}>
        <span className={styles.srOnly}>Search podcasts</span>
        <input
          data-switchboard-podcast-query
          type="search"
          value={query}
          placeholder="Search podcasts…"
          disabled={subscribingId !== null}
          onChange={(event) => onQuery(event.currentTarget.value)}
        />
      </label>
      {failed ? (
        <p role="status">
          Couldn’t search podcasts.{" "}
          <button type="button" onClick={onRetry}>
            <RotateCw size={14} aria-hidden="true" /> Retry
          </button>
        </p>
      ) : null}
      {query.trim() && !busy && !failed && results.length === 0 ? (
        <p className={styles.empty}>No podcasts found</p>
      ) : null}
      <ul className={styles.rows}>
        {results.map((result) => {
          const owned = result.podcast_id !== null;
          const key =
            result.type === "podcasts"
              ? result.provider_podcast_id
              : result.provider_episode_id;
          const title =
            result.type === "podcasts" ? result.title : result.podcast_title;
          const metadata =
            result.type === "podcasts"
              ? owned
                ? "In your podcasts"
                : "Subscribe and open"
              : owned
                ? result.title
                : `${result.title} · Subscribe and open`;
          return (
            <li key={key} className={styles.row}>
              <button
                type="button"
                className={styles.rowMain}
                disabled={subscribingId !== null}
                onClick={() => onSelect(result)}
              >
                <span className={styles.rowLabel}>{title}</span>
                <span className={styles.rowMeta}>
                  {subscribingId === result.provider_podcast_id
                    ? "Subscribing…"
                    : metadata}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.liveRegion} aria-live="polite">
        {subscribingId !== null
          ? "Subscribing to podcast…"
          : busy
            ? "Searching podcasts…"
            : ""}
      </div>
    </div>
  );
}
