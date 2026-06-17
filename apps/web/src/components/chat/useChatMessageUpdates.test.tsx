import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import { useChatMessageUpdates } from "./useChatMessageUpdates";
import type { SSECitationIndexEvent } from "@/lib/api/sse/events";
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { ConversationMessage } from "@/lib/conversations/types";

const ASSISTANT_ID = "assistant-1";
const NOTE_BLOCK_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";

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
});
