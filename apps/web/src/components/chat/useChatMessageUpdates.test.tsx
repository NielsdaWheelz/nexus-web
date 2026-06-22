import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import { useChatMessageUpdates } from "./useChatMessageUpdates";
import type {
  SSECitationIndexEvent,
  SSEDoneEvent,
  SSEPromptAssemblyEvent,
  SSEToolLedgerSnapshotEvent,
  SSEToolResultEvent,
} from "@/lib/api/sse/events";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type {
  ConversationMessage,
  MessageRetrieval,
  TrustRetrievalPlan,
} from "@/lib/conversations/types";

const ASSISTANT_ID = "assistant-1";
const NOTE_BLOCK_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const RETRIEVAL_PLAN: TrustRetrievalPlan = {
  version: "chat_retrieval_plan.v1",
  route_intent: "private_deep_retrieval",
  source_domain: "private_app",
  mixing_policy: "single_domain",
  query_class: "multi_hop_search_read_inspect_question",
  allowed_tools: ["app_search", "inspect_resource", "read_resource"],
  blocked_tools: ["web_search"],
  candidate_tool_sequence: ["app_search", "inspect_resource", "read_resource"],
  internal_tool_sequence: [],
  reason: "multi_hop_private",
  context_ref_count: 1,
  search_scope_count: 1,
  search_scope_uris: ["media:11111111-1111-1111-1111-111111111111"],
  budget_policy: "tool_output_budget_from_prompt_assembly",
};

function assistantMessage(): ConversationMessage {
  return {
    id: ASSISTANT_ID,
    seq: 2,
    role: "assistant",
    status: "complete",
    error_code: null,
    can_retry_response: false,
    created_at: "2026-06-09T00:00:00Z",
    updated_at: "2026-06-09T00:00:00Z",
    message_document: {
      type: "message_document",
      // The `[1]`/`[2]` markers are what MarkdownMessage turns into chips once
      // the citation read-model is present.
      blocks: [
        {
          type: "text",
          format: "markdown",
          text: "Supported by [1] and contradicted in context by [2].",
        },
      ],
    },
    trust_trail: {
      schema_version: "assistant_trust_trail.v1",
      assistant_message_id: ASSISTANT_ID,
      conversation_id: "conversation-1",
      chat_run_id: null,
      status: "complete",
      run: null,
      prompt: null,
      tool_calls: [],
      citations: [],
      context_refs_added: [],
      integrity_notices: [],
      created_at: "2026-06-09T00:00:00Z",
      updated_at: "2026-06-09T00:00:00Z",
    },
  };
}

const NOTE_CITATION: CitationOut = {
  ordinal: 1,
  role: "supports",
  target_ref: { type: "note_block", id: NOTE_BLOCK_ID },
  activation: {
    resourceRef: `note_block:${NOTE_BLOCK_ID}`,
    kind: "route",
    href: `/notes/${NOTE_BLOCK_ID}`,
    unresolvedReason: null,
  },
  media_id: null,
  locator: {
    type: "note_block_offsets",
    block_id: NOTE_BLOCK_ID,
    start_offset: 0,
    end_offset: 16,
  },
  deep_link: `/notes/${NOTE_BLOCK_ID}`,
  snapshot: {
    title: "Cited note",
    excerpt: "the cited claim",
    section_label: null,
    result_type: null,
  },
};

const MEDIA_CITATION: CitationOut = {
  ordinal: 2,
  role: "context",
  target_ref: { type: "media", id: MEDIA_ID },
  activation: {
    resourceRef: `media:${MEDIA_ID}`,
    kind: "route",
    href: `/media/${MEDIA_ID}#fragment-1`,
    unresolvedReason: null,
  },
  media_id: MEDIA_ID,
  locator: {
    type: "web_text_offsets",
    media_id: MEDIA_ID,
    fragment_id: "fragment-1",
    start_offset: 20,
    end_offset: 34,
  },
  deep_link: `/media/${MEDIA_ID}#fragment-1`,
  snapshot: {
    title: "Background source",
    excerpt: null,
    section_label: null,
    result_type: null,
  },
};

// Two backend-built citations: one note target and one media target.
const TWO_CITATION_EVENT: SSECitationIndexEvent["data"] = {
  assistant_message_id: ASSISTANT_ID,
  citations: [
    { citation_edge_id: "edge-1", citation: NOTE_CITATION },
    { citation_edge_id: "edge-2", citation: MEDIA_CITATION },
  ],
};

// A later index for the same message carrying only the first citation.
const ONE_CITATION_EVENT: SSECitationIndexEvent["data"] = {
  assistant_message_id: ASSISTANT_ID,
  citations: [TWO_CITATION_EVENT.citations[0]],
};

// Drives the real fold (useChatMessageUpdates.handleCitationIndex) over real
// message state and renders the real disclosure. Each button dispatches a
// citation_index event so the assertion is on what the user sees before vs.
// after the event arrives. The list mirrors the folded read-model
// (ordinal/role/target/locator) that flows to render, so we can assert the
// backend-built locator survives the live fold.
function CitationIndexHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    assistantMessage(),
  ]);
  const { handleCitationIndex } = useChatMessageUpdates({ setMessages });
  const message = messages[0];
  return (
    <div>
      <button
        type="button"
        onClick={() => handleCitationIndex(ASSISTANT_ID, TWO_CITATION_EVENT)}
      >
        Fold two
      </button>
      <button
        type="button"
        onClick={() => handleCitationIndex(ASSISTANT_ID, ONE_CITATION_EVENT)}
      >
        Fold one
      </button>
      <AssistantEvidenceDisclosure message={message} />
      <ul aria-label="folded citations">
        {(message.citations ?? []).map((citation) => (
          <li key={citation.ordinal}>
            {[
              citation.ordinal,
              citation.role,
              citation.target_ref.type,
              citation.target_ref.id,
              citation.media_id ?? "none",
              citation.locator?.type ?? "none",
            ].join(":")}
          </li>
        ))}
      </ul>
    </div>
  );
}

function foldedRows(): string[] {
  return Array.from(
    screen.getByRole("list", { name: "folded citations" }).children,
    (li) => li.textContent ?? "",
  );
}

function mediaRetrieval(id: string, ordinal: number): MessageRetrieval {
  return {
    id,
    tool_call_id: "tool-1",
    tool_call_index: 1,
    ordinal,
    scope: "all",
    result_type: "media",
    source_id: MEDIA_ID,
    media_id: MEDIA_ID,
    evidence_span_id: null,
    context_ref: { type: "media", id: MEDIA_ID, evidence_span_ids: [] },
    result_ref: {
      type: "media",
      id: MEDIA_ID,
      result_type: "media",
      source_id: MEDIA_ID,
      title: "Shared target",
      source_label: null,
      snippet: "Shared evidence",
      deep_link: `/media/${MEDIA_ID}`,
      citation_target: `media:${MEDIA_ID}`,
      context_ref: { type: "media", id: MEDIA_ID, evidence_span_ids: [] },
      locator: null,
      media_id: MEDIA_ID,
      media_kind: "book",
      score: 1,
      selected: true,
    },
    deep_link: `/media/${MEDIA_ID}`,
    citation_label: null,
    locator: null,
    score: 1,
    selected: true,
    source_title: "Shared target",
    section_label: null,
    exact_snippet: "Shared evidence",
    retrieval_status: "selected",
    included_in_prompt: true,
    included_in_prompt_source: "tool_output",
  };
}

function CitationRetrievalLinkHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      trust_trail: {
        ...assistantMessage().trust_trail!,
        tool_calls: [
          {
            id: "tool-1",
            assistant_message_id: ASSISTANT_ID,
            tool_name: "app_search",
            tool_call_index: 1,
            status: "complete",
            scope: "all",
            requested_types: ["media"],
            result_refs: [],
            selected_context_refs: [],
            provider_request_ids: [],
            result_count: 2,
            selected_count: 2,
            more_candidates_available: false,
            retrievals: [mediaRetrieval("retrieval-a", 0), mediaRetrieval("retrieval-b", 1)],
            candidate_ledgers: [],
            rerank_ledgers: [],
          },
        ],
      },
    },
  ]);
  const { handleCitationIndex } = useChatMessageUpdates({ setMessages });
  const event: SSECitationIndexEvent["data"] = {
    assistant_message_id: ASSISTANT_ID,
    citations: [
      {
        citation_edge_id: "edge-unlinked",
        retrieval_id: null,
        tool_call_id: "tool-1",
        citation: { ...MEDIA_CITATION, ordinal: 1 },
      },
      {
        citation_edge_id: "edge-linked",
        retrieval_id: "retrieval-b",
        tool_call_id: "tool-1",
        citation: { ...MEDIA_CITATION, ordinal: 2 },
      },
    ],
  };
  const retrievals = messages[0].trust_trail?.tool_calls[0]?.retrievals ?? [];
  return (
    <div>
      <button
        type="button"
        onClick={() => handleCitationIndex(ASSISTANT_ID, event)}
      >
        Fold retrieval links
      </button>
      <output aria-label="retrieval citation state">
        {retrievals
          .map(
            (retrieval) =>
              `${retrieval.id}:${retrieval.cited_edge_id ?? "none"}:${
                retrieval.citation_number ?? "none"
              }`,
          )
          .join("|")}
      </output>
    </div>
  );
}

function ToolDeltaHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      message_document: { type: "message_document", blocks: [] },
    },
  ]);
  const { handleToolCallDelta } = useChatMessageUpdates({ setMessages });
  const tool = messages[0].trust_trail?.tool_calls[0];
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          handleToolCallDelta(ASSISTANT_ID, {
            assistant_message_id: ASSISTANT_ID,
            tool_name: "app_search",
            tool_call_index: 1,
            provider_tool_call_id: "provider-tool-1",
            input_delta: '{"query":"ne',
            input_preview: '{"query":"nexus"}',
            provider_event_seq_start: 4,
            provider_event_seq_end: 4,
          })
        }
      >
        Fold tool delta
      </button>
      <output aria-label="tool preview">
        {tool
          ? [
              tool.tool_name,
              tool.tool_call_index,
              tool.status,
              tool.input_preview ?? "",
            ].join(":")
          : ""}
      </output>
    </div>
  );
}

function PersistedToolDeltaHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      message_document: { type: "message_document", blocks: [] },
      trust_trail: {
        ...assistantMessage().trust_trail!,
        tool_calls: [
          {
            id: "tool-1",
            assistant_message_id: ASSISTANT_ID,
            tool_name: "app_search",
            tool_call_index: 1,
            status: "running",
            scope: "all",
            requested_types: ["media"],
            source_domain: "private_app",
            source_policy: {
              version: "source_boundary_policy.v1",
              decision: "allowed",
              source_domain: "private_app",
              mixing_allowed: false,
              reason: "single_domain_private_app",
              domains_seen: [],
              requested_domains: ["private_app"],
            },
            result_refs: [],
            selected_context_refs: [],
            provider_request_ids: [],
            result_count: 0,
            selected_count: 0,
            more_candidates_available: false,
            retrievals: [],
            candidate_ledgers: [],
            rerank_ledgers: [],
          },
        ],
      },
    },
  ]);
  const { handleToolCallDelta } = useChatMessageUpdates({ setMessages });
  const tool = messages[0].trust_trail?.tool_calls[0];
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          handleToolCallDelta(ASSISTANT_ID, {
            tool_call_id: "tool-1",
            assistant_message_id: ASSISTANT_ID,
            tool_name: "app_search",
            tool_call_index: 1,
            provider_tool_call_id: "provider-tool-1",
            input_delta: '{"query":"ne',
            input_preview: '{"query":"nexus"}',
            provider_event_seq_start: 4,
            provider_event_seq_end: 4,
          })
        }
      >
        Fold persisted tool delta
      </button>
      <output aria-label="persisted tool preview">
        {tool
          ? [
              tool.id,
              tool.tool_name,
              tool.tool_call_index,
              tool.status,
              tool.input_preview ?? "",
              tool.source_policy?.reason ?? "missing",
            ].join(":")
          : ""}
      </output>
    </div>
  );
}

function ToolCallStartHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      message_document: { type: "message_document", blocks: [] },
    },
  ]);
  const { handleToolCall } = useChatMessageUpdates({ setMessages });
  const tool = messages[0].trust_trail?.tool_calls[0];
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          handleToolCall(ASSISTANT_ID, {
            tool_call_id: "tool-1",
            assistant_message_id: ASSISTANT_ID,
            tool_name: "app_search",
            tool_call_index: 1,
            provider_tool_call_id: "provider-tool-1",
            provider_event_seq_start: 1,
            provider_event_seq_end: 1,
          })
        }
      >
        Open tool call
      </button>
      <output aria-label="started tool">
        {tool
          ? [tool.tool_name, tool.tool_call_index, tool.status].join(":")
          : ""}
      </output>
    </div>
  );
}

function ToolResultHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      message_document: { type: "message_document", blocks: [] },
    },
  ]);
  const { handleCitationIndex, handleToolResult } = useChatMessageUpdates({
    setMessages,
  });
  const retrievalId = "77777777-7777-4777-8777-777777777777";
  const data: SSEToolResultEvent["data"] = {
    tool_call_id: "tool-1",
    assistant_message_id: ASSISTANT_ID,
    tool_name: "app_search",
    tool_call_index: 1,
    status: "complete",
    scope: "all",
    types: ["media"],
    source_domain: "private_app",
    source_policy: {
      version: "source_boundary_policy.v1",
      decision: "allowed",
      source_domain: "private_app",
      mixing_allowed: false,
      reason: "single_domain_private_app",
      domains_seen: [],
      requested_domains: ["private_app"],
    },
    error_code: null,
    result_count: 8,
    selected_count: 6,
    more_candidates_available: true,
    latency_ms: 12,
    provider_request_ids: [],
    retrieval_ids: [retrievalId],
    filters: {},
    results: [
      {
        type: "media",
        id: MEDIA_ID,
        result_type: "media",
        source_id: MEDIA_ID,
        title: "Selected source",
        source_label: null,
        snippet: "Selected evidence",
        deep_link: `/media/${MEDIA_ID}`,
        citation_target: null,
        context_ref: { type: "media", id: MEDIA_ID, evidence_span_ids: [] },
        locator: null,
        media_id: MEDIA_ID,
        media_kind: "book",
        score: 1,
        selected: true,
      },
    ],
  };
  const citationIndex: SSECitationIndexEvent["data"] = {
    assistant_message_id: ASSISTANT_ID,
    citations: [
      {
        citation_edge_id: "edge-live",
        retrieval_id: retrievalId,
        tool_call_id: "tool-1",
        citation: { ...MEDIA_CITATION, ordinal: 1 },
      },
    ],
  };
  const tool = messages[0].trust_trail?.tool_calls[0];
  const included =
    tool?.retrievals.filter((item) => item.included_in_prompt).length ?? 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => handleToolResult(ASSISTANT_ID, data)}
      >
        Fold tool result
      </button>
      <button
        type="button"
        onClick={() => handleCitationIndex(ASSISTANT_ID, citationIndex)}
      >
        Fold tool citation
      </button>
      <output aria-label="tool result">
        {tool
          ? [
              tool.tool_name,
              tool.result_count ?? 0,
              tool.selected_count ?? 0,
              included,
              tool.more_candidates_available ? "more" : "done",
              tool.source_policy?.reason ?? "missing",
              tool.retrievals[0]?.included_in_prompt_source ?? "missing",
            ].join(":")
          : ""}
      </output>
      <output aria-label="tool result citation state">
        {tool?.retrievals
          .map(
            (retrieval) =>
              `${retrieval.id}:${retrieval.cited_edge_id ?? "none"}:${
                retrieval.citation_number ?? "none"
              }`,
          )
          .join("|") ?? ""}
      </output>
    </div>
  );
}

const PROMPT_ASSEMBLY: SSEPromptAssemblyEvent["data"] = {
  assistant_message_id: ASSISTANT_ID,
  prompt: {
    id: "55555555-5555-4555-8555-555555555555",
    cacheable_input_tokens_estimate: 1,
    prompt_block_manifest: { blocks: [] },
    max_context_tokens: 1000,
    reserved_output_tokens: 100,
    reserved_reasoning_tokens: 0,
    input_budget_tokens: 900,
    estimated_input_tokens: 42,
    included_message_ids: [],
    included_retrieval_ids: [],
    included_context_refs: [],
    dropped_items: [],
    budget_breakdown: {},
    created_at: "2026-06-09T00:00:00Z",
  },
};

function PromptAndLedgerHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      message_document: { type: "message_document", blocks: [] },
      trust_trail: {
        ...assistantMessage().trust_trail!,
        run: {
          run_id: "run-1",
          model_id: "model-1",
          provider: "openai",
          model_name: "gpt-test",
          reasoning_mode: "medium",
          key_mode: "auto",
          status: "running",
          usage: null,
          error_code: null,
          final_chars: null,
          started_at: null,
          completed_at: null,
          retrieval_plan: null,
        },
      },
    },
  ]);
  const { handlePromptAssembly, handleRetrievalPlan, handleToolLedgerSnapshot } =
    useChatMessageUpdates({ setMessages });
  const ledger: SSEToolLedgerSnapshotEvent["data"] = {
    assistant_message_id: ASSISTANT_ID,
    tool_call_id: "tool-1",
    tool_name: "app_search",
    tool_call_index: 1,
    scope: `media:${MEDIA_ID}`,
    requested_types: ["media"],
    source_domain: "private_app",
    source_policy: {
      version: "source_boundary_policy.v1",
      decision: "allowed",
      source_domain: "private_app",
      mixing_allowed: false,
      reason: "single_domain_private_app",
      domains_seen: [],
      requested_domains: ["private_app"],
    },
    candidate_ledgers: [
      {
        id: "candidate-ledger-1",
        tool_call_id: "tool-1",
        retrieval_id: null,
        ordinal: 0,
        result_type: "media",
        source_id: MEDIA_ID,
        score: 1,
        selected: true,
        included_in_prompt: true,
        ledger_included_in_prompt: true,
        linked_retrieval_included_in_prompt: null,
        included_in_prompt_source: "candidate_ledger",
        included_in_prompt_reconciled: true,
        selection_status: "selected",
        selection_reason: "selected_within_budget",
        result_ref: {
          type: "media",
          id: MEDIA_ID,
          result_type: "media",
          source_id: MEDIA_ID,
          title: "Selected source",
          source_label: null,
          snippet: "Selected evidence",
          deep_link: `/media/${MEDIA_ID}`,
          citation_target: null,
          context_ref: { type: "media", id: MEDIA_ID, evidence_span_ids: [] },
          locator: null,
          media_id: MEDIA_ID,
          media_kind: "book",
          score: 1,
          selected: true,
        },
        locator: null,
        created_at: "2026-06-09T00:00:00Z",
      },
    ],
    rerank_ledgers: [
      {
        id: "rerank-ledger-1",
        tool_call_id: "tool-1",
        strategy: "app_search_provider_rerank",
        input_count: 8,
        selected_count: 6,
        budget_chars: 16000,
        selected_chars: 1200,
        status: "complete",
        metadata: {
          rerank_mode: "provider_rerank",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          key_mode_used: "platform",
          llm_call_id: "11111111-1111-4111-8111-111111111111",
          provider_request_id: "req_provider_rerank_1",
          latency_ms: 123,
          estimated_cost_usd_micros: 4,
          cost_status: "known",
          candidate_rerank_trace: [
            {
              from: 0,
              to: 0,
              result_type: "media",
              source_id: MEDIA_ID,
              score: 1,
              selection_score: 0.98,
              citation_quality: 0.25,
              provider_score: 0.98,
              provider_reason: "direct_answer",
              selection_status: "selected",
              selection_reason: "selected_within_budget",
              selected: true,
              included_in_prompt: true,
            },
          ],
        },
        created_at: "2026-06-09T00:00:00Z",
      },
    ],
  };
  const trail = messages[0].trust_trail;
  const tool = trail?.tool_calls[0];
  return (
    <div>
      <button
        type="button"
        onClick={() => handlePromptAssembly(ASSISTANT_ID, PROMPT_ASSEMBLY)}
      >
        Fold prompt
      </button>
      <button
        type="button"
        onClick={() =>
          handleRetrievalPlan(ASSISTANT_ID, {
            assistant_message_id: ASSISTANT_ID,
            retrieval_plan: RETRIEVAL_PLAN,
          })
        }
      >
        Fold plan
      </button>
      <button
        type="button"
        onClick={() => handleToolLedgerSnapshot(ASSISTANT_ID, ledger)}
      >
        Fold ledgers
      </button>
      <output aria-label="prompt route">
        {trail?.run?.retrieval_plan?.route_intent ?? "none"}
      </output>
      <output aria-label="ledger snapshot">
        {tool
          ? [
              tool.id,
              tool.tool_name,
              tool.scope ?? "missing",
              tool.candidate_ledgers.length,
              tool.rerank_ledgers[0]?.strategy ?? "none",
              tool.rerank_ledgers[0]?.metadata.rerank_mode ?? "none",
              tool.source_policy?.reason ?? "missing",
            ].join(":")
          : ""}
      </output>
      <output aria-label="ledger metadata">
        {tool
          ? [
              tool.rerank_ledgers[0]?.metadata.provider ?? "none",
              tool.rerank_ledgers[0]?.metadata.model ?? "none",
              tool.rerank_ledgers[0]?.metadata.key_mode_used ?? "none",
              tool.rerank_ledgers[0]?.metadata.provider_request_id ?? "none",
              tool.rerank_ledgers[0]?.metadata.cost_status ?? "none",
              tool.rerank_ledgers[0]?.metadata.candidate_rerank_trace?.[0]
                ?.provider_reason ?? "none",
            ].join(":")
          : ""}
      </output>
    </div>
  );
}

function NoTrustTrailHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    { ...assistantMessage(), trust_trail: null },
  ]);
  const { handlePromptAssembly } = useChatMessageUpdates({ setMessages });
  return (
    <div>
      <button
        type="button"
        onClick={() => handlePromptAssembly(ASSISTANT_ID, PROMPT_ASSEMBLY)}
      >
        Fold prompt without trail
      </button>
      <output aria-label="missing trail">
        {messages[0].trust_trail ? "created" : "none"}
      </output>
    </div>
  );
}

function DoneHarness() {
  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      ...assistantMessage(),
      status: "pending",
      error_code: null,
      trust_trail: {
        ...assistantMessage().trust_trail!,
        status: "running",
        run: {
          run_id: "run-1",
          model_id: "model-1",
          provider: "openai",
          model_name: "gpt-test",
          reasoning_mode: "medium",
          key_mode: "auto",
          status: "running",
          usage: null,
          error_code: null,
          final_chars: null,
          started_at: null,
          completed_at: null,
          retrieval_plan: null,
        },
      },
    },
  ]);
  const { handleDone } = useChatMessageUpdates({ setMessages });
  const data: SSEDoneEvent["data"] = {
    status: "complete",
    usage: { input_tokens: 3, output_tokens: 5 },
    error_code: null,
    final_chars: 42,
    last_provider_event_seq: 9,
  };
  const run = messages[0].trust_trail?.run;
  return (
    <div>
      <button type="button" onClick={() => handleDone(ASSISTANT_ID, data)}>
        Fold done
      </button>
      <output aria-label="done state">
        {[
          messages[0].status,
          messages[0].trust_trail?.status,
          run?.status,
          run?.final_chars ?? "none",
          run?.usage?.output_tokens ?? "none",
        ].join(":")}
      </output>
    </div>
  );
}

describe("useChatMessageUpdates citation_index fold", () => {
  it("folds a citation_index event into chips with backend-built citations", async () => {
    const user = userEvent.setup();
    render(<CitationIndexHarness />);

    // No chips before the citation_index event lands.
    expect(
      screen.queryByRole("link", { name: "Open citation 1" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Citation 2")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fold two" }));

    // The note citation stays actionable because its backend-built locator is
    // stored directly instead of reconstructed with locator=null.
    const chip1 = await screen.findByRole("link", { name: "Open citation 1" });
    expect(chip1).toHaveTextContent("1");
    expect(chip1).toHaveAttribute("href", `/notes/${NOTE_BLOCK_ID}`);

    const chip2 = screen.getByRole("link", { name: "Open citation 2" });
    expect(chip2).toHaveTextContent("2");
    expect(chip2).toHaveAttribute("href", `/media/${MEDIA_ID}#fragment-1`);

    // The folded read-model carries the backend-built media_id and locator for
    // each citation, in order.
    expect(foldedRows()).toEqual([
      `1:supports:note_block:${NOTE_BLOCK_ID}:none:note_block_offsets`,
      `2:context:media:${MEDIA_ID}:${MEDIA_ID}:web_text_offsets`,
    ]);
  });

  it("replaces a prior citation_index with the latest one (replace, not merge)", async () => {
    const user = userEvent.setup();
    render(<CitationIndexHarness />);

    await user.click(screen.getByRole("button", { name: "Fold two" }));
    expect(
      await screen.findByRole("link", { name: "Open citation 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open citation 2" }),
    ).toBeInTheDocument();

    // A later event with a single edge supersedes the prior read-model wholesale:
    // chip [2] disappears and only [1] remains.
    await user.click(screen.getByRole("button", { name: "Fold one" }));

    expect(
      screen.queryByRole("link", { name: "Open citation 2" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open citation 1" }),
    ).toBeInTheDocument();
    expect(foldedRows()).toEqual([
      `1:supports:note_block:${NOTE_BLOCK_ID}:none:note_block_offsets`,
    ]);
  });

  it("links citation edges to retrievals only through backend retrieval_id", async () => {
    const user = userEvent.setup();
    render(<CitationRetrievalLinkHarness />);

    await user.click(screen.getByRole("button", { name: "Fold retrieval links" }));

    expect(screen.getByLabelText("retrieval citation state")).toHaveTextContent(
      "retrieval-a:none:none|retrieval-b:edge-linked:2",
    );
  });
});

describe("useChatMessageUpdates tool-call fold", () => {
  it("does not create durable tool rows from provider-only tool deltas", async () => {
    const user = userEvent.setup();
    render(<ToolDeltaHarness />);

    await user.click(screen.getByRole("button", { name: "Fold tool delta" }));

    expect(screen.getByLabelText("tool preview")).toHaveTextContent("");
  });

  it("opens a durable running tool row from a tool_call_start", async () => {
    const user = userEvent.setup();
    render(<ToolCallStartHarness />);

    await user.click(screen.getByRole("button", { name: "Open tool call" }));

    expect(screen.getByLabelText("started tool")).toHaveTextContent(
      "app_search:1:running",
    );
  });

  it("folds tool_call_delta preview into an existing durable tool row", async () => {
    const user = userEvent.setup();
    render(<PersistedToolDeltaHarness />);

    await user.click(
      screen.getByRole("button", { name: "Fold persisted tool delta" }),
    );

    expect(screen.getByLabelText("persisted tool preview")).toHaveTextContent(
      'tool-1:app_search:1:running:{"query":"nexus"}:single_domain_private_app',
    );
  });

  it("folds tool_result more-candidates state into the live trust trail", async () => {
    const user = userEvent.setup();
    render(<ToolResultHarness />);

    await user.click(screen.getByRole("button", { name: "Fold tool result" }));

    expect(screen.getByLabelText("tool result")).toHaveTextContent(
      "app_search:8:6:1:more:single_domain_private_app:tool_output",
    );
    expect(screen.getByLabelText("tool result citation state")).toHaveTextContent(
      "77777777-7777-4777-8777-777777777777:none:none",
    );

    await user.click(screen.getByRole("button", { name: "Fold tool citation" }));

    expect(screen.getByLabelText("tool result citation state")).toHaveTextContent(
      "77777777-7777-4777-8777-777777777777:edge-live:1",
    );
  });

  it("folds prompt and ledger snapshots into the live trust trail", async () => {
    const user = userEvent.setup();
    render(<PromptAndLedgerHarness />);

    await user.click(screen.getByRole("button", { name: "Fold prompt" }));
    await user.click(screen.getByRole("button", { name: "Fold plan" }));
    await user.click(screen.getByRole("button", { name: "Fold ledgers" }));

    expect(screen.getByLabelText("prompt route")).toHaveTextContent(
      "private_deep_retrieval",
    );
    expect(screen.getByLabelText("ledger snapshot")).toHaveTextContent(
      `tool-1:app_search:media:${MEDIA_ID}:1:app_search_provider_rerank:provider_rerank:single_domain_private_app`,
    );
    expect(screen.getByLabelText("ledger metadata")).toHaveTextContent(
      "anthropic:claude-haiku-4-5-20251001:platform:req_provider_rerank_1:known:direct_answer",
    );
  });

  it("does not synthesize a trust trail when backend readback omitted one", async () => {
    const user = userEvent.setup();
    render(<NoTrustTrailHarness />);

    await user.click(
      screen.getByRole("button", { name: "Fold prompt without trail" }),
    );

    expect(screen.getByLabelText("missing trail")).toHaveTextContent("none");
  });

  it("folds done usage and final chars into the live trust trail run", async () => {
    const user = userEvent.setup();
    render(<DoneHarness />);

    await user.click(screen.getByRole("button", { name: "Fold done" }));

    expect(screen.getByLabelText("done state")).toHaveTextContent(
      "complete:complete:complete:42:5",
    );
  });
});
