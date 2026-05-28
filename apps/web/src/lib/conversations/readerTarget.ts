import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { isRetrievalLocator } from "@/lib/api/sse/locators";
import type {
  MessageContextSnapshot,
  MessageRetrieval,
} from "./types";

export function readerTargetFromContext(
  context: MessageContextSnapshot,
  href: string | null,
): ReaderSourceTarget | null {
  if (context.kind !== "reader_selection") return null;
  const mediaId = context.source_media_id ?? context.media_id;
  if (!mediaId || !context.source_version || !isRetrievalLocator(context.locator)) {
    return null;
  }
  return {
    source: "message_context",
    media_id: mediaId,
    locator: context.locator,
    snippet: context.exact ?? context.preview ?? null,
    source_version: context.source_version,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: "attached_context",
    label: context.title ?? context.media_title,
    href,
    context_id: context.client_context_id ?? null,
  };
}

export function readerTargetFromRetrieval(
  retrieval: MessageRetrieval,
): ReaderSourceTarget | null {
  if (
    !retrieval.media_id ||
    !retrieval.source_version ||
    !isRetrievalLocator(retrieval.locator ?? null)
  ) {
    return null;
  }
  return {
    source: "message_retrieval",
    media_id: retrieval.media_id,
    locator: retrieval.locator!,
    snippet: retrieval.exact_snippet ?? null,
    source_version: retrieval.source_version,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: retrieval.retrieval_status ?? "retrieved",
    label: retrieval.source_title ?? undefined,
    href: retrieval.deep_link ?? null,
    evidence_span_id: retrieval.evidence_span_id ?? null,
    evidence_id: retrieval.id,
  };
}
