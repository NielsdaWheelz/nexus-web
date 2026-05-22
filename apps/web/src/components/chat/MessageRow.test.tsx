import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageRow } from "./MessageRow";
import type {
  ConversationMessage,
  MessageArtifact,
  MessageCitationAudit,
  MessageClaim,
  MessageClaimEvidence,
  MessageEvidenceSummary,
  MessageRetrievalResultRef,
} from "@/lib/conversations/types";

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiFetch: apiFetchMock,
  isApiError: (error: unknown) =>
    error instanceof Error && error.name === "ApiError",
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

type MessageFixture = ConversationMessage & {
  content?: string;
  artifacts?: MessageArtifact[];
  evidence_summary?: MessageEvidenceSummary | null;
  citation_audit?: MessageCitationAudit | null;
  claims?: MessageClaim[];
  claim_evidence?: MessageClaimEvidence[];
};

const baseMessage: MessageFixture = {
  id: "assistant-1",
  seq: 1,
  role: "assistant",
  content: "Current answer.",
  message_document: {
    type: "message_document",
    version: 1,
    blocks: [
      {
        type: "text",
        format: "markdown",
        text: "Current answer.",
      },
    ],
  },
  status: "complete",
  error_code: null,
  can_retry_response: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

type MessageDocumentBlock = NonNullable<
  ConversationMessage["message_document"]
>["blocks"][number];

function messageDocument(blocks: MessageDocumentBlock[]) {
  return {
    type: "message_document" as const,
    version: 1,
    blocks,
  };
}

function textBlock(text: string): MessageDocumentBlock {
  return {
    type: "text",
    format: "markdown",
    text,
  };
}

function claimBlock(claim: MessageClaim): MessageDocumentBlock {
  return {
    type: "claim",
    claim_id: claim.id,
    message_id: claim.message_id,
    ordinal: claim.ordinal,
    claim_text: claim.claim_text,
    answer_start_offset: claim.answer_start_offset,
    answer_end_offset: claim.answer_end_offset,
    claim_kind: claim.claim_kind,
    support_status: claim.support_status,
    unsupported_reason: claim.unsupported_reason,
    confidence: claim.confidence,
    verifier_status: claim.verifier_status,
    created_at: claim.created_at,
  };
}

function claimEvidenceBlock(
  evidence: MessageClaimEvidence,
): MessageDocumentBlock {
  return {
    type: "claim_evidence",
    ...evidence,
  };
}

function artifactPartSource(partId: string, artifactId = "artifact-1") {
  return {
    source_version: `artifact_part:${partId}:v1`,
    locator: {
      type: "artifact_part_ref",
      artifact_id: artifactId,
      artifact_part_id: partId,
      message_id: "assistant-1",
      conversation_id: "conversation-1",
    },
  } as const;
}

function messageRetrievalResultRef(title = "Source message") {
  return {
    type: "message" as const,
    id: "message-1",
    result_type: "message" as const,
    source_id: "message-1",
    conversation_id: "conversation-1",
    seq: 1,
    title,
    snippet: "Evidence excerpt",
    deep_link: "/conversations/conversation-1",
    context_ref: { type: "message" as const, id: "message-1" },
    source_version: "message:v1",
    locator: {
      type: "message_offsets" as const,
      conversation_id: "conversation-1",
      message_id: "message-1",
      start_offset: 0,
      end_offset: 16,
      message_seq: 1,
    },
    score: 0.91,
    selected: true,
  };
}

function openEvidence() {
  fireEvent.click(screen.getByRole("button", { name: /^Evidence/ }));
}

function openAllDetails() {
  screen
    .getAllByRole("button", { name: "Details" })
    .forEach((button) => fireEvent.click(button));
}

function pdfResultRef({
  title = "Research PDF",
  citationLabel = "p. 4",
  sourceId = "chunk-1",
  mediaId = "media-1",
  page = 4,
  exact = "PDF quote",
}: {
  title?: string;
  citationLabel?: string;
  sourceId?: string;
  mediaId?: string;
  page?: number;
  exact?: string;
} = {}): MessageRetrievalResultRef {
  return {
    type: "content_chunk",
    id: sourceId,
    result_type: "content_chunk",
    source_id: sourceId,
    title,
    source_label: title,
    snippet: exact,
    deep_link: `/media/${mediaId}?page=${page}`,
    citation_label: citationLabel,
    source_kind: "pdf",
    evidence_span_ids: [],
    context_ref: { type: "content_chunk", id: sourceId },
    source_version: `pdf:${mediaId}:v1`,
    locator: {
      type: "pdf_page_geometry",
      media_id: mediaId,
      page_number: page,
      quads: [{ x1: 1, y1: 1, x2: 2, y2: 1, x3: 2, y3: 2, x4: 1, y4: 2 }],
      exact,
    },
    media_id: mediaId,
    media_kind: "pdf",
    score: 1,
    selected: true,
  };
}

function webResultRef({
  id = "web-result-1",
  title = "Example result",
  url = "https://example.com/story",
  displayUrl = "example.com",
  snippet = "A relevant web excerpt.",
}: {
  id?: string;
  title?: string;
  url?: string;
  displayUrl?: string;
  snippet?: string;
} = {}): MessageRetrievalResultRef {
  return {
    type: "web_result",
    id,
    result_type: "web_result",
    result_ref: id,
    source_id: id,
    title,
    url,
    display_url: displayUrl,
    deep_link: url,
    snippet,
    provider: "test",
    source_version: `web_search:test:${id}`,
    context_ref: { type: "web_result", id },
    locator: {
      type: "external_url",
      url,
      title,
      display_url: displayUrl,
    },
    media_id: null,
    media_kind: null,
    score: null,
    selected: true,
  };
}

describe("MessageRow", () => {
  it("exposes a reply fork action on complete assistant messages", () => {
    const onReplyToAssistant = vi.fn();

    render(
      <MessageRow
        message={baseMessage}
        onReplyToAssistant={onReplyToAssistant}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Fork from this answer" }),
    );

    expect(onReplyToAssistant).toHaveBeenCalledWith({
      parentMessageId: "assistant-1",
      parentMessageSeq: 1,
      parentMessagePreview: "Current answer.",
      anchor: {
        kind: "assistant_message",
        message_id: "assistant-1",
      },
    });
  });

  it("branches from selected assistant answer text", () => {
    const onReplyToAssistant = vi.fn();

    render(
      <MessageRow
        message={baseMessage}
        onReplyToAssistant={onReplyToAssistant}
      />,
    );

    const answer = screen.getByText("Current answer.");
    const removeAllRanges = vi.fn();
    const cloneRange = () =>
      ({
        selectNodeContents: vi.fn(),
        setEnd: vi.fn(),
        setStart: vi.fn(),
        toString: () => "",
        detach: vi.fn(),
      }) as unknown as Range;
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "answer",
      getRangeAt: () =>
        ({
          startContainer: answer,
          endContainer: answer,
          commonAncestorContainer: answer,
          getBoundingClientRect: () => new DOMRect(20, 20, 80, 20),
          cloneRange,
        }) as unknown as Range,
      removeAllRanges,
    } as unknown as Selection);

    fireEvent.mouseUp(answer);
    fireEvent.click(
      screen.getByRole("button", { name: "Fork from selection" }),
    );

    expect(onReplyToAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: "assistant-1",
        anchor: expect.objectContaining({
          kind: "assistant_selection",
          message_id: "assistant-1",
          exact: "answer",
          offset_status: "mapped",
          start_offset: 8,
          end_offset: 14,
        }),
      }),
    );
  });

  it("branches from repeated selected text as unmapped without offsets", () => {
    const onReplyToAssistant = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      content: "repeat then repeat.",
      message_document: messageDocument([textBlock("repeat then repeat.")]),
    };

    render(
      <MessageRow message={message} onReplyToAssistant={onReplyToAssistant} />,
    );

    const answer = screen.getByText("repeat then repeat.");
    const cloneRange = () =>
      ({
        selectNodeContents: vi.fn(),
        setEnd: vi.fn(),
        setStart: vi.fn(),
        toString: () => "",
        detach: vi.fn(),
      }) as unknown as Range;
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "repeat",
      getRangeAt: () =>
        ({
          startContainer: answer,
          endContainer: answer,
          commonAncestorContainer: answer,
          getBoundingClientRect: () => new DOMRect(20, 20, 80, 20),
          cloneRange,
        }) as unknown as Range,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent.mouseUp(answer);
    fireEvent.click(
      screen.getByRole("button", { name: "Fork from selection" }),
    );

    const draft = onReplyToAssistant.mock.calls[0][0];
    expect(draft.anchor).toMatchObject({
      kind: "assistant_selection",
      message_id: "assistant-1",
      exact: "repeat",
      offset_status: "unmapped",
    });
    expect("start_offset" in draft.anchor).toBe(false);
    expect("end_offset" in draft.anchor).toBe(false);
  });

  it("renders persisted claim evidence with exact web snippets and statuses", () => {
    const content = "Nexus cites exact evidence.";
    const summary = {
      id: "summary-1",
      message_id: "assistant-1",
      scope_type: "general" as const,
      scope_ref: null,
      retrieval_status: "web_result" as const,
      support_status: "supported" as const,
      verifier_status: "llm_verified" as const,
      claim_count: 1,
      supported_claim_count: 1,
      unsupported_claim_count: 0,
      not_enough_evidence_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const claim: MessageClaim = {
      id: "claim-1",
      message_id: "assistant-1",
      ordinal: 0,
      claim_text: content,
      answer_start_offset: 0,
      answer_end_offset: content.length,
      claim_kind: "answer",
      support_status: "supported",
      verifier_status: "llm_verified",
      created_at: "2026-01-01T00:00:00Z",
    };
    const evidence: MessageClaimEvidence = {
      id: "evidence-1",
      claim_id: "claim-1",
      ordinal: 0,
      evidence_role: "supports",
      source_ref: {
        type: "web_result",
        id: "web-result-1",
        label: "Example result",
      },
      retrieval_id: "retrieval-1",
      context_ref: { type: "web_result", id: "web-result-1" },
      result_ref: webResultRef(),
      exact_snippet: "A relevant web excerpt.",
      locator: {
        type: "external_url",
        url: "https://example.com/story",
        title: "Example result",
        display_url: "example.com",
        accessed_at: "2026-01-01T00:00:00Z",
      },
      deep_link: "https://example.com/story",
      score: 0.91,
      retrieval_status: "web_result",
      selected: true,
      included_in_prompt: true,
      source_version: "web-snapshot-1",
      created_at: "2026-01-01T00:00:00Z",
    };
    const message: MessageFixture = {
      ...baseMessage,
      content,
      message_document: messageDocument([
        textBlock(content),
        { type: "verification_summary", ...summary },
        claimBlock(claim),
        claimEvidenceBlock(evidence),
      ]),
    };

    const onAttachContext = vi.fn();

    render(<MessageRow message={message} onAttachContext={onAttachContext} />);

    const citation = screen.getByRole("link", { name: "Open citation 1" });
    expect(citation).toHaveAttribute("href", "https://example.com/story");
    expect(citation).toHaveAttribute("target", "_blank");
    expect(citation).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /example result/i })).toBeNull();
    expect(screen.queryByText(/support_status: supported/i)).toBeNull();

    openEvidence();

    const link = screen.getByRole("link", { name: /example result/i });
    expect(link).toHaveAttribute("href", "https://example.com/story");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("A relevant web excerpt.")).toBeInTheDocument();

    openAllDetails();

    expect(screen.getAllByText(/Support: Supported/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("Available from web").length).toBeGreaterThan(0);
    expect(screen.getByText("Used in the answer")).toBeInTheDocument();
    expect(screen.queryByText("selected: true")).toBeNull();
    expect(screen.queryByText("included_in_prompt: true")).toBeNull();
  });

  it("loads verifier run ledger from the evidence panel", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/messages/assistant-1/verifier-runs") {
        return {
          data: [
            {
              id: "verifier-run-1",
              message_id: "assistant-1",
              chat_run_id: "chat-run-1",
              prompt_assembly_id: "prompt-1",
              verifier_name: "llm_claim_classifier",
              verifier_version: "v1",
              verifier_status: "llm_verified",
              support_status: "supported",
              claim_count: 1,
              supported_claim_count: 1,
              unsupported_claim_count: 0,
              not_enough_evidence_count: 0,
              metadata: { source_backed: true },
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      return { data: [] };
    });
    const summary = {
      id: "summary-1",
      message_id: "assistant-1",
      scope_type: "general" as const,
      scope_ref: null,
      retrieval_status: "retrieved" as const,
      support_status: "supported" as const,
      verifier_status: "llm_verified" as const,
      verifier_run_id: "verifier-run-1",
      prompt_assembly_id: "prompt-1",
      claim_count: 1,
      supported_claim_count: 1,
      unsupported_claim_count: 0,
      not_enough_evidence_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const message: MessageFixture = {
      ...baseMessage,
      message_document: messageDocument([
        textBlock("Audited answer."),
        { type: "verification_summary", ...summary },
      ]),
    };

    render(<MessageRow message={message} />);
    openEvidence();
    fireEvent.click(screen.getByRole("button", { name: "Verifier ledger" }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/messages/assistant-1/verifier-runs",
      ),
    );
    expect(await screen.findByText("1 runs")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "llm_claim_classifier llm verified",
      }),
    );
    expect(screen.getByText("Run: verifier-run-1")).toBeInTheDocument();
    expect(screen.getByText("Prompt assembly: prompt-1")).toBeInTheDocument();
    expect(screen.queryByText(/Metadata/)).toBeNull();
  });

  it("renders persisted citation audits with compact trust statuses", () => {
    const audit = {
      id: "audit-1",
      message_id: "assistant-1",
      chat_run_id: "run-1",
      verifier_run_id: "verifier-1",
      supported_claim_count: 2,
      supported_claims_with_valid_offsets_count: 1,
      supported_claims_with_citation_count: 1,
      missing_locator_count: 2,
      missing_source_version_count: 1,
      supported_claims_have_valid_offsets: false,
      supported_claims_have_citation_placement: false,
      claim_evidence_has_required_locators: false,
      claim_evidence_has_source_versions: false,
      details: {
        invalid_offset_claim_ids: ["claim-2"],
        missing_locator_evidence_ids: ["evidence-1", "evidence-2"],
      },
      created_at: "2026-01-01T00:00:00Z",
    };
    const message: MessageFixture = {
      ...baseMessage,
      message_document: messageDocument([
        textBlock("Current answer."),
        { type: "citation_audit", ...audit },
      ]),
    };
    const onAttachContext = vi.fn();

    render(<MessageRow message={message} onAttachContext={onAttachContext} />);

    expect(screen.getByText("Citation audit needs review")).toBeVisible();
    const auditRegion = screen.getByRole("region", { name: "Citation audit" });
    expect(auditRegion).toHaveTextContent("1/2 offsets valid");
    expect(auditRegion).toHaveTextContent("1/2 citations placed");
    expect(auditRegion).toHaveTextContent("2 missing locators");
    expect(auditRegion).toHaveTextContent("1 missing source version");

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(auditRegion).toHaveTextContent("invalid_offset_claim_ids: 1 entry");
    expect(auditRegion).toHaveTextContent(
      "missing_locator_evidence_ids: 2 entries",
    );
  });

  it("renders citation audit blocks from the message document", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "Fallback answer.",
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          {
            type: "text",
            format: "markdown",
            text: "Audited answer.",
          },
          {
            type: "citation_audit",
            id: "audit-1",
            message_id: "assistant-1",
            chat_run_id: null,
            verifier_run_id: null,
            supported_claim_count: 2,
            supported_claims_with_valid_offsets_count: 2,
            supported_claims_with_citation_count: 2,
            missing_locator_count: 0,
            missing_source_version_count: 0,
            supported_claims_have_valid_offsets: true,
            supported_claims_have_citation_placement: true,
            claim_evidence_has_required_locators: true,
            claim_evidence_has_source_versions: true,
            details: {},
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("Audited answer.")).toBeVisible();
    expect(screen.getByText("Citation audit passed")).toBeVisible();

    openEvidence();

    const audit = screen.getByRole("region", { name: "Citation audit" });
    expect(audit).toHaveTextContent("2/2 offsets valid");
    expect(audit).toHaveTextContent("2/2 citations placed");
    expect(audit).toHaveTextContent("Locators present");
    expect(audit).toHaveTextContent("Source versions present");
  });

  it("renders persisted source manifests from the message document", () => {
    apiFetchMock.mockResolvedValue({ data: [] });
    const message: MessageFixture = {
      ...baseMessage,
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          {
            type: "text",
            format: "markdown",
            text: "Here is the synthesis.",
          },
          {
            type: "source_manifest",
            assistant_message_id: "assistant-1",
            tool_call_id: "tool-1",
            tool_name: "app_search",
            tool_call_index: 0,
            scope: "all",
            filters: { media_kinds: ["pdf"], tag_ids: ["tag-1"] },
            requested_types: ["fragment", "highlight"],
            candidate_count: 5,
            result_count: 3,
            selected_count: 2,
            included_in_prompt_count: 1,
            excluded_by_budget_count: 1,
            excluded_by_scope_count: 0,
            stale_count: 0,
            unreadable_count: 0,
            web_search_mode: "off",
            index_versions: ["semantic:v2"],
            metadata: { empty_status: "partial" },
            latency_ms: 24,
            status: "complete",
          },
        ],
      },
    };

    render(<MessageRow message={message} />);

    const manifest = screen.getByRole("region", { name: "Source manifest" });
    const toggle = screen.getByRole("button", { name: /Sources searched/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(manifest).toHaveTextContent("fragment, highlight");
    expect(manifest).toHaveTextContent("2/3 selected");
    expect(manifest).toHaveTextContent("5 candidates");
    expect(manifest).toHaveTextContent("1 in prompt");
    expect(manifest).toHaveTextContent("1 budget-excluded");
    expect(manifest).not.toHaveTextContent("semantic:v2");
    expect(manifest).not.toHaveTextContent("media_kinds: pdf");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(manifest).toHaveTextContent("semantic:v2");
    expect(manifest).toHaveTextContent("media_kinds: pdf");
    expect(manifest).toHaveTextContent("tag_ids: tag-1");
    expect(manifest).not.toHaveTextContent("empty_status");
  });

  it("loads source manifest audit ledgers inline", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/messages/assistant-1/retrieval-candidate-ledgers") {
        return {
          data: [
            {
              id: "candidate-1",
              tool_call_id: "tool-1",
              retrieval_id: "retrieval-1",
              ordinal: 0,
              result_type: "message",
              source_id: "message-1",
              score: 0.91,
              selected: true,
              included_in_prompt: true,
              ledger_included_in_prompt: false,
              linked_retrieval_included_in_prompt: true,
              included_in_prompt_source: "linked_retrieval",
              included_in_prompt_reconciled: false,
              selection_status: "selected",
              selection_reason: "within_context_budget",
              result_ref: messageRetrievalResultRef(),
              locator: {
                type: "message_offsets",
                conversation_id: "conversation-1",
                message_id: "message-1",
                start_offset: 0,
                end_offset: 16,
                message_seq: 1,
              },
              source_version: "message:v1",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      if (path === "/api/messages/assistant-1/rerank-ledgers") {
        return {
          data: [
            {
              id: "rerank-1",
              tool_call_id: "tool-1",
              strategy: "search_score_then_context_budget",
              input_count: 2,
              selected_count: 1,
              budget_chars: 12000,
              selected_chars: 16,
              status: "complete",
              metadata: { selected_limit: 4 },
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    const message: MessageFixture = {
      ...baseMessage,
      message_document: messageDocument([
        textBlock("Here is the synthesis."),
        {
          type: "source_manifest",
          assistant_message_id: "assistant-1",
          tool_call_id: "tool-1",
          tool_name: "app_search",
          tool_call_index: 0,
          scope: "all",
          filters: {},
          requested_types: ["message"],
          candidate_count: 2,
          result_count: 2,
          selected_count: 1,
          included_in_prompt_count: 1,
          excluded_by_budget_count: 1,
          excluded_by_scope_count: 0,
          stale_count: 0,
          unreadable_count: 0,
          index_versions: ["messages:v1"],
          status: "complete",
        },
      ]),
    };

    render(<MessageRow message={message} />);
    const manifest = screen.getByRole("region", { name: "Source manifest" });
    fireEvent.click(screen.getByRole("button", { name: /Sources searched/ }));

    await waitFor(() => {
      expect(manifest).toHaveTextContent("1 candidates, 1 rerank passes");
    });
    expect(manifest).toHaveTextContent("search_score_then_context_budget");
    expect(manifest).toHaveTextContent("1/2 selected");
    expect(manifest).toHaveTextContent("Source message");
    expect(manifest).toHaveTextContent("in prompt");
    expect(manifest).toHaveTextContent("within context budget");
    expect(manifest).toHaveTextContent("prompt mismatch");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/messages/assistant-1/retrieval-candidate-ledgers",
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/messages/assistant-1/rerank-ledgers",
    );
  });

  it("refetches source manifest audit ledgers after streaming manifest updates", async () => {
    let candidateRequests = 0;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/messages/assistant-1/retrieval-candidate-ledgers") {
        candidateRequests += 1;
        return {
          data:
            candidateRequests === 1
              ? []
              : [
                  {
                    id: "candidate-1",
                    tool_call_id: "tool-1",
                    retrieval_id: "retrieval-1",
                    ordinal: 0,
                    result_type: "message",
                    source_id: "message-1",
                    score: 0.91,
                    selected: true,
                    included_in_prompt: true,
                    ledger_included_in_prompt: true,
                    linked_retrieval_included_in_prompt: true,
                    included_in_prompt_source: "linked_retrieval",
                    included_in_prompt_reconciled: true,
                    selection_status: "selected",
                    selection_reason: "within_context_budget",
                    result_ref: messageRetrievalResultRef("Updated source"),
                    locator: messageRetrievalResultRef().locator,
                    source_version: "message:v1",
                    created_at: "2026-01-01T00:00:00Z",
                  },
                ],
        };
      }
      if (path === "/api/messages/assistant-1/rerank-ledgers") {
        return { data: [] };
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    const sourceManifest = (
      status: "running" | "complete",
      candidateCount: number,
    ): MessageDocumentBlock => ({
      type: "source_manifest",
      assistant_message_id: "assistant-1",
      tool_call_id: "tool-1",
      tool_name: "app_search",
      tool_call_index: 0,
      scope: "all",
      filters: {},
      requested_types: ["message"],
      candidate_count: candidateCount,
      result_count: candidateCount,
      selected_count: candidateCount,
      included_in_prompt_count: candidateCount,
      excluded_by_budget_count: 0,
      excluded_by_scope_count: 0,
      stale_count: 0,
      unreadable_count: 0,
      index_versions: ["messages:v1"],
      status,
    });
    const { rerender } = render(
      <MessageRow
        message={{
          ...baseMessage,
          message_document: messageDocument([
            textBlock("Here is the synthesis."),
            sourceManifest("running", 0),
          ]),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Sources searched/ }));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/messages/assistant-1/retrieval-candidate-ledgers",
      );
    });

    rerender(
      <MessageRow
        message={{
          ...baseMessage,
          message_document: messageDocument([
            textBlock("Here is the synthesis."),
            sourceManifest("complete", 1),
          ]),
        }}
      />,
    );

    await waitFor(() => {
      expect(candidateRequests).toBe(2);
      expect(
        screen.getByRole("region", { name: "Source manifest" }),
      ).toHaveTextContent("Updated source");
    });
  });

  it("renders persisted retrieval result blocks from the message document", () => {
    const message: MessageFixture = {
      ...baseMessage,
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          {
            type: "text",
            format: "markdown",
            text: "Here is the synthesis.",
          },
          {
            type: "retrieval_result",
            id: "retrieval-1",
            tool_call_id: "tool-1",
            ordinal: 0,
            result_type: "highlight",
            source_id: "highlight-1",
            media_id: "media-1",
            evidence_span_id: null,
            context_ref: { type: "highlight", id: "highlight-1" },
            result_ref: {
              type: "highlight",
              id: "highlight-1",
              result_type: "highlight",
              source_id: "highlight-1",
              color: "yellow",
              exact: "Important saved quote.",
              title: "Saved Quote",
              source_label: "Reader Source",
              snippet: "Important saved quote.",
              deep_link: "/media/media-1?highlight=highlight-1",
              context_ref: { type: "highlight", id: "highlight-1" },
              media_id: "media-1",
              media_kind: "pdf",
              score: 0.92,
              selected: true,
              source_version: "highlight:v1",
              locator: {
                type: "web_text_offsets",
                media_id: "media-1",
                fragment_id: "fragment-1",
                start_offset: 0,
                end_offset: 21,
              },
            },
            deep_link: "/media/media-1?highlight=highlight-1",
            score: 0.92,
            selected: true,
            source_title: "Saved Quote",
            section_label: "Reader Source",
            exact_snippet: "Important saved quote.",
            snippet_prefix: null,
            snippet_suffix: null,
            locator: null,
            retrieval_status: "included_in_prompt",
            included_in_prompt: true,
            source_version: "highlight:v1",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      tool_calls: [],
    };

    render(<MessageRow message={message} />);

    const retrieved = screen.getByRole("region", { name: "Retrieved sources" });
    expect(retrieved).toHaveTextContent("Saved Quote");
    expect(retrieved).toHaveTextContent("Important saved quote.");
    expect(retrieved).toHaveTextContent("Available from prompt");
    expect(retrieved).toHaveTextContent("highlight:v1");
  });

  it("does not count uncited artifact parts as cited", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "Here is the synthesis.",
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          {
            type: "text",
            format: "markdown",
            text: "Here is the synthesis.",
          },
          {
            type: "artifact_preview",
            artifact_id: "artifact-1",
            artifact_kind: "timeline",
            title: "Publication timeline",
            status: "complete",
            delta: "A concise timeline was generated.",
            parts: [{ id: "part-1", ...artifactPartSource("part-1") }],
          },
        ],
      },
    };
    const onAttachContext = vi.fn();

    render(<MessageRow message={message} onAttachContext={onAttachContext} />);

    expect(
      screen.getByRole("region", { name: "Generated artifacts" }),
    ).toBeVisible();
    expect(screen.getByText("Publication timeline")).toBeVisible();
    expect(screen.getByText("A concise timeline was generated.")).toBeVisible();
    expect(screen.queryByText("1 cited parts")).not.toBeInTheDocument();
  });

  it("counts artifact parts as cited only when they carry evidence refs", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "Here is the synthesis.",
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          {
            type: "text",
            format: "markdown",
            text: "Here is the synthesis.",
          },
          {
            type: "artifact_preview",
            artifact_id: "artifact-1",
            artifact_kind: "timeline",
            title: "Publication timeline",
            status: "complete",
            delta: "A concise timeline was generated.",
            parts: [
              { id: "part-1", ...artifactPartSource("part-1") },
              {
                id: "part-2",
                ...artifactPartSource("part-2"),
                source_ref: {
                  type: "message_retrieval",
                  id: "retrieval-1",
                  retrieval_id: "retrieval-1",
                },
              },
            ],
          },
        ],
      },
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("1 cited parts")).toBeVisible();
  });

  it("renders top-level durable artifacts without preview blocks", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "Here is the synthesis.",
      artifacts: [
        {
          id: "durable-artifact-1",
          conversation_id: "conversation-1",
          message_id: "assistant-1",
          chat_run_id: "run-1",
          artifact_key: "artifact-1",
          artifact_version: 1,
          artifact_kind: "timeline",
          title: "Publication timeline",
          status: "complete",
          preview_text: "A durable timeline was generated.",
          metadata: {},
          parts: [
            {
              id: "part-1",
              artifact_id: "durable-artifact-1",
              ...artifactPartSource("part-1", "durable-artifact-1"),
              ordinal: 0,
              part_key: "event-1",
              part_type: "event",
              text: "Cited event",
              source_ref: {
                type: "message_retrieval",
                id: "retrieval-1",
              },
              source_refs: [],
              evidence_span_ids: [],
              metadata: {},
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(
      screen.getByRole("region", { name: "Generated artifacts" }),
    ).toBeVisible();
    expect(screen.getByText("Publication timeline")).toBeVisible();
    expect(screen.getByText("A durable timeline was generated.")).toBeVisible();
    expect(screen.getByText("1 cited parts")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Export markdown" }),
    ).toBeVisible();
  });

  it("renders durable artifact previews from the message document", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "Here is the synthesis.",
      message_document: messageDocument([
        textBlock("Here is the synthesis."),
        {
          type: "artifact_preview",
          artifact_id: "artifact-1",
          durable_artifact_id: "durable-artifact-1",
          artifact_key: "artifact-1",
          artifact_version: 1,
          artifact_kind: "timeline",
          title: "Publication timeline",
          status: "complete",
          delta: "A durable timeline was generated.",
          parts: [
            {
              id: "part-1",
              artifact_id: "durable-artifact-1",
              ...artifactPartSource("part-1", "durable-artifact-1"),
              ordinal: 0,
              part_key: "event-1",
              part_type: "event",
              text: "Cited event",
              source_ref: {
                type: "message_retrieval",
                id: "retrieval-1",
              },
              source_refs: [],
              evidence_span_ids: [],
              metadata: {},
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ]),
      artifacts: [
        {
          id: "durable-artifact-1",
          conversation_id: "conversation-1",
          message_id: "assistant-1",
          chat_run_id: "run-1",
          artifact_key: "artifact-1",
          artifact_version: 1,
          artifact_kind: "timeline",
          title: "Duplicate top-level artifact",
          status: "complete",
          preview_text: "Duplicate durable preview.",
          metadata: {},
          parts: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(
      screen.getByRole("region", { name: "Generated artifacts" }),
    ).toBeVisible();
    expect(screen.getByText("Publication timeline")).toBeVisible();
    expect(screen.getByText("A durable timeline was generated.")).toBeVisible();
    expect(screen.queryByText("Duplicate top-level artifact")).toBeNull();
    expect(screen.queryByText("Duplicate durable preview.")).toBeNull();
    expect(screen.getByText("1 cited parts")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Export markdown" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Export json" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export html" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export csv" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export pdf" })).toBeVisible();
  });

  it("loads artifact detail and does not expose raw model-id ask payloads", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/artifacts/durable-artifact-1/exports") {
        return {
          data: [
            {
              id: "export-1",
              conversation_id: "conversation-1",
              message_id: "assistant-1",
              artifact_id: "durable-artifact-1",
              viewer_user_id: "user-1",
              format: "markdown",
              artifact_version: 1,
              content_sha256: "abcdef1234567890",
              manifest_sha256: "123456abcdef7890",
              metadata: {},
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      if (path === "/api/artifacts/durable-artifact-1") {
        return {
          data: {
            id: "durable-artifact-1",
            conversation_id: "conversation-1",
            message_id: "assistant-1",
            chat_run_id: "run-1",
            artifact_key: "artifact-1",
            artifact_version: 1,
            artifact_kind: "timeline",
            title: "Publication timeline",
            status: "complete",
            preview_text: "A concise timeline was generated.",
            parts: [
              {
                id: "part-1",
                ...artifactPartSource("part-1", "durable-artifact-1"),
                ordinal: 0,
                part_key: "event-1",
                part_type: "event",
                text: "Cited event",
                source_ref: {
                  type: "message_retrieval",
                  id: "retrieval-1",
                },
                evidence_span_ids: [],
                source_refs: [],
                metadata: {},
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        };
      }
      throw new Error(`Unexpected API call: ${path}`);
    });
    const message: MessageFixture = {
      ...baseMessage,
      content: "Here is the synthesis.",
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          {
            type: "text",
            format: "markdown",
            text: "Here is the synthesis.",
          },
          {
            type: "artifact_preview",
            artifact_id: "artifact-1",
            durable_artifact_id: "durable-artifact-1",
            artifact_kind: "timeline",
            title: "Publication timeline",
            status: "complete",
            delta: "A concise timeline was generated.",
            parts: [
              {
                id: "part-1",
                ...artifactPartSource("part-1"),
                source_ref: {
                  type: "message_retrieval",
                  id: "retrieval-1",
                },
              },
            ],
          },
        ],
      },
    };

    const onAttachContext = vi.fn();

    render(<MessageRow message={message} onAttachContext={onAttachContext} />);

    fireEvent.click(screen.getByRole("button", { name: "Inspect artifact" }));

    await waitFor(() => {
      expect(screen.getByText("Citation manifest")).toBeVisible();
    });
    expect(screen.getByText("artifact_part:part-1:v1")).toBeVisible();
    expect(screen.getByText("message_retrieval retrieval-1")).toBeVisible();
    expect(screen.getAllByText("event-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cited event").length).toBeGreaterThan(0);
    expect(screen.getByText("Follow-up context")).toBeVisible();
    expect(screen.getByText("Export ledger")).toBeVisible();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName.toLowerCase() === "li" &&
          element.textContent?.includes("markdown") === true &&
          element.textContent.includes("v1"),
      ),
    ).toBeVisible();
    expect(screen.getByText(/content abcdef123456/)).toBeVisible();
    expect(screen.getByText(/manifest 123456abcdef/)).toBeVisible();
    expect(screen.queryByLabelText("Model ID")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create ask payload" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Attach selected part" }),
    );
    expect(onAttachContext).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "object_ref",
        type: "artifact_part",
        id: "part-1",
        artifact_id: "durable-artifact-1",
        artifact_key: "artifact-1",
        artifact_version: 1,
        source_version: "artifact_part:part-1:v1",
        locator: expect.objectContaining({
          type: "artifact_part_ref",
          artifact_id: "durable-artifact-1",
          artifact_part_id: "part-1",
        }),
        artifact_part_provenance: expect.objectContaining({
          artifact_id: "durable-artifact-1",
          artifact_part_id: "part-1",
          source_version: "artifact_part:part-1:v1",
        }),
        preview: "Cited event",
        exact: "Cited event",
        color: "purple",
      }),
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/artifacts/durable-artifact-1/exports",
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/artifacts/durable-artifact-1",
    );
  });

  it.each([
    ["briefing_document", "Executive summary"],
    ["faq", "Question 1"],
    ["source_map", "Node 1"],
    ["video_slide_overview_manifest", "Slide 1"],
    ["bibliography", "Source 1"],
  ])(
    "renders a structured %s artifact viewer",
    async (artifactKind, partKey) => {
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === "/api/artifacts/durable-artifact-1/exports") {
          return { data: [] };
        }
        if (path === "/api/artifacts/durable-artifact-1") {
          return {
            data: {
              id: "durable-artifact-1",
              conversation_id: "conversation-1",
              message_id: "assistant-1",
              chat_run_id: "run-1",
              artifact_key: "artifact-1",
              artifact_version: 1,
              artifact_kind: artifactKind,
              title: "Structured artifact",
              status: "complete",
              preview_text: "Structured preview.",
              parts: [
                {
                  id: "part-1",
                  ...artifactPartSource("part-1", "durable-artifact-1"),
                  ordinal: 0,
                  part_key: partKey,
                  part_type: "section",
                  text: "Cited structured content",
                  source_ref: {
                    type: "message_retrieval",
                    id: "retrieval-1",
                  },
                  evidence_span_ids: [],
                  source_refs: [],
                  metadata: {},
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          };
        }
        throw new Error(`Unexpected API call: ${path}`);
      });
      const message: MessageFixture = {
        ...baseMessage,
        content: "Here is the synthesis.",
        message_document: messageDocument([
          textBlock("Here is the synthesis."),
          {
            type: "artifact_preview",
            artifact_id: "artifact-1",
            durable_artifact_id: "durable-artifact-1",
            artifact_kind: artifactKind,
            title: "Structured artifact",
            status: "complete",
            delta: "Structured preview.",
            parts: [
              {
                id: "part-1",
                ...artifactPartSource("part-1"),
                source_ref: {
                  type: "message_retrieval",
                  id: "retrieval-1",
                },
              },
            ],
          },
        ]),
      };

      render(<MessageRow message={message} />);
      fireEvent.click(screen.getByRole("button", { name: "Inspect artifact" }));

      await waitFor(() => {
        expect(screen.getAllByText(partKey).length).toBeGreaterThan(0);
      });
      expect(
        screen.getAllByText("Cited structured content").length,
      ).toBeGreaterThan(0);
    },
  );

  it("asks about a selected artifact part through the artifact ask API", async () => {
    const artifactAskRunPayload = {
      conversation_id: "conversation-1",
      parent_message_id: "assistant-1",
      branch_anchor: {
        kind: "assistant_message",
        message_id: "assistant-1",
      },
      content: "Explain this event",
      model_id: "model-1",
      reasoning: "default",
      key_mode: "auto",
      contexts: [
        {
          kind: "object_ref",
          type: "artifact_part",
          id: "part-1",
          evidence_span_ids: ["backend-span-1"],
          artifact_id: "durable-artifact-1",
          artifact_key: "artifact-1",
          artifact_version: 1,
          source_version: "artifact_part:part-1:v1",
          locator: {
            type: "artifact_part_ref",
            artifact_id: "durable-artifact-1",
            artifact_part_id: "part-1",
            message_id: "assistant-1",
            conversation_id: "conversation-1",
          },
          artifact_part_provenance: {
            type: "artifact_part",
            artifact_id: "durable-artifact-1",
            artifact_part_id: "part-1",
            artifact_key: "artifact-1",
            artifact_version: 1,
            source_version: "artifact_part:part-1:v1",
            evidence_span_ids: ["backend-span-1"],
          },
        },
      ],
      web_search: {
        mode: "off",
        allowed_domains: [],
        blocked_domains: [],
      },
      artifact_intent: { kind: "off" },
    };
    apiFetchMock.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (path === "/api/artifacts/durable-artifact-1/exports") {
          return { data: [] };
        }
        if (path === "/api/artifacts/durable-artifact-1") {
          return {
            data: {
              id: "durable-artifact-1",
              conversation_id: "conversation-1",
              message_id: "assistant-1",
              chat_run_id: "run-1",
              artifact_key: "artifact-1",
              artifact_version: 1,
              artifact_kind: "timeline",
              title: "Publication timeline",
              status: "complete",
              preview_text: "A concise timeline was generated.",
              parts: [
                {
                  id: "part-1",
                  ...artifactPartSource("part-1", "durable-artifact-1"),
                  ordinal: 0,
                  part_key: "event-1",
                  part_type: "event",
                  text: "Cited event",
                  source_ref: {
                    type: "message_retrieval",
                    id: "retrieval-1",
                  },
                  source_refs: [],
                  evidence_span_ids: ["client-stale-span"],
                  metadata: {},
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          };
        }
        if (path === "/api/chat-runs/run-1") {
          return {
            data: {
              run: {
                id: "run-1",
                status: "complete",
                conversation_id: "conversation-1",
                user_message_id: "user-1",
                assistant_message_id: "assistant-1",
                model_id: "model-1",
                reasoning: "default",
                key_mode: "auto",
                artifact_intent: { kind: "off" },
                cancel_requested_at: null,
                started_at: null,
                completed_at: "2026-01-01T00:00:00Z",
                error_code: null,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
              conversation: {
                id: "conversation-1",
                title: "Conversation",
                sharing: "private",
                message_count: 2,
                scope: { type: "general" },
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
              user_message: { ...baseMessage, id: "user-1", role: "user" },
              assistant_message: baseMessage,
            },
          };
        }
        if (path === "/api/chat-runs") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual(artifactAskRunPayload);
          return {
            data: {
              run: {
                id: "run-2",
                status: "queued",
                conversation_id: "conversation-1",
                user_message_id: "user-2",
                assistant_message_id: "assistant-2",
                model_id: "model-1",
                reasoning: "default",
                key_mode: "auto",
                artifact_intent: { kind: "off" },
                cancel_requested_at: null,
                started_at: null,
                completed_at: null,
                error_code: null,
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
              conversation: {
                id: "conversation-1",
                title: "Conversation",
                sharing: "private",
                message_count: 4,
                scope: { type: "general" },
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
              },
              user_message: { ...baseMessage, id: "user-2", role: "user" },
              assistant_message: { ...baseMessage, id: "assistant-2" },
            },
          };
        }
        if (path === "/api/artifacts/durable-artifact-1/ask") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            content: "Explain this event",
            artifact_part_id: "part-1",
            model_id: "model-1",
          });
          return {
            data: artifactAskRunPayload,
          };
        }
        throw new Error(`Unexpected API call: ${path}`);
      },
    );
    const onAttachContext = vi.fn();
    const onChatRunCreated = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      message_document: messageDocument([
        textBlock("Here is the synthesis."),
        {
          type: "artifact_preview",
          artifact_id: "artifact-1",
          durable_artifact_id: "durable-artifact-1",
          artifact_key: "artifact-1",
          artifact_version: 1,
          artifact_kind: "timeline",
          title: "Publication timeline",
          status: "complete",
          delta: "A concise timeline was generated.",
          parts: [
            {
              id: "part-1",
              ...artifactPartSource("part-1", "durable-artifact-1"),
              ordinal: 0,
              part_key: "event-1",
              part_type: "event",
              text: "Cited event",
              source_ref: {
                type: "message_retrieval",
                id: "retrieval-1",
              },
              source_refs: [],
              evidence_span_ids: [],
              metadata: {},
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ]),
    };

    render(
      <MessageRow
        message={message}
        onAttachContext={onAttachContext}
        onChatRunCreated={onChatRunCreated}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect artifact" }));
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Explain this event" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Ask about selected part" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Started artifact ask.")).toBeVisible();
    });
    expect(onAttachContext).not.toHaveBeenCalled();
    expect(onChatRunCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: "run-2" }),
        user_message: expect.objectContaining({ id: "user-2" }),
        assistant_message: expect.objectContaining({ id: "assistant-2" }),
      }),
    );
  });

  it("exposes source actions for artifact parts with reader locators", () => {
    const onReaderSourceActivate = vi.fn();
    const onAskAboutSource = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      message_document: messageDocument([
        textBlock("Here is the synthesis."),
        {
          type: "artifact_preview",
          artifact_id: "artifact-1",
          durable_artifact_id: "durable-artifact-1",
          artifact_key: "artifact-1",
          artifact_version: 1,
          artifact_kind: "timeline",
          title: "Publication timeline",
          status: "complete",
          delta: "A concise timeline was generated.",
          parts: [
            {
              id: "part-1",
              ...artifactPartSource("part-1", "durable-artifact-1"),
              ordinal: 0,
              part_key: "event-1",
              part_type: "event",
              text: "Cited event",
              result_ref: {
                result_type: "content_chunk",
                type: "content_chunk",
                id: "chunk-1",
                source_id: "chunk-1",
                title: "Research paper",
                source_label: "Research paper",
                snippet: "Cited event",
                citation_label: "Research paper",
                source_kind: "pdf",
                evidence_span_ids: [],
                deep_link: "/media/media-1",
                context_ref: { type: "content_chunk", id: "chunk-1" },
                media_id: "media-1",
                media_kind: "pdf",
                score: 0.9,
                selected: true,
                source_version: "pdf:media-1:v1",
                locator: {
                  type: "pdf_page_geometry",
                  media_id: "media-1",
                  page_number: 2,
                  quads: [
                    {
                      x1: 1,
                      y1: 1,
                      x2: 2,
                      y2: 1,
                      x3: 2,
                      y3: 2,
                      x4: 1,
                      y4: 2,
                    },
                  ],
                  exact: "Cited event",
                },
              },
              source_refs: [],
              evidence_span_ids: [],
              metadata: {},
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ]),
    };

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
        onAskAboutSource={onAskAboutSource}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect artifact" }));
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(onReaderSourceActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        media_id: "media-1",
        snippet: "Cited event",
        href: "/media/media-1",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask source" }));
    expect(onAskAboutSource).toHaveBeenCalledWith(
      expect.objectContaining({
        media_id: "media-1",
        snippet: "Cited event",
      }),
    );
  });

  it("renders app evidence with deep links, exact snippets, and backend labels", () => {
    const content = "The paper makes the claim.";
    const message: MessageFixture = {
      ...baseMessage,
      content,
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Research paper" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: content,
          answer_start_offset: 0,
          answer_end_offset: content.length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Research paper",
            media_id: "media-1",
            deep_link: "/media/media-1?page=12",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: pdfResultRef({
            title: "Research paper",
            citationLabel: "p. 12",
            page: 12,
            exact: "The exact app-source excerpt.",
          }),
          exact_snippet: "The exact app-source excerpt.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 12,
            quads: [{ x1: 1, y1: 1, x2: 2, y2: 1, x3: 2, y3: 2, x4: 1, y4: 2 }],
            exact: "The exact app-source excerpt.",
          },
          deep_link: null,
          score: 0.82,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          source_version: "pdf-source:v1",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(content),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(<MessageRow message={message} />);

    openEvidence();

    expect(screen.getByText("p. 12")).toBeVisible();
    expect(screen.queryByRole("link", { name: /p\. 12/i })).toBeNull();
    expect(
      screen.getByText("The exact app-source excerpt."),
    ).toBeInTheDocument();

    openAllDetails();

    expect(screen.getAllByText("Available from prompt").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("Used in the answer")).toBeInTheDocument();
    expect(screen.queryByText("page: 12")).not.toBeInTheDocument();
  });

  it("reports resolved app evidence source targets upward", () => {
    const onReaderSourceActivate = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      content: "The paper makes the claim.",
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Research paper" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: "The paper makes the claim.",
          answer_start_offset: 0,
          answer_end_offset: "The paper makes the claim.".length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Research paper",
            media_id: "media-1",
          },
          retrieval_id: "retrieval-1",
          evidence_span_id: "span-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: pdfResultRef({
            title: "Research paper",
            citationLabel: "p. 12",
            page: 12,
            exact: "The exact app-source excerpt.",
          }),
          exact_snippet: "The exact app-source excerpt.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 12,
            quads: [{ x1: 1 }],
            exact: "The exact app-source excerpt.",
          },
          deep_link: "/media/media-1?evidence=span-1&page=12",
          score: 0.82,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          source_version: "pdf-source:v1",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
      />,
    );

    openEvidence();

    fireEvent.click(
      screen.getByRole("button", { name: /open source p\. 12/i }),
    );

    expect(onReaderSourceActivate).toHaveBeenCalledWith({
      source: "claim_evidence",
      media_id: "media-1",
      locator: {
        type: "pdf_page_geometry",
        media_id: "media-1",
        page_number: 12,
        quads: [{ x1: 1 }],
        exact: "The exact app-source excerpt.",
      },
      snippet: "The exact app-source excerpt.",
      source_version: "pdf-source:v1",
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: "included_in_prompt",
      label: "p. 12",
      href: "/media/media-1?evidence=span-1&page=12",
      evidence_span_id: "span-1",
      evidence_id: "evidence-1",
      context_id: "media-1",
    });
  });

  it("offers ask and save actions for PDF evidence with geometry", () => {
    const onAskAboutSource = vi.fn();
    const onSaveSourceQuote = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      content: "The PDF supports this.",
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Research PDF" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: "The PDF supports this.",
          answer_start_offset: 0,
          answer_end_offset: "The PDF supports this.".length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Research PDF",
            media_id: "media-1",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: pdfResultRef(),
          exact_snippet: "PDF quote",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 4,
            quads: [{ x1: 1 }],
            exact: "PDF quote",
          },
          deep_link: "/media/media-1?page=4",
          score: 1,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          source_version: "pdf-source:v1",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={vi.fn()}
        onAskAboutSource={onAskAboutSource}
        onSaveSourceQuote={onSaveSourceQuote}
      />,
    );

    openEvidence();
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    fireEvent.click(screen.getByRole("button", { name: "Save quote" }));

    expect(onAskAboutSource).toHaveBeenCalledWith(
      expect.objectContaining({ media_id: "media-1", snippet: "PDF quote" }),
    );
    expect(onSaveSourceQuote).toHaveBeenCalledWith(
      expect.objectContaining({ media_id: "media-1", snippet: "PDF quote" }),
    );
  });

  it("activates and saves web text offset evidence from citations", () => {
    const onReaderSourceActivate = vi.fn();
    const onAskAboutSource = vi.fn();
    const onSaveSourceQuote = vi.fn();
    const content = "The article supports this.";
    const locator = {
      type: "web_text_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 5,
      end_offset: 29,
      media_kind: "web_article",
    } as const;
    const message: MessageFixture = {
      ...baseMessage,
      content,
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Article" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: content,
          answer_start_offset: 0,
          answer_end_offset: content.length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Article",
            media_id: "media-1",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "content_chunk", id: "chunk-1" },
          result_ref: {
            type: "content_chunk",
            id: "chunk-1",
            result_type: "content_chunk",
            source_id: "chunk-1",
            source_kind: "web_article",
            title: "Article",
            source_label: "Article",
            snippet: "Article quote",
            deep_link: "/media/media-1?fragment=fragment-1",
            citation_label: "Article",
            context_ref: { type: "content_chunk", id: "chunk-1" },
            evidence_span_ids: ["span-1"],
            source_version: "web:media-1:v1",
            locator,
            media_id: "media-1",
            media_kind: "web_article",
            score: 1,
            selected: true,
          },
          exact_snippet: "Article quote",
          locator,
          deep_link: "/media/media-1?fragment=fragment-1",
          score: 1,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          source_version: "web:media-1:v1",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(content),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
        onAskAboutSource={onAskAboutSource}
        onSaveSourceQuote={onSaveSourceQuote}
      />,
    );

    openEvidence();
    fireEvent.click(
      screen.getByRole("button", { name: "Open source Article" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    fireEvent.click(screen.getByRole("button", { name: "Save quote" }));

    const target = {
      source: "claim_evidence",
      media_id: "media-1",
      locator,
      snippet: "Article quote",
      source_version: "web:media-1:v1",
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: "included_in_prompt",
      label: "Article",
      href: "/media/media-1?fragment=fragment-1",
      evidence_span_id: null,
      evidence_id: "evidence-1",
      context_id: "chunk-1",
    };
    expect(onReaderSourceActivate).toHaveBeenCalledWith(target);
    expect(onAskAboutSource).toHaveBeenCalledWith(target);
    expect(onSaveSourceQuote).toHaveBeenCalledWith(target);
  });

  it("offers persisted evidence actions from inline citation hover cards", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onReaderSourceActivate = vi.fn();
    const onAskAboutSource = vi.fn();
    const onSaveSourceQuote = vi.fn();
    const content = "The PDF supports this.";
    const message: MessageFixture = {
      ...baseMessage,
      content,
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Research PDF" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: content,
          answer_start_offset: 0,
          answer_end_offset: content.length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Research PDF",
            media_id: "media-1",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: pdfResultRef(),
          exact_snippet: "PDF quote",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 4,
            quads: [{ x1: 1 }],
            exact: "PDF quote",
          },
          deep_link: "/media/media-1?page=4",
          score: 0.91,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          source_version: "pdf-source:v1",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(content),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
        onAskAboutSource={onAskAboutSource}
        onSaveSourceQuote={onSaveSourceQuote}
      />,
    );

    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(screen.getByText("Supporting sources")).toBeInTheDocument();
    expect(screen.getByText("Page 4")).toBeInTheDocument();
    expect(screen.getByText("pdf-source:v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open in context" }));
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    fireEvent.click(screen.getByRole("button", { name: "Save quote" }));
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    fireEvent.click(screen.getByRole("button", { name: "Copy citation" }));

    expect(onReaderSourceActivate).toHaveBeenCalledWith(
      expect.objectContaining({ media_id: "media-1", snippet: "PDF quote" }),
    );
    expect(onAskAboutSource).toHaveBeenCalledWith(
      expect.objectContaining({ media_id: "media-1", snippet: "PDF quote" }),
    );
    expect(onSaveSourceQuote).toHaveBeenCalledWith(
      expect.objectContaining({ media_id: "media-1", snippet: "PDF quote" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("PDF quote"),
    );
  });

  it("renders unresolved app evidence sources as non-clickable", () => {
    const onReaderSourceActivate = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      content: "The paper makes the claim.",
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Research paper" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: "The paper makes the claim.",
          answer_start_offset: 0,
          answer_end_offset: "The paper makes the claim.".length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Research paper",
            media_id: "media-1",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: pdfResultRef({
            title: "Research paper",
            citationLabel: "p. 12",
            page: 12,
            exact: "The exact app-source excerpt.",
          }),
          exact_snippet: "The exact app-source excerpt.",
          locator: null,
          deep_link: null,
          score: 0.82,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
      />,
    );

    expect(screen.getByLabelText("Citation 1")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open citation 1" })).toBeNull();

    openEvidence();

    expect(
      screen.queryByRole("button", { name: /open source p\. 12/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /p\. 12/i })).toBeNull();
    expect(screen.getByText("p. 12")).toBeInTheDocument();

    openAllDetails();

    expect(screen.getAllByText("Available from prompt").length).toBeGreaterThan(
      0,
    );
    expect(onReaderSourceActivate).not.toHaveBeenCalled();
  });

  it("renders unsupported claims as evidence diagnostics", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "There is not enough scoped evidence to answer that.",
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "library",
        scope_ref: { library_name: "Research library" },
        retrieval_status: "excluded_by_scope",
        support_status: "not_enough_evidence",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 0,
        unsupported_claim_count: 1,
        not_enough_evidence_count: 1,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: "There is not enough scoped evidence to answer that.",
          answer_start_offset: null,
          answer_end_offset: null,
          claim_kind: "insufficient_evidence",
          support_status: "not_enough_evidence",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
    ]);

    render(<MessageRow message={message} />);

    expect(screen.getAllByText("Not enough evidence").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("1 unsupported")).toBeInTheDocument();
    openAllDetails();

    expect(
      screen.getAllByText(/support_status: not_enough_evidence/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Excluded by scope").length).toBeGreaterThan(0);
    expect(screen.getByText("Needs more evidence: 1")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "1" })).toBeNull();
  });

  it("renders short user messages as compact prompt blocks", () => {
    const message: MessageFixture = {
      ...baseMessage,
      id: "user-1",
      role: "user",
      content: "Please summarize this.",
      message_document: messageDocument([textBlock("Please summarize this.")]),
    };

    render(<MessageRow message={message} />);

    const prompt = screen.getByRole("group", { name: "User prompt" });
    expect(prompt).toHaveAttribute("data-presentation", "compact");
    expect(prompt).toHaveTextContent("Please summarize this.");
    expect(prompt).toHaveTextContent("You");
  });

  it("expands structured user prompts into readable prompt blocks", () => {
    const message: MessageFixture = {
      ...baseMessage,
      id: "user-1",
      role: "user",
      content: ["Review this:", "```ts", "const value = 1;", "```"].join("\n"),
      message_document: messageDocument([
        textBlock(
          ["Review this:", "```ts", "const value = 1;", "```"].join("\n"),
        ),
      ]),
    };

    render(<MessageRow message={message} />);

    const prompt = screen.getByRole("group", { name: "User prompt" });
    expect(prompt).toHaveAttribute("data-presentation", "expanded");
    expect(prompt).toHaveTextContent("Review this:");
    expect(prompt).toHaveTextContent("const value = 1;");
  });

  it("shows title and route snapshots in inline citation hover cards", async () => {
    const message: MessageFixture = {
      ...baseMessage,
      role: "user",
      content: "Use these notes.",
      contexts: [
        {
          kind: "object_ref",
          type: "note_block",
          id: "note-1",
          title: "Project notes",
          route: "/notes/note-1",
        },
        {
          kind: "object_ref",
          type: "media",
          id: "media-1",
          title: "Source article",
          route: "/media/media-1",
        },
      ],
    };

    render(<MessageRow message={message} />);

    const citation = screen.getByLabelText("Open citation 1");
    fireEvent.pointerEnter(citation);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(screen.getByText("Project notes")).toBeInTheDocument();
    expect(screen.getByText("/notes/note-1")).toBeInTheDocument();
  });

  it("links object-ref user citation chips to available source routes", () => {
    const message: MessageFixture = {
      ...baseMessage,
      role: "user",
      content: "Use these contexts.",
      contexts: [
        {
          kind: "object_ref",
          type: "highlight",
          id: "highlight-1",
          media_id: "media-1",
          title: "Saved quote",
        },
        {
          kind: "object_ref",
          type: "page",
          id: "page-1",
          title: "Project page",
        },
        {
          kind: "object_ref",
          type: "note_block",
          id: "note-1",
          title: "Project note",
        },
        {
          kind: "object_ref",
          type: "content_chunk",
          id: "chunk-1",
          media_id: "media-2",
          evidence_span_ids: ["span-1"],
          title: "Source chunk",
        },
        {
          kind: "object_ref",
          type: "media",
          id: "media-3",
          title: "Media source",
        },
        {
          kind: "object_ref",
          type: "podcast",
          id: "podcast-1",
          title: "Podcast source",
        },
        {
          kind: "object_ref",
          type: "fragment",
          id: "fragment-2",
          media_id: "media-4",
          title: "Article fragment",
        },
        {
          kind: "object_ref",
          type: "evidence_span",
          id: "span-2",
          media_id: "media-5",
          title: "Evidence span",
        },
        {
          kind: "object_ref",
          type: "conversation",
          id: "conversation-2",
          title: "Conversation",
        },
        {
          kind: "object_ref",
          type: "message",
          id: "message-2",
          title: "Message",
          locator: {
            type: "message_offsets",
            conversation_id: "conversation-3",
            message_id: "message-2",
            start_offset: 0,
            end_offset: 5,
          },
        },
        {
          kind: "object_ref",
          type: "artifact_part",
          id: "part-1",
          title: "Artifact part",
          locator: {
            type: "artifact_part_ref",
            artifact_id: "artifact-1",
            artifact_part_id: "part-1",
            message_id: "assistant-1",
            conversation_id: "conversation-4",
          },
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(screen.getByLabelText("Open citation 1")).toHaveAttribute(
      "href",
      "/media/media-1?highlight=highlight-1",
    );
    expect(screen.getByLabelText("Open citation 2")).toHaveAttribute(
      "href",
      "/pages/page-1",
    );
    expect(screen.getByLabelText("Open citation 3")).toHaveAttribute(
      "href",
      "/notes/note-1",
    );
    expect(screen.getByLabelText("Open citation 4")).toHaveAttribute(
      "href",
      "/media/media-2?evidence=span-1",
    );
    expect(screen.getByLabelText("Open citation 5")).toHaveAttribute(
      "href",
      "/media/media-3",
    );
    expect(screen.getByLabelText("Open citation 6")).toHaveAttribute(
      "href",
      "/podcasts/podcast-1",
    );
    expect(screen.getByLabelText("Open citation 7")).toHaveAttribute(
      "href",
      "/media/media-4?fragment=fragment-2",
    );
    expect(screen.getByLabelText("Open citation 8")).toHaveAttribute(
      "href",
      "/media/media-5?evidence=span-2",
    );
    expect(screen.getByLabelText("Open citation 9")).toHaveAttribute(
      "href",
      "/conversations/conversation-2",
    );
    expect(screen.getByLabelText("Open citation 10")).toHaveAttribute(
      "href",
      "/conversations/conversation-3",
    );
    expect(screen.getByLabelText("Open citation 11")).toHaveAttribute(
      "href",
      "/conversations/conversation-4?artifact=artifact-1&artifactPart=part-1",
    );
  });

  it("reports reader-selection inline citation targets upward", () => {
    const onReaderSourceActivate = vi.fn();
    const message: MessageFixture = {
      ...baseMessage,
      role: "user",
      content: "Use these quotes.",
      contexts: [
        {
          kind: "reader_selection",
          client_context_id: "selection-1",
          media_id: "media-1",
          source_media_id: "media-1",
          source_version: "pdf:media-1:v1",
          media_title: "Source PDF",
          media_kind: "pdf",
          exact: "Selected quote text.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 4,
            quads: [{ x1: 1, y1: 1, x2: 2, y2: 1, x3: 2, y3: 2, x4: 1, y4: 2 }],
            exact: "Selected quote text.",
            text_quote_selector: { exact: "Selected quote text." },
          },
          title: "Source PDF",
          route: "/media/media-1?evidence=span-1&page=4",
        },
        {
          kind: "object_ref",
          type: "note_block",
          id: "note-1",
          title: "Project notes",
        },
      ],
    };

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open citation 1" }));

    expect(onReaderSourceActivate).toHaveBeenCalledWith({
      source: "message_context",
      media_id: "media-1",
      locator: {
        type: "pdf_page_geometry",
        media_id: "media-1",
        page_number: 4,
        quads: [{ x1: 1, y1: 1, x2: 2, y2: 1, x3: 2, y3: 2, x4: 1, y4: 2 }],
        exact: "Selected quote text.",
        text_quote_selector: { exact: "Selected quote text." },
      },
      snippet: "Selected quote text.",
      source_version: "pdf:media-1:v1",
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: "attached_context",
      label: "Source PDF",
      href: "/media/media-1?evidence=span-1&page=4",
      context_id: "selection-1",
    });
    expect(
      screen.queryByRole("button", { name: "Open citation 2" }),
    ).toBeNull();
  });

  it("labels active web-search tool activity", () => {
    const message: MessageFixture = {
      ...baseMessage,
      status: "pending",
      tool_calls: [
        {
          assistant_message_id: "assistant-1",
          tool_name: "web_search",
          tool_call_index: 0,
          status: "running",
          retrievals: [],
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("Searching web")).toBeInTheDocument();
  });

  it("renders retrieved sources and source manifest before the answer", () => {
    const sourceManifest = {
      type: "source_manifest" as const,
      assistant_message_id: "assistant-1",
      tool_call_id: "tool-1",
      tool_name: "app_search" as const,
      tool_call_index: 0,
      scope: "all",
      filters: {},
      requested_types: ["highlight", "page"],
      candidate_count: 4,
      result_count: 4,
      selected_count: 2,
      included_in_prompt_count: 2,
      excluded_by_budget_count: 0,
      excluded_by_scope_count: 0,
      stale_count: 0,
      unreadable_count: 0,
      index_versions: [],
      latency_ms: 24,
      status: "complete" as const,
    };
    const message: MessageFixture = {
      ...baseMessage,
      tool_calls: [
        {
          id: "tool-1",
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 0,
          status: "complete",
          scope: "all",
          requested_types: ["highlight", "page"],
          latency_ms: 24,
          retrievals: [
            {
              id: "retrieval-1",
              tool_call_id: "tool-1",
              ordinal: 0,
              result_type: "highlight",
              source_id: "highlight-1",
              media_id: "media-1",
              context_ref: { type: "highlight", id: "highlight-1" },
              result_ref: {
                type: "highlight",
                id: "highlight-1",
                result_type: "highlight",
                source_id: "highlight-1",
                color: "yellow",
                exact: "Important saved quote.",
                title: "Saved Quote",
                source_label: "Reader Source",
                snippet: "Important saved quote.",
                deep_link: "/media/media-1?highlight=highlight-1",
                context_ref: { type: "highlight", id: "highlight-1" },
                media_id: "media-1",
                media_kind: "web_article",
                score: 0.92,
                selected: true,
                source_version: "highlight:highlight-1:v1",
                locator: {
                  type: "web_text_offsets",
                  media_id: "media-1",
                  fragment_id: "fragment-1",
                  start_offset: 4,
                  end_offset: 12,
                },
              },
              deep_link: "/media/media-1?highlight=highlight-1",
              locator: {
                type: "epub_fragment_offsets",
                media_id: "media-1",
                section_id: "section-1",
                fragment_id: "fragment-1",
                start_offset: 4,
                end_offset: 12,
              },
              score: 0.92,
              selected: true,
              exact_snippet: "Important saved quote.",
              retrieval_status: "included_in_prompt",
              included_in_prompt: true,
              source_version: "fragment-run:v1",
            },
          ],
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      sourceManifest,
      ...message.tool_calls!.flatMap((toolCall) =>
        (toolCall.retrievals ?? []).map((retrieval) => ({
          type: "retrieval_result" as const,
          ...retrieval,
        })),
      ),
    ]);

    render(<MessageRow message={message} />);

    expect(
      screen.getByRole("region", { name: "Source manifest" }),
    ).toHaveTextContent("highlight, page");
    expect(
      screen.getByRole("region", { name: "Source manifest" }),
    ).toHaveTextContent("2/4 selected");
    expect(
      screen.getByRole("region", { name: "Retrieved sources" }),
    ).toHaveTextContent("Important saved quote.");
    expect(
      screen.getByRole("region", { name: "Retrieved sources" }),
    ).toHaveTextContent("Available from prompt");
    expect(
      screen.getByRole("region", { name: "Retrieved sources" }),
    ).toHaveTextContent("fragment-run:v1");
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      "/media/media-1?highlight=highlight-1",
    );
    expect(
      screen.getByRole("button", { name: "Copy citation" }),
    ).toBeInTheDocument();
  });

  it("routes locatable retrieval-card actions through reader source targets", () => {
    const onReaderSourceActivate = vi.fn();
    const onAskAboutSource = vi.fn();
    const onSaveSourceQuote = vi.fn();
    const locator = {
      type: "epub_fragment_offsets",
      media_id: "media-1",
      section_id: "section-1",
      fragment_id: "fragment-1",
      start_offset: 4,
      end_offset: 12,
    } as const;
    const message: MessageFixture = {
      ...baseMessage,
      tool_calls: [
        {
          id: "tool-1",
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 0,
          status: "complete",
          retrievals: [
            {
              id: "retrieval-1",
              tool_call_id: "tool-1",
              ordinal: 0,
              result_type: "highlight",
              source_id: "highlight-1",
              media_id: "media-1",
              evidence_span_id: "span-1",
              context_ref: { type: "highlight", id: "highlight-1" },
              result_ref: {
                type: "highlight",
                id: "highlight-1",
                result_type: "highlight",
                source_id: "highlight-1",
                color: "yellow",
                exact: "Important saved quote.",
                title: "Saved Quote",
                source_label: "Reader Source",
                snippet: "Important saved quote.",
                deep_link: "/media/media-1?highlight=highlight-1",
                context_ref: { type: "highlight", id: "highlight-1" },
                media_id: "media-1",
                media_kind: "web_article",
                score: 0.92,
                selected: true,
                source_version: "highlight:highlight-1:v1",
                locator,
              },
              deep_link: "/media/media-1?highlight=highlight-1",
              locator,
              score: 0.92,
              selected: true,
              exact_snippet: "Important saved quote.",
              retrieval_status: "selected",
              included_in_prompt: true,
              source_version: "fragment-run:v1",
            },
          ],
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      ...message.tool_calls!.flatMap((toolCall) =>
        (toolCall.retrievals ?? []).map((retrieval) => ({
          type: "retrieval_result" as const,
          ...retrieval,
        })),
      ),
    ]);

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
        onAskAboutSource={onAskAboutSource}
        onSaveSourceQuote={onSaveSourceQuote}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    fireEvent.click(screen.getByRole("button", { name: "Save quote" }));

    const target = {
      source: "message_retrieval",
      media_id: "media-1",
      locator,
      snippet: "Important saved quote.",
      source_version: "fragment-run:v1",
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: "selected",
      label: "Saved Quote",
      href: "/media/media-1?highlight=highlight-1",
      evidence_span_id: "span-1",
      evidence_id: "retrieval-1",
      context_id: "highlight-1",
    };
    expect(onReaderSourceActivate).toHaveBeenCalledWith(target);
    expect(onAskAboutSource).toHaveBeenCalledWith(target);
    expect(onSaveSourceQuote).toHaveBeenCalledWith(target);
  });

  it("renders web retrieval cards as inspectable retrieved sources", () => {
    const message: MessageFixture = {
      ...baseMessage,
      tool_calls: [
        {
          id: "tool-1",
          assistant_message_id: "assistant-1",
          tool_name: "web_search",
          tool_call_index: 1,
          status: "complete",
          scope: "public_web",
          requested_types: ["mixed"],
          latency_ms: 31,
          retrievals: [
            {
              id: "retrieval-web-1",
              tool_call_id: "tool-1",
              ordinal: 0,
              result_type: "web_result",
              source_id: "web:1",
              media_id: null,
              context_ref: { type: "web_result", id: "web:1" },
              result_ref: {
                type: "web_result",
                id: "web:1",
                result_type: "web_result",
                result_ref: "web:1",
                source_id: "web:1",
                title: "External source",
                url: "https://example.com/source",
                display_url: "example.com/source",
                deep_link: "https://example.com/source",
                snippet: "External web evidence snippet.",
                provider: "test",
                source_version: "web_search:test:web:1",
                context_ref: { type: "web_result", id: "web:1" },
                media_id: null,
                media_kind: null,
                score: null,
                selected: true,
                locator: {
                  type: "external_url",
                  url: "https://example.com/source",
                  title: "External source",
                  display_url: "example.com/source",
                },
              },
              deep_link: "https://example.com/source",
              score: null,
              selected: true,
              exact_snippet: "External web evidence snippet.",
              retrieval_status: "web_result",
              included_in_prompt: true,
            },
          ],
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      ...message.tool_calls!.flatMap((toolCall) =>
        (toolCall.retrievals ?? []).map((retrieval) => ({
          type: "retrieval_result" as const,
          ...retrieval,
        })),
      ),
    ]);

    render(<MessageRow message={message} />);

    const retrieved = screen.getByRole("region", { name: "Retrieved sources" });
    expect(retrieved).toHaveTextContent("External source");
    expect(retrieved).toHaveTextContent("External web evidence snippet.");
    expect(retrieved).toHaveTextContent("web result");
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "href",
      "https://example.com/source",
    );
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
      "target",
      "_blank",
    );
  });

  it("renders selected highlight evidence as a claim citation source", () => {
    const content = "The saved quote says the important thing.";
    const message: MessageFixture = {
      ...baseMessage,
      content,
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "general",
        scope_ref: null,
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: content,
          answer_start_offset: 0,
          answer_end_offset: content.length,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Saved Quote",
            media_id: "media-1",
            deep_link: "/media/media-1?highlight=highlight-1",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "highlight", id: "highlight-1" },
          result_ref: {
            type: "highlight",
            id: "highlight-1",
            result_type: "highlight",
            source_id: "highlight-1",
            color: "yellow",
            exact: "Important saved quote.",
            title: "Saved Quote",
            source_label: "Reader Source",
            snippet: "Important saved quote.",
            deep_link: "/media/media-1?highlight=highlight-1",
            context_ref: { type: "highlight", id: "highlight-1" },
            media_id: "media-1",
            media_kind: "web_article",
            score: 0.92,
            selected: true,
            source_version: "highlight:highlight-1:v1",
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              fragment_id: "fragment-1",
              start_offset: 4,
              end_offset: 12,
            },
          },
          exact_snippet: "Important saved quote.",
          locator: {
            type: "external_url",
            title: "highlight",
            url: "/media/media-1?highlight=highlight-1",
          },
          deep_link: "/media/media-1?highlight=highlight-1",
          score: 0.92,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(content),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(<MessageRow message={message} />);

    expect(
      screen.getByRole("link", { name: "Open citation 1" }),
    ).toHaveAttribute("href", "/media/media-1?highlight=highlight-1");
    openEvidence();
    expect(screen.getByText("Important saved quote.")).toBeInTheDocument();
  });

  it("surfaces supported claims that cannot be placed inline", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "The saved quote says the important thing.",
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "general",
        scope_ref: null,
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "llm_verified",
        claim_count: 1,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        not_enough_evidence_count: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      claims: [
        {
          id: "claim-1",
          message_id: "assistant-1",
          ordinal: 0,
          claim_text: "The saved quote says the important thing.",
          answer_start_offset: null,
          answer_end_offset: null,
          claim_kind: "answer",
          support_status: "supported",
          verifier_status: "llm_verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [
        {
          id: "evidence-1",
          claim_id: "claim-1",
          ordinal: 0,
          evidence_role: "supports",
          source_ref: {
            type: "message_retrieval",
            id: "retrieval-1",
            label: "Saved Quote",
          },
          retrieval_id: "retrieval-1",
          exact_snippet: "Important saved quote.",
          deep_link: "/media/media-1?highlight=highlight-1",
          score: 0.92,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    message.message_document = messageDocument([
      textBlock(message.content ?? ""),
      { type: "verification_summary", ...message.evidence_summary! },
      ...message.claims!.map(claimBlock),
      ...message.claim_evidence!.map(claimEvidenceBlock),
    ]);

    render(<MessageRow message={message} />);

    openEvidence();
    expect(
      screen.getByText("1 supported claims need answer offsets"),
    ).toBeInTheDocument();
    openAllDetails();
    expect(screen.getByText("answer_offsets: missing")).toBeInTheDocument();
  });

  it("does not treat placeholder citation syntax as citation source of truth", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "This answer has model-minted placeholders <<cite:1>> and [1].",
      message_document: messageDocument([
        textBlock(
          "This answer has model-minted placeholders <<cite:1>> and [1].",
        ),
      ]),
    };

    render(<MessageRow message={message} />);

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName.toLowerCase() === "p" &&
          element.textContent?.includes("<<cite:1>>") === true,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open citation 1" })).toBeNull();
    expect(screen.queryByLabelText("Citation 1")).toBeNull();
  });

  it("shows incomplete model responses as readable failures", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "The model ran out of output tokens before it could finish.",
      message_document: messageDocument([
        textBlock("The model ran out of output tokens before it could finish."),
      ]),
      status: "error",
      error_code: "E_LLM_INCOMPLETE",
    };

    render(<MessageRow message={message} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Response stopped before completion.",
    );
    expect(screen.queryByText("E_LLM_INCOMPLETE")).not.toBeInTheDocument();
  });

  it("does not render generic backend failure prose as assistant body content", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "An unexpected error occurred. Please try again.",
      message_document: messageDocument([
        textBlock("An unexpected error occurred. Please try again."),
      ]),
      status: "error",
      error_code: "E_INTERNAL",
    };

    render(<MessageRow message={message} />);

    expect(screen.getByRole("alert")).toHaveTextContent("The response failed.");
    expect(
      screen.queryByText("An unexpected error occurred. Please try again."),
    ).not.toBeInTheDocument();
  });

  it("keeps partial assistant content before the terminal failure notice", () => {
    const message: MessageFixture = {
      ...baseMessage,
      content: "Partial answer before failure.",
      message_document: messageDocument([
        textBlock("Partial answer before failure."),
      ]),
      status: "error",
      error_code: "E_INTERNAL",
    };

    render(<MessageRow message={message} />);

    expect(
      screen.getByText("Partial answer before failure."),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The response failed.");
  });
});
