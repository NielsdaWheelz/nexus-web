import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConversationFindAdapter,
  useConversationPaneFind,
} from "@/components/chat/useConversationPaneFind";
import type {
  ChatReadingPosition,
  ChatScrollHandle,
} from "@/components/chat/useChatScroll";
import { createConversationFindSnapshot } from "@/lib/conversations/conversationFind";
import type { ConversationMessage } from "@/lib/conversations/types";
import { createPaneFindSourceKey } from "@/lib/panes/paneSearch";

const timestamp = "2026-07-29T00:00:00Z";

function message(
  id: string,
  seq: number,
  role: ConversationMessage["role"],
  text: string,
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
    status: "complete",
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function scrollHandle() {
  const origin: ChatReadingPosition = {
    anchorMessageId: "user-1",
    anchorOffsetTop: 12,
    focusTarget: null,
  };
  const handle: ChatScrollHandle = {
    captureAnchor: vi.fn(),
    scrollToMessage: vi.fn(),
    captureReadingPosition: vi.fn(() => origin),
    restoreReadingPosition: vi.fn(() => true),
    previewFindOccurrence: vi.fn(async () => true),
    clearFindPresentation: vi.fn(),
  };
  return { handle, origin };
}

describe("Conversation Pane Find", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an adapter request whose exact transcript source is stale", async () => {
    const snapshot = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "assistant-1",
      messages: [message("user-1", 1, "user", "needle")],
    });
    const { handle } = scrollHandle();
    const adapter = createConversationFindAdapter({
      snapshot,
      getCurrentSourceKey: () =>
        createPaneFindSourceKey({
          kind: "ConversationTranscript",
          revision: "newer",
        }),
      getScrollHandle: () => handle,
    });

    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: snapshot.sourceKey,
      signal: new AbortController().signal,
      query: "needle",
      scopeId: "EntireConversation",
      matchCase: false,
      wholeWord: false,
    });

    expect(response).toMatchObject({
      kind: "Failed",
      error: { kind: "StaleSource" },
    });
    expect(handle.captureReadingPosition).not.toHaveBeenCalled();
    expect(handle.previewFindOccurrence).not.toHaveBeenCalled();
  });

  it("captures the initial reading origin once, previews repeated jumps, closes without returning, and returns once", async () => {
    const { handle, origin } = scrollHandle();
    const fetchSpy = vi.spyOn(window, "fetch");
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");
    const initialHref = window.location.href;
    const messages = [
      message("user-1", 1, "user", "needle first"),
      message("assistant-1", 2, "assistant", "needle second"),
    ];
    const scrollRef = { current: handle };
    const { result } = renderHook(() =>
      useConversationPaneFind({
        conversationId: "conversation-1",
        activeLeafMessageId: "assistant-1",
        messages,
        scrollRef,
      }),
    );

    act(() => result.current.onQueryChange("needle"));
    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
    await waitFor(() =>
      expect(handle.previewFindOccurrence).toHaveBeenCalledTimes(1),
    );
    expect(handle.captureReadingPosition).toHaveBeenCalledTimes(1);

    act(() => result.current.onStep("Next"));
    await waitFor(() =>
      expect(handle.previewFindOccurrence).toHaveBeenCalledTimes(2),
    );
    act(() => result.current.onStep("Previous"));
    await waitFor(() =>
      expect(handle.previewFindOccurrence).toHaveBeenCalledTimes(3),
    );
    expect(handle.captureReadingPosition).toHaveBeenCalledTimes(1);

    act(() => result.current.onDismiss());
    await waitFor(() => expect(result.current.result.kind).toBe("Idle"));
    expect(handle.clearFindPresentation).toHaveBeenCalled();
    expect(handle.restoreReadingPosition).not.toHaveBeenCalled();
    expect(result.current.returnToReadingPosition.kind).toBe("Available");

    act(() => {
      if (result.current.returnToReadingPosition.kind === "Available") {
        result.current.returnToReadingPosition.onReturn();
      }
    });
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Unavailable"),
    );
    expect(handle.restoreReadingPosition).toHaveBeenCalledTimes(1);
    expect(handle.restoreReadingPosition).toHaveBeenCalledWith(origin);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialHref);
  });
});
