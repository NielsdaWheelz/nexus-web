import { describe, expect, it } from "vitest";
import { buildCitations } from "./citations";
import type { ConversationMessage, MessageRetrieval } from "./types";

const locator = {
  type: "web_text_offsets",
  media_id: "media-1",
  fragment_id: "fragment-1",
  start_offset: 10,
  end_offset: 24,
} as const;

const retrieval = {
  id: "retrieval-1",
  tool_call_id: "tool-call-1",
  ordinal: 0,
  result_type: "fragment",
  source_id: "fragment-1",
  media_id: "media-1",
  evidence_span_id: "span-1",
  context_ref: { type: "fragment", id: "fragment-1" },
  result_ref: {} as MessageRetrieval["result_ref"],
  deep_link: null,
  locator,
  score: 0.8,
  selected: true,
  source_title: "Source title",
  section_label: "Section",
  exact_snippet: "matched source text",
  retrieval_status: "retrieved",
  source_version: "fragment:fragment-1:v1",
} satisfies MessageRetrieval;

function assistantMessage(): ConversationMessage {
  return {
    id: "assistant-1",
    seq: 2,
    role: "assistant",
    status: "complete",
    error_code: null,
    can_retry_response: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    retrievals: [retrieval],
    citation_index: [
      {
        n: 1,
        retrieval_id: "retrieval-1",
        tool_call_id: "tool-call-1",
        ordinal: 0,
      },
    ],
  };
}

describe("buildCitations", () => {
  it("builds reader citation data from message retrievals", () => {
    expect(buildCitations(assistantMessage())).toEqual([
      {
        index: 1,
        color: "yellow",
        preview: {
          title: "Source title",
          excerpt: "matched source text",
          meta: ["Section", "fragment"],
        },
        href: "/media/media-1#evidence-span-1",
        target: {
          source: "message_retrieval",
          media_id: "media-1",
          locator,
          snippet: "matched source text",
          source_version: "fragment:fragment-1:v1",
          highlight_behavior: "pulse",
          focus_behavior: "scroll_into_view",
          status: "retrieved",
          label: "Source title",
          href: "/media/media-1#evidence-span-1",
          evidence_span_id: "span-1",
          evidence_id: "retrieval-1",
        },
      },
    ]);
  });
});
