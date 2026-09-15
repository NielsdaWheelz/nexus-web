import { decodeDocumentEmbeds } from "@/lib/media/documentEmbeds";
import type { Fragment } from "@/lib/media/transcriptView";
import {
  expectArray,
  expectExactRecord,
  expectInteger,
  expectIsoInstant,
  expectNullableInteger,
  expectNullableString,
  expectString,
} from "@/lib/validation";

export function decodeMediaFragment(
  raw: unknown,
  index: number,
  expectedMediaId: string,
): Fragment {
  const name = `Media fragments[${index}]`;
  const value = expectExactRecord(
    raw,
    [
      "id",
      "media_id",
      "idx",
      "html_sanitized",
      "canonical_text",
      "word_count",
      "document_word_start",
      "t_start_ms",
      "t_end_ms",
      "speaker_label",
      "document_embeds",
      "created_at",
    ],
    name,
  );
  const mediaId = expectString(value.media_id, `${name}.media_id`);
  if (mediaId !== expectedMediaId) {
    throw new TypeError(`${name}.media_id must match the requested media`);
  }
  return {
    id: expectString(value.id, `${name}.id`),
    media_id: mediaId,
    idx: expectInteger(value.idx, `${name}.idx`),
    html_sanitized: expectString(
      value.html_sanitized,
      `${name}.html_sanitized`,
    ),
    canonical_text: expectString(
      value.canonical_text,
      `${name}.canonical_text`,
    ),
    word_count: expectInteger(value.word_count, `${name}.word_count`),
    document_word_start: expectInteger(
      value.document_word_start,
      `${name}.document_word_start`,
    ),
    t_start_ms: expectNullableInteger(value.t_start_ms, `${name}.t_start_ms`),
    t_end_ms: expectNullableInteger(value.t_end_ms, `${name}.t_end_ms`),
    speaker_label: expectNullableString(
      value.speaker_label,
      `${name}.speaker_label`,
    ),
    document_embeds: decodeDocumentEmbeds(
      value.document_embeds,
      `${name}.document_embeds`,
    ),
    created_at: expectIsoInstant(value.created_at, `${name}.created_at`),
  };
}

export function decodeMediaFragmentsResponse(
  raw: unknown,
  expectedMediaId: string,
): Fragment[] {
  const envelope = expectExactRecord(raw, ["data"], "Media fragments response");
  return expectArray(
    envelope.data,
    (fragment, index) =>
      decodeMediaFragment(fragment, index, expectedMediaId),
    "Media fragments response.data",
  );
}
