/**
 * Browse presenter — maps a browse search result (document/video/podcast/
 * episode) to a `CollectionRowView`. Pure data: no React, no fetch.
 *
 * The activation (add/open/follow) is surface-specific, so the pane supplies
 * `onActivate` + the verb `activateLabel`. The add-to-library destination
 * picker stays a pane-owned control and is NOT emitted here.
 */

import type { CollectionRowView, SignalFact } from "@/lib/collections/types";
import { mediaKindIcon, resourceIconForScheme } from "@/lib/resources/resourceKind";
import {
  getDocumentSourceLabel,
  type BrowseResult,
} from "@/app/(authenticated)/browse/browseState";

export type { BrowseResult };

export interface BrowsePresenterContext {
  onActivate: (result: BrowseResult) => void;
  activateLabel: string;
}

const DOCUMENT_BADGE: Record<
  "pdf" | "epub" | "web_article",
  "PDF" | "EPUB" | "Article"
> = {
  pdf: "PDF",
  epub: "EPUB",
  web_article: "Article",
};

export function presentBrowseResult(
  result: BrowseResult,
  ctx: BrowsePresenterContext,
): CollectionRowView {
  const primary: CollectionRowView["primary"] = {
    kind: "button",
    onActivate: () => ctx.onActivate(result),
    label: ctx.activateLabel,
  };

  switch (result.type) {
    case "documents": {
      const sourceLabel = getDocumentSourceLabel(result);
      const signals: SignalFact[] = [];
      if (sourceLabel) signals.push({ value: sourceLabel });
      return {
        id: result.url,
        kind: "browse_result",
        primary,
        lead: { icon: mediaKindIcon(result.document_kind) },
        headline: { text: result.title },
        signals,
        status: { tone: "neutral", label: DOCUMENT_BADGE[result.document_kind] },
        contributors:
          result.contributors && result.contributors.length > 0
            ? { credits: result.contributors, maxVisible: 2 }
            : undefined,
      };
    }
    case "videos":
      return {
        id: `video:${result.provider_video_id}`,
        kind: "browse_result",
        primary,
        lead: { icon: mediaKindIcon("video"), remoteUrl: result.thumbnail_url ?? undefined },
        headline: { text: result.title },
        signals: [],
        status: { tone: "neutral", label: "Video" },
        contributors:
          result.contributors.length > 0
            ? { credits: result.contributors, maxVisible: 2 }
            : undefined,
      };
    case "podcasts":
      return {
        id: `podcast:${result.provider_podcast_id}`,
        kind: "browse_result",
        primary,
        lead: { icon: resourceIconForScheme("podcast"), remoteUrl: result.image_url ?? undefined },
        headline: { text: result.title },
        signals: [],
        status: { tone: "neutral", label: "Podcast" },
        contributors:
          result.contributors.length > 0
            ? { credits: result.contributors, maxVisible: 2 }
            : undefined,
      };
    case "podcast_episodes":
      return {
        id: `episode:${result.provider_episode_id}`,
        kind: "browse_result",
        primary,
        lead: { icon: mediaKindIcon("podcast_episode"), remoteUrl: result.podcast_image_url ?? undefined },
        headline: { text: result.title },
        signals: result.podcast_title ? [{ value: result.podcast_title }] : [],
        status: { tone: "neutral", label: "Episode" },
        contributors:
          result.podcast_contributors.length > 0
            ? { credits: result.podcast_contributors, maxVisible: 2 }
            : undefined,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
