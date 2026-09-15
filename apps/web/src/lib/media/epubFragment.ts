import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { expectExactRecord, expectNonnegativeInteger, expectString } from "@/lib/validation";

export interface EpubFragmentContent {
  readonly fragment_id: string;
  readonly fragment_idx: number;
  readonly href_path: string;
  readonly html_sanitized: string;
  readonly canonical_text: string;
  readonly char_count: number;
  readonly word_count: number;
  readonly document_word_start: number;
  readonly created_at: string;
  readonly generation: number;
}

export function decodeEpubFragmentContent(raw: unknown): EpubFragmentContent {
  const envelope = expectExactRecord(raw, ["data"], "EpubFragmentResponse");
  const name = "EpubFragmentResponse.data";
  const value = expectExactRecord(envelope.data, [
    "fragment_id", "fragment_idx", "href_path", "html_sanitized", "canonical_text",
    "char_count", "word_count", "document_word_start", "created_at", "generation",
  ], name);
  const generation = expectNonnegativeInteger(value.generation, `${name}.generation`);
  if (generation < 1) throw new TypeError(`${name}.generation must be positive`);
  return {
    fragment_id: expectString(value.fragment_id, `${name}.fragment_id`),
    fragment_idx: expectNonnegativeInteger(value.fragment_idx, `${name}.fragment_idx`),
    href_path: expectString(value.href_path, `${name}.href_path`),
    html_sanitized: expectString(value.html_sanitized, `${name}.html_sanitized`),
    canonical_text: expectString(value.canonical_text, `${name}.canonical_text`),
    char_count: expectNonnegativeInteger(value.char_count, `${name}.char_count`),
    word_count: expectNonnegativeInteger(value.word_count, `${name}.word_count`),
    document_word_start: expectNonnegativeInteger(value.document_word_start, `${name}.document_word_start`),
    created_at: expectString(value.created_at, `${name}.created_at`),
    generation,
  };
}

export async function requestEpubFragment({ mediaId, fragmentId, signal }: {
  readonly mediaId: string;
  readonly fragmentId: string;
  readonly signal: AbortSignal;
}): Promise<EpubFragmentContent> {
  return decodeApiPayload(
    await apiFetch<unknown>(`/api/media/${mediaId}/fragments/${encodeURIComponent(fragmentId)}`, { signal }),
    decodeEpubFragmentContent,
    "GET /api/media/{id}/fragments/{fragment_id}",
  );
}
