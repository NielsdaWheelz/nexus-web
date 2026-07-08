/**
 * Browse API wire-format types. These describe the shapes returned by
 * `GET /api/browse` and consumed by the Launcher `browse` lane.
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
