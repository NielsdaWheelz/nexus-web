import { decodePresence, type Presence } from "@/lib/api/presence";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import { decodePodcastUnplayedCount } from "@/lib/podcasts/activityFacts";
import {
  decodePodcastSyncStatus,
  type PodcastSyncStatus,
} from "@/lib/status/podcastSync";
import {
  decodeOptionalPublicationDate,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import {
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectInteger,
  expectOneOf,
  expectRecord,
} from "@/lib/validation";

const INT32_MAX = 2_147_483_647;
const MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "podcast_episode",
  "video",
] as const;
const PROCESSING_STATUSES = [
  "pending",
  "extracting",
  "ready_for_reading",
  "failed",
] as const;
const READ_STATES = ["unread", "in_progress", "finished"] as const;

export type LibraryMediaKind = (typeof MEDIA_KINDS)[number];

export interface ReadingTimeEstimate {
  totalMinutes: PositiveMinutes;
  remainingMinutes: Presence<PositiveMinutes>;
}

export type ReadingTimeEstimatePresence = Presence<ReadingTimeEstimate>;

type DecodedReadingTimeEntry<T> = T extends {
  kind: "media";
  media: infer Media;
}
  ? Omit<T, "media" | "readingTimeEstimate"> & {
      media: Media & {
        progressFraction: Presence<ProgressFraction>;
        publicationDate: Presence<PublicationDate>;
        sourceHost: Presence<string>;
      };
      readingTimeEstimate: ReadingTimeEstimatePresence;
    }
  : T extends { kind: "podcast"; podcast: infer Podcast }
    ? Omit<T, "podcast" | "readingTimeEstimate"> & {
        podcast: Podcast & {
          unplayedCount: ReturnType<typeof decodePodcastUnplayedCount>;
          publicationDate: Presence<PublicationDate>;
          syncStatus: Presence<PodcastSyncStatus>;
        };
        readingTimeEstimate: ReadingTimeEstimatePresence;
      }
    : T extends object
      ? Omit<T, "readingTimeEstimate"> & {
          readingTimeEstimate: ReadingTimeEstimatePresence;
        }
      : never;

function decodeMinutes(raw: unknown, name: string): number {
  const value = expectInteger(raw, name);
  if (value < 1 || value > INT32_MAX) {
    throw new TypeError(`${name} must be between 1 and ${INT32_MAX}`);
  }
  return value;
}

function decodeEstimate(raw: unknown): ReadingTimeEstimate {
  const value = expectExactRecord(
    raw,
    ["totalMinutes", "remainingMinutes"],
    "readingTimeEstimate.value",
  );
  const totalMinutes = {
    value: decodeMinutes(
      value.totalMinutes,
      "readingTimeEstimate.value.totalMinutes",
    ),
  };
  const remainingMinutes = decodePresence(value.remainingMinutes, (minutes) =>
    ({
      value: decodeMinutes(
        minutes,
        "readingTimeEstimate.value.remainingMinutes.value",
      ),
    }),
  );
  if (
    remainingMinutes.kind === "Present" &&
    remainingMinutes.value.value > totalMinutes.value
  ) {
    throw new TypeError(
      "remaining reading time must not exceed total reading time",
    );
  }
  return { totalMinutes, remainingMinutes };
}

function decodeSourceHost(
  kind: LibraryMediaKind,
  raw: unknown,
): Presence<string> {
  if (kind !== "web_article" || raw === null) return { kind: "Absent" };
  if (typeof raw !== "string") {
    throw new TypeError("Library media canonical_source_url must be a URL or null");
  }
  const host = new URL(raw).hostname;
  if (host.length === 0) {
    throw new TypeError("Library media canonical_source_url must have a host");
  }
  return { kind: "Present", value: host };
}

export function decodeLibraryReadingTimeEntry<T extends object>(
  raw: T,
): DecodedReadingTimeEntry<T>;
export function decodeLibraryReadingTimeEntry(
  raw: object,
): object & { readingTimeEstimate: ReadingTimeEstimatePresence } {
  const entry = expectRecord(raw, "Library entry");
  if ("reading_time_estimate" in entry) {
    throw new TypeError("Library entry must not contain reading_time_estimate");
  }
  if ("read_state" in entry || "progress_fraction" in entry) {
    throw new TypeError("Library entry consumption belongs to nested media");
  }
  const entryKind = expectOneOf(
    entry.kind,
    ["media", "podcast"] as const,
    "Library entry kind",
  );
  const estimate = decodePresence(entry.readingTimeEstimate, decodeEstimate);

  if (entryKind === "podcast") {
    if (estimate.kind === "Present") {
      throw new TypeError("Podcast Library entries cannot carry reading time");
    }
    const podcast = expectRecord(entry.podcast, "Library entry podcast");
    const syncStatus: Presence<PodcastSyncStatus> =
      entry.subscription === null
        ? { kind: "Absent" }
        : (() => {
            const subscription = expectRecord(
              entry.subscription,
              "Library entry subscription",
            );
            const status = expectOneOf(
              subscription.status,
              ["active", "unsubscribed"] as const,
              "Library entry subscription.status",
            );
            const decodedSyncStatus = decodePodcastSyncStatus(
              subscription.sync_status,
              "Library entry subscription.sync_status",
            );
            return status === "active"
              ? { kind: "Present", value: decodedSyncStatus }
              : { kind: "Absent" };
          })();
    const decoded = {
      ...raw,
      podcast: {
        ...podcast,
        unplayedCount: decodePodcastUnplayedCount(podcast.unplayed_count),
        publicationDate: { kind: "Absent" as const },
        syncStatus,
      },
      readingTimeEstimate: estimate,
    };
    return decoded;
  }

  const media = expectRecord(entry.media, "Library entry media");
  const publicationDate = decodeOptionalPublicationDate(
    media.published_date,
    "Library media published_date",
  );
  const mediaKind = expectOneOf(media.kind, MEDIA_KINDS, "Library media kind");
  const sourceHost = decodeSourceHost(mediaKind, media.canonical_source_url);
  const processingStatus = expectOneOf(
    media.processing_status,
    PROCESSING_STATUSES,
    "Library media processing_status",
  );
  const readState = expectOneOf(
    media.read_state,
    READ_STATES,
    "Library media read_state",
  );
  const progressFraction =
    media.progress_fraction === null
      ? null
      : expectFiniteNumber(
          media.progress_fraction,
          "Library media progress_fraction",
        );
  if (
    progressFraction !== null &&
    (progressFraction < 0 || progressFraction > 1)
  ) {
    throw new TypeError(
      "Library media progress_fraction must be in [0, 1] or null",
    );
  }
  const decodedProgressFraction: Presence<ProgressFraction> =
    progressFraction === null
      ? { kind: "Absent" }
      : { kind: "Present", value: { value: progressFraction } };
  const capabilities = expectRecord(
    media.capabilities,
    "Library media capabilities",
  );
  const canQuote = expectBoolean(
    capabilities.can_quote,
    "Library media capabilities.can_quote",
  );

  if (estimate.kind === "Present") {
    if (
      !(
        mediaKind === "web_article" ||
        mediaKind === "epub" ||
        mediaKind === "pdf"
      ) ||
      processingStatus !== "ready_for_reading" ||
      !canQuote
    ) {
      throw new TypeError("Reading time requires a ready, quotable document");
    }

    const hasRemaining = estimate.value.remainingMinutes.kind === "Present";
    if (mediaKind === "pdf") {
      if (hasRemaining) {
        throw new TypeError("PDF reading time cannot carry remaining time");
      }
    } else {
      const requiresRemaining =
        readState === "in_progress" && progressFraction !== null;
      if (hasRemaining !== requiresRemaining) {
        throw new TypeError(
          "Web and EPUB remaining time must match in-progress whole-document progression",
        );
      }
    }
  }

  const decoded = {
    ...raw,
    media: {
      ...media,
      progressFraction: decodedProgressFraction,
      publicationDate,
      sourceHost,
    },
    readingTimeEstimate: estimate,
  };
  return decoded;
}
