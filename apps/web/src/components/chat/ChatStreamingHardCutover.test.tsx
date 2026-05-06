import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatSurface from "./ChatSurface";
import { useChatRunTail } from "./useChatRunTail";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";

const streamMocks = vi.hoisted(() => ({
  fetchStreamToken: vi.fn(),
  sseClientDirect: vi.fn(),
}));

vi.mock("@/lib/api/streamToken", () => ({
  fetchStreamToken: streamMocks.fetchStreamToken,
}));

vi.mock("@/lib/api/sse", () => ({
  sseClientDirect: streamMocks.sseClientDirect,
}));

const baseTimestamp = "2026-01-01T12:00:00Z";

function message(
  overrides: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role" | "seq">,
): ConversationMessage {
  return {
    content: "",
    status: "complete",
    error_code: null,
    created_at: baseTimestamp,
    updated_at: baseTimestamp,
    ...overrides,
  };
}

function runData({
  runId = "run-1",
  conversationId = "conversation-1",
  userSeq = 1,
  assistantSeq = 2,
  userContent = "What changed?",
  assistantCreatedAt = "2026-01-02T12:00:00Z",
  parentMessageId = null,
}: {
  runId?: string;
  conversationId?: string;
  userSeq?: number;
  assistantSeq?: number;
  userContent?: string;
  assistantCreatedAt?: string;
  parentMessageId?: string | null;
} = {}): ChatRunResponse["data"] {
  return {
    run: {
      id: runId,
      status: "running",
      conversation_id: conversationId,
      user_message_id: `${runId}-user`,
      assistant_message_id: `${runId}-assistant`,
      model_id: "gpt-5-mini",
      reasoning: "default",
      key_mode: "auto",
      cancel_requested_at: null,
      started_at: null,
      completed_at: null,
      error_code: null,
      created_at: baseTimestamp,
      updated_at: baseTimestamp,
    },
    conversation: {
      id: conversationId,
      title: "Test conversation",
      sharing: "private",
      message_count: 2,
      scope: { type: "general" },
      created_at: baseTimestamp,
      updated_at: baseTimestamp,
    },
    user_message: message({
      id: `${runId}-user`,
      seq: userSeq,
      role: "user",
      content: userContent,
      parent_message_id: parentMessageId,
      created_at: "2026-01-01T12:00:00Z",
    }),
    assistant_message: message({
      id: `${runId}-assistant`,
      seq: assistantSeq,
      role: "assistant",
      content: "",
      status: "pending",
      parent_message_id: `${runId}-user`,
      created_at: assistantCreatedAt,
    }),
  };
}

function StreamingHarness({
  initialMessages = [],
  nextRunData = runData(),
}: {
  initialMessages?: ConversationMessage[];
  nextRunData?: ChatRunResponse["data"];
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>(initialMessages);
  const shouldScrollRef = useRef(true);
  const { tailChatRun } = useChatRunTail({ setMessages, shouldScrollRef });

  return (
    <ChatSurface
      messages={messages}
      emptyState={<p>No messages yet</p>}
      composer={
        <button type="button" onClick={() => void tailChatRun(nextRunData)}>
          Send
        </button>
      }
    />
  );
}

describe("chat streaming hard cutover", () => {
  beforeEach(() => {
    streamMocks.fetchStreamToken.mockReset();
    streamMocks.sseClientDirect.mockReset();
  });

  it("shows an empty pending assistant row immediately for a new chat", async () => {
    streamMocks.fetchStreamToken.mockReturnValue(new Promise(() => undefined));

    render(<StreamingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("What changed?")).toBeVisible();
    });

    expect(screen.queryByText("No messages yet")).not.toBeInTheDocument();
    expect(screen.getByTestId("streaming-cue")).toBeInTheDocument();
    expect(streamMocks.fetchStreamToken).toHaveBeenCalledOnce();
    expect(streamMocks.sseClientDirect).not.toHaveBeenCalled();
  });

  it("keeps existing chat history while adding the empty pending assistant row", async () => {
    streamMocks.fetchStreamToken.mockReturnValue(new Promise(() => undefined));
    const initialMessages = [
      message({
        id: "existing-user",
        seq: 1,
        role: "user",
        content: "Earlier question",
      }),
      message({
        id: "existing-assistant",
        seq: 2,
        role: "assistant",
        content: "Earlier answer",
      }),
    ];

    render(
      <StreamingHarness
        initialMessages={initialMessages}
        nextRunData={runData({
          runId: "run-2",
          userSeq: 3,
          assistantSeq: 4,
          userContent: "Follow up?",
          parentMessageId: "existing-assistant",
          assistantCreatedAt: "2026-01-04T12:00:00Z",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Follow up?")).toBeVisible();
    });

    expect(screen.getByText("Earlier question")).toBeVisible();
    expect(screen.getByText("Earlier answer")).toBeVisible();
    expect(screen.getByTestId("streaming-cue")).toBeInTheDocument();
    expect(streamMocks.fetchStreamToken).toHaveBeenCalledOnce();
    expect(streamMocks.sseClientDirect).not.toHaveBeenCalled();
  });

  it("streams assistant deltas into the visible pending row", async () => {
    streamMocks.fetchStreamToken.mockResolvedValue({
      stream_base_url: "https://stream.nexus.test",
      token: "stream-token",
    });
    streamMocks.sseClientDirect.mockImplementation(
      (_streamBaseUrl, _streamToken, _runId, handlers) => {
        handlers.onEvent({
          type: "delta",
          data: { delta: "Streamed answer" },
        });
        handlers.onEvent({
          type: "done",
          data: { status: "complete", error_code: null, final_chars: 15 },
        });
        return vi.fn();
      },
    );

    render(<StreamingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Streamed answer")).toBeVisible();
    });

    expect(screen.queryByText("Generating response...")).not.toBeInTheDocument();
    expect(streamMocks.sseClientDirect).toHaveBeenCalledOnce();
  });

  it("does not let a hidden sibling stream replace the selected transcript", async () => {
    streamMocks.fetchStreamToken.mockResolvedValue({
      stream_base_url: "https://stream.nexus.test",
      token: "stream-token",
    });
    streamMocks.sseClientDirect.mockImplementation(
      (_streamBaseUrl, _streamToken, _runId, handlers) => {
        handlers.onEvent({
          type: "delta",
          data: { delta: "Hidden streamed answer" },
        });
        return vi.fn();
      },
    );
    const selectedMessages = [
      message({
        id: "root-assistant",
        seq: 1,
        role: "assistant",
        content: "Common branch point",
      }),
      message({
        id: "selected-user",
        seq: 2,
        role: "user",
        content: "Selected branch",
        parent_message_id: "root-assistant",
      }),
      message({
        id: "selected-assistant",
        seq: 3,
        role: "assistant",
        content: "Selected answer",
        parent_message_id: "selected-user",
      }),
    ];

    function HiddenSiblingHarness() {
      const [messages, setMessages] = useState<ConversationMessage[]>(selectedMessages);
      const shouldScrollRef = useRef(true);
      const selectedIdsRef = useRef(new Set(messages.map((item) => item.id)));
      selectedIdsRef.current = new Set(messages.map((item) => item.id));
      const { tailChatRun } = useChatRunTail({
        setMessages,
        shouldScrollRef,
        shouldApplyRun: ({ userMessageId, assistantMessageId }) =>
          selectedIdsRef.current.has(userMessageId) ||
          selectedIdsRef.current.has(assistantMessageId),
      });

      return (
        <ChatSurface
          messages={messages}
          composer={
            <button
              type="button"
              onClick={() =>
                void tailChatRun(
                  runData({
                    runId: "hidden-run",
                    userSeq: 4,
                    assistantSeq: 5,
                    userContent: "Hidden sibling",
                    parentMessageId: "root-assistant",
                  }),
                )
              }
            >
              Tail hidden sibling
            </button>
          }
        />
      );
    }

    render(<HiddenSiblingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Tail hidden sibling" }));

    await waitFor(() => expect(streamMocks.sseClientDirect).toHaveBeenCalledOnce());

    expect(screen.getByText("Selected branch")).toBeVisible();
    expect(screen.getByText("Selected answer")).toBeVisible();
    expect(screen.queryByText("Hidden sibling")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden streamed answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Generating response...")).not.toBeInTheDocument();
  });

  it("does not open duplicate SSE connections for an already tailed run", async () => {
    streamMocks.fetchStreamToken.mockResolvedValue({
      stream_base_url: "https://stream.nexus.test",
      token: "stream-token",
    });
    streamMocks.sseClientDirect.mockReturnValue(vi.fn());

    render(<StreamingHarness />);
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);

    await waitFor(() => {
      expect(streamMocks.sseClientDirect).toHaveBeenCalledOnce();
    });

    fireEvent.click(send);

    await waitFor(() => {
      expect(streamMocks.sseClientDirect).toHaveBeenCalledOnce();
    });
  });
});
