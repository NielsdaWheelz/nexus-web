import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type {
  AssistantTrustTrail,
  ConversationMessage,
  ExpectedChatFailure,
  MessageToolCall,
} from "@/lib/conversations/types";
import type { CitationOut } from "@/lib/conversations/citationOut";
import AssistantMessage from "./AssistantMessage";

type TrustRun = NonNullable<AssistantTrustTrail["run"]>;

function failureRun(failure: ExpectedChatFailure): TrustRun {
  return {
    run_id: "run-1",
    profile_id: "balanced",
    reasoning_option_id: "default",
    provider: null,
    model_name: null,
    status: "error",
    usage: null,
    error_code: null,
    error_origin: null,
    failure,
    final_chars: 0,
    started_at: null,
    completed_at: null,
    total_cost_usd_micros: null,
  };
}

function writeToolCall(
  overrides: Partial<MessageToolCall> & Pick<MessageToolCall, "tool_name">,
): MessageToolCall {
  return {
    id: `tool-${overrides.tool_name}`,
    assistant_message_id: "assistant-1",
    tool_call_index: 0,
    status: "complete",
    scope: "assistant_write",
    requested_types: [],
    result_refs: [],
    selected_context_refs: [],
    provider_request_ids: [],
    result_count: 1,
    selected_count: 0,
    retrievals: [],
    created_at: "2026-06-03T00:00:00Z",
    updated_at: "2026-06-03T00:00:00Z",
    ...overrides,
  };
}

function assistantMessage(text = "Alpha beta gamma"): ConversationMessage {
  return {
    id: "assistant-1",
    seq: 2,
    role: "assistant",
    status: "complete",
    can_rerun: false,
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function failedMessage(
    failure: ExpectedChatFailure,
    text = "",
    canRerun = true,
  ): ConversationMessage {
    const message: ConversationMessage = {
      ...assistantMessage(text),
      status: "error",
      can_rerun: canRerun,
    };
    message.trust_trail = {
      ...message.trust_trail!,
      status: "error",
      run: failureRun(failure),
    };
    return message;
  }

  it("renders a Run again action on a rerunnable failure and fires the rerun", () => {
    const onRerunAssistantResponse = vi.fn();
    const message = failedMessage({
      code: "incomplete",
      origin: "provider_response",
      support_id: "sup-1",
      can_rerun: true,
    });

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
        onRerunAssistantResponse={onRerunAssistantResponse}
      />,
    );

    expect(screen.getByText("Response incomplete")).toBeInTheDocument();
    expect(screen.getByText("Support ID: sup-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(onRerunAssistantResponse).toHaveBeenCalledWith("assistant-1");
  });

  it("shows the generic defect card (no failure, no rerun) for a DEFECT", () => {
    const message: ConversationMessage = {
      ...assistantMessage(""),
      status: "error",
      can_rerun: false,
    };
    message.trust_trail = { ...message.trust_trail!, status: "error", run: null };

    render(<AssistantMessage message={message} forkOptions={[]} />);

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("renders valid partial text ABOVE the card for a non-refusal failure", () => {
    const message = failedMessage(
      { code: "incomplete", origin: "provider_response", support_id: null, can_rerun: true },
      "Here is a partial answer",
    );

    render(<AssistantMessage message={message} forkOptions={[]} />);

    expect(screen.getByText("Here is a partial answer")).toBeInTheDocument();
    expect(screen.getByText("Response incomplete")).toBeInTheDocument();
  });

  it("suppresses all partial text for a Fable refusal (card is the only projection)", () => {
    const message = failedMessage(
      { code: "refused", origin: "provider_stream", support_id: null, can_rerun: false },
      "leaked refusal preamble",
      false,
    );

    render(<AssistantMessage message={message} forkOptions={[]} />);

    expect(screen.getByText("Response declined")).toBeInTheDocument();
    expect(screen.queryByText("leaked refusal preamble")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("renders exactly one Reconnect action for the client-only connection-lost state", () => {
    const onReconnectAssistant = vi.fn();
    const message: ConversationMessage = {
      ...assistantMessage("Partial so far"),
      status: "pending",
    };

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
        connectionLost
        onReconnectAssistant={onReconnectAssistant}
      />,
    );

    // Partial text is preserved while offering a single Reconnect action.
    expect(screen.getByText("Partial so far")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnectAssistant).toHaveBeenCalledWith("assistant-1");
  });

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
      />,
    );

    const answer = screen.getByText("Alpha beta gamma");
    selectText(answer, "beta");
    fireEvent.mouseUp(answer);

    await user.click(await screen.findByRole("button", { name: "Fork from selection" }));

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
      />,
    );

    const answer = screen.getByText("Alpha beta gamma");
    selectText(answer, "beta");
    fireEvent.keyUp(answer);

    expect(
      await screen.findByRole("button", { name: "Fork from selection" }),
    ).toBeInTheDocument();
  });

  it("renders trust-trail tool, retrieval, citation, context-ref, and integrity-notice details", () => {
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
        profile_id: "balanced",
        reasoning_option_id: "medium",
        provider: "openai",
        model_name: "gpt-test",
        status: "complete",
        usage: null,
        error_code: null,
        error_origin: null,
        failure: null,
        final_chars: 11,
        started_at: null,
        completed_at: null,
        total_cost_usd_micros: null,
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
              included_in_prompt_source: "retrieval",
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
          code: "selected_retrieval_missing_citation",
          message: "Selected retrieval retrieval-1 has no citation edge.",
        },
      ],
    };
    const onCitationActivate = vi.fn();

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
        onCitationActivate={onCitationActivate}
      />,
    );

    fireEvent.click(screen.getByText(/1 tools - 1 retrieved - 1 selected/));

    expect(screen.getByText("openai/gpt-test")).toBeInTheDocument();
    expect(screen.getByText(/#1 app_search - complete/)).toBeInTheDocument();
    expect(screen.getByText(/retrieval 0: Source title/)).toBeInTheDocument();
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
      screen.getByText("Selected retrieval retrieval-1 has no citation edge."),
    ).toBeInTheDocument();
    expect(screen.getByText("selected_retrieval_missing_citation")).toBeInTheDocument();
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
          created_at: "2026-06-03T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
        },
      ],
    };

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Running custom_tool");
  });

  it("renders one small-caps verb row per write tool call", () => {
    const message = assistantMessage("Done.");
    message.trust_trail = {
      ...message.trust_trail!,
      tool_calls: [
        writeToolCall({
          tool_name: "add_to_library",
          id: "w-file",
          result_refs: [{ kind: "entry", label: "Criticism" }],
        }),
        writeToolCall({
          tool_name: "create_highlight",
          id: "w-hl",
          result_refs: [{ kind: "highlight", label: "the entropy of the system" }],
        }),
        writeToolCall({
          tool_name: "mint_edge",
          id: "w-edge",
          result_refs: [{ kind: "edge", label: "these rhyme" }],
        }),
        writeToolCall({
          tool_name: "jot_note",
          id: "w-note",
          result_refs: [{ kind: "note_block", label: "today's note" }],
        }),
        writeToolCall({
          tool_name: "queue_add",
          id: "w-queue",
          result_refs: [{ kind: "queue", label: "The Waste Land" }],
        }),
      ],
    };

    render(
      <AssistantMessage message={message} forkOptions={[]} />,
    );

    expect(screen.getByText("Filed to")).toBeInTheDocument();
    expect(screen.getByText("Criticism")).toBeInTheDocument();
    expect(screen.getByText("Highlighted")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Noted in")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("The Waste Land")).toBeInTheDocument();
    // One Undo control per completed write.
    expect(screen.getAllByRole("button", { name: /^Undo:/ })).toHaveLength(5);
  });

  it("renders a mint_edge row as 'Connected A ↔ B' with the rationale detail (§2/§7)", () => {
    const message = assistantMessage("Done.");
    message.trust_trail = {
      ...message.trust_trail!,
      tool_calls: [
        writeToolCall({
          tool_name: "mint_edge",
          id: "w-edge",
          result_refs: [
            {
              kind: "edge",
              source_label: "The Waste Land",
              target_label: "Four Quartets",
              rationale: "shared imagery",
            },
          ],
        }),
      ],
    };

    render(
      <AssistantMessage message={message} forkOptions={[]} />,
    );

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("The Waste Land ↔ Four Quartets")).toBeInTheDocument();
    expect(screen.getByText("shared imagery")).toBeInTheDocument();
  });

  it("fires the undo request through the fetch boundary and flips to Undone", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { tool_name: "mint_edge", reverted_at: "2026-06-03T01:00:00Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const message = assistantMessage("Connected them.");
    message.trust_trail = {
      ...message.trust_trail!,
      tool_calls: [
        writeToolCall({
          tool_name: "mint_edge",
          id: "w-edge",
          result_refs: [{ kind: "edge", label: "these rhyme" }],
        }),
      ],
    };

    render(
      <AssistantMessage message={message} forkOptions={[]} />,
    );

    await user.click(screen.getByRole("button", { name: /^Undo:/ }));

    expect(await screen.findByText("Undone")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/conversation-1/tool-calls/w-edge/undo",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByRole("button", { name: /^Undo:/ })).toBeNull();
  });

  it("sets the machine register with an ASSISTANT signature and a valid <time> (AC-2)", () => {
    render(
      <AssistantMessage
        message={assistantMessage()}
        forkOptions={[]}
      />,
    );

    // The prose is wrapped by the machine owner, stamped with the honest origin.
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the prose renders INSIDE the machine wrapper; the wrapper carries a data-provenance attribute, not a role/label
    const machine = document.querySelector('[data-machine-origin="Assistant"]');
    expect(machine).not.toBeNull();
    expect(machine).toContainElement(screen.getByText("Alpha beta gamma"));

    // Head signature: small-caps origin + a machine-readable <time> (the
    // "· 12:00 AM" text node is the <time>; its datetime is the ISO instant).
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByText(/^·/)).toHaveAttribute(
      "datetime",
      "2026-06-03T00:00:00Z",
    );
  });

  // --- Colophon + footnotes gating (S3 / AC-4 / AC-5 / AC-6) ----------------

  function citationFixture(): CitationOut {
    return {
      ordinal: 1,
      role: "context",
      target_ref: {
        type: "content_chunk",
        id: "33333333-3333-4333-8333-333333333333",
      },
      activation: {
        resourceRef: "content_chunk:33333333-3333-4333-8333-333333333333",
        kind: "route",
        href: "/reader/source",
        unresolvedReason: null,
      },
      media_id: null,
      locator: null,
      deep_link: "/reader/source",
      snapshot: {
        title: "Source title",
        excerpt: "Quoted evidence",
        section_label: "Section",
        result_type: "content_chunk",
        summary_md: null,
      },
    };
  }

  function completedWithRun(): ConversationMessage {
    const message = assistantMessage("The answer [1].");
    message.citations = [citationFixture()];
    message.trust_trail = {
      ...message.trust_trail!,
      run: {
        run_id: "run-1",
        profile_id: "balanced",
        reasoning_option_id: "medium",
        provider: "anthropic",
        model_name: "claude-sonnet-4-6",
        status: "complete",
        usage: { input_tokens: 3200, output_tokens: 1100 },
        error_code: null,
        error_origin: null,
        failure: null,
        final_chars: 15,
        started_at: null,
        completed_at: null,
        total_cost_usd_micros: 14_123,
      },
    };
    return message;
  }

  it("renders the colophon and footnotes on a completed turn with a run (AC-4/AC-5/AC-6)", () => {
    render(
      <AssistantMessage
        message={completedWithRun()}
        forkOptions={[]}
      />,
    );

    // Colophon: model uppercased, tokens, cost, and source count (AC-5/AC-6).
    const colophon = screen.getByLabelText("Generation provenance");
    expect(colophon).toHaveTextContent("CLAUDE-SONNET-4-6");
    expect(colophon).toHaveTextContent("3.2K IN / 1.1K OUT");
    expect(colophon).toHaveTextContent("$0.014");
    expect(colophon).toHaveTextContent("1 SOURCE");

    // Footnotes: the <ol aria-label="Sources"> with one entry (AC-4).
    expect(screen.getByRole("list", { name: "Sources" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /1\. Source title/ }),
    ).toBeInTheDocument();
  });

  it("omits the colophon while the turn is streaming (AC-5)", () => {
    const message = completedWithRun();
    message.status = "pending";

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
      />,
    );

    expect(screen.queryByLabelText("Generation provenance")).toBeNull();
  });

  it("omits the colophon on an errored turn (AC-5)", () => {
    const message = completedWithRun();
    message.status = "error";

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
      />,
    );

    expect(screen.queryByLabelText("Generation provenance")).toBeNull();
  });

  it("omits the colophon when the completed turn has no run data (AC-5)", () => {
    const message = completedWithRun();
    message.trust_trail = { ...message.trust_trail!, run: null };

    render(
      <AssistantMessage
        message={message}
        forkOptions={[]}
      />,
    );

    expect(screen.queryByLabelText("Generation provenance")).toBeNull();
  });
});
