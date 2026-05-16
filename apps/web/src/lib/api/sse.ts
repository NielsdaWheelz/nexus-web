/**
 * SSE parser and direct browser -> FastAPI chat-run stream client.
 *
 * Framing rules:
 * 1. Only process `event:` + `data:` lines.
 * 2. Ignore comment lines (`:`); unknown event types are stream errors.
 * 3. `data:` payload is JSON, one object per event.
 * 4. Max event size: 256 KB. Exceeding this is a stream error.
 * 5. If JSON parse fails on a `data:` line: stream error.
 */

import type { ObjectType } from "@/lib/objectRefs";
import type {
  BranchAnchor,
  MessageClaimEvidence,
  MessageClaimKind,
  MessageClaimSupportStatus,
  MessageEvidenceRetrievalStatus,
  MessageEvidenceRole,
  MessageEvidenceVerifierStatus,
} from "@/lib/conversations/types";

/** Maximum single event payload size (256 KB). */
const MAX_EVENT_SIZE_BYTES = 256 * 1024;
const RECONNECT_DELAY_MS = 1000;
const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

// ============================================================================
// Types
// ============================================================================

/** Meta event: initial IDs and model info. */
export interface SSEMetaEvent {
  type: "meta";
  data: {
    conversation_id: string;
    user_message_id: string;
    assistant_message_id: string;
    model_id: string;
    provider: string;
  };
}

/** Delta event: incremental content chunk. */
export interface SSEDeltaEvent {
  type: "delta";
  data: {
    delta: string;
  };
}

/** Done event: stream completion. */
export interface SSEDoneEvent {
  type: "done";
  data: {
    status: "complete" | "error" | "cancelled";
    error_code: string | null;
    final_chars?: number;
  };
}

export type ContextItemType = ObjectType;
export type ContextItemColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type SearchCitationResultType =
  | "media"
  | "podcast"
  | "episode"
  | "video"
  | "content_chunk"
  | "fragment"
  | "page"
  | "note_block"
  | "highlight"
  | "message"
  | "contributor"
  | "evidence_span"
  | "conversation"
  | "artifact"
  | "artifact_part";

export type AppCitationResultType =
  | "media"
  | "podcast"
  | "episode"
  | "video"
  | "content_chunk"
  | "fragment"
  | "page"
  | "note_block"
  | "highlight"
  | "message"
  | "contributor"
  | "evidence_span"
  | "conversation"
  | "artifact"
  | "artifact_part";

export type RetrievalContextRef =
  | {
      type: SearchCitationResultType;
      id: string;
      evidence_span_ids?: string[];
    }
  | {
      type: "web_result";
      id: string;
      evidence_span_ids?: string[];
    };

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

type SearchCitationBase<
  TType extends SearchCitationResultType,
  TContextType extends RetrievalContextRef["type"],
  TSourceVersion extends string | null,
  TLocator extends RetrievalLocator | null,
> = {
  type: TType;
  id: string;
  result_type: TType;
  source_id: string;
  title: string;
  source_label: string | null;
  snippet: string;
  deep_link: string;
  citation_label?: string | null;
  context_ref: {
    type: TContextType;
    id: string;
    evidence_span_ids?: string[];
  };
  evidence_span_id?: string | null;
  source_version: TSourceVersion;
  locator: TLocator;
  media_id: string | null;
  media_kind: string | null;
  score: number | null;
  selected: boolean;
};

export type MediaSearchCitationEventData = SearchCitationBase<
  "media",
  "media",
  null,
  null
>;

export type PodcastSearchCitationEventData = SearchCitationBase<
  "podcast",
  "podcast",
  null,
  null
> & {
  contributors: Array<Record<string, unknown>>;
};

export type EpisodeSearchCitationEventData = SearchCitationBase<
  "episode",
  "media",
  null,
  null
>;

export type VideoSearchCitationEventData = SearchCitationBase<
  "video",
  "media",
  null,
  null
>;

export type ContentChunkSearchCitationEventData = SearchCitationBase<
  "content_chunk",
  "content_chunk",
  string,
  MediaRetrievalLocator
> & {
  citation_label: string;
  source_kind: string;
  evidence_span_ids: string[];
};

export type FragmentSearchCitationEventData = SearchCitationBase<
  "fragment",
  "fragment",
  string,
  MediaRetrievalLocator
>;

export type PageSearchCitationEventData = SearchCitationBase<
  "page",
  "page",
  string,
  null
> & {
  description?: string | null;
};

export type NoteBlockSearchCitationEventData = SearchCitationBase<
  "note_block",
  "note_block",
  string,
  Extract<RetrievalLocator, { type: "note_block_offsets" }>
> & {
  page_id: string;
  page_title: string;
  body_text: string;
  highlight_excerpt?: string | null;
};

export type HighlightSearchCitationEventData = SearchCitationBase<
  "highlight",
  "highlight",
  string,
  MediaRetrievalLocator
> & {
  color: string;
  exact: string;
};

export type MessageSearchCitationEventData = SearchCitationBase<
  "message",
  "message",
  string,
  Extract<RetrievalLocator, { type: "message_offsets" }>
> & {
  conversation_id: string;
  seq: number;
};

export type ContributorSearchCitationEventData = SearchCitationBase<
  "contributor",
  "contributor",
  null,
  null
> & {
  contributor_handle: string;
};

export type EvidenceSpanSearchCitationEventData = SearchCitationBase<
  "evidence_span",
  "evidence_span",
  string,
  MediaRetrievalLocator
> & {
  citation_label: string;
  evidence_span_id: string;
  media_id: string;
};

export type ConversationSearchCitationEventData = SearchCitationBase<
  "conversation",
  "conversation",
  null,
  null
>;

export type ArtifactSearchCitationEventData = SearchCitationBase<
  "artifact",
  "artifact",
  null,
  null
> & {
  conversation_id: string;
  message_id: string;
  artifact_kind: string;
};

export type ArtifactPartSearchCitationEventData = SearchCitationBase<
  "artifact_part",
  "artifact_part",
  string,
  Extract<RetrievalLocator, { type: "artifact_part_ref" }>
> & {
  artifact_id: string;
  message_id: string;
  conversation_id: string;
  artifact_kind: string;
  artifact_title?: string | null;
  part_key?: string | null;
  part_type?: string | null;
};

export type SearchCitationEventData =
  | MediaSearchCitationEventData
  | PodcastSearchCitationEventData
  | EpisodeSearchCitationEventData
  | VideoSearchCitationEventData
  | ContentChunkSearchCitationEventData
  | FragmentSearchCitationEventData
  | PageSearchCitationEventData
  | NoteBlockSearchCitationEventData
  | HighlightSearchCitationEventData
  | MessageSearchCitationEventData
  | ContributorSearchCitationEventData
  | EvidenceSpanSearchCitationEventData
  | ConversationSearchCitationEventData
  | ArtifactSearchCitationEventData
  | ArtifactPartSearchCitationEventData;

export type WebCitationEventData = {
  assistant_message_id?: string;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_call_index?: number | null;
  citation_index?: number;
  index?: number;
  type: "web_result";
  id: string;
  result_ref: string;
  result_type: "web_result";
  source_id: string;
  title: string;
  url: string;
  display_url?: string | null;
  source_name?: string | null;
  deep_link: string;
  snippet: string;
  excerpt?: string | null;
  extra_snippets?: string[];
  published_at?: string | null;
  provider?: string | null;
  provider_request_id?: string | null;
  rank?: number;
  source_version: string;
  context_ref: Extract<RetrievalContextRef, { type: "web_result" }>;
  media_id: null;
  media_kind: null;
  score: number | null;
  selected: boolean;
  locator: Extract<RetrievalLocator, { type: "external_url" }>;
};

export type CitationEventData = SearchCitationEventData | WebCitationEventData;
export type ChatToolStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

export interface SSEToolCallEvent {
  type: "tool_call";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: "app_search" | "web_search";
    tool_call_index: number;
    status: ChatToolStatus;
    scope: string;
    types: string[];
    semantic: boolean;
    filters: Record<string, unknown>;
    freshness_days?: number | null;
    allowed_domains?: string[];
    blocked_domains?: string[];
    error_code?: string | null;
  };
}

export interface SSERetrievalResultEvent {
  type: "retrieval_result";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: "app_search" | "web_search";
    tool_call_index: number;
    status: ChatToolStatus;
    error_code?: string | null;
    result_count: number;
    selected_count: number;
    latency_ms?: number | null;
    filters: Record<string, unknown>;
    results: CitationEventData[];
  };
}

export interface SSESourceManifestDeltaEvent {
  type: "source_manifest_delta";
  data: {
    assistant_message_id: string;
    tool_call_id?: string | null;
    tool_name: "app_search" | "web_search";
    tool_call_index: number;
    query_hash?: string | null;
    scope: string;
    filters: Record<string, unknown>;
    requested_types: string[];
    candidate_count: number;
    result_count: number;
    selected_count: number;
    included_in_prompt_count: number;
    excluded_by_budget_count: number;
    excluded_by_scope_count: number;
    stale_count: number;
    unreadable_count: number;
    web_search_mode?: "off" | "auto" | "required" | null;
    index_versions: string[];
    metadata?: Record<string, unknown>;
    latency_ms?: number | null;
    status: ChatToolStatus;
  };
}

export interface SSEArtifactDeltaEvent {
  type: "artifact_delta";
  data: {
    artifact_id?: string | null;
    durable_artifact_id?: string | null;
    artifact_key?: string | null;
    artifact_version?: number | null;
    supersedes_artifact_id?: string | null;
    artifact_kind?: string | null;
    title?: string | null;
    status?: string | null;
    delta?: string | null;
    parts?: unknown[];
  };
}

export interface SSEClaimEvent {
  type: "claim";
  data: {
    id?: string;
    message_id?: string;
    ordinal?: number;
    claim_text: string;
    answer_start_offset?: number | null;
    answer_end_offset?: number | null;
    claim_kind: MessageClaimKind;
    support_status: MessageClaimSupportStatus;
    unsupported_reason?: string | null;
    confidence?: number | null;
    verifier_status: MessageEvidenceVerifierStatus;
    created_at?: string;
  };
}

export interface SSEClaimEvidenceEvent {
  type: "claim_evidence";
  data: MessageClaimEvidence;
}

export type SSEEvent =
  | SSEMetaEvent
  | SSEDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSERetrievalResultEvent
  | SSESourceManifestDeltaEvent
  | SSEArtifactDeltaEvent
  | SSEClaimEvent
  | SSEClaimEvidenceEvent;

type SSEEventHandler = (event: SSEEvent) => void;
type SSEErrorHandler = (error: Error) => void;
type SSECompleteHandler = (terminalEventSeen: boolean) => void;
type SSERetryHandler = (milliseconds: number) => void;

export interface SSEJsonEvent {
  id: string;
  type: string;
  data: unknown;
}

type SSEJsonEventHandler = (event: SSEJsonEvent) => void;

// ============================================================================
// Request payload types
// ============================================================================

export interface ObjectRefContextItem {
  kind: "object_ref";
  type: ContextItemType;
  id: string;
  evidence_span_ids?: string[];
  artifact_id?: string;
  artifact_key?: string | null;
  artifact_version?: number | null;
  source_version?: string;
  locator?: RetrievalLocator;
  artifact_part_provenance?: Record<string, unknown>;
  /** Display fields carried by the caller when available. */
  color?: ContextItemColor;
  preview?: string;
  mediaId?: string;
  mediaTitle?: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  mediaKind?: string;
}

export interface ReaderSelectionContextItem {
  kind: "reader_selection";
  client_context_id: string;
  media_id: string;
  media_kind: string;
  media_title: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  preview?: string;
  locator: RetrievalLocator;
  source_version: string;
  color?: ContextItemColor;
}

export type ContextItem = ObjectRefContextItem | ReaderSelectionContextItem;

export type ConversationScopeInput =
  | { type: "general" }
  | { type: "media"; media_id: string }
  | { type: "library"; library_id: string };

export type ArtifactIntentKind =
  | "off"
  | "auto"
  | "briefing_document"
  | "study_guide"
  | "faq"
  | "timeline"
  | "comparison_table"
  | "extraction_table"
  | "claim_table"
  | "contradiction_report"
  | "source_map"
  | "concept_map"
  | "outline"
  | "flashcards"
  | "quiz"
  | "audio_overview_script"
  | "audio_overview"
  | "video_slide_overview_manifest"
  | "bibliography"
  | "citation_audit";

export interface ArtifactIntentOptions {
  kind: ArtifactIntentKind;
}

export type ChatRunContext =
  | {
      kind: "object_ref";
      type: ContextItemType;
      id: string;
      evidence_span_ids?: string[];
      artifact_id?: string;
      artifact_key?: string | null;
      artifact_version?: number | null;
      source_version?: string;
      locator?: RetrievalLocator;
      artifact_part_provenance?: Record<string, unknown>;
    }
  | {
      kind: "reader_selection";
      client_context_id: string;
      media_id: string;
      media_kind: string;
      media_title: string;
      exact: string;
      prefix?: string;
      suffix?: string;
      locator: RetrievalLocator;
      source_version: string;
    };

export function toWireContextItem(item: ContextItem): ChatRunContext {
  if (item.kind === "reader_selection") {
    return {
      kind: "reader_selection",
      client_context_id: item.client_context_id,
      media_id: item.media_id,
      media_kind: item.media_kind,
      media_title: item.media_title,
      exact: item.exact,
      ...(item.prefix ? { prefix: item.prefix } : {}),
      ...(item.suffix ? { suffix: item.suffix } : {}),
      locator: item.locator,
      source_version: item.source_version,
    };
  }

  return {
    kind: "object_ref",
    type: item.type,
    id: item.id,
    ...(item.evidence_span_ids?.length
      ? { evidence_span_ids: item.evidence_span_ids }
      : {}),
    ...(item.artifact_id ? { artifact_id: item.artifact_id } : {}),
    ...(item.artifact_key ? { artifact_key: item.artifact_key } : {}),
    ...(item.artifact_version
      ? { artifact_version: item.artifact_version }
      : {}),
    ...(item.source_version ? { source_version: item.source_version } : {}),
    ...(item.locator ? { locator: item.locator } : {}),
    ...(item.artifact_part_provenance
      ? { artifact_part_provenance: item.artifact_part_provenance }
      : {}),
  };
}

export interface ChatRunCreateRequest {
  content: string;
  model_id: string;
  reasoning: "default" | "none" | "minimal" | "low" | "medium" | "high" | "max";
  key_mode?: "auto" | "byok_only" | "platform_only";
  parent_message_id?: string;
  branch_anchor?: BranchAnchor;
  conversation_scope?: ConversationScopeInput;
  contexts?: ChatRunContext[];
  web_search: {
    mode: "off" | "auto" | "required";
    freshness_days?: number | null;
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  artifact_intent: ArtifactIntentOptions;
}

// ============================================================================
// SSE Parser
// ============================================================================

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>.
 *
 * Follows the SSE spec: events are separated by blank lines.
 * Each event has optional `event:` and required `data:` fields.
 */
export async function parseSSEJsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SSEJsonEventHandler,
  onRetry: SSERetryHandler,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentId = "";
  let currentEvent = "";
  let currentDataLines: string[] = [];
  let currentDataBytes = 0;
  const textEncoder = new TextEncoder();

  const dispatchEvent = () => {
    if (currentDataLines.length > 0) {
      processJsonEvent(
        currentEvent,
        currentDataLines.join("\n"),
        currentId,
        onEvent,
      );
    }
    currentId = "";
    currentEvent = "";
    currentDataLines = [];
    currentDataBytes = 0;
  };

  const processLine = (line: string) => {
    if (line === "") {
      dispatchEvent();
      return;
    }

    if (line.startsWith(":")) {
      // Comment line — ignore
      return;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "id":
        currentId = value;
        break;
      case "event":
        currentEvent = value;
        break;
      case "data": {
        const valueBytes = textEncoder.encode(value).byteLength;
        const newlineBytes = currentDataLines.length > 0 ? 1 : 0;
        currentDataBytes += valueBytes + newlineBytes;
        if (currentDataBytes > MAX_EVENT_SIZE_BYTES) {
          throw new Error(
            `SSE event exceeds maximum size of ${MAX_EVENT_SIZE_BYTES} bytes`,
          );
        }
        currentDataLines.push(value);
        break;
      }
      case "retry":
        if (/^\d+$/.test(value)) {
          onRetry(Number(value));
        }
        break;
      default:
        // Unknown field — ignore per SSE spec
        break;
    }
  };

  const processBufferedLines = (flush: boolean) => {
    let start = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i];
      if (char !== "\n" && char !== "\r") continue;

      if (char === "\r" && i + 1 === buffer.length && !flush) {
        break;
      }

      processLine(buffer.slice(start, i));

      if (char === "\r" && buffer[i + 1] === "\n") {
        i += 1;
      }
      start = i + 1;
    }

    buffer = buffer.slice(start);

    if (flush && buffer !== "") {
      processLine(buffer);
      buffer = "";
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      processBufferedLines(false);
    }

    buffer += decoder.decode();
    processBufferedLines(true);
    dispatchEvent();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Process a single SSE event: parse JSON data and dispatch it with raw type.
 */
function processJsonEvent(
  eventType: string,
  data: string,
  id: string,
  onEvent: SSEJsonEventHandler,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(
      `Failed to parse SSE ${eventType || "message"} event (${data.length} bytes)`,
    );
  }

  onEvent({ id, type: eventType, data: parsed });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}

function isValidOffsetRange(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  start_offset: number;
  end_offset: number;
} {
  const start = value.start_offset;
  const end = value.end_offset;
  return (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start
  );
}

function isValidTimeRange(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { t_start_ms: number; t_end_ms: number } {
  const start = value.t_start_ms;
  const end = value.t_end_ms;
  return (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start
  );
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

const SEARCH_CITATION_RESULT_TYPES = new Set<SearchCitationResultType>([
  "media",
  "podcast",
  "episode",
  "video",
  "content_chunk",
  "fragment",
  "page",
  "note_block",
  "highlight",
  "message",
  "contributor",
  "evidence_span",
  "conversation",
  "artifact",
  "artifact_part",
]);

const MEDIA_RETRIEVAL_LOCATOR_TYPES = new Set<RetrievalLocator["type"]>([
  "web_text_offsets",
  "epub_fragment_offsets",
  "pdf_page_geometry",
  "audio_time_range",
  "video_time_range",
  "transcript_time_range",
]);

export function isRetrievalContextRef(
  value: unknown,
): value is RetrievalContextRef {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ["type", "id", "evidence_span_ids"]) ||
    typeof value.type !== "string" ||
    typeof value.id !== "string"
  ) {
    return false;
  }
  if (
    !SEARCH_CITATION_RESULT_TYPES.has(value.type as SearchCitationResultType) &&
    value.type !== "web_result"
  ) {
    return false;
  }
  return (
    value.evidence_span_ids === undefined ||
    (Array.isArray(value.evidence_span_ids) &&
      value.evidence_span_ids.every((id) => typeof id === "string"))
  );
}

function isOptionalRetrievalContextRef(value: unknown): boolean {
  return value === undefined || value === null || isRetrievalContextRef(value);
}

function isOptionalRetrievalResultRef(value: unknown): boolean {
  return value === undefined || value === null || isCitationEventData(value);
}

function isSourceRefLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "page",
      "fragment_id",
      "t_start_ms",
      "start_offset",
      "end_offset",
    ]) &&
    (value.page === undefined ||
      value.page === null ||
      (typeof value.page === "number" &&
        Number.isInteger(value.page) &&
        value.page >= 1)) &&
    isOptionalString(value.fragment_id) &&
    (value.t_start_ms === undefined ||
      value.t_start_ms === null ||
      (typeof value.t_start_ms === "number" &&
        Number.isInteger(value.t_start_ms) &&
        value.t_start_ms >= 0)) &&
    (value.start_offset === undefined ||
      value.start_offset === null ||
      (typeof value.start_offset === "number" &&
        Number.isInteger(value.start_offset) &&
        value.start_offset >= 0)) &&
    (value.end_offset === undefined ||
      value.end_offset === null ||
      (typeof value.end_offset === "number" &&
        Number.isInteger(value.end_offset) &&
        value.end_offset >= 0)) &&
    !(
      typeof value.start_offset === "number" &&
      typeof value.end_offset === "number" &&
      value.end_offset < value.start_offset
    )
  );
}

function isSourceRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "type",
      "id",
      "label",
      "conversation_id",
      "message_id",
      "message_context_id",
      "message_seq",
      "tool_call_id",
      "retrieval_id",
      "context_ref",
      "result_ref",
      "media_id",
      "evidence_span_id",
      "deep_link",
      "location",
      "source_version",
    ]) &&
    (value.type === "message" ||
      value.type === "message_context" ||
      value.type === "message_retrieval" ||
      value.type === "app_context_ref" ||
      value.type === "web_result") &&
    typeof value.id === "string" &&
    isOptionalString(value.label) &&
    isOptionalString(value.conversation_id) &&
    isOptionalString(value.message_id) &&
    isOptionalString(value.message_context_id) &&
    (value.message_seq === undefined ||
      value.message_seq === null ||
      (typeof value.message_seq === "number" &&
        Number.isInteger(value.message_seq) &&
        value.message_seq >= 1)) &&
    isOptionalString(value.tool_call_id) &&
    isOptionalString(value.retrieval_id) &&
    isOptionalRetrievalContextRef(value.context_ref) &&
    isOptionalRetrievalResultRef(value.result_ref) &&
    isOptionalString(value.media_id) &&
    isOptionalString(value.evidence_span_id) &&
    isOptionalString(value.deep_link) &&
    (value.location === undefined ||
      value.location === null ||
      isSourceRefLocation(value.location)) &&
    isOptionalString(value.source_version)
  );
}

function isOptionalSourceRef(value: unknown): boolean {
  return value === undefined || value === null || isSourceRef(value);
}

const SEARCH_CITATION_BASE_KEYS = [
  "type",
  "id",
  "result_type",
  "source_id",
  "title",
  "source_label",
  "snippet",
  "deep_link",
  "citation_label",
  "context_ref",
  "evidence_span_id",
  "source_version",
  "locator",
  "media_id",
  "media_kind",
  "score",
  "selected",
];

export function isSearchCitationEventData(
  citation: unknown,
): citation is SearchCitationEventData {
  if (!isRecord(citation)) return false;
  const resultType = citation.result_type;
  if (
    typeof resultType !== "string" ||
    !SEARCH_CITATION_RESULT_TYPES.has(resultType as SearchCitationResultType)
  ) {
    return false;
  }

  switch (resultType) {
    case "media":
      return isSearchCitationBase(citation, "media", "media", []);
    case "podcast":
      return (
        isSearchCitationBase(citation, "podcast", "podcast", [
          "contributors",
        ]) &&
        Array.isArray(citation.contributors) &&
        citation.contributors.every(isRecord)
      );
    case "episode":
      return isSearchCitationBase(citation, "episode", "media", []);
    case "video":
      return isSearchCitationBase(citation, "video", "media", []);
    case "content_chunk":
      return (
        isSearchCitationBase(citation, "content_chunk", "content_chunk", [
          "source_kind",
          "evidence_span_ids",
        ]) &&
        typeof citation.source_kind === "string" &&
        Array.isArray(citation.evidence_span_ids) &&
        citation.evidence_span_ids.every((id) => typeof id === "string") &&
        typeof citation.source_version === "string" &&
        typeof citation.citation_label === "string"
      );
    case "fragment":
      return (
        isSearchCitationBase(citation, "fragment", "fragment", []) &&
        typeof citation.source_version === "string"
      );
    case "page":
      return (
        isSearchCitationBase(citation, "page", "page", ["description"]) &&
        isOptionalString(citation.description) &&
        typeof citation.source_version === "string"
      );
    case "note_block":
      return (
        isSearchCitationBase(citation, "note_block", "note_block", [
          "page_id",
          "page_title",
          "body_text",
          "highlight_excerpt",
        ]) &&
        typeof citation.page_id === "string" &&
        typeof citation.page_title === "string" &&
        typeof citation.body_text === "string" &&
        isOptionalString(citation.highlight_excerpt) &&
        typeof citation.source_version === "string"
      );
    case "highlight":
      return (
        isSearchCitationBase(citation, "highlight", "highlight", [
          "color",
          "exact",
        ]) &&
        typeof citation.color === "string" &&
        typeof citation.exact === "string" &&
        typeof citation.source_version === "string"
      );
    case "message":
      return (
        isSearchCitationBase(citation, "message", "message", [
          "conversation_id",
          "seq",
        ]) &&
        typeof citation.conversation_id === "string" &&
        typeof citation.seq === "number" &&
        typeof citation.source_version === "string"
      );
    case "contributor":
      return (
        isSearchCitationBase(citation, "contributor", "contributor", [
          "contributor_handle",
        ]) && typeof citation.contributor_handle === "string"
      );
    case "evidence_span":
      return (
        isSearchCitationBase(citation, "evidence_span", "evidence_span", []) &&
        typeof citation.evidence_span_id === "string" &&
        typeof citation.citation_label === "string" &&
        typeof citation.source_version === "string" &&
        typeof citation.media_id === "string"
      );
    case "conversation":
      return isSearchCitationBase(citation, "conversation", "conversation", []);
    case "artifact":
      return (
        isSearchCitationBase(citation, "artifact", "artifact", [
          "conversation_id",
          "message_id",
          "artifact_kind",
        ]) &&
        typeof citation.conversation_id === "string" &&
        typeof citation.message_id === "string" &&
        typeof citation.artifact_kind === "string"
      );
    case "artifact_part":
      return (
        isSearchCitationBase(citation, "artifact_part", "artifact_part", [
          "artifact_id",
          "message_id",
          "conversation_id",
          "artifact_kind",
          "artifact_title",
          "part_key",
          "part_type",
        ]) &&
        typeof citation.artifact_id === "string" &&
        typeof citation.message_id === "string" &&
        typeof citation.conversation_id === "string" &&
        typeof citation.artifact_kind === "string" &&
        typeof citation.source_version === "string" &&
        isOptionalString(citation.artifact_title) &&
        isOptionalString(citation.part_key) &&
        isOptionalString(citation.part_type)
      );
  }
  return false;
}

function isSearchCitationBase(
  citation: Record<string, unknown>,
  resultType: SearchCitationResultType,
  contextType: RetrievalContextRef["type"],
  variantKeys: string[],
): boolean {
  return (
    hasOnlyKeys(citation, [...SEARCH_CITATION_BASE_KEYS, ...variantKeys]) &&
    citation.type === resultType &&
    citation.result_type === resultType &&
    typeof citation.id === "string" &&
    typeof citation.source_id === "string" &&
    typeof citation.title === "string" &&
    (typeof citation.source_label === "string" ||
      citation.source_label === null) &&
    typeof citation.snippet === "string" &&
    typeof citation.deep_link === "string" &&
    isOptionalString(citation.citation_label) &&
    isRetrievalContextRef(citation.context_ref) &&
    citation.context_ref.type === contextType &&
    isOptionalString(citation.evidence_span_id) &&
    (citation.source_version === null ||
      typeof citation.source_version === "string") &&
    isSearchCitationLocator(resultType, citation.locator) &&
    (typeof citation.media_id === "string" || citation.media_id === null) &&
    (typeof citation.media_kind === "string" || citation.media_kind === null) &&
    (typeof citation.score === "number" || citation.score === null) &&
    typeof citation.selected === "boolean"
  );
}

function isSearchCitationLocator(
  resultType: SearchCitationResultType,
  locator: unknown,
): boolean {
  switch (resultType) {
    case "media":
    case "podcast":
    case "episode":
    case "video":
    case "page":
    case "contributor":
    case "conversation":
    case "artifact":
      return locator === null;
    case "content_chunk":
    case "fragment":
    case "highlight":
    case "evidence_span":
      return (
        isRetrievalLocator(locator) &&
        MEDIA_RETRIEVAL_LOCATOR_TYPES.has(locator.type)
      );
    case "note_block":
      return (
        isRetrievalLocator(locator) && locator.type === "note_block_offsets"
      );
    case "message":
      return isRetrievalLocator(locator) && locator.type === "message_offsets";
    case "artifact_part":
      return (
        isRetrievalLocator(locator) && locator.type === "artifact_part_ref"
      );
  }
}

export function isWebCitationEventData(
  citation: unknown,
): citation is WebCitationEventData {
  return (
    isRecord(citation) &&
    hasOnlyKeys(citation, [
      "assistant_message_id",
      "tool_call_id",
      "tool_name",
      "tool_call_index",
      "citation_index",
      "index",
      "type",
      "id",
      "result_ref",
      "result_type",
      "source_id",
      "title",
      "url",
      "display_url",
      "source_name",
      "deep_link",
      "snippet",
      "excerpt",
      "extra_snippets",
      "published_at",
      "provider",
      "provider_request_id",
      "rank",
      "source_version",
      "context_ref",
      "media_id",
      "media_kind",
      "score",
      "selected",
      "locator",
    ]) &&
    citation.type === "web_result" &&
    typeof citation.id === "string" &&
    citation.result_type === "web_result" &&
    typeof citation.result_ref === "string" &&
    typeof citation.source_id === "string" &&
    typeof citation.title === "string" &&
    typeof citation.url === "string" &&
    (citation.display_url === undefined ||
      citation.display_url === null ||
      typeof citation.display_url === "string") &&
    (citation.source_name === undefined ||
      citation.source_name === null ||
      typeof citation.source_name === "string") &&
    typeof citation.deep_link === "string" &&
    typeof citation.snippet === "string" &&
    (citation.excerpt === undefined ||
      citation.excerpt === null ||
      typeof citation.excerpt === "string") &&
    (citation.extra_snippets === undefined ||
      (Array.isArray(citation.extra_snippets) &&
        citation.extra_snippets.every((item) => typeof item === "string"))) &&
    (citation.published_at === undefined ||
      citation.published_at === null ||
      typeof citation.published_at === "string") &&
    (citation.provider === undefined ||
      citation.provider === null ||
      typeof citation.provider === "string") &&
    (citation.provider_request_id === undefined ||
      citation.provider_request_id === null ||
      typeof citation.provider_request_id === "string") &&
    (citation.rank === undefined || Number.isInteger(citation.rank)) &&
    typeof citation.source_version === "string" &&
    isRetrievalContextRef(citation.context_ref) &&
    citation.context_ref.type === "web_result" &&
    isRetrievalLocator(citation.locator) &&
    citation.locator.type === "external_url" &&
    citation.media_id === null &&
    citation.media_kind === null &&
    (citation.score === null || typeof citation.score === "number") &&
    typeof citation.selected === "boolean"
  );
}

export function isCitationEventData(
  citation: unknown,
): citation is CitationEventData {
  return (
    isWebCitationEventData(citation) || isSearchCitationEventData(citation)
  );
}

function parseMetaData(data: unknown): SSEMetaEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.conversation_id !== "string" ||
    typeof data.user_message_id !== "string" ||
    typeof data.assistant_message_id !== "string" ||
    typeof data.model_id !== "string" ||
    typeof data.provider !== "string"
  ) {
    throw new Error("Invalid SSE payload for meta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the meta payload.
  return data as SSEMetaEvent["data"];
}

function parseDeltaData(data: unknown): SSEDeltaEvent["data"] {
  if (!isRecord(data) || typeof data.delta !== "string") {
    throw new Error("Invalid SSE payload for delta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the delta payload.
  return data as SSEDeltaEvent["data"];
}

function parseDoneData(data: unknown): SSEDoneEvent["data"] {
  if (
    !isRecord(data) ||
    (data.status !== "complete" &&
      data.status !== "error" &&
      data.status !== "cancelled") ||
    !(typeof data.error_code === "string" || data.error_code === null) ||
    (data.final_chars !== undefined && !Number.isInteger(data.final_chars))
  ) {
    throw new Error("Invalid SSE payload for done");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the done payload.
  return data as SSEDoneEvent["data"];
}

function parseToolCallData(data: unknown): SSEToolCallEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "status",
      "scope",
      "types",
      "semantic",
      "filters",
      "freshness_days",
      "allowed_domains",
      "blocked_domains",
      "error_code",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    (data.tool_name !== "app_search" && data.tool_name !== "web_search") ||
    !Number.isInteger(data.tool_call_index) ||
    !isChatToolStatus(data.status) ||
    (data.tool_call_id !== undefined &&
      data.tool_call_id !== null &&
      typeof data.tool_call_id !== "string") ||
    typeof data.scope !== "string" ||
    !Array.isArray(data.types) ||
    !data.types.every((item) => typeof item === "string") ||
    typeof data.semantic !== "boolean" ||
    !isRecord(data.filters) ||
    (data.freshness_days !== undefined &&
      data.freshness_days !== null &&
      !Number.isInteger(data.freshness_days)) ||
    (data.allowed_domains !== undefined &&
      (!Array.isArray(data.allowed_domains) ||
        !data.allowed_domains.every((item) => typeof item === "string"))) ||
    (data.blocked_domains !== undefined &&
      (!Array.isArray(data.blocked_domains) ||
        !data.blocked_domains.every((item) => typeof item === "string"))) ||
    !isOptionalString(data.error_code)
  ) {
    throw new Error("Invalid SSE payload for tool_call");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the tool_call payload.
  return data as SSEToolCallEvent["data"];
}

function parseRetrievalResultData(
  data: unknown,
): SSERetrievalResultEvent["data"] {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "tool_call_id",
      "assistant_message_id",
      "tool_name",
      "tool_call_index",
      "status",
      "error_code",
      "result_count",
      "selected_count",
      "latency_ms",
      "filters",
      "results",
    ]) ||
    typeof data.assistant_message_id !== "string" ||
    (data.tool_name !== "app_search" && data.tool_name !== "web_search") ||
    !isOptionalString(data.tool_call_id) ||
    !Number.isInteger(data.tool_call_index) ||
    !isChatToolStatus(data.status) ||
    !isOptionalString(data.error_code) ||
    !Number.isInteger(data.result_count) ||
    !Number.isInteger(data.selected_count) ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      !Number.isInteger(data.latency_ms)) ||
    !isRecord(data.filters) ||
    !Array.isArray(data.results) ||
    !data.results.every(isCitationEventData)
  ) {
    throw new Error("Invalid SSE payload for retrieval_result");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the retrieval_result payload.
  return data as SSERetrievalResultEvent["data"];
}

function parseArtifactDeltaData(data: unknown): SSEArtifactDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    (data.artifact_id !== undefined &&
      data.artifact_id !== null &&
      typeof data.artifact_id !== "string") ||
    (data.durable_artifact_id !== undefined &&
      data.durable_artifact_id !== null &&
      typeof data.durable_artifact_id !== "string") ||
    (data.artifact_key !== undefined &&
      data.artifact_key !== null &&
      typeof data.artifact_key !== "string") ||
    (data.artifact_version !== undefined &&
      data.artifact_version !== null &&
      !Number.isInteger(data.artifact_version)) ||
    (data.supersedes_artifact_id !== undefined &&
      data.supersedes_artifact_id !== null &&
      typeof data.supersedes_artifact_id !== "string") ||
    (data.artifact_kind !== undefined &&
      data.artifact_kind !== null &&
      typeof data.artifact_kind !== "string") ||
    (data.title !== undefined &&
      data.title !== null &&
      typeof data.title !== "string") ||
    (data.status !== undefined &&
      data.status !== null &&
      typeof data.status !== "string") ||
    (data.delta !== undefined &&
      data.delta !== null &&
      typeof data.delta !== "string") ||
    (data.parts !== undefined &&
      (!Array.isArray(data.parts) || !data.parts.every(isArtifactDeltaPart)))
  ) {
    throw new Error("Invalid SSE payload for artifact_delta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the artifact_delta payload.
  return data as SSEArtifactDeltaEvent["data"];
}

function isArtifactDeltaPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (
    !hasOnlyKeys(part, [
      "id",
      "artifact_id",
      "ordinal",
      "part_key",
      "part_type",
      "text",
      "source_version",
      "locator",
      "source_ref",
      "source_refs",
      "context_ref",
      "result_ref",
      "evidence_span_id",
      "evidence_span_ids",
      "metadata",
      "created_at",
    ]) ||
    typeof part.source_version !== "string" ||
    !isRetrievalLocator(part.locator) ||
    (part.id !== undefined &&
      part.id !== null &&
      typeof part.id !== "string") ||
    (part.artifact_id !== undefined &&
      part.artifact_id !== null &&
      typeof part.artifact_id !== "string") ||
    (part.ordinal !== undefined &&
      part.ordinal !== null &&
      !Number.isInteger(part.ordinal)) ||
    !isOptionalString(part.part_key) ||
    !isOptionalString(part.part_type) ||
    !isOptionalString(part.text) ||
    !isOptionalSourceRef(part.source_ref) ||
    (part.source_refs !== undefined &&
      (!Array.isArray(part.source_refs) ||
        !part.source_refs.every(isSourceRef))) ||
    !isOptionalRetrievalContextRef(part.context_ref) ||
    !isOptionalRetrievalResultRef(part.result_ref) ||
    !isOptionalString(part.evidence_span_id) ||
    (part.evidence_span_ids !== undefined &&
      (!Array.isArray(part.evidence_span_ids) ||
        !part.evidence_span_ids.every((id) => typeof id === "string"))) ||
    !isOptionalRecord(part.metadata) ||
    !isOptionalString(part.created_at)
  ) {
    return false;
  }
  return (
    isRecord(part.source_ref) ||
    isRecord(part.context_ref) ||
    isRecord(part.result_ref) ||
    (Array.isArray(part.source_refs) && part.source_refs.length > 0) ||
    typeof part.evidence_span_id === "string" ||
    (Array.isArray(part.evidence_span_ids) &&
      part.evidence_span_ids.length > 0) ||
    (isRecord(part.metadata) &&
      part.metadata.support_state === "not_source_grounded")
  );
}

function parseClaimData(data: unknown): SSEClaimEvent["data"] {
  if (
    !isRecord(data) ||
    (data.id !== undefined && typeof data.id !== "string") ||
    (data.message_id !== undefined && typeof data.message_id !== "string") ||
    (data.ordinal !== undefined && !Number.isInteger(data.ordinal)) ||
    typeof data.claim_text !== "string" ||
    (data.answer_start_offset !== undefined &&
      data.answer_start_offset !== null &&
      !Number.isInteger(data.answer_start_offset)) ||
    (data.answer_end_offset !== undefined &&
      data.answer_end_offset !== null &&
      !Number.isInteger(data.answer_end_offset)) ||
    !isMessageClaimKind(data.claim_kind) ||
    !isMessageClaimSupportStatus(data.support_status) ||
    (data.unsupported_reason !== undefined &&
      data.unsupported_reason !== null &&
      typeof data.unsupported_reason !== "string") ||
    (data.confidence !== undefined &&
      data.confidence !== null &&
      typeof data.confidence !== "number") ||
    !isMessageEvidenceVerifierStatus(data.verifier_status) ||
    (data.created_at !== undefined && typeof data.created_at !== "string")
  ) {
    throw new Error("Invalid SSE payload for claim");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the claim payload.
  return data as SSEClaimEvent["data"];
}

function parseClaimEvidenceData(data: unknown): MessageClaimEvidence {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      "id",
      "claim_id",
      "ordinal",
      "evidence_role",
      "source_ref",
      "retrieval_id",
      "evidence_span_id",
      "context_ref",
      "result_ref",
      "exact_snippet",
      "snippet_prefix",
      "snippet_suffix",
      "locator",
      "deep_link",
      "citation_label",
      "score",
      "retrieval_status",
      "selected",
      "included_in_prompt",
      "source_version",
      "created_at",
    ]) ||
    typeof data.id !== "string" ||
    typeof data.claim_id !== "string" ||
    !Number.isInteger(data.ordinal) ||
    !isMessageEvidenceRole(data.evidence_role) ||
    !isSourceRef(data.source_ref) ||
    !isMessageEvidenceRetrievalStatus(data.retrieval_status) ||
    typeof data.selected !== "boolean" ||
    typeof data.included_in_prompt !== "boolean" ||
    (data.retrieval_id !== undefined &&
      data.retrieval_id !== null &&
      typeof data.retrieval_id !== "string") ||
    (data.evidence_span_id !== undefined &&
      data.evidence_span_id !== null &&
      typeof data.evidence_span_id !== "string") ||
    !isOptionalRetrievalContextRef(data.context_ref) ||
    !isOptionalRetrievalResultRef(data.result_ref) ||
    !isOptionalString(data.exact_snippet) ||
    !isOptionalString(data.snippet_prefix) ||
    !isOptionalString(data.snippet_suffix) ||
    (data.locator !== undefined &&
      data.locator !== null &&
      !isRetrievalLocator(data.locator)) ||
    !isOptionalString(data.deep_link) ||
    !isOptionalString(data.citation_label) ||
    (data.score !== undefined &&
      data.score !== null &&
      typeof data.score !== "number") ||
    !isOptionalString(data.source_version) ||
    typeof data.created_at !== "string" ||
    ((data.evidence_role === "supports" ||
      data.evidence_role === "contradicts") &&
      (data.locator === undefined ||
        data.locator === null ||
        typeof data.source_version !== "string" ||
        !data.source_version.trim() ||
        typeof data.exact_snippet !== "string" ||
        !data.exact_snippet.trim()))
  ) {
    throw new Error("Invalid SSE payload for claim_evidence");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the claim_evidence payload; the `unknown` step is required
  // because a Record<string, unknown> index signature is not directly
  // assignable to the specific MessageClaimEvidence field types.
  return data as unknown as MessageClaimEvidence;
}

function parseSourceManifestDeltaData(
  data: unknown,
): SSESourceManifestDeltaEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.assistant_message_id !== "string" ||
    !isOptionalString(data.tool_call_id) ||
    (data.tool_name !== "app_search" && data.tool_name !== "web_search") ||
    !Number.isInteger(data.tool_call_index) ||
    !isOptionalString(data.query_hash) ||
    typeof data.scope !== "string" ||
    !isRecord(data.filters) ||
    !Array.isArray(data.requested_types) ||
    !data.requested_types.every((item) => typeof item === "string") ||
    !Number.isInteger(data.candidate_count) ||
    !Number.isInteger(data.result_count) ||
    !Number.isInteger(data.selected_count) ||
    !Number.isInteger(data.included_in_prompt_count) ||
    !Number.isInteger(data.excluded_by_budget_count) ||
    !Number.isInteger(data.excluded_by_scope_count) ||
    !Number.isInteger(data.stale_count) ||
    !Number.isInteger(data.unreadable_count) ||
    !Array.isArray(data.index_versions) ||
    !data.index_versions.every((item) => typeof item === "string") ||
    !isOptionalRecord(data.metadata) ||
    (data.web_search_mode !== undefined &&
      data.web_search_mode !== null &&
      data.web_search_mode !== "off" &&
      data.web_search_mode !== "auto" &&
      data.web_search_mode !== "required") ||
    (data.latency_ms !== undefined &&
      data.latency_ms !== null &&
      !Number.isInteger(data.latency_ms)) ||
    !isChatToolStatus(data.status)
  ) {
    throw new Error("Invalid SSE payload for source_manifest_delta");
  }
  // justify-type-assertion: the guard above exhaustively validated every
  // field of the source_manifest_delta payload.
  return data as SSESourceManifestDeltaEvent["data"];
}

function isMessageClaimKind(value: unknown): value is MessageClaimKind {
  return value === "answer" || value === "insufficient_evidence";
}

function isMessageEvidenceRole(value: unknown): value is MessageEvidenceRole {
  return (
    value === "supports" ||
    value === "contradicts" ||
    value === "context" ||
    value === "scope_boundary"
  );
}

function isMessageEvidenceRetrievalStatus(
  value: unknown,
): value is MessageEvidenceRetrievalStatus {
  return (
    value === "attached_context" ||
    value === "retrieved" ||
    value === "selected" ||
    value === "included_in_prompt" ||
    value === "excluded_by_budget" ||
    value === "excluded_by_scope" ||
    value === "web_result"
  );
}

function isMessageClaimSupportStatus(
  value: unknown,
): value is MessageClaimSupportStatus {
  return (
    value === "supported" ||
    value === "partially_supported" ||
    value === "contradicted" ||
    value === "not_enough_evidence" ||
    value === "out_of_scope" ||
    value === "not_source_grounded"
  );
}

function isMessageEvidenceVerifierStatus(
  value: unknown,
): value is MessageEvidenceVerifierStatus {
  return (
    value === "llm_verified" || value === "parse_failed" || value === "failed"
  );
}

function isChatToolStatus(value: unknown): value is ChatToolStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "complete" ||
    value === "error" ||
    value === "cancelled"
  );
}

function toChatSSEEvent(eventType: string, data: unknown): SSEEvent {
  switch (eventType) {
    case "meta":
      return { type: "meta", data: parseMetaData(data) };
    case "delta":
      return { type: "delta", data: parseDeltaData(data) };
    case "done":
      return { type: "done", data: parseDoneData(data) };
    case "tool_call":
      return { type: "tool_call", data: parseToolCallData(data) };
    case "retrieval_result":
      return { type: "retrieval_result", data: parseRetrievalResultData(data) };
    case "source_manifest_delta":
      return {
        type: "source_manifest_delta",
        data: parseSourceManifestDeltaData(data),
      };
    case "artifact_delta":
      return { type: "artifact_delta", data: parseArtifactDeltaData(data) };
    case "claim":
      return { type: "claim", data: parseClaimData(data) };
    case "claim_evidence":
      return { type: "claim_evidence", data: parseClaimEvidenceData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}

// ============================================================================
// Direct-to-FastAPI Chat Run SSE Client
// ============================================================================

/**
 * Tail a durable chat run via direct browser -> FastAPI SSE using a stream token.
 *
 * @param streamBaseUrl - The fastapi base URL for streaming
 * @param streamToken - The short-lived stream JWT, or a supplier that mints one per reconnect
 * @param runId - Chat run ID returned by POST /api/chat-runs
 * @param handlers - Event callbacks
 * @param options - Optional fetch options
 * @returns Cleanup function to abort the stream
 */
export function sseClientDirect(
  streamBaseUrl: string,
  streamToken: string | (() => Promise<string>),
  runId: string,
  handlers: {
    onEvent: SSEEventHandler;
    onError: SSEErrorHandler;
    onComplete?: SSECompleteHandler;
    onLastEventId?: (id: string) => void;
  },
  options?: {
    signal?: AbortSignal;
    lastEventId?: string;
  },
): () => void {
  const controller = new AbortController();
  const combinedSignal = options?.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  const url = `${streamBaseUrl}/chat-runs/${runId}/events`;
  let lastEventId = options?.lastEventId ?? "";
  let reconnectDelayMs = RECONNECT_DELAY_MS;

  // Start the fetch + parse pipeline
  (async () => {
    let terminalEventSeen = false;

    while (!combinedSignal.aborted && !terminalEventSeen) {
      let response: Response;
      try {
        const token =
          typeof streamToken === "function" ? await streamToken() : streamToken;
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        };
        if (lastEventId) headers["Last-Event-ID"] = lastEventId;

        response = await fetch(url, {
          method: "GET",
          headers,
          signal: combinedSignal,
        });
      } catch (err) {
        if (isAbortError(err) || combinedSignal.aborted) {
          handlers.onComplete?.(terminalEventSeen);
          return;
        }
        await delay(reconnectDelayMs);
        continue;
      }

      if (!response.ok) {
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorBody = await response.json();
          if (errorBody?.error?.message) {
            errorMessage = errorBody.error.message;
          }
        } catch {
          // justify-ignore-error: error bodies are optional; the HTTP status fallback is enough.
        }
        handlers.onError(new Error(errorMessage));
        return;
      }

      if (!isEventStreamResponse(response)) {
        handlers.onError(new Error("Invalid SSE content type"));
        return;
      }

      if (!response.body) {
        handlers.onError(new Error("Response body is null"));
        return;
      }

      try {
        await parseSSEJsonStream(
          response.body,
          (jsonEvent) => {
            if (jsonEvent.id) {
              lastEventId = jsonEvent.id;
              handlers.onLastEventId?.(lastEventId);
            }
            const event = toChatSSEEvent(jsonEvent.type, jsonEvent.data);
            handlers.onEvent(event);
            if (event.type === "done") terminalEventSeen = true;
          },
          (milliseconds) => {
            reconnectDelayMs = milliseconds;
          },
        );
      } catch (err) {
        if (isAbortError(err) || combinedSignal.aborted) {
          handlers.onComplete?.(terminalEventSeen);
          return;
        }
        if (
          err instanceof Error &&
          (err.message.startsWith("SSE event exceeds maximum size") ||
            err.message.startsWith("Failed to parse SSE ") ||
            err.message.startsWith("Invalid SSE payload") ||
            err.message.startsWith("Unknown SSE event type"))
        ) {
          handlers.onError(err);
          return;
        }
        await delay(reconnectDelayMs);
        continue;
      }

      break;
    }

    handlers.onComplete?.(terminalEventSeen);
  })().catch((err) => {
    if (isAbortError(err)) {
      handlers.onComplete?.(false);
      return;
    }
    handlers.onError(
      err instanceof Error ? err : new Error("Unknown SSE error"),
    );
  });

  return () => controller.abort();
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return (
    contentType?.split(";", 1)[0].trim().toLowerCase() ===
    EVENT_STREAM_CONTENT_TYPE
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Combine two AbortSignals so that aborting either aborts the combined signal.
 */
function combineSignals(
  signal1: AbortSignal,
  signal2: AbortSignal,
): AbortSignal {
  const controller = new AbortController();

  const abort = () => controller.abort();

  if (signal1.aborted || signal2.aborted) {
    controller.abort();
    return controller.signal;
  }

  signal1.addEventListener("abort", abort, { once: true });
  signal2.addEventListener("abort", abort, { once: true });

  return controller.signal;
}
