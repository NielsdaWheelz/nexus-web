import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageRow } from "./MessageRow";
import type { ConversationMessage } from "@/lib/conversations/types";

const baseMessage = {
  id: "assistant-1",
  seq: 1,
  role: "assistant",
  content: "Current answer.",
  status: "complete",
  error_code: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

describe("MessageRow", () => {
  it("renders persisted claim evidence with exact web snippets and statuses", () => {
    const content = "Nexus cites exact evidence.";
    const message: ConversationMessage = {
      ...baseMessage,
      content,
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "general",
        scope_ref: null,
        retrieval_status: "web_result",
        support_status: "supported",
        verifier_status: "verified",
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
          claim_kind: "source_grounded",
          support_status: "supported",
          verifier_status: "verified",
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
            type: "web_result",
            id: "web-result-1",
            label: "Example result",
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "web_result", id: "web-result-1" },
          result_ref: {
            title: "Example result",
            url: "https://example.com/story",
            display_url: "example.com",
          },
          exact_snippet: "A relevant web excerpt.",
          locator: {
            type: "web_url",
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
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute(
      "href",
      "#claim-evidence-1-1",
    );
    const link = screen.getByRole("link", { name: /example result/i });
    expect(link).toHaveAttribute("href", "https://example.com/story");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("A relevant web excerpt.")).toBeInTheDocument();
    expect(
      screen.getAllByText(/support_status: supported/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("retrieval_status: web_result").length).toBe(2);
    expect(screen.getByText("selected: true")).toBeInTheDocument();
    expect(screen.getByText("included_in_prompt: true")).toBeInTheDocument();
  });

  it("renders app evidence with app links, exact snippets, and locator detail", () => {
    const content = "The paper makes the claim.";
    const message: ConversationMessage = {
      ...baseMessage,
      content,
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "media",
        scope_ref: { title: "Research paper" },
        retrieval_status: "included_in_prompt",
        support_status: "supported",
        verifier_status: "verified",
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
          claim_kind: "source_grounded",
          support_status: "supported",
          verifier_status: "verified",
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
          result_ref: { title: "Research paper" },
          exact_snippet: "The exact app-source excerpt.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 12,
            quads: [],
            exact: "The exact app-source excerpt.",
          },
          deep_link: "/media/media-1?page=12",
          score: 0.82,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    render(<MessageRow message={message} />);

    const link = screen.getByRole("link", { name: /research paper/i });
    expect(link).toHaveAttribute("href", "/media/media-1?page=12");
    expect(link).not.toHaveAttribute("target");
    expect(screen.getByText("The exact app-source excerpt.")).toBeInTheDocument();
    expect(
      screen.getAllByText("retrieval_status: included_in_prompt").length,
    ).toBe(2);
    expect(screen.getByText("page: 12")).toBeInTheDocument();
  });

  it("renders unsupported claims as evidence diagnostics", () => {
    const message: ConversationMessage = {
      ...baseMessage,
      content: "There is not enough scoped evidence to answer that.",
      evidence_summary: {
        id: "summary-1",
        message_id: "assistant-1",
        scope_type: "library",
        scope_ref: { library_name: "Research library" },
        retrieval_status: "excluded_by_scope",
        support_status: "not_enough_evidence",
        verifier_status: "verified",
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
          verifier_status: "verified",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      claim_evidence: [],
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("Not enough evidence")).toBeInTheDocument();
    expect(screen.getAllByText(/support_status: not_enough_evidence/i).length).toBe(2);
    expect(screen.getByText("retrieval_status: excluded_by_scope")).toBeInTheDocument();
    expect(screen.getByText("not_enough_evidence_count: 1")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "1" })).toBeNull();
  });

  it("does not render legacy source chips when persisted evidence is absent", () => {
    const message = {
      ...baseMessage,
      citations: [
        {
          title: "Legacy web result",
          url: "https://example.com/legacy",
          display_url: "example.com",
          snippet: "Legacy snippet.",
        },
      ],
      tool_calls: [
        {
          assistant_message_id: "assistant-1",
          tool_name: "app_search",
          tool_call_index: 0,
          status: "complete",
          retrievals: [
            {
              result_type: "media",
              source_id: "media-1",
              media_id: "media-1",
              context_ref: { type: "media", id: "media-1" },
              result_ref: {
                result_type: "media",
                source_id: "media-1",
                title: "Legacy app source",
                source_label: "Legacy app source",
                snippet: "Legacy app snippet.",
                deep_link: "/media/media-1",
                context_ref: { type: "media", id: "media-1" },
                media_id: "media-1",
                media_kind: "web_article",
                score: 0.5,
                selected: true,
              },
              deep_link: "/media/media-1",
              score: 0.5,
              selected: true,
            },
          ],
        },
      ],
    } as ConversationMessage & {
      citations: Array<{ title: string; url: string; display_url: string; snippet: string }>;
    };

    render(<MessageRow message={message} />);

    expect(screen.queryByRole("link", { name: /legacy web result/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /legacy app source/i })).toBeNull();
    expect(screen.queryByText("Legacy app snippet.")).toBeNull();
  });

  it("labels active web-search tool activity", () => {
    const message: ConversationMessage = {
      ...baseMessage,
      status: "pending",
      tool_calls: [
        {
          assistant_message_id: "assistant-1",
          tool_name: "web_search",
          tool_call_index: 0,
          status: "started",
          retrievals: [],
        },
      ],
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("Searching web")).toBeInTheDocument();
  });

  it("shows incomplete model responses as readable failures", () => {
    const message: ConversationMessage = {
      ...baseMessage,
      content: "The model ran out of output tokens before it could finish.",
      status: "error",
      error_code: "E_LLM_INCOMPLETE",
    };

    render(<MessageRow message={message} />);

    expect(screen.getByText("Response stopped before completion.")).toBeInTheDocument();
    expect(screen.getByText("E_LLM_INCOMPLETE")).toBeInTheDocument();
  });
});
