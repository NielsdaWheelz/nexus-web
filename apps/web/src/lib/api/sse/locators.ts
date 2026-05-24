import { isRecord } from "@/lib/validation";
import {
  hasOnlyKeys,
  isOptionalRecord,
  isOptionalString,
  isValidOffsetRange,
  isValidTimeRange,
} from "./guards";

export type RetrievalLocator =
  | {
      type: "web_text_offsets";
      media_id: string;
      fragment_id: string;
      start_offset: number;
      end_offset: number;
      media_kind?: string | null;
      text_quote_selector?: Record<string, unknown> | null;
    }
  | {
      type: "epub_fragment_offsets";
      media_id: string;
      section_id?: string;
      fragment_id: string;
      start_offset: number;
      end_offset: number;
      media_kind?: string | null;
      text_quote_selector?: Record<string, unknown> | null;
    }
  | {
      type: "pdf_page_geometry";
      media_id: string;
      page_number: number;
      quads: unknown[];
      exact: string;
      prefix?: string | null;
      suffix?: string | null;
      text_quote_selector?: Record<string, unknown> | null;
    }
  | {
      type: "audio_time_range" | "video_time_range";
      media_id: string;
      transcript_version_id?: string | null;
      t_start_ms: number;
      t_end_ms: number;
    }
  | {
      type: "transcript_time_range";
      media_id: string;
      transcript_version_id?: string | null;
      t_start_ms: number;
      t_end_ms: number;
      text_quote_selector?: Record<string, unknown> | null;
    }
  | {
      type: "note_block_offsets";
      page_id: string;
      block_id: string;
      start_offset: number;
      end_offset: number;
    }
  | {
      type: "message_offsets";
      conversation_id: string;
      message_id: string;
      start_offset: number;
      end_offset: number;
      message_seq?: number | null;
    }
  | {
      type: "external_url";
      url: string;
      title?: string | null;
      display_url?: string | null;
      accessed_at?: string | null;
    }
  | {
      type: "artifact_part_ref";
      artifact_id: string;
      artifact_part_id: string;
      message_id: string;
      conversation_id: string;
      part_key?: string | null;
    };

export type MediaRetrievalLocator = Extract<
  RetrievalLocator,
  {
    type:
      | "web_text_offsets"
      | "epub_fragment_offsets"
      | "pdf_page_geometry"
      | "audio_time_range"
      | "video_time_range"
      | "transcript_time_range";
  }
>;

const MEDIA_RETRIEVAL_LOCATOR_TYPES = new Set<RetrievalLocator["type"]>([
  "web_text_offsets",
  "epub_fragment_offsets",
  "pdf_page_geometry",
  "audio_time_range",
  "video_time_range",
  "transcript_time_range",
]);

export function isMediaRetrievalLocator(
  locator: RetrievalLocator,
): locator is MediaRetrievalLocator {
  return MEDIA_RETRIEVAL_LOCATOR_TYPES.has(locator.type);
}

export function isRetrievalLocator(value: unknown): value is RetrievalLocator {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "web_text_offsets":
      return (
        hasOnlyKeys(value, [
          "type",
          "media_id",
          "fragment_id",
          "start_offset",
          "end_offset",
          "media_kind",
          "text_quote_selector",
        ]) &&
        typeof value.media_id === "string" &&
        typeof value.fragment_id === "string" &&
        isValidOffsetRange(value) &&
        isOptionalString(value.media_kind) &&
        isOptionalRecord(value.text_quote_selector)
      );
    case "epub_fragment_offsets":
      return (
        hasOnlyKeys(value, [
          "type",
          "media_id",
          "section_id",
          "fragment_id",
          "start_offset",
          "end_offset",
          "media_kind",
          "text_quote_selector",
        ]) &&
        typeof value.media_id === "string" &&
        isOptionalString(value.section_id) &&
        typeof value.fragment_id === "string" &&
        isValidOffsetRange(value) &&
        isOptionalString(value.media_kind) &&
        isOptionalRecord(value.text_quote_selector)
      );
    case "pdf_page_geometry":
      return (
        hasOnlyKeys(value, [
          "type",
          "media_id",
          "page_number",
          "quads",
          "exact",
          "prefix",
          "suffix",
          "text_quote_selector",
        ]) &&
        typeof value.media_id === "string" &&
        typeof value.page_number === "number" &&
        Number.isInteger(value.page_number) &&
        value.page_number >= 1 &&
        Array.isArray(value.quads) &&
        value.quads.length > 0 &&
        value.quads.every(isPdfGeometryQuad) &&
        typeof value.exact === "string" &&
        isOptionalString(value.prefix) &&
        isOptionalString(value.suffix) &&
        isOptionalRecord(value.text_quote_selector)
      );
    case "transcript_time_range":
      return (
        hasOnlyKeys(value, [
          "type",
          "media_id",
          "transcript_version_id",
          "t_start_ms",
          "t_end_ms",
          "text_quote_selector",
        ]) &&
        typeof value.media_id === "string" &&
        isValidTimeRange(value) &&
        isOptionalString(value.transcript_version_id) &&
        isOptionalRecord(value.text_quote_selector)
      );
    case "audio_time_range":
    case "video_time_range":
      return (
        hasOnlyKeys(value, [
          "type",
          "media_id",
          "transcript_version_id",
          "t_start_ms",
          "t_end_ms",
        ]) &&
        typeof value.media_id === "string" &&
        isValidTimeRange(value) &&
        isOptionalString(value.transcript_version_id)
      );
    case "note_block_offsets":
      return (
        hasOnlyKeys(value, [
          "type",
          "page_id",
          "block_id",
          "start_offset",
          "end_offset",
        ]) &&
        typeof value.page_id === "string" &&
        typeof value.block_id === "string" &&
        isValidOffsetRange(value)
      );
    case "message_offsets":
      return (
        hasOnlyKeys(value, [
          "type",
          "conversation_id",
          "message_id",
          "start_offset",
          "end_offset",
          "message_seq",
        ]) &&
        typeof value.conversation_id === "string" &&
        typeof value.message_id === "string" &&
        isValidOffsetRange(value) &&
        (value.message_seq === undefined ||
          value.message_seq === null ||
          (typeof value.message_seq === "number" &&
            Number.isInteger(value.message_seq) &&
            value.message_seq >= 1))
      );
    case "external_url":
      return (
        hasOnlyKeys(value, [
          "type",
          "url",
          "title",
          "display_url",
          "accessed_at",
        ]) &&
        typeof value.url === "string" &&
        isOptionalString(value.title) &&
        isOptionalString(value.display_url) &&
        isOptionalString(value.accessed_at)
      );
    case "artifact_part_ref":
      return (
        hasOnlyKeys(value, [
          "type",
          "artifact_id",
          "artifact_part_id",
          "message_id",
          "conversation_id",
          "part_key",
        ]) &&
        typeof value.artifact_id === "string" &&
        typeof value.artifact_part_id === "string" &&
        typeof value.message_id === "string" &&
        typeof value.conversation_id === "string" &&
        isOptionalString(value.part_key)
      );
    default:
      return false;
  }
}

function isPdfGeometryQuad(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"];
  return (
    hasOnlyKeys(value, keys) &&
    keys.every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    )
  );
}
