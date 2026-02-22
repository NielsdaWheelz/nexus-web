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

const ATTACH_PARAM_KEYS = ["attach_type", "attach_id"] as const;

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

  return [{ type: attachType as ContextItem["type"], id: attachId }];
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
