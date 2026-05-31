/**
 * Browse pane data shapes and pure state helpers.
 *
 * Owns the four browse result-row shapes (documents, videos, podcasts,
 * episodes), the per-section page/results envelope, the URL <-> visible-
 * type-set parser, document label helpers, and the immutable section-state
 * mutators that the browse component composes into its reducers.
 */

import type { ContributorCredit } from "@/lib/contributors/types";

export type BrowseSectionType =
  | "documents"
  | "videos"
  | "podcasts"
  | "podcast_episodes";

type BrowsePageInfo = {
  has_more: boolean;
  next_cursor: string | null;
};

export type BrowseDocumentResult = {
  type: "documents";
  title: string;
  description: string | null;
  url: string;
  document_kind: "pdf" | "epub" | "web_article";
  site_name: string | null;
  source_label?: string | null;
  source_type?: string | null;
  media_id?: string | null;
  contributors?: ContributorCredit[];
};

export type BrowseVideoResult = {
  type: "videos";
  provider_video_id: string;
  title: string;
  description: string | null;
  watch_url: string;
  published_at: string | null;
  thumbnail_url: string | null;
  media_id?: string | null;
  contributors: ContributorCredit[];
};

export type BrowsePodcastResult = {
  type: "podcasts";
  podcast_id: string | null;
  provider_podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
};

export type BrowseEpisodeResult = {
  type: "podcast_episodes";
  podcast_id: string | null;
  provider_podcast_id: string;
  provider_episode_id: string;
  podcast_title: string;
  podcast_contributors: ContributorCredit[];
  podcast_image_url: string | null;
  title: string;
  audio_url: string;
  published_at: string | null;
  duration_seconds: number | null;
  feed_url: string;
  website_url: string | null;
  description: string | null;
};

export type BrowseResult =
  | BrowseDocumentResult
  | BrowseVideoResult
  | BrowsePodcastResult
  | BrowseEpisodeResult;

export type BrowseSectionData = {
  results: BrowseResult[];
  page: BrowsePageInfo;
};

export type BrowseResponse = {
  data: {
    query?: string;
    sections: Partial<Record<BrowseSectionType, BrowseSectionData>>;
  };
};

export const BROWSE_TYPES: BrowseSectionType[] = [
  "documents",
  "videos",
  "podcasts",
  "podcast_episodes",
];

export const TYPE_LABELS: Record<BrowseSectionType, string> = {
  documents: "Documents",
  videos: "Videos",
  podcasts: "Podcasts",
  podcast_episodes: "Episodes",
};

export function emptySections(): Record<BrowseSectionType, BrowseSectionData> {
  return {
    documents: { results: [], page: { has_more: false, next_cursor: null } },
    videos: { results: [], page: { has_more: false, next_cursor: null } },
    podcasts: { results: [], page: { has_more: false, next_cursor: null } },
    podcast_episodes: {
      results: [],
      page: { has_more: false, next_cursor: null },
    },
  };
}

export function normalizeBrowseQuery(value: string | null): string {
  return value ? value.trim() : "";
}

function isBrowseSectionType(value: string): value is BrowseSectionType {
  return (
    value === "documents" ||
    value === "videos" ||
    value === "podcasts" ||
    value === "podcast_episodes"
  );
}

export function parseVisibleTypes(
  searchParams: URLSearchParams,
): BrowseSectionType[] {
  if (!searchParams.has("types")) {
    return [...BROWSE_TYPES];
  }
  const raw = searchParams.getAll("types").join(",");
  if (raw === "") {
    return [];
  }
  const seen = new Set<BrowseSectionType>();
  for (const part of raw.split(",")) {
    if (isBrowseSectionType(part) && !seen.has(part)) {
      seen.add(part);
    }
  }
  return seen.size > 0 ? BROWSE_TYPES.filter((type) => seen.has(type)) : [];
}

export function buildBrowseHref(
  query: string,
  visibleTypes: BrowseSectionType[],
): string {
  const params = new URLSearchParams();
  const trimmedQuery = query.trim();
  if (trimmedQuery) {
    params.set("q", trimmedQuery);
  }
  if (visibleTypes.length === 0) {
    params.set("types", "");
  } else if (visibleTypes.length < BROWSE_TYPES.length) {
    params.set("types", visibleTypes.join(","));
  }
  const search = params.toString();
  return search ? `/browse?${search}` : "/browse";
}

export function formatEpisodeMeta(result: BrowseEpisodeResult): string {
  const bits: string[] = [];
  if (result.published_at) {
    bits.push(
      `Published ${new Date(result.published_at).toLocaleDateString()}`,
    );
  }
  if (result.duration_seconds) {
    bits.push(`${Math.round(result.duration_seconds / 60)} min`);
  }
  return bits.length > 0 ? bits.join(" · ") : "Recent episode preview";
}

export function getDocumentSourceLabel(
  result: BrowseDocumentResult,
): string | null {
  if (typeof result.source_label === "string" && result.source_label.trim()) {
    return result.source_label.trim();
  }
  if (result.source_type === "nexus") {
    return "Nexus";
  }
  if (result.source_type === "project_gutenberg") {
    return "Project Gutenberg";
  }
  if (result.site_name && result.site_name.trim()) {
    return result.site_name.trim();
  }
  return null;
}

export function isProjectGutenbergDocument(
  result: BrowseDocumentResult,
): boolean {
  if (result.source_type === "project_gutenberg") {
    return true;
  }
  return getDocumentSourceLabel(result) === "Project Gutenberg";
}

export function getDocumentActionLabel(
  result: BrowseDocumentResult,
  busy: boolean,
): string {
  if (result.media_id) {
    return busy ? "Opening..." : "Open";
  }
  if (isProjectGutenbergDocument(result)) {
    return busy ? "Importing..." : "Import";
  }
  return busy ? "Adding..." : "Add";
}

export function getDocumentFallbackDescription(
  result: BrowseDocumentResult,
): string {
  if (result.media_id) {
    return "Open this document in the reader.";
  }
  if (isProjectGutenbergDocument(result)) {
    return "Import this Project Gutenberg document into the reader.";
  }
  return "Add this document to open it in the reader.";
}

export function normalizeSections(
  data: BrowseResponse["data"],
): Record<BrowseSectionType, BrowseSectionData> {
  const nextSections = emptySections();
  for (const type of BROWSE_TYPES) {
    const section = data.sections[type];
    if (section) {
      nextSections[type] = section;
    }
  }
  return nextSections;
}

function replaceSection(
  current: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType,
  nextSection: BrowseSectionData,
): Record<BrowseSectionType, BrowseSectionData> {
  return {
    ...current,
    [sectionType]: nextSection,
  };
}

export function updateSectionResults<T extends BrowseResult>(
  results: BrowseResult[],
  match: (row: BrowseResult) => row is T,
  update: (row: T) => T,
): BrowseResult[] {
  return results.map((row) => (match(row) ? update(row) : row));
}

export function isPodcastResult(row: BrowseResult): row is BrowsePodcastResult {
  return row.type === "podcasts";
}

export function isPodcastEpisodeResult(
  row: BrowseResult,
): row is BrowseEpisodeResult {
  return row.type === "podcast_episodes";
}

export function isDocumentResult(
  row: BrowseResult,
): row is BrowseDocumentResult {
  return row.type === "documents";
}

export function isVideoResult(row: BrowseResult): row is BrowseVideoResult {
  return row.type === "videos";
}

export function mergeSectionResults(
  current: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType,
  nextSection: BrowseSectionData,
): Record<BrowseSectionType, BrowseSectionData> {
  return replaceSection(current, sectionType, {
    results: [...current[sectionType].results, ...nextSection.results],
    page: nextSection.page,
  });
}

export function updateSection(
  current: Record<BrowseSectionType, BrowseSectionData>,
  sectionType: BrowseSectionType,
  updateResults: (results: BrowseResult[]) => BrowseResult[],
): Record<BrowseSectionType, BrowseSectionData> {
  return replaceSection(current, sectionType, {
    ...current[sectionType],
    results: updateResults(current[sectionType].results),
  });
}
