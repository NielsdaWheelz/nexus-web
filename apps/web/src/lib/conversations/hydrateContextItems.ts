/**
 * Hydration utility for context items.
 *
 * Fetches full highlight + media data from existing BFF proxy routes
 * to enrich context items with prefix/suffix, annotation body, and media kind.
 */

import { apiFetch } from "@/lib/api/client";
import type { ContextItem } from "@/lib/api/sse";

interface HighlightResponse {
  data: {
    id: string;
    exact: string;
    prefix?: string;
    suffix?: string;
    color?: "yellow" | "green" | "blue" | "pink" | "purple";
    annotation?: { body?: string } | null;
    anchor?: { media_id?: string } | null;
    media_id?: string;
  };
}

interface MediaResponse {
  data: {
    id: string;
    title?: string;
    kind?: string;
  };
}

async function hydrateOne(item: ContextItem): Promise<ContextItem> {
  if (item.hydrated) return item;

  const enriched: ContextItem = { ...item, hydrated: true };

  try {
    if (item.type === "highlight" || item.type === "annotation") {
      const res = await apiFetch<HighlightResponse>(
        `/api/highlights/${item.id}`,
      );
      const h = res.data;
      enriched.exact = h.exact;
      enriched.preview = enriched.preview || h.exact;
      enriched.prefix = h.prefix;
      enriched.suffix = h.suffix;
      enriched.color = enriched.color || h.color;
      enriched.annotationBody = h.annotation?.body;

      const mediaId = h.media_id || h.anchor?.media_id;
      if (mediaId) {
        enriched.mediaId = enriched.mediaId || mediaId;
        try {
          const mediaRes = await apiFetch<MediaResponse>(
            `/api/media/${mediaId}`,
          );
          enriched.mediaTitle = enriched.mediaTitle || mediaRes.data.title;
          enriched.mediaKind = mediaRes.data.kind;
        } catch {
          // Media fetch failed — keep what we have
        }
      }
    } else if (item.type === "media") {
      const mediaId = item.mediaId || item.id;
      const mediaRes = await apiFetch<MediaResponse>(`/api/media/${mediaId}`);
      enriched.mediaTitle = enriched.mediaTitle || mediaRes.data.title;
      enriched.mediaKind = mediaRes.data.kind;
      enriched.preview = enriched.preview || mediaRes.data.title;
    }
  } catch {
    // Hydration failed — URL-param data acts as fallback
  }

  return enriched;
}

/**
 * Hydrate context items by fetching full data from BFF routes.
 * Skips items already marked as hydrated. Errors are caught silently.
 */
export async function hydrateContextItems(
  items: ContextItem[],
): Promise<ContextItem[]> {
  return Promise.all(items.map(hydrateOne));
}
