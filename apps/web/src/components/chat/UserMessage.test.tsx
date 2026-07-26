import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { present } from "@/lib/api/presence";
import type { ConversationMessage } from "@/lib/conversations/types";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import UserMessage from "./UserMessage";
import SystemMessage from "./SystemMessage";

const timestamp = "2026-06-03T00:00:00Z";

function message(
  id: string,
  role: ConversationMessage["role"],
  text: string,
): ConversationMessage {
  return {
    id,
    seq: 1,
    role,
    message_document: {
      type: "message_document",
      blocks: [{ type: "text", format: "plain", text }],
    },
    parent_message_id: null,
    trust_trail: null,
    status: "complete",
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

// Human and assistant turns share the quiet timestamp contract while only the
// human turn keeps the accent-rail prompt treatment.
describe("chat human rows keep their timestamp", () => {
  it("user row renders its timestamp in the normal chat register", () => {
    render(
      <UserMessage
        message={message("user-1", "user", "What is the capital of France?")}
        timestampLabel="Jun 3"
      />,
    );

    const stamp = screen.getByText("Jun 3");
    expect(stamp).toBeInTheDocument();
    expect(stamp).toHaveAttribute("datetime", timestamp);
    expect(screen.getByRole("group", { name: "Your message" })).toContainElement(
      screen.getByText("What is the capital of France?"),
    );
    // eslint-disable-next-line testing-library/no-node-access -- asserting the hard-cut machine wrapper has no compatibility path
    expect(stamp.closest("[data-machine-origin]")).toBeNull();
  });

  it("system row renders its timestamp", () => {
    render(
      <SystemMessage
        message={message("system-1", "system", "Conversation renamed.")}
        timestampLabel="Jun 4"
      />,
    );

    expect(screen.getByText("Jun 4")).toBeInTheDocument();
  });
});

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT_ID = "22222222-2222-4222-8222-222222222222";

function quotedSelection(): ReaderSelectionOut {
  return {
    key: { mediaId: MEDIA_ID, highlightId: HIGHLIGHT_ID },
    sourceLabel: "On the Origin of Species",
    exact: "endless forms most beautiful",
    prefix: "",
    suffix: "",
    locator: {
      type: "web_text_offsets",
      media_id: MEDIA_ID,
      fragment_id: "frag-1",
      start_offset: 0,
      end_offset: 27,
    },
    activation: {
      resourceRef: `media:${MEDIA_ID}`,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolvedReason: null,
    },
  };
}

describe("UserMessage sent reader-quote card", () => {
  it("renders a read-only quote card above the user body and activates its source", async () => {
    const user = userEvent.setup();
    const onReaderSourceActivate = vi.fn();
    const quoted: ConversationMessage = {
      ...message("user-1", "user", "What does this passage mean?"),
      reader_selection: present(quotedSelection()),
    };

    render(
      <UserMessage
        message={quoted}
        timestampLabel="Jun 3"
        onReaderSourceActivate={onReaderSourceActivate}
      />,
    );

    // The immutable quote renders above the prompt body; both are visible.
    expect(screen.getByText("Quoted passage")).toBeVisible();
    expect(screen.getByText("endless forms most beautiful")).toBeVisible();
    expect(screen.getByText("What does this passage mean?")).toBeVisible();

    // Read-only: no Remove control in the sent card.
    expect(
      screen.queryByRole("button", { name: "Remove quoted passage" }),
    ).toBeNull();

    // Source activation routes through the immutable snapshot locator.
    await user.click(
      screen.getByRole("button", { name: /Open source/ }),
    );
    expect(onReaderSourceActivate).toHaveBeenCalledOnce();
    const [activation, target] = onReaderSourceActivate.mock.calls[0];
    expect(activation).toMatchObject({ kind: "route", href: `/media/${MEDIA_ID}` });
    expect(target).toMatchObject({
      kind: "media",
      source: "reader_selection",
      media_id: MEDIA_ID,
      snippet: "endless forms most beautiful",
    });
  });

  it("renders no quote card for an ordinary user message", () => {
    render(
      <UserMessage
        message={message("user-2", "user", "Just a plain question.")}
        timestampLabel="Jun 3"
      />,
    );

    expect(screen.queryByText("Quoted passage")).toBeNull();
    expect(screen.getByText("Just a plain question.")).toBeVisible();
  });
});
