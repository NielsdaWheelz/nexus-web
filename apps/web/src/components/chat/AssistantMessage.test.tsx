import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { ConversationMessage } from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";

function assistantMessage(text = "Alpha beta gamma"): ConversationMessage {
  return {
    id: "assistant-1",
    seq: 2,
    role: "assistant",
    status: "complete",
    error_code: null,
    can_retry_response: false,
    created_at: "2026-06-03T00:00:00Z",
    updated_at: "2026-06-03T00:00:00Z",
    message_document: {
      type: "message_document",
      blocks: [{ type: "text", format: "plain", text }],
    },
    trust_trail: {
      schema_version: "assistant_trust_trail.v1",
      assistant_message_id: "assistant-1",
      conversation_id: "conversation-1",
      chat_run_id: null,
      status: "complete",
      run: null,
      prompt: null,
      tool_calls: [],
      citations: [],
      context_refs_added: [],
      integrity_notices: [],
      created_at: "2026-06-03T00:00:00Z",
      updated_at: "2026-06-03T00:00:00Z",
    },
  };
}

function selectText(root: HTMLElement, exact: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node && !node.textContent?.includes(exact)) {
    node = walker.nextNode() as Text | null;
  }
  if (!node?.textContent) {
    throw new Error(`Missing text: ${exact}`);
  }

  const start = node.textContent.indexOf(exact);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + exact.length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe("AssistantMessage", () => {
  it("captures assistant selection and branches from it", async () => {
    const user = userEvent.setup();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 80, 60, 20),
    );
    const onReplyToAssistant = vi.fn();

    render(
      <AssistantMessage
        message={assistantMessage()}
        forkOptions={[]}
        onReplyToAssistant={onReplyToAssistant}
        errorLabel="The response failed."
        timestampLabel="Jun 3"
      />,
    );

    const answer = screen.getByText("Alpha beta gamma");
    selectText(answer, "beta");
    fireEvent.mouseUp(answer);

    await user.click(
      await screen.findByRole("button", { name: "Fork from selection" }),
    );

    expect(onReplyToAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: "assistant-1",
        parentMessageSeq: 2,
        parentMessagePreview: "Alpha beta gamma",
        anchor: expect.objectContaining({
          kind: "assistant_selection",
          message_id: "assistant-1",
          exact: "beta",
          offset_status: "mapped",
          start_offset: 6,
          end_offset: 10,
          client_selection_id: expect.any(String),
        }),
      }),
    );
  });

  it("captures assistant selection from the keyboard path", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 80, 60, 20),
    );
    render(
      <AssistantMessage
        message={assistantMessage()}
        forkOptions={[]}
        onReplyToAssistant={vi.fn()}
        errorLabel="The response failed."
        timestampLabel="Jun 3"
      />,
    );

    const answer = screen.getByText("Alpha beta gamma");
    selectText(answer, "beta");
    fireEvent.keyUp(answer);

    expect(
      await screen.findByRole("button", { name: "Fork from selection" }),
    ).toBeInTheDocument();
  });

  it("renders trust-trail tool, retrieval, ledger, citation, context-ref, and notice details", () => {
    const message = assistantMessage("Answer [1].");
    const citation = {
      ordinal: 1,
      role: "context" as const,
      target_ref: {
        type: "content_chunk" as const,
        id: "33333333-3333-4333-8333-333333333333",
      },
      activation: {
        resourceRef: "content_chunk:33333333-3333-4333-8333-333333333333",
        kind: "route" as const,
        href: "/reader/source",
        unresolvedReason: null,
      },
      media_id: "22222222-2222-4222-8222-222222222222",
      locator: {
        type: "web_text_offsets" as const,
        media_id: "22222222-2222-4222-8222-222222222222",
        fragment_id: "fragment-1",
        start_offset: 0,
        end_offset: 15,
      },
      deep_link: "/reader/source",
      snapshot: {
        title: "Source title",
        excerpt: "Quoted evidence",
        section_label: "Section",
        result_type: "content_chunk",
      },
    };
    message.trust_trail = {
      ...message.trust_trail!,
      run: {
        run_id: "run-1",
        model_id: "model-1",
        provider: "openai",
        model_name: "gpt-test",
        reasoning_mode: "medium",
        key_mode: "auto",
        status: "complete",
        usage: null,
        error_code: null,
        final_chars: 11,
        started_at: null,
        completed_at: null,
      },
      prompt: {
        id: "prompt-1",
        cacheable_input_tokens_estimate: 20,
        prompt_block_manifest: {},
        max_context_tokens: 1000,
        reserved_output_tokens: 100,
        reserved_reasoning_tokens: 50,
        input_budget_tokens: 850,
        estimated_input_tokens: 200,
        included_message_ids: ["user-1"],
        included_retrieval_ids: ["retrieval-1"],
        included_context_refs: [{ uri: "media:1" }],
        dropped_items: [],
        budget_breakdown: {},
        created_at: "2026-06-03T00:00:00Z",
      },
      tool_calls: [
        {
          id: "tool-1",
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 1,
          status: "complete",
          scope: "all",
          requested_types: ["content_chunk"],
          result_refs: [],
          selected_context_refs: [],
          provider_request_ids: [],
          latency_ms: 12,
          result_count: 1,
          selected_count: 1,
          more_candidates_available: true,
          error_code: null,
          retrievals: [
            {
              id: "retrieval-1",
              tool_call_id: "tool-1",
              ordinal: 0,
              result_type: "media",
              source_id: "source-1",
              media_id: "media-1",
              evidence_span_id: null,
              context_ref: { type: "media", id: "media-1" },
              result_ref: {
                type: "media",
                id: "media-1",
                result_type: "media",
                source_id: "source-1",
                title: "Source title",
                source_label: null,
                snippet: "Quoted evidence",
                deep_link: "/reader/source",
                context_ref: { type: "media", id: "media-1" },
                locator: null,
                media_id: "media-1",
                media_kind: "book",
                score: 0.91,
                selected: true,
              },
              deep_link: "/reader/source",
              score: 0.91,
              selected: true,
              source_title: "Source title",
              section_label: "Section",
              exact_snippet: "Quoted evidence",
              locator: null,
              retrieval_status: "selected",
              included_in_prompt: true,
              cited_edge_id: "edge-1",
              citation_number: 1,
              citation_role: "context",
              included_in_prompt_source: "tool_output",
              created_at: "2026-06-03T00:00:00Z",
            },
          ],
          candidate_ledgers: [
            {
              id: "candidate-1",
              tool_call_id: "tool-1",
              retrieval_id: "retrieval-1",
              ordinal: 0,
              result_type: "media",
              source_id: "source-1",
              score: 0.91,
              selected: true,
              included_in_prompt: true,
              ledger_included_in_prompt: true,
              linked_retrieval_included_in_prompt: true,
              included_in_prompt_source: "tool_output",
              included_in_prompt_reconciled: true,
              selection_status: "selected",
              selection_reason: "selected_within_budget",
              result_ref: {
                type: "media",
                id: "media-1",
                result_type: "media",
                source_id: "source-1",
                title: "Source title",
                source_label: null,
                snippet: "Quoted evidence",
                deep_link: "/reader/source",
                context_ref: { type: "media", id: "media-1" },
                locator: null,
                media_id: "media-1",
                media_kind: "book",
                score: 0.91,
                selected: true,
              },
              locator: null,
              created_at: "2026-06-03T00:00:00Z",
            },
          ],
          rerank_ledgers: [
            {
              id: "rerank-1",
              tool_call_id: "tool-1",
              strategy: "app_search_deterministic_selection",
              input_count: 1,
              selected_count: 1,
              budget_chars: 4000,
              selected_chars: 15,
              status: "complete",
              metadata: {
                selection_strategy: "app_search_deterministic_selection",
                selection_policy_version: "v1",
                ordering_policy:
                  "hybrid_score_exactness_citation_quality_diversity",
                diversity_policy: "source_section_penalty",
                budget_policy: "greedy_context_budget",
                candidate_limit: 50,
                selected_limit: 6,
                query_class: "unclassified",
                retrieval_mode: "deep",
                policy_reason: "global_scope",
              },
              created_at: "2026-06-03T00:00:00Z",
            },
          ],
          created_at: "2026-06-03T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
        },
      ],
      citations: [
        {
          citation_edge_id: "edge-1",
          ordinal: 1,
          role: "context",
          target_ref: citation.target_ref,
          retrieval_id: "retrieval-1",
          tool_call_id: "tool-1",
          citation,
        },
      ],
      context_refs_added: [
        {
          chat_run_event_seq: 4,
          id: "ref-1",
          conversation_id: "conversation-1",
          resource_ref: "content_chunk:33333333-3333-4333-8333-333333333333",
          activation: {
            resourceRef: "content_chunk:33333333-3333-4333-8333-333333333333",
            kind: "route",
            href: "/media/11111111-1111-4111-8111-111111111111#evidence-33333333-3333-4333-8333-333333333333",
            unresolvedReason: null,
          },
          label: "Source title",
          summary: "Context",
          missing: false,
          created_at: "2026-06-03T00:00:00Z",
          citation_edge_id: "edge-1",
        },
      ],
      integrity_notices: [
        {
          code: "candidate_inclusion_mismatch:candidate-2",
          message:
            "Candidate ledger candidate-2 prompt-inclusion flag disagrees.",
        },
      ],
    };
    const onCitationActivate = vi.fn();

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
        onCitationActivate={onCitationActivate}
        errorLabel="The response failed."
        timestampLabel="Jun 3"
      />,
    );

    fireEvent.click(screen.getByText(/1 tools - 1 retrieved - 1 selected/));

    expect(screen.getByText("openai/gpt-test")).toBeInTheDocument();
    expect(screen.getByText(/#1 app_search - complete/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /tool tool-1 - all - 1 results \/ 1 selected - more available - 12ms/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/retrieval 0: Source title/)).toBeInTheDocument();
    expect(screen.getByText(/candidate 0: source-1/)).toBeInTheDocument();
    expect(
      screen.getByText("app_search_deterministic_selection"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "deep - global_scope - candidates 50 - selected cap 6 - unclassified",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "v1 - hybrid_score_exactness_citation_quality_diversity - source_section_penalty - greedy_context_budget",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /\[1\] Source title/ }));
    expect(onCitationActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceRef: "content_chunk:33333333-3333-4333-8333-333333333333",
      }),
      expect.objectContaining({
        kind: "media",
        media_id: "22222222-2222-4222-8222-222222222222",
      }),
      expect.anything(),
    );
    expect(screen.getAllByText("Source title").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Candidate ledger candidate-2/),
    ).toBeInTheDocument();
  });

  it("labels active future tools by tool name", () => {
    const message = assistantMessage();
    message.status = "pending";
    message.trust_trail = {
      ...message.trust_trail!,
      status: "running",
      tool_calls: [
        {
          id: "tool-1",
          assistant_message_id: "assistant-1",
          tool_name: "custom_tool",
          tool_call_index: 1,
          status: "running",
          scope: "provider_tool",
          requested_types: [],
          result_refs: [],
          selected_context_refs: [],
          provider_request_ids: [],
          result_count: 0,
          selected_count: 0,
          retrievals: [],
          candidate_ledgers: [],
          rerank_ledgers: [],
          created_at: "2026-06-03T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
        },
      ],
    };

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
        errorLabel="The response failed."
        timestampLabel="Jun 3"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Running custom_tool");
  });
});
