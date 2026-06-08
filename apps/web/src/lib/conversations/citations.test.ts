import { describe, expect, it } from "vitest";
import {
  messageToCitationOuts,
  toReaderCitationData,
} from "./citations";
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

function messageWith(
  overrides: Partial<MessageRetrieval>,
): ConversationMessage {
  return {
    ...assistantMessage(),
    retrievals: [{ ...retrieval, ...overrides }],
  };
}

describe("messageToCitationOuts → toReaderCitationData", () => {
  it("renders reader citation data byte-identically to the chat citation flow", () => {
    expect(
      messageToCitationOuts(assistantMessage()).map(toReaderCitationData),
    ).toEqual([
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
          kind: "media",
          source: "message_retrieval",
          media_id: "media-1",
          locator,
          snippet: "matched source text",
          highlight_behavior: "pulse",
          focus_behavior: "scroll_into_view",
          label: "Source title",
          href: "/media/media-1#evidence-span-1",
          evidence_span_id: "span-1",
        },
      },
    ]);
  });
});

describe("messageToCitationOuts", () => {
  it("emits role 'context' and an evidence_span target_ref", () => {
    const outs = messageToCitationOuts(assistantMessage());
    expect(outs).toHaveLength(1);
    expect(outs[0]!.role).toBe("context");
    expect(outs[0]!.target_ref).toEqual({ type: "evidence_span", id: "span-1" });
  });

  it("targets a content_chunk when no span and result_type is content_chunk", () => {
    const outs = messageToCitationOuts(
      messageWith({ evidence_span_id: null, result_type: "content_chunk" }),
    );
    expect(outs[0]!.target_ref).toEqual({
      type: "content_chunk",
      id: "fragment-1",
    });
  });

  it("targets media when no span and not a content_chunk", () => {
    const outs = messageToCitationOuts(
      messageWith({ evidence_span_id: null, result_type: "fragment" }),
    );
    expect(outs[0]!.target_ref).toEqual({ type: "media", id: "media-1" });
  });

  it("returns [] when citation_index is empty", () => {
    expect(
      messageToCitationOuts({
        ...assistantMessage(),
        citation_index: [],
      }),
    ).toEqual([]);
  });
});

describe("toReaderCitationData", () => {
  it("uses deep_link for href when present", () => {
    const outs = messageToCitationOuts(
      messageWith({ deep_link: "https://example.com/source" }),
    );
    const data = toReaderCitationData(outs[0]!);
    expect(data.href).toBe("https://example.com/source");
    expect(data.target?.href).toBe("https://example.com/source");
  });

  it("falls back to hrefForReaderTarget when deep_link is null", () => {
    const outs = messageToCitationOuts(assistantMessage());
    expect(toReaderCitationData(outs[0]!).href).toBe(
      "/media/media-1#evidence-span-1",
    );
  });

  it("surfaces a per-media summary_md as the preview summary", () => {
    const outs = messageToCitationOuts(
      messageWith({ summary_md: "A concise per-media abstract." }),
    );
    expect(toReaderCitationData(outs[0]!).preview.summary).toBe(
      "A concise per-media abstract.",
    );
  });

  it("omits the preview summary when summary_md is absent or blank", () => {
    expect(
      toReaderCitationData(messageToCitationOuts(assistantMessage())[0]!).preview
        .summary,
    ).toBeUndefined();
    expect(
      toReaderCitationData(
        messageToCitationOuts(messageWith({ summary_md: "   " }))[0]!,
      ).preview.summary,
    ).toBeUndefined();
  });
});
