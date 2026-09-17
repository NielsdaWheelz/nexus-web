import { decodePresence, type Presence } from "@/lib/api/presence";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import {
  MEDIA_KINDS,
  type MediaKind,
} from "@/lib/media/kind";
import {
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectInteger,
  expectOneOf,
  expectRecord,
} from "@/lib/validation";

const INT32_MAX = 2_147_483_647;

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
        podcast: Podcast;
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
  return { totalMinutes, remainingMinutes };
}

function decodeSourceHost(
  kind: MediaKind,
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
  const entryKind = expectOneOf(
    entry.kind,
    ["media", "podcast"] as const,
    "Library entry kind",
  );
  const estimate = decodePresence(entry.readingTimeEstimate, decodeEstimate);

  if (entryKind === "podcast") {
    const decoded = {
      ...raw,
      readingTimeEstimate: estimate,
    };
    return decoded;
  }

  const media = expectRecord(entry.media, "Library entry media");
  const mediaKind = expectOneOf(
    media.kind,
    MEDIA_KINDS,
    "Library media kind",
  );
  const sourceHost = decodeSourceHost(mediaKind, media.canonical_source_url);
  expectBoolean(
    media.progress_resettable,
    "Library media progress_resettable",
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
  const decoded = {
    ...raw,
    media: {
      ...media,
      progressFraction: decodedProgressFraction,
      publicationDate: media.original_published_date,
      sourceHost,
    },
    readingTimeEstimate: estimate,
  };
  return decoded;
}
