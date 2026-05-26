import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AssistantEvidenceDisclosure from "@/components/chat/AssistantEvidenceDisclosure";
import type { ConversationMessage } from "@/lib/conversations/types";

function baseAssistant(): ConversationMessage {
  return {
    id: "assistant-1",
    seq: 2,
    role: "assistant",
    message_document: {
      type: "message_document",
      version: 1,
      blocks: [
        { type: "text", format: "markdown", text: "An answer about the web." },
      ],
    },
    contexts: [],
    tool_calls: [],
    status: "complete",
    error_code: null,
    can_retry_response: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function svgClassNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("svg"))
    .map((svg) => svg.getAttribute("class") ?? "")
    .filter((value): value is string => Boolean(value));
}

describe("AssistantEvidenceDisclosure", () => {
  it("does not render a web-search-mode badge for evidence summaries", () => {
    const message: ConversationMessage = {
      ...baseAssistant(),
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          { type: "text", format: "markdown", text: "An answer." },
          {
            type: "verification_summary",
            id: "summary-1",
            message_id: "assistant-1",
            scope_ref: null,
            retrieval_status: "retrieved",
            support_status: "supported",
            verifier_status: "llm_verified",
            claim_count: 1,
            supported_claim_count: 1,
            unsupported_claim_count: 0,
            not_enough_evidence_count: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    };

    render(
      <AssistantEvidenceDisclosure
        message={message}
        onActivateTarget={() => {}}
        hasReaderActivator={false}
      />,
    );

    expect(screen.queryByText(/web (auto|required|off)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/web_search_mode/i)).not.toBeInTheDocument();
  });

  it("renders a web_search source-manifest row with the Globe icon and 'Web search' label", () => {
    const message: ConversationMessage = {
      ...baseAssistant(),
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          { type: "text", format: "markdown", text: "An answer." },
          {
            type: "source_manifest",
            assistant_message_id: "assistant-1",
            tool_call_id: "tool-1",
            tool_name: "web_search",
            tool_call_index: 0,
            scope: "public_web",
            filters: {},
            requested_types: [],
            candidate_count: 1,
            result_count: 1,
            selected_count: 1,
            included_in_prompt_count: 1,
            excluded_by_budget_count: 0,
            excluded_by_scope_count: 0,
            stale_count: 0,
            unreadable_count: 0,
            index_versions: [],
            latency_ms: 30,
            status: "complete",
          },
        ],
      },
    };

    render(
      <AssistantEvidenceDisclosure
        message={message}
        onActivateTarget={() => {}}
        hasReaderActivator={false}
      />,
    );

    const manifest = screen.getByRole("region", { name: "Source manifest" });
    const toggle = screen.getByRole("button", { name: /Sources searched/i });
    fireEvent.click(toggle);

    expect(manifest).toHaveTextContent("Web search");
    expect(svgClassNames(manifest).some((cls) => cls.includes("globe"))).toBe(true);
  });

  it("renders an app_search source-manifest row with the Search icon and 'App search' label", () => {
    const message: ConversationMessage = {
      ...baseAssistant(),
      message_document: {
        type: "message_document",
        version: 1,
        blocks: [
          { type: "text", format: "markdown", text: "An answer." },
          {
            type: "source_manifest",
            assistant_message_id: "assistant-1",
            tool_call_id: "tool-2",
            tool_name: "app_search",
            tool_call_index: 0,
            scope: "all",
            filters: {},
            requested_types: ["highlight"],
            candidate_count: 2,
            result_count: 2,
            selected_count: 1,
            included_in_prompt_count: 1,
            excluded_by_budget_count: 0,
            excluded_by_scope_count: 0,
            stale_count: 0,
            unreadable_count: 0,
            index_versions: [],
            latency_ms: 12,
            status: "complete",
          },
        ],
      },
    };

    render(
      <AssistantEvidenceDisclosure
        message={message}
        onActivateTarget={() => {}}
        hasReaderActivator={false}
      />,
    );

    const manifest = screen.getByRole("region", { name: "Source manifest" });
    const toggle = screen.getByRole("button", { name: /Sources searched/i });
    fireEvent.click(toggle);

    expect(manifest).toHaveTextContent("App search");
    expect(svgClassNames(manifest).some((cls) => cls.includes("search"))).toBe(true);
  });
});
