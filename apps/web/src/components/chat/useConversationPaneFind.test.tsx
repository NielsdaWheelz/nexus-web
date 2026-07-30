import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationPaneFind } from "@/components/chat/useConversationPaneFind";
import type {
  ChatReadingPosition,
  ChatScrollHandle,
} from "@/components/chat/useChatScroll";
import type { ConversationMessage } from "@/lib/conversations/types";

const timestamp = "2026-07-29T00:00:00Z";

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  text: string,
  status: ConversationMessage["status"] = "complete",
): ConversationMessage {
  return {
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      blocks: [
        {
          type: "text",
          format: role === "assistant" ? "markdown" : "plain",
          text,
        },
      ],
    },
    trust_trail: null,
    status,
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function transcript(messages: readonly ConversationMessage[]): HTMLDivElement {
  const root = document.createElement("div");
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const item = messages[messageIndex]!;
    const row = document.createElement("div");
    row.dataset.messageId = item.id;
    for (const [blockIndex, block] of (
      item.message_document?.blocks ?? []
    ).entries()) {
      const blockRoot = document.createElement("span");
      blockRoot.dataset.paneFindBlock = "true";
      blockRoot.dataset.paneFindMessageId = item.id;
      blockRoot.dataset.paneFindMessageOrdinal = String(messageIndex + 1);
      blockRoot.dataset.paneFindBlockIndex = String(blockIndex);
      blockRoot.dataset.paneFindRole = item.role;
      blockRoot.textContent = block.text;
      row.append(blockRoot);
    }
    root.append(row);
  }
  document.body.append(root);
  return root;
}

function scrollHandle(root: HTMLDivElement) {
  const origin: ChatReadingPosition = {
    anchorMessageId: "user-1",
    anchorOffsetTop: 12,
    focusTarget: null,
    pinMode: "released",
  };
  const handle: ChatScrollHandle = {
    captureAnchor: vi.fn(),
    scrollToMessage: vi.fn(),
    captureReadingPosition: vi.fn(() => origin),
    restoreReadingPosition: vi.fn(),
    getTranscriptElement: vi.fn(() => root),
    previewFindOccurrence: vi.fn(async () => ({
      kind: "Revealed" as const,
    })),
    clearFindPresentation: vi.fn(),
  };
  return { handle, origin };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Conversation Pane Find", () => {
  it("is Strict Mode safe, keeps pending token churn in one session, then reruns once on terminalization", async () => {
    const complete = message("user-1", 1, "user", "needle");
    const firstPending = message(
      "assistant-1",
      2,
      "assistant",
      "stream",
      "pending",
    );
    let root = transcript([complete, firstPending]);
    const { handle } = scrollHandle(root);
    const scrollRef = { current: handle };
    const fetchSpy = vi.spyOn(window, "fetch");
    const initialHref = window.location.href;
    const view = renderHook(
      ({ messages }: { messages: readonly ConversationMessage[] }) =>
        useConversationPaneFind({
          conversationId: "conversation-1",
          activeLeafMessageId: "assistant-1",
          messages,
          scrollRef,
        }),
      {
        initialProps: { messages: [complete, firstPending] },
        wrapper: ({ children }: PropsWithChildren) => (
          <StrictMode>{children}</StrictMode>
        ),
      },
    );

    act(() => view.result.current.onQueryChange("needle"));
    await waitFor(() => expect(view.result.current.result.kind).toBe("Ready"));
    const stableSourceKey = view.result.current.sourceKey;
    const previewCount = vi.mocked(handle.previewFindOccurrence).mock.calls
      .length;

    view.rerender({
      messages: [
        complete,
        message("assistant-1", 2, "assistant", "streaming delta", "pending"),
      ],
    });
    expect(view.result.current.sourceKey).toBe(stableSourceKey);
    expect(view.result.current.query).toBe("needle");
    expect(view.result.current.result.kind).toBe("Ready");
    expect(handle.previewFindOccurrence).toHaveBeenCalledTimes(previewCount);

    root.remove();
    const terminal = message(
      "assistant-1",
      2,
      "assistant",
      "terminal needle",
    );
    root = transcript([complete, terminal]);
    vi.mocked(handle.getTranscriptElement).mockImplementation(() => root);
    view.rerender({ messages: [complete, terminal] });

    await waitFor(() =>
      expect(
        view.result.current.result.kind === "Ready" &&
          view.result.current.result.rows.length,
      ).toBe(2),
    );
    expect(view.result.current.sourceKey).not.toBe(stableSourceKey);
    expect(view.result.current.query).toBe("needle");
    expect(handle.clearFindPresentation).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialHref);
  });
});
