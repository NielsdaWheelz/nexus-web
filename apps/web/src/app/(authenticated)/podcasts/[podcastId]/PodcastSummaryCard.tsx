"use client";

import Image from "next/image";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import { formatSubscriptionPlaybackSummary } from "@/lib/player/subscriptionPlaybackSpeed";
import type { PodcastDetailResponse } from "../podcastSubscriptions";
import styles from "./page.module.css";

export default function PodcastSummaryCard({
  detail,
  activeSubscription,
  podcastLibraryCount,
}: {
  detail: PodcastDetailResponse;
  activeSubscription: PodcastDetailResponse["subscription"];
  podcastLibraryCount: number;
}) {
  return (
    <div className={styles.summaryCard}>
      <div className={styles.summaryHeader}>
        {detail.podcast.image_url ? (
          <Image
            src={buildMediaImageProxySrc(detail.podcast.image_url)}
            alt=""
            width={88}
            height={88}
            className={styles.summaryArtwork}
            unoptimized
          />
        ) : (
          <span className={styles.summaryArtworkFallback} aria-hidden="true">
            {detail.podcast.title
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase() ?? "")
              .join("") || "P"}
          </span>
        )}
        <div className={styles.summaryCopy}>
          <h2 className={styles.summaryTitle}>{detail.podcast.title}</h2>
          <ContributorCreditList
            credits={detail.podcast.contributors}
            className={styles.summaryByline}
            maxVisible={3}
          />
          <p className={styles.summaryDescription}>
            {detail.podcast.description?.trim() || "No summary from source."}
          </p>
        </div>
      </div>
      <div className={styles.summaryMeta}>
        <span className={styles.summaryMetaBadge}>
          {activeSubscription ? "Subscribed" : "Not subscribed"}
        </span>
        <span className={styles.summaryMetaBadge}>
          In {podcastLibraryCount} librar
          {podcastLibraryCount === 1 ? "y" : "ies"}
        </span>
        {activeSubscription ? (
          <span className={styles.summaryMetaBadge}>
            Sync {activeSubscription.sync_status}
          </span>
        ) : null}
        {activeSubscription ? (
          <span className={styles.summaryMetaBadge}>
            {formatSubscriptionPlaybackSummary(
              activeSubscription.default_playback_speed,
              activeSubscription.auto_queue,
            )}
          </span>
        ) : null}
        {detail.podcast.feed_url ? (
          <a
            href={detail.podcast.feed_url}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.summaryMetaLink}
          >
            RSS feed
          </a>
        ) : null}
        {detail.podcast.website_url ? (
          <a
            href={detail.podcast.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.summaryMetaLink}
          >
            Website
          </a>
        ) : null}
      </div>
      {activeSubscription ? (
        <p className={styles.syncState}>
          Subscription is active. Manage playback defaults, sync, and library
          membership from this header.
        </p>
      ) : (
        <p className={styles.unsubscribedLabel}>
          Subscribe to save playback defaults and add this show to your
          libraries.
        </p>
      )}
      {activeSubscription?.sync_error_code && (
        <p className={styles.syncError}>
          <strong>{activeSubscription.sync_error_code}</strong>
          {activeSubscription.sync_error_message
            ? `: ${activeSubscription.sync_error_message}`
            : ""}
        </p>
      )}
    </div>
  );
}
