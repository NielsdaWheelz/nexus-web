/**
 * URL-based attach-context parsing for chat composer flows.
 *
 * Supports attach_type=highlight only in v1. Invalid or unsupported
 * values are silently ignored (non-fatal).
 */

import type { ContextItem } from "@/lib/api/sse";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPPORTED_ATTACH_TYPES = new Set<ContextItem["type"]>(["highlight"]);

const VALID_COLORS = new Set(["yellow", "green", "blue", "pink", "purple"]);

const ATTACH_PARAM_KEYS = [
  "attach_type",
  "attach_id",
  "attach_color",
  "attach_preview",
  "attach_media_id",
  "attach_media_title",
] as const;

/**
 * Parse attach query params into a ContextItem list.
 *
 * Returns empty array when params are missing, malformed, or unsupported.
 */
export function parseAttachContext(
  searchParams: URLSearchParams,
): ContextItem[] {
  const attachType = searchParams.get("attach_type");
  const attachId = searchParams.get("attach_id");

  if (!attachType || !attachId) return [];
  if (!SUPPORTED_ATTACH_TYPES.has(attachType as ContextItem["type"]))
    return [];
  if (!UUID_RE.test(attachId)) return [];

  const item: ContextItem = {
    type: attachType as ContextItem["type"],
    id: attachId,
  };

  const color = searchParams.get("attach_color");
  if (color && VALID_COLORS.has(color)) {
    item.color = color as ContextItem["color"];
  }

  const preview = searchParams.get("attach_preview");
  if (preview) {
    item.preview = preview;
  }

  const mediaId = searchParams.get("attach_media_id");
  if (mediaId && UUID_RE.test(mediaId)) {
    item.mediaId = mediaId;
  }

  const mediaTitle = searchParams.get("attach_media_title");
  if (mediaTitle) {
    item.mediaTitle = mediaTitle;
  }

  return [item];
}

/**
 * Stable signature for URL-backed attach context state.
 *
 * Includes only fields sourced from attach_* params so hydrated enrichment
 * does not trigger false-positive "changed" comparisons.
 */
export function getAttachContextSignature(items: ContextItem[]): string {
  return items
    .map((item) =>
      [
        item.type,
        item.id,
        item.color ?? "",
        item.preview ?? "",
        item.mediaId ?? "",
        item.mediaTitle ?? "",
      ].join("\u001f")
    )
    .join("\u001e");
}

/**
 * Remove attach_type and attach_id from query params while preserving
 * all other keys. Returns a new URLSearchParams instance.
 */
export function stripAttachParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const cleaned = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (!(ATTACH_PARAM_KEYS as readonly string[]).includes(key)) {
      cleaned.set(key, value);
    }
  }
  return cleaned;
}
