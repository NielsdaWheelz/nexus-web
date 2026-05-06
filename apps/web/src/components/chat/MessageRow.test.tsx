import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  it("exposes a reply fork action on complete assistant messages", () => {
    const onReplyToAssistant = vi.fn();

    render(
      <MessageRow
        message={baseMessage}
        onReplyToAssistant={onReplyToAssistant}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reply / fork from here" }),
    );

    expect(onReplyToAssistant).toHaveBeenCalledWith({
      parentMessageId: "assistant-1",
      parentMessageSeq: 1,
      parentMessagePreview: "Current answer.",
      anchor: {
        kind: "assistant_message",
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
    fireEvent.click(screen.getByRole("button", { name: "Branch from selection" }));

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
    const message: ConversationMessage = {
      ...baseMessage,
      content: "repeat then repeat.",
    };

    render(
      <MessageRow
        message={message}
        onReplyToAssistant={onReplyToAssistant}
      />,
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
    fireEvent.click(screen.getByRole("button", { name: "Branch from selection" }));

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

  it("renders app evidence with resolver links, exact snippets, and backend labels", () => {
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
          result_ref: {
            title: "Research paper",
            citation_label: "p. 12",
            resolver: {
              kind: "pdf",
              route: "/media/media-1",
              params: { evidence: "span-1", page: "12" },
              status: "resolved",
              selector: {},
            },
          },
          exact_snippet: "The exact app-source excerpt.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 12,
            quads: [],
            exact: "The exact app-source excerpt.",
          },
          deep_link: null,
          score: 0.82,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    render(<MessageRow message={message} />);

    const link = screen.getByRole("link", { name: /p\. 12/i });
    expect(link).toHaveAttribute("href", "/media/media-1?evidence=span-1&page=12");
    expect(link).not.toHaveAttribute("target");
    expect(screen.getByText("The exact app-source excerpt.")).toBeInTheDocument();
    expect(
      screen.getAllByText("retrieval_status: included_in_prompt").length,
    ).toBe(2);
    expect(screen.queryByText("page: 12")).not.toBeInTheDocument();
  });

  it("reports resolved app evidence source targets upward", () => {
    const onReaderSourceActivate = vi.fn();
    const message: ConversationMessage = {
      ...baseMessage,
      content: "The paper makes the claim.",
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
          claim_text: "The paper makes the claim.",
          answer_start_offset: 0,
          answer_end_offset: "The paper makes the claim.".length,
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
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: {
            title: "Research paper",
            citation_label: "p. 12",
            resolver: {
              kind: "pdf",
              route: "/media/media-1",
              params: { evidence: "span-1", page: "12" },
              status: "resolved",
              selector: {},
            },
          },
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
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /open source p\. 12/i }));

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
      status: "resolved",
      label: "p. 12",
      href: "/media/media-1?evidence=span-1&page=12",
      evidence_span_id: "span-1",
      evidence_id: "evidence-1",
      context_id: "media-1",
    });
  });

  it("renders unresolved app evidence sources as non-clickable", () => {
    const onReaderSourceActivate = vi.fn();
    const message: ConversationMessage = {
      ...baseMessage,
      content: "The paper makes the claim.",
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
          claim_text: "The paper makes the claim.",
          answer_start_offset: 0,
          answer_end_offset: "The paper makes the claim.".length,
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
          },
          retrieval_id: "retrieval-1",
          context_ref: { type: "media", id: "media-1" },
          result_ref: {
            citation_label: "p. 12",
            resolver: {
              kind: "pdf",
              route: "/media/media-1",
              params: { evidence: "span-1", page: "12" },
              status: "unresolved",
              selector: {},
            },
          },
          exact_snippet: "The exact app-source excerpt.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 12,
            quads: [],
            exact: "The exact app-source excerpt.",
          },
          deep_link: "/media/media-1?evidence=span-1&page=12",
          score: 0.82,
          retrieval_status: "included_in_prompt",
          selected: true,
          included_in_prompt: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };

    render(
      <MessageRow
        message={message}
        onReaderSourceActivate={onReaderSourceActivate}
      />
    );

    expect(screen.queryByRole("button", { name: /open source p\. 12/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /p\. 12/i })).toBeNull();
    expect(screen.getByText("p. 12")).toBeInTheDocument();
    expect(screen.getByText("source_status: unavailable")).toBeInTheDocument();
    expect(onReaderSourceActivate).not.toHaveBeenCalled();
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

  it("shows title and route snapshots in inline citation hover cards", () => {
    const message: ConversationMessage = {
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

    fireEvent.mouseEnter(screen.getByText("1"));

    expect(screen.getByText("Project notes")).toBeInTheDocument();
    expect(screen.getByText("/notes/note-1")).toBeInTheDocument();
  });

  it("reports reader-selection inline citation targets upward", () => {
    const onReaderSourceActivate = vi.fn();
    const message: ConversationMessage = {
      ...baseMessage,
      role: "user",
      content: "Use these quotes.",
      contexts: [
        {
          kind: "reader_selection",
          client_context_id: "selection-1",
          media_id: "media-1",
          source_media_id: "media-1",
          media_title: "Source PDF",
          media_kind: "pdf",
          exact: "Selected quote text.",
          locator: {
            type: "pdf_text_quote",
            page_number: 4,
            text_quote_selector: { exact: "Selected quote text." },
          },
          title: "Source PDF",
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
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open citation 1" }));

    expect(onReaderSourceActivate).toHaveBeenCalledWith({
      source: "message_context",
      media_id: "media-1",
      locator: {
        type: "pdf_text_quote",
        page_number: 4,
        text_quote_selector: { exact: "Selected quote text." },
      },
      snippet: "Selected quote text.",
      status: "attached_context",
      label: "Source PDF",
      context_id: "selection-1",
    });
    expect(screen.queryByRole("button", { name: "Open citation 2" })).toBeNull();
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

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Response stopped before completion."
    );
    expect(screen.queryByText("E_LLM_INCOMPLETE")).not.toBeInTheDocument();
  });
});
