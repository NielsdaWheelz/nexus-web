import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import AssistantEvidenceDisclosure from "./AssistantEvidenceDisclosure";
import { useChatMessageUpdates } from "./useChatMessageUpdates";
import type { SSECitationIndexEvent } from "@/lib/api/sse/events";
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
  };
}

// Two edges: one supports/note_block with a deep link (renders as a link chip)
// and one context/media without a deep link (renders as a plain chip).
const TWO_ENTRY_EVENT: SSECitationIndexEvent["data"] = {
  assistant_message_id: ASSISTANT_ID,
  entries: [
    {
      citation_edge_id: "edge-1",
      n: 1,
      target_ref: { type: "note_block", id: NOTE_BLOCK_ID },
      kind: "supports",
      deep_link: "/notes/page-1#block",
      snapshot: {
        title: "Cited note",
        excerpt: "the cited claim",
        section_label: null,
        result_type: null,
      },
    },
    {
      citation_edge_id: "edge-2",
      n: 2,
      target_ref: { type: "media", id: MEDIA_ID },
      kind: "context",
      deep_link: null,
      snapshot: {
        title: "Background source",
        excerpt: null,
        section_label: null,
        result_type: null,
      },
    },
  ],
};

// A later index for the same message carrying only the first edge.
const ONE_ENTRY_EVENT: SSECitationIndexEvent["data"] = {
  assistant_message_id: ASSISTANT_ID,
  entries: [TWO_ENTRY_EVENT.entries[0]],
};

// Drives the real fold (useChatMessageUpdates.handleCitationIndex) over real
// message state and renders the real disclosure. Each button dispatches a
// citation_index event so the assertion is on what the user sees before vs.
// after the event arrives. The list mirrors the folded read-model
// (ordinal/kind/target) that flows to render, so we can assert n/kind/target.
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
        onClick={() => handleCitationIndex(ASSISTANT_ID, TWO_ENTRY_EVENT)}
      >
        Fold two
      </button>
      <button
        type="button"
        onClick={() => handleCitationIndex(ASSISTANT_ID, ONE_ENTRY_EVENT)}
      >
        Fold one
      </button>
      <AssistantEvidenceDisclosure message={message} />
      <ul aria-label="folded citations">
        {(message.citations ?? []).map((citation) => (
          <li key={citation.ordinal}>
            {`${citation.ordinal}:${citation.role}:${citation.target_ref.type}:${citation.target_ref.id}`}
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
  it("folds a citation_index event into chips with the right n/kind/target", async () => {
    const user = userEvent.setup();
    render(<CitationIndexHarness />);

    // No chips before the citation_index event lands.
    expect(
      screen.queryByRole("link", { name: "Open citation 1" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Citation 2")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fold two" }));

    // The deep-linked supports edge renders as an actionable [1] link chip; the
    // deep-link-less context edge renders as a plain [2] chip.
    const chip1 = await screen.findByRole("link", { name: "Open citation 1" });
    expect(chip1).toHaveTextContent("1");
    expect(chip1).toHaveAttribute("href", "/notes/page-1#block");

    const chip2 = screen.getByLabelText("Citation 2");
    expect(chip2).toHaveTextContent("2");

    // The folded read-model carries the right ordinal (n), role (kind), and
    // target_ref for each edge, in order.
    expect(foldedRows()).toEqual([
      `1:supports:note_block:${NOTE_BLOCK_ID}`,
      `2:context:media:${MEDIA_ID}`,
    ]);
  });

  it("replaces a prior citation_index with the latest one (replace, not merge)", async () => {
    const user = userEvent.setup();
    render(<CitationIndexHarness />);

    await user.click(screen.getByRole("button", { name: "Fold two" }));
    expect(
      await screen.findByRole("link", { name: "Open citation 1" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Citation 2")).toBeInTheDocument();

    // A later event with a single edge supersedes the prior read-model wholesale:
    // chip [2] disappears and only [1] remains.
    await user.click(screen.getByRole("button", { name: "Fold one" }));

    expect(screen.queryByLabelText("Citation 2")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open citation 1" }),
    ).toBeInTheDocument();
    expect(foldedRows()).toEqual([`1:supports:note_block:${NOTE_BLOCK_ID}`]);
  });
});
