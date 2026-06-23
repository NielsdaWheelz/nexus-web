import { describe, expect, it } from "vitest";
import { toChatSSEEvent } from "./events";

describe("toChatSSEEvent", () => {
  const ASSISTANT_ID = "44444444-4444-4444-8444-444444444444";
  const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
  const TOOL_ID = "55555555-5555-4555-8555-555555555555";
  const CANDIDATE_LEDGER_ID = "66666666-6666-4666-8666-666666666666";
  const RERANK_LEDGER_ID = "77777777-7777-4777-8777-777777777777";

  const citation = {
    ordinal: 1,
    role: "supports",
    target_ref: {
      type: "note_block",
      id: "22222222-2222-4222-8222-222222222222",
    },
    activation: {
      resourceRef: "note_block:22222222-2222-4222-8222-222222222222",
      kind: "route",
      href: "/notes/22222222-2222-4222-8222-222222222222",
      unresolvedReason: null,
    },
    media_id: null,
    locator: {
      type: "note_block_offsets",
      block_id: "22222222-2222-4222-8222-222222222222",
      start_offset: 0,
      end_offset: 12,
    },
    deep_link: "/notes/22222222-2222-4222-8222-222222222222",
    snapshot: {
      title: "Source title",
      excerpt: "selected words",
      section_label: "Section",
      result_type: "note_block",
    },
  };

  const item = {
    citation_edge_id: "11111111-1111-4111-8111-111111111111",
    citation,
  };

  const messageResult = {
    type: "message",
    id: "message-1",
    result_type: "message",
    source_id: "message-1",
    conversation_id: "conversation-1",
    seq: 1,
    title: "Conversation message #1",
    source_label: null,
    snippet: "water on the Moon",
    deep_link: "/conversations/conversation-1",
    citation_target: null,
    context_ref: { type: "message", id: "message-1", evidence_span_ids: [] },
    locator: {
      type: "message_offsets",
      conversation_id: "conversation-1",
      message_id: "message-1",
      start_offset: 0,
      end_offset: 18,
      message_seq: 1,
    },
    media_id: null,
    media_kind: null,
    score: 1,
    selected: true,
  };

  it("parses backend-shaped meta events", () => {
    const data = {
      run_id: "11111111-1111-4111-8111-111111111111",
      conversation_id: "22222222-2222-4222-8222-222222222222",
      user_message_id: "33333333-3333-4333-8333-333333333333",
      assistant_message_id: "44444444-4444-4444-8444-444444444444",
      model_id: "55555555-5555-4555-8555-555555555555",
      provider: "openai",
      chat_subject: {
        requested_resource_ref:
          "highlight:66666666-6666-4666-8666-666666666666",
        resource_ref: "note_block:77777777-7777-4777-8777-777777777777",
        context_edge_id: "88888888-8888-4888-8888-888888888888",
        companions: ["media:99999999-9999-4999-8999-999999999999"],
      },
    };

    expect(toChatSSEEvent("meta", data)).toEqual({
      seq: 0,
      type: "meta",
      data,
    });
    expect(toChatSSEEvent("meta", { ...data, chat_subject: null })).toEqual({
      seq: 0,
      type: "meta",
      data: { ...data, chat_subject: null },
    });
  });

  it("rejects the old five-key meta shape", () => {
    expect(() =>
      toChatSSEEvent("meta", {
        conversation_id: "22222222-2222-4222-8222-222222222222",
        user_message_id: "33333333-3333-4333-8333-333333333333",
        assistant_message_id: "44444444-4444-4444-8444-444444444444",
        model_id: "55555555-5555-4555-8555-555555555555",
        provider: "openai",
      }),
    ).toThrow("Invalid SSE payload for meta");
  });

  it("parses citation index events as backend-built citations", () => {
    expect(
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        citations: [item],
      }),
    ).toEqual({
      seq: 0,
      type: "citation_index",
      data: { assistant_message_id: ASSISTANT_ID, citations: [item] },
    });
  });

  it("rejects an old entries payload", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        entries: [item],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects a citation with an ordinal below 1", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        citations: [{ ...item, citation: { ...citation, ordinal: 0 } }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects citation index items with non-UUID edge IDs", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        citations: [{ ...item, citation_edge_id: "edge-1" }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects a citation with an unknown target type", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        citations: [
          {
            ...item,
            citation: {
              ...citation,
              target_ref: { type: "bogus", id: "x" },
            },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("rejects citation index payloads with legacy identity fields", () => {
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        source_version: "old-source:v1",
        citations: [],
      }),
    ).toThrow("Invalid SSE payload for citation_index");

    // An edge item carrying a legacy identity key is rejected (extra="forbid").
    expect(() =>
      toChatSSEEvent("citation_index", {
        assistant_message_id: ASSISTANT_ID,
        citations: [{ ...item, transcript_version_id: "transcript-version-1" }],
      }),
    ).toThrow("Invalid SSE payload for citation_index");
  });

  it("parses a context_ref_added event as a ContextRefOut", () => {
    const data = {
      id: "33333333-3333-4333-8333-333333333333",
      conversation_id: CONVERSATION_ID,
      resource_ref: "media:44444444-4444-4444-8444-444444444444",
      activation: {
        resourceRef: "media:44444444-4444-4444-8444-444444444444",
        kind: "route",
        href: "/media/44444444-4444-4444-8444-444444444444",
        unresolvedReason: null,
      },
      label: "Annual report",
      summary: "Page 4",
      missing: false,
      created_at: "2026-01-01T00:00:00Z",
      citation_edge_id: "55555555-5555-4555-8555-555555555555",
    };
    expect(toChatSSEEvent("context_ref_added", data)).toEqual({
      seq: 0,
      type: "context_ref_added",
      data,
    });
  });

  it("rejects context_ref_added payloads without a citation edge key", () => {
    expect(() =>
      toChatSSEEvent("context_ref_added", {
        id: "33333333-3333-4333-8333-333333333333",
        conversation_id: CONVERSATION_ID,
        resource_ref: "media:44444444-4444-4444-8444-444444444444",
        activation: {
          resourceRef: "media:44444444-4444-4444-8444-444444444444",
          kind: "route",
          href: "/media/44444444-4444-4444-8444-444444444444",
          unresolvedReason: null,
        },
        label: "Annual report",
        summary: "Page 4",
        missing: false,
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("Invalid SSE payload for context_ref_added");
  });

  it("accepts generic non-empty tool names", () => {
    expect(
      toChatSSEEvent("tool_call_start", {
        tool_call_id: TOOL_ID,
        assistant_message_id: ASSISTANT_ID,
        tool_name: "read_resource",
        tool_call_index: 2,
        provider_tool_call_id: "provider-tool-1",
        provider_event_seq_start: 4,
        provider_event_seq_end: 4,
      }),
    ).toEqual({
      seq: 0,
      type: "tool_call_start",
      data: {
        tool_call_id: TOOL_ID,
        assistant_message_id: ASSISTANT_ID,
        tool_name: "read_resource",
        tool_call_index: 2,
        provider_tool_call_id: "provider-tool-1",
        provider_event_seq_start: 4,
        provider_event_seq_end: 4,
      },
    });
  });

  it("accepts parsed tool-call delta previews", () => {
    expect(
      toChatSSEEvent("tool_call_delta", {
        tool_call_id: TOOL_ID,
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        provider_tool_call_id: "provider-tool-1",
        input_delta: '{"query":"ne',
        input_preview: '{"query":"nexus"}',
        provider_event_seq_start: 5,
        provider_event_seq_end: 5,
      }),
    ).toEqual({
      seq: 0,
      type: "tool_call_delta",
      data: {
        tool_call_id: TOOL_ID,
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        provider_tool_call_id: "provider-tool-1",
        input_delta: '{"query":"ne',
        input_preview: '{"query":"nexus"}',
        provider_event_seq_start: 5,
        provider_event_seq_end: 5,
      },
    });
  });

  it("rejects backend-invalid provider tool-call strings", () => {
    expect(() =>
      toChatSSEEvent("tool_call_start", {
        tool_call_id: TOOL_ID,
        assistant_message_id: ASSISTANT_ID,
        tool_name: "read_resource",
        tool_call_index: 2,
        provider_tool_call_id: "",
        provider_event_seq_start: 4,
        provider_event_seq_end: 4,
      }),
    ).toThrow("Invalid SSE payload for tool_call_start");
  });

  it("rejects overlong tool-call input previews", () => {
    expect(() =>
      toChatSSEEvent("tool_call_delta", {
        tool_call_id: TOOL_ID,
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        provider_tool_call_id: "provider-tool-1",
        input_delta: '{"query":"ne',
        input_preview: "x".repeat(513),
        provider_event_seq_start: 5,
        provider_event_seq_end: 5,
      }),
    ).toThrow("Invalid SSE payload for tool_call_delta");
  });

  it("accepts backend tool_result payloads with scope and types", () => {
    expect(
      toChatSSEEvent(
        "tool_result",
        {
          tool_call_id: TOOL_ID,
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
          result_count: 1,
          selected_count: 1,
          more_candidates_available: false,
          latency_ms: 12,
          provider_request_ids: [],
          retrieval_ids: ["66666666-6666-4666-8666-666666666666"],
          filters: {},
          results: [messageResult],
        },
        "7",
      ),
    ).toEqual({
      seq: 7,
      type: "tool_result",
      data: {
        tool_call_id: TOOL_ID,
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
        result_count: 1,
        selected_count: 1,
        more_candidates_available: false,
        latency_ms: 12,
        provider_request_ids: [],
        retrieval_ids: ["66666666-6666-4666-8666-666666666666"],
        filters: {},
        results: [messageResult],
      },
    });
  });

  it("rejects tool_result source-policy shape drift", () => {
    const base = {
      assistant_message_id: ASSISTANT_ID,
      tool_name: "app_search",
      tool_call_index: 0,
      status: "complete",
      scope: "all",
      types: [],
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
      result_count: 0,
      selected_count: 0,
      latency_ms: 1,
      retrieval_ids: [],
      filters: {},
      results: [],
    };

    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        source_policy: undefined,
      }),
    ).toThrow("Invalid SSE payload for tool_result");
    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        source_domain: "public_web",
      }),
    ).toThrow("Invalid SSE payload for tool_result");
    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        source_policy: { ...base.source_policy, reason: " " },
      }),
    ).toThrow("Invalid SSE payload for tool_result");
    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        result_count: 1,
        selected_count: 1,
        retrieval_ids: undefined,
        results: [messageResult],
      }),
    ).toThrow("Invalid SSE payload for tool_result");
    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        retrieval_ids: ["66666666-6666-4666-8666-666666666666"],
      }),
    ).toThrow("Invalid SSE payload for tool_result");
    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        result_count: 1,
        selected_count: 1,
        retrieval_ids: ["not-a-uuid"],
        results: [messageResult],
      }),
    ).toThrow("Invalid SSE payload for tool_result");
    for (const key of ["semantic", "content_kinds", "contributor_handles"]) {
      expect(() =>
        toChatSSEEvent("tool_result", {
          ...base,
          filters: { [key]: [] },
        }),
      ).toThrow("Invalid SSE payload for tool_result");
    }
    expect(() =>
      toChatSSEEvent("tool_result", {
        ...base,
        source_domain: "provider_control",
        source_policy: {
          ...base.source_policy,
          source_domain: "provider_control",
          reason: "provider_control_only",
          domains_seen: [],
          requested_domains: [],
        },
      }),
    ).not.toThrow();
  });

  it("parses retrieval plan, prompt assembly, and tool ledger snapshot payloads", () => {
    const retrievalPlan = {
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
      search_scope_uris: ["media:11111111-1111-4111-8111-111111111111"],
      budget_policy: "tool_output_budget_from_prompt_assembly",
    };
    expect(
      toChatSSEEvent("retrieval_plan", {
        assistant_message_id: ASSISTANT_ID,
        retrieval_plan: retrievalPlan,
      }),
    ).toEqual({
      seq: 0,
      type: "retrieval_plan",
      data: { assistant_message_id: ASSISTANT_ID, retrieval_plan: retrievalPlan },
    });
    expect(() =>
      toChatSSEEvent("retrieval_plan", {
        assistant_message_id: ASSISTANT_ID,
        retrieval_plan: {
          ...retrievalPlan,
          candidate_tool_sequence: ["web_search"],
        },
      }),
    ).toThrow("Invalid SSE payload for retrieval_plan");

    const prompt = {
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
    };
    expect(
      toChatSSEEvent("prompt_assembly", {
        assistant_message_id: ASSISTANT_ID,
        prompt,
      }),
    ).toEqual({
      seq: 0,
      type: "prompt_assembly",
      data: { assistant_message_id: ASSISTANT_ID, prompt },
    });
    expect(() =>
      toChatSSEEvent("prompt_assembly", {
        assistant_message_id: ASSISTANT_ID,
        prompt: {
          ...prompt,
          retrieval_plan: { version: "chat_retrieval_plan.v1" },
        },
      }),
    ).toThrow("Invalid SSE payload for prompt_assembly");

    const candidateResult = {
      type: "media",
      id: "media-1",
      result_type: "media",
      source_id: "media-1",
      title: "Selected source",
      source_label: null,
      snippet: "Selected evidence",
      deep_link: "/media/media-1",
      citation_target: "media:media-1",
      context_ref: { type: "media", id: "media-1", evidence_span_ids: [] },
      locator: null,
      media_id: "media-1",
      media_kind: "book",
      score: 1,
      selected: true,
    };
    const candidate = {
      id: CANDIDATE_LEDGER_ID,
      tool_call_id: TOOL_ID,
      retrieval_id: null,
      ordinal: 0,
      result_type: "media",
      source_id: "media-1",
      score: 1,
      selected: true,
      included_in_prompt: true,
      ledger_included_in_prompt: true,
      linked_retrieval_included_in_prompt: null,
      included_in_prompt_source: "candidate_ledger",
      included_in_prompt_reconciled: true,
      selection_status: "selected",
      selection_reason: "selected_within_budget",
      result_ref: candidateResult,
      locator: null,
      created_at: "2026-06-09T00:00:00Z",
    };
    const rerank = {
      id: RERANK_LEDGER_ID,
      tool_call_id: TOOL_ID,
      strategy: "app_search_provider_rerank",
      input_count: 8,
      selected_count: 6,
      budget_chars: 16000,
      selected_chars: 1200,
      status: "complete",
      metadata: { rerank_mode: "provider_rerank" },
      created_at: "2026-06-09T00:00:00Z",
    };
    const interruptedRerank = {
      ...rerank,
      id: "88888888-8888-4888-8888-888888888888",
      status: "error",
      metadata: { error_code: "interrupted_before_tool_result" },
    };
    expect(
      toChatSSEEvent("tool_ledger_snapshot", {
        assistant_message_id: ASSISTANT_ID,
        tool_call_id: TOOL_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        scope: "media:media-1",
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
        candidate_ledgers: [candidate],
        rerank_ledgers: [rerank],
      }),
    ).toEqual({
      seq: 0,
      type: "tool_ledger_snapshot",
      data: {
        assistant_message_id: ASSISTANT_ID,
        tool_call_id: TOOL_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        scope: "media:media-1",
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
        candidate_ledgers: [candidate],
        rerank_ledgers: [rerank],
      },
    });
    expect(
      toChatSSEEvent("tool_ledger_snapshot", {
        assistant_message_id: ASSISTANT_ID,
        tool_call_id: TOOL_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        scope: "media:media-1",
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
        candidate_ledgers: [candidate],
        rerank_ledgers: [interruptedRerank],
      }),
    ).toEqual({
      seq: 0,
      type: "tool_ledger_snapshot",
      data: {
        assistant_message_id: ASSISTANT_ID,
        tool_call_id: TOOL_ID,
        tool_name: "app_search",
        tool_call_index: 1,
        scope: "media:media-1",
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
        candidate_ledgers: [candidate],
        rerank_ledgers: [interruptedRerank],
      },
    });
  });

  it("rejects tool ledger snapshots without source policy or valid rerank metadata", () => {
    const candidateResult = {
      type: "media",
      id: "media-1",
      result_type: "media",
      source_id: "media-1",
      title: "Selected source",
      source_label: null,
      snippet: "Selected evidence",
      deep_link: "/media/media-1",
      citation_target: "media:media-1",
      context_ref: { type: "media", id: "media-1", evidence_span_ids: [] },
      locator: null,
      media_id: "media-1",
      media_kind: "book",
      score: 1,
      selected: true,
    };
    const candidate = {
      id: CANDIDATE_LEDGER_ID,
      tool_call_id: TOOL_ID,
      retrieval_id: null,
      ordinal: 0,
      result_type: "media",
      source_id: "media-1",
      score: 1,
      selected: true,
      included_in_prompt: true,
      ledger_included_in_prompt: true,
      linked_retrieval_included_in_prompt: null,
      included_in_prompt_source: "candidate_ledger",
      included_in_prompt_reconciled: true,
      selection_status: "selected",
      selection_reason: "selected_within_budget",
      result_ref: candidateResult,
      locator: null,
      created_at: "2026-06-09T00:00:00Z",
    };
    const sourcePolicy = {
      version: "source_boundary_policy.v1",
      decision: "allowed",
      source_domain: "private_app",
      mixing_allowed: false,
      reason: "single_domain_private_app",
      domains_seen: [],
      requested_domains: ["private_app"],
    };
    const rerankTrace = {
      from: 0,
      to: 0,
      result_type: "media",
      source_id: "media-1",
      source: "media:media-1",
      section: "media:media-1:section-1",
      score: 1,
      selection_score: 2.35,
      lexical: 1,
      phrase: true,
      type_bonus: -0.05,
      citation_quality: 0.25,
      source_penalty: 0,
      section_penalty: 0.12,
      reason: "moved_up_exact_passage",
      provider_score: 0.98,
      selected: true,
      included_in_prompt: true,
      selection_status: "selected",
      selection_reason: "selected_within_budget",
    };
    const base = {
      assistant_message_id: ASSISTANT_ID,
      tool_call_id: TOOL_ID,
      tool_name: "app_search",
      tool_call_index: 1,
      scope: "media:media-1",
      requested_types: ["media"],
      source_domain: "private_app",
      source_policy: sourcePolicy,
      candidate_ledgers: [candidate],
      rerank_ledgers: [
        {
          id: RERANK_LEDGER_ID,
          tool_call_id: TOOL_ID,
          strategy: "app_search_provider_rerank",
          input_count: 8,
          selected_count: 6,
          budget_chars: 16000,
          selected_chars: 1200,
          status: "complete",
          metadata: { candidate_rerank_trace: [rerankTrace] },
          created_at: "2026-06-09T00:00:00Z",
        },
      ],
    };
    const publicPolicy = {
      version: "source_boundary_policy.v1",
      decision: "allowed",
      source_domain: "public_web",
      mixing_allowed: false,
      reason: "single_domain_public_web",
      domains_seen: [],
      requested_domains: ["public_web"],
    };
    const webSnapshotId = "44444444-4444-4444-8444-444444444444";
    const webCandidate = {
      ...candidate,
      result_type: "web_result",
      source_id: webSnapshotId,
      result_ref: {
        type: "web_result",
        id: webSnapshotId,
        result_ref: webSnapshotId,
        result_type: "web_result",
        source_id: webSnapshotId,
        title: "Web result",
        url: "https://example.com/1",
        display_url: "example.com",
        deep_link: "https://example.com/1",
        citation_target: `external_snapshot:${webSnapshotId}`,
        snippet: "Snippet",
        context_ref: { type: "web_result", id: webSnapshotId },
        media_id: null,
        media_kind: null,
        score: 1,
        selected: true,
        locator: {
          type: "external_url",
          url: "https://example.com/1",
          title: "Web result",
          display_url: "example.com",
        },
      },
      locator: {
        type: "external_url",
        url: "https://example.com/1",
        title: "Web result",
        display_url: "example.com",
      },
    };

    const withoutPolicy = { ...base };
    delete (withoutPolicy as Record<string, unknown>).source_policy;
    expect(() => toChatSSEEvent("tool_ledger_snapshot", withoutPolicy)).toThrow(
      "Invalid SSE payload for tool_ledger_snapshot",
    );
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        source_policy: { ...sourcePolicy, reason: "" },
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        source_policy: { ...sourcePolicy, domains_seen: ["provider_control"] },
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        source_policy: {
          ...sourcePolicy,
          requested_domains: ["provider_control"],
        },
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        source_policy: publicPolicy,
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        candidate_ledgers: [{ ...candidate, score: Number.NaN }],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        candidate_ledgers: [{ ...candidate, source_id: "" }],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        candidate_ledgers: [{ ...candidate, selection_status: "" }],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        candidate_ledgers: [{ ...candidate, result_type: "page" }],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        source_domain: "public_web",
        source_policy: publicPolicy,
        candidate_ledgers: [webCandidate],
        rerank_ledgers: [],
      }),
    ).not.toThrow();
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        source_domain: "public_web",
        source_policy: publicPolicy,
        candidate_ledgers: [
          {
            ...webCandidate,
            result_ref: {
              ...webCandidate.result_ref,
              locator: {
                display_url: "example.com",
                title: "Web result",
                url: "https://example.com/1",
                type: "external_url",
              },
            },
          },
        ],
        rerank_ledgers: [],
      }),
    ).not.toThrow();
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        candidate_ledgers: [{ ...candidate, source_id: "media-2" }],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        candidate_ledgers: [
          {
            ...candidate,
            locator: { type: "external_url", url: "https://example.com" },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: { unknown_metadata_key: true },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: {
              retrieval_guidance: {
                version: "retrieval_guidance_usage.v1",
                status: "unused",
                ready_count: 1,
              },
            },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: {
              candidate_rerank_trace: [
                { ...rerankTrace, provider_score: "0.98" },
              ],
            },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: {
              candidate_rerank_trace: [
                { ...rerankTrace, provider_score: 1.1 },
              ],
            },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: {
              candidate_rerank_trace: [
                { ...rerankTrace, selection_score: Number.POSITIVE_INFINITY },
              ],
            },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    // selection_score is a signed composite (base score plus a possibly-negative
    // type bonus, minus diversity penalties) and may fall below zero; it parses.
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: {
              candidate_rerank_trace: [
                { ...rerankTrace, selection_score: -0.05 },
              ],
            },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: {
              candidate_rerank_trace: [
                {
                  from: 0,
                  to: 0,
                  result_type: "media",
                  source_id: "media-1",
                  provider_score: 0.98,
                },
              ],
            },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
    expect(() =>
      toChatSSEEvent("tool_ledger_snapshot", {
        ...base,
        rerank_ledgers: [
          {
            ...base.rerank_ledgers[0],
            metadata: { error_code: 404 },
          },
        ],
      }),
    ).toThrow("Invalid SSE payload for tool_ledger_snapshot");
  });

  it("rejects negative tool and retrieval counters", () => {
    expect(() =>
      toChatSSEEvent("tool_call_start", {
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: -1,
        provider_event_seq_start: 1,
        provider_event_seq_end: 1,
      }),
    ).toThrow("Invalid SSE payload for tool_call_start");

    expect(() =>
      toChatSSEEvent("tool_result", {
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        scope: "all",
        types: [],
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
        result_count: -1,
        selected_count: 0,
        latency_ms: 1,
        retrieval_ids: [],
        filters: {},
        results: [],
      }),
    ).toThrow("Invalid SSE payload for tool_result");

    expect(() =>
      toChatSSEEvent("tool_result", {
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: 0,
        status: "complete",
        scope: "all",
        types: [],
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
        result_count: 1,
        selected_count: 0,
        more_candidates_available: "true",
        latency_ms: 1,
        retrieval_ids: [],
        filters: {},
        results: [],
      }),
    ).toThrow("Invalid SSE payload for tool_result");
  });

  it("rejects extra keys on tool payloads", () => {
    expect(() =>
      toChatSSEEvent("tool_call_start", {
        assistant_message_id: ASSISTANT_ID,
        tool_name: "app_search",
        tool_call_index: 0,
        provider_event_seq_start: 1,
        provider_event_seq_end: 1,
        freshness_days: 1,
      }),
    ).toThrow("Invalid SSE payload for tool_call_start");
  });

  it.each(["delta", "tool_call", "retrieval_result"])(
    "rejects old %s event names",
    (eventType) => {
      expect(() => toChatSSEEvent(eventType, {})).toThrow(
        `Unknown SSE event type: ${eventType}`,
      );
    },
  );
});
