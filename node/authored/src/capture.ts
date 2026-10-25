/** Capture the existing typed locator vocabulary with explicit nullable fields.
 * Literal quote selector extensions are retained; normalization belongs to identity. */
import { validateLocator } from "./validate.ts";
import type { Locator } from "./types.ts";
export function captureLocator(value: unknown, source_ref: string): Locator {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected locator object");
  const raw = Object.fromEntries(Object.entries(value));
  const candidate = raw.text_quote_selector;
  if (candidate !== null && candidate !== undefined && (typeof candidate !== "object" || Array.isArray(candidate))) throw new TypeError("Expected quote selector object");
  const quote = candidate == null ? null : Object.fromEntries(Object.entries(candidate));
  const selector = quote === null || quote === undefined ? null : {
    ...quote,
    exact: quote.exact,
    prefix: quote.prefix ?? null,
    suffix: quote.suffix ?? null,
  };
  const locator = (() => {
  switch (raw.type) {
    case "web_text_offsets": return { type: raw.type, media_id: raw.media_id, fragment_id: raw.fragment_id, start_offset: raw.start_offset, end_offset: raw.end_offset, media_kind: raw.media_kind ?? null, text_quote_selector: selector };
    case "epub_fragment_offsets": return { type: raw.type, media_id: raw.media_id, fragment_id: raw.fragment_id, section_id: raw.section_id ?? null, start_offset: raw.start_offset, end_offset: raw.end_offset, media_kind: raw.media_kind ?? null, text_quote_selector: selector };
    case "note_block_offsets": return { type: raw.type, block_id: raw.block_id, start_offset: raw.start_offset, end_offset: raw.end_offset, body_version: raw.body_version ?? null, text_quote_selector: selector };
    case "pdf_page_geometry": return { type: raw.type, media_id: raw.media_id, page_number: raw.page_number, quads: raw.quads, exact: raw.exact, prefix: raw.prefix ?? null, suffix: raw.suffix ?? null, text_quote_selector: selector, projection: raw.projection ?? null };
    case "pdf_page": return { type: raw.type, media_id: raw.media_id, page_number: raw.page_number };
    case "transcript_time_range": return { type: raw.type, media_id: raw.media_id, t_start_ms: raw.t_start_ms, t_end_ms: raw.t_end_ms, text_quote_selector: selector };
    case "audio_time_range":
    case "video_time_range": return { type: raw.type, media_id: raw.media_id, t_start_ms: raw.t_start_ms, t_end_ms: raw.t_end_ms };
    case "message_offsets": return { type: raw.type, conversation_id: raw.conversation_id, message_id: raw.message_id, start_offset: raw.start_offset, end_offset: raw.end_offset, message_seq: raw.message_seq ?? null, text_quote_selector: selector };
    case "external_url": return { type: raw.type, url: raw.url, title: raw.title ?? null, display_url: raw.display_url ?? null, accessed_at: raw.accessed_at ?? null };
    default: throw new TypeError("Unknown locator type");
  }
  })();
  // justify-type-assertion: the closed construction above and shared runtime
  // validator establish the locator fields and their source agreement.
  validateLocator(locator as Locator, source_ref);
  return locator as Locator;
}
