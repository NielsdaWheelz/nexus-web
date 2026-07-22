import { decodePresence, type Presence } from "@/lib/api/presence";
import type { ReadStatus } from "@/lib/collections/types";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";
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
  totalMinutes: number;
  remainingMinutes: Presence<number>;
}

export type ReadingTimeEstimatePresence = Presence<ReadingTimeEstimate>;

type DecodedReadingTimeEntry<T> = T extends object
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
  const totalMinutes = decodeMinutes(
    value.totalMinutes,
    "readingTimeEstimate.value.totalMinutes",
  );
  const remainingMinutes = decodePresence(value.remainingMinutes, (minutes) =>
    decodeMinutes(minutes, "readingTimeEstimate.value.remainingMinutes.value"),
  );
  if (
    remainingMinutes.kind === "Present" &&
    remainingMinutes.value > totalMinutes
  ) {
    throw new TypeError(
      "remaining reading time must not exceed total reading time",
    );
  }
  return { totalMinutes, remainingMinutes };
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
    return { ...raw, readingTimeEstimate: estimate };
  }

  const media = expectRecord(entry.media, "Library entry media");
  const mediaKind = expectOneOf(media.kind, MEDIA_KINDS, "Library media kind");
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

  return { ...raw, readingTimeEstimate: estimate };
}

function formatReadingDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

export function readingTimeSignal(
  estimate: ReadingTimeEstimatePresence,
  media: {
    processing_status: MediaProcessingStatus;
    read_state: ReadStatus;
    capabilities: { can_quote: boolean };
  },
): string | null {
  if (
    estimate.kind === "Absent" ||
    media.processing_status !== "ready_for_reading" ||
    !media.capabilities.can_quote
  ) {
    return null;
  }
  switch (media.read_state) {
    case "in_progress":
      if (estimate.value.remainingMinutes.kind === "Present") {
        return `≈ ${formatReadingDuration(
          estimate.value.remainingMinutes.value,
        )} left`;
      }
      return `≈ ${formatReadingDuration(estimate.value.totalMinutes)} read`;
    case "unread":
    case "finished":
      return `≈ ${formatReadingDuration(estimate.value.totalMinutes)} read`;
    default: {
      const exhaustive: never = media.read_state;
      throw new Error(`Unsupported Library read state: ${exhaustive}`);
    }
  }
}
