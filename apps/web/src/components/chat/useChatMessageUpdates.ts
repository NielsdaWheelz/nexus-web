"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  SearchCitationEventData,
  WebCitationEventData,
} from "@/lib/api/sse/citations";
import type {
  SSEArtifactDeltaEvent,
  SSEClaimEvent,
  SSEClaimEvidenceEvent,
  SSERetrievalResultEvent,
  SSESourceManifestDeltaEvent,
  SSEToolCallEvent,
} from "@/lib/api/sse/events";
import { isRetrievalLocator } from "@/lib/api/sse/locators";
import {
  isSearchCitation,
  isWebCitation,
} from "@/lib/chat/citations";
import { conversationMessageText } from "@/lib/conversations/types";
import type {
  ConversationMessage,
  MessageArtifactPart,
  MessageDocument,
  MessageRetrievalResultRef,
  MessageSourceManifestDelta,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";

function artifactPartHasEvidence(part: unknown): part is MessageArtifactPart {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  if (
    typeof record.source_version !== "string" ||
    !isRetrievalLocator(record.locator)
  ) {
    return false;
  }
  return (
    Boolean(record.source_ref && typeof record.source_ref === "object") ||
    Boolean(record.context_ref && typeof record.context_ref === "object") ||
    Boolean(record.result_ref && typeof record.result_ref === "object") ||
    (Array.isArray(record.source_refs) && record.source_refs.length > 0) ||
    typeof record.evidence_span_id === "string" ||
    (Array.isArray(record.evidence_span_ids) && record.evidence_span_ids.length > 0)
  );
}

function artifactPartIsVisible(part: unknown): part is MessageArtifactPart {
  if (artifactPartHasEvidence(part)) return true;
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  if (
    typeof record.source_version !== "string" ||
    !isRetrievalLocator(record.locator)
  ) {
    return false;
  }
  const metadata = record.metadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).support_state === "not_source_grounded"
  );
}

function retrievalFromSearchCitation(
  citation: SearchCitationEventData,
  data: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
    tool_name?: string;
  },
  index: number,
): MessageRetrieval {
  const result_ref = citation as MessageRetrievalResultRef;
  return {
    tool_call_id: data.tool_call_id ?? undefined,
    tool_call_index: data.tool_call_index ?? null,
    ordinal: index,
    result_type: citation.result_type,
    source_id: citation.source_id,
    media_id: citation.media_id,
    evidence_span_id: citation.evidence_span_id ?? null,
    context_ref: citation.context_ref,
    result_ref,
    deep_link: citation.deep_link,
    citation_label: citation.citation_label ?? null,
    locator: citation.locator,
    score: citation.score,
    selected: citation.selected,
    source_title: citation.title,
    section_label: citation.source_label,
    exact_snippet: citation.snippet,
    retrieval_status: citation.selected ? "selected" : "retrieved",
    included_in_prompt: false,
    source_version: citation.source_version ?? null,
  };
}

function retrievalFromWebCitation(
  citation: WebCitationEventData,
  data: SSERetrievalResultEvent["data"],
  index: number,
): MessageRetrieval {
  const result_ref: MessageRetrievalResultRef = citation;
  return {
    tool_call_id: data.tool_call_id ?? undefined,
    tool_call_index: data.tool_call_index ?? null,
    ordinal: index,
    result_type: "web_result",
    source_id: citation.source_id,
    media_id: citation.media_id ?? null,
    context_ref: citation.context_ref,
    result_ref,
    deep_link: citation.deep_link,
    citation_label: citation.display_url ?? citation.source_name ?? null,
    locator: citation.locator,
    score: citation.score ?? null,
    selected: citation.selected ?? true,
    source_title: citation.title,
    exact_snippet: citation.snippet,
    retrieval_status: "web_result",
    included_in_prompt: false,
    source_version: citation.source_version,
  };
}

function sameToolBlock(
  block: {
    tool_call_id?: string | null;
    tool_call_index?: number | null;
    tool_name?: string | null;
  },
  data: {
    tool_call_id?: string | null;
    tool_call_index: number;
    tool_name?: string | null;
  },
): boolean {
  if (block.tool_name && data.tool_name && block.tool_name !== data.tool_name) {
    return false;
  }
  return data.tool_call_id
    ? block.tool_call_id === data.tool_call_id
    : block.tool_call_index === data.tool_call_index;
}

function messageDocumentWithText(
  message: ConversationMessage,
  content: string,
): MessageDocument {
  const existingBlocks = message.message_document?.blocks ?? [];
  return {
    type: "message_document",
    version: message.message_document?.version ?? 1,
    blocks: [
      ...(content.trim().length > 0
        ? [
            {
              type: "text" as const,
              format: "markdown" as const,
              text: content,
            },
          ]
        : []),
      ...existingBlocks.filter((block) => block.type !== "text"),
    ],
  };
}

function messageDocumentWithRetrievals(
  message: ConversationMessage,
  data: SSERetrievalResultEvent["data"],
  retrievals: MessageRetrieval[],
): MessageDocument {
  const existingBlocks = message.message_document?.blocks ?? [];
  return {
    type: "message_document",
    version: message.message_document?.version ?? 1,
    blocks: [
      ...existingBlocks.filter(
        (block) =>
          block.type !== "retrieval_result" || !sameToolBlock(block, data),
      ),
      ...retrievals.map((retrieval) => ({
        type: "retrieval_result" as const,
        ...retrieval,
      })),
    ],
  };
}

function messageDocumentWithSourceManifest(
  message: ConversationMessage,
  data: MessageSourceManifestDelta,
): MessageDocument {
  const existingBlocks = message.message_document?.blocks ?? [];
  return {
    type: "message_document",
    version: message.message_document?.version ?? 1,
    blocks: [
      ...existingBlocks.filter(
        (block) =>
          block.type !== "source_manifest" || !sameToolBlock(block, data),
      ),
      {
        type: "source_manifest" as const,
        ...data,
      },
    ],
  };
}

export function useChatMessageUpdates({
  setMessages,
  shouldScrollRef,
}: {
  setMessages: Dispatch<SetStateAction<ConversationMessage[]>>;
  shouldScrollRef?: MutableRefObject<boolean>;
}) {
  const deltaBufferRef = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number | null>(null);

  const flushDeltas = useCallback(() => {
    rafRef.current = null;
    const buffer = deltaBufferRef.current;
    if (buffer.size === 0) return;
    const snapshot = new Map(buffer);
    buffer.clear();
    setMessages((prev) =>
      prev.map((m) => {
        const delta = snapshot.get(m.id);
        if (!delta) return m;
        const content = conversationMessageText(m) + delta;
        return {
          ...m,
          message_document: messageDocumentWithText(m, content),
        };
      }),
    );
  }, [setMessages]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleOptimisticMessages = useCallback(
    (userMsg: ConversationMessage, assistantMsg: ConversationMessage) => {
      if (shouldScrollRef) {
        shouldScrollRef.current = true;
      }
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    [setMessages, shouldScrollRef],
  );

  const handleMetaReceived = useCallback(
    (
      tempUserId: string,
      realUserId: string,
      tempAsstId: string,
      realAsstId: string,
    ) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId) return { ...m, id: realUserId };
          if (m.id === tempAsstId) return { ...m, id: realAsstId };
          return m;
        }),
      );
    },
    [setMessages],
  );

  const handleDelta = useCallback(
    (assistantId: string, delta: string) => {
      const buffer = deltaBufferRef.current;
      buffer.set(assistantId, (buffer.get(assistantId) ?? "") + delta);
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushDeltas);
      }
    },
    [flushDeltas],
  );

  const handleToolCall = useCallback(
    (assistantId: string, data: SSEToolCallEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const existing = m.tool_calls ?? [];
          const nextCall: MessageToolCall = {
            id: data.tool_call_id ?? undefined,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: data.status,
            scope: data.scope,
            requested_types: data.types,
            semantic: data.semantic,
          };
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const toolCalls =
            index >= 0
              ? existing.map((call, idx) =>
                  idx === index ? { ...call, ...nextCall } : call,
                )
              : [...existing, nextCall];
          return { ...m, tool_calls: toolCalls };
        }),
      );
    },
    [setMessages],
  );

  const handleToolResult = useCallback(
    (assistantId: string, data: SSERetrievalResultEvent["data"]) => {
      const results = Array.isArray(data.results) ? data.results : [];
      const retrievals: MessageRetrieval[] = results.flatMap(
        (citation, index) => {
          if (isWebCitation(citation)) {
            return [retrievalFromWebCitation(citation, data, index)];
          }
          if (!isSearchCitation(citation)) return [];
          return [retrievalFromSearchCitation(citation, data, index)];
        },
      );
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const existing = m.tool_calls ?? [];
          const index = existing.findIndex(
            (call) => call.tool_call_index === data.tool_call_index,
          );
          const nextCall: MessageToolCall = {
            ...(index >= 0 ? existing[index] : {}),
            id: data.tool_call_id ?? existing[index]?.id,
            assistant_message_id: data.assistant_message_id,
            tool_name: data.tool_name,
            tool_call_index: data.tool_call_index,
            status: data.status,
            error_code: data.error_code ?? null,
            latency_ms: data.latency_ms,
            result_count: data.result_count,
            selected_count: data.selected_count,
          };
          const toolCalls =
            index >= 0
              ? existing.map((call, idx) => (idx === index ? nextCall : call))
              : [...existing, nextCall];
          return {
            ...m,
            tool_calls: toolCalls,
            message_document: messageDocumentWithRetrievals(
              m,
              data,
              retrievals,
            ),
          };
        }),
      );
    },
    [setMessages],
  );

  const handleSourceManifestDelta = useCallback(
    (assistantId: string, data: SSESourceManifestDeltaEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          return {
            ...m,
            message_document: messageDocumentWithSourceManifest(m, data),
          };
        }),
      );
    },
    [setMessages],
  );

  const handleArtifactDelta = useCallback(
    (assistantId: string, data: SSEArtifactDeltaEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const artifact = {
            artifact_id: typeof data.artifact_id === "string" ? data.artifact_id : null,
            durable_artifact_id:
              typeof data.durable_artifact_id === "string" ? data.durable_artifact_id : null,
            artifact_key:
              typeof data.artifact_key === "string" ? data.artifact_key : null,
            artifact_version:
              typeof data.artifact_version === "number" ? data.artifact_version : null,
            supersedes_artifact_id:
              typeof data.supersedes_artifact_id === "string"
                ? data.supersedes_artifact_id
                : null,
            artifact_kind:
              typeof data.artifact_kind === "string" ? data.artifact_kind : null,
            title: typeof data.title === "string" ? data.title : null,
            status: typeof data.status === "string" ? data.status : null,
            delta: typeof data.delta === "string" ? data.delta : null,
            parts: Array.isArray(data.parts)
              ? data.parts.filter(artifactPartIsVisible)
              : [],
          };
          const blocks = m.message_document?.blocks ?? [];
          return {
            ...m,
            message_document: {
              type: "message_document",
              version: 1,
              blocks: [
                ...blocks.filter(
                  (block) =>
                    block.type !== "artifact_preview" ||
                    !artifact.artifact_id ||
                    block.artifact_id !== artifact.artifact_id,
                ),
                {
                  type: "artifact_preview",
                  artifact_id: artifact.artifact_id,
                  durable_artifact_id: artifact.durable_artifact_id,
                  artifact_key: artifact.artifact_key,
                  artifact_version: artifact.artifact_version,
                  supersedes_artifact_id: artifact.supersedes_artifact_id,
                  artifact_kind: artifact.artifact_kind,
                  title: artifact.title,
                  status: artifact.status,
                  delta: artifact.delta,
                  parts: artifact.parts,
                },
              ],
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleClaim = useCallback(
    (assistantId: string, data: SSEClaimEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.id !== assistantId ||
            typeof data.claim_text !== "string" ||
            !(
              data.claim_kind === "answer" ||
              data.claim_kind === "insufficient_evidence"
            ) ||
            !(
              data.support_status === "supported" ||
              data.support_status === "partially_supported" ||
              data.support_status === "contradicted" ||
              data.support_status === "not_enough_evidence" ||
              data.support_status === "out_of_scope" ||
              data.support_status === "not_source_grounded"
            ) ||
            !(
              data.verifier_status === "llm_verified" ||
              data.verifier_status === "parse_failed" ||
              data.verifier_status === "failed"
            )
          ) {
            return m;
          }
          const createdAt = data.created_at ?? new Date().toISOString();
          const blocks = m.message_document?.blocks ?? [];
          const ordinal =
            data.ordinal ?? blocks.filter((block) => block.type === "claim").length;
          const claimId = data.id ?? `${assistantId}-claim-${ordinal}`;
          return {
            ...m,
            message_document: {
              type: "message_document",
              version: 1,
              blocks: [
                ...blocks.filter(
                  (block) => block.type !== "claim" || block.claim_id !== claimId,
                ),
                {
                  type: "claim",
                  claim_id: claimId,
                  message_id: data.message_id ?? assistantId,
                  ordinal,
                  claim_text: data.claim_text,
                  answer_start_offset: data.answer_start_offset ?? null,
                  answer_end_offset: data.answer_end_offset ?? null,
                  claim_kind: data.claim_kind,
                  support_status: data.support_status,
                  unsupported_reason: data.unsupported_reason ?? null,
                  confidence:
                    typeof data.confidence === "number" ? data.confidence : null,
                  verifier_status: data.verifier_status,
                  created_at: createdAt,
                },
              ],
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleClaimEvidence = useCallback(
    (assistantId: string, evidence: SSEClaimEvidenceEvent["data"]) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const blocks = m.message_document?.blocks ?? [];
          return {
            ...m,
            message_document: {
              type: "message_document",
              version: 1,
              blocks: [
                ...blocks.filter(
                  (block) =>
                    block.type !== "claim_evidence" || block.id !== evidence.id,
                ),
                {
                  type: "claim_evidence",
                  ...evidence,
                },
              ],
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const handleDone = useCallback(
    (
      assistantId: string,
      status: "complete" | "error" | "cancelled",
      errorCode: string | null,
    ) => {
      const buffer = deltaBufferRef.current;
      const remaining = buffer.get(assistantId);
      buffer.delete(assistantId);

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          const content = remaining
            ? conversationMessageText(m) + remaining
            : conversationMessageText(m);
          return {
            ...m,
            message_document: messageDocumentWithText(m, content),
            status,
            error_code: errorCode,
          };
        }),
      );
    },
    [setMessages],
  );

  return {
    flushDeltas,
    handleOptimisticMessages,
    handleMetaReceived,
    handleDelta,
    handleToolCall,
    handleToolResult,
    handleSourceManifestDelta,
    handleArtifactDelta,
    handleClaim,
    handleClaimEvidence,
    handleDone,
  };
}
