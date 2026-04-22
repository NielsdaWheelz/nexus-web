import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ConversationPaneBody from "@/app/(authenticated)/conversations/[id]/ConversationPaneBody";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiFetch: apiFetchMock,
  isApiError: () => false,
}));

vi.mock("@/components/ChatComposer", () => ({
  default: (props: {
    onOptimisticMessages?: (
      userMsg: {
        id: string;
        seq: number;
        role: "user" | "assistant" | "system";
        content: string;
        status: "pending" | "complete" | "error";
        error_code: string | null;
        created_at: string;
        updated_at: string;
      },
      assistantMsg: {
        id: string;
        seq: number;
        role: "user" | "assistant" | "system";
        content: string;
        status: "pending" | "complete" | "error";
        error_code: string | null;
        created_at: string;
        updated_at: string;
      }
    ) => void;
    onMessageSent?: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          const now = new Date().toISOString();
          props.onOptimisticMessages?.(
            {
              id: "optimistic-user",
              seq: 2,
              role: "user",
              content: "new user message",
              status: "complete",
              error_code: null,
              created_at: now,
              updated_at: now,
            },
            {
              id: "optimistic-assistant",
              seq: 3,
              role: "assistant",
              content: "new assistant reply",
              status: "pending",
              error_code: null,
              created_at: now,
              updated_at: now,
            }
          );
          props.onMessageSent?.();
        }}
      >
        Send mock message
      </button>
      <textarea placeholder="Type a message... (Enter to send, Shift+Enter for newline)" />
    </div>
  ),
}));

function renderConversationPane(
  href: string,
  {
    onReplacePane = () => {},
    onSetPaneTitle,
  }: {
    onReplacePane?: (paneId: string, href: string) => void;
    onSetPaneTitle?: (
      paneId: string,
      title: string | null,
      metadata: { routeId: string; resourceRef: string | null }
    ) => void;
  } = {}
) {
  return render(
    <PaneRuntimeProvider
      paneId="pane-conversation"
      href={href}
      routeId="conversation"
      resourceRef="conversation:conv-1"
      pathParams={{ id: "conv-1" }}
      onNavigatePane={() => {}}
      onReplacePane={onReplacePane}
      onOpenInNewPane={() => {}}
      onSetPaneTitle={onSetPaneTitle}
    >
      <ConversationPaneBody />
    </PaneRuntimeProvider>
  );
}

describe("ConversationPaneBody", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("loads messages into a transcript scroll container and keeps composer visible", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 1,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return {
          data: [
            {
              id: "msg-1",
              seq: 1,
              role: "assistant",
              content: "existing assistant reply",
              status: "complete",
              error_code: null,
              created_at: "2026-03-30T00:00:00.000Z",
              updated_at: "2026-03-30T00:00:00.000Z",
            },
          ],
          page: { next_cursor: null },
        };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderConversationPane("/conversations/conv-1");

    expect(await screen.findByText("existing assistant reply")).toBeInTheDocument();
    expect(screen.getByTestId("chat-transcript")).toHaveStyle({ overflowY: "auto" });
    expect(
      screen.getByPlaceholderText("Type a message... (Enter to send, Shift+Enter for newline)")
    ).toBeInTheDocument();
  });

  it("renders persisted user context snapshots above user message content", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 2,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return {
          data: [
            {
              id: "msg-user",
              seq: 1,
              role: "user",
              content: "What does this mean?",
              contexts: [
                {
                  type: "highlight",
                  id: "hl-1",
                  preview: "Persisted quote",
                  color: "yellow",
                  media_title: "Source",
                  media_kind: "pdf",
                },
              ],
              status: "complete",
              error_code: null,
              created_at: "2026-03-30T00:00:00.000Z",
              updated_at: "2026-03-30T00:00:00.000Z",
            },
            {
              id: "msg-asst",
              seq: 2,
              role: "assistant",
              content: "It means this is context-aware.",
              status: "complete",
              error_code: null,
              created_at: "2026-03-30T00:00:00.000Z",
              updated_at: "2026-03-30T00:00:00.000Z",
            },
          ],
          page: { next_cursor: null },
        };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderConversationPane("/conversations/conv-1");

    expect(await screen.findByText("Persisted quote")).toBeInTheDocument();

    const linkedContextButton = screen.queryByRole("button", { name: "Linked context" });
    if (linkedContextButton) {
      await userEvent.setup().click(linkedContextButton);
    }

    const contextPane = await screen.findByTestId("conversation-context-pane");
    expect(within(contextPane).getByText(/Source - pdf - Message #1/)).toBeInTheDocument();
    expect(screen.getByText("What does this mean?")).toBeInTheDocument();
  });

  it("appends optimistic user+assistant messages when composer sends", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 0,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return { data: [], page: { next_cursor: null } };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderConversationPane("/conversations/conv-1");
    await screen.findByRole("button", { name: "Send mock message" });

    await user.click(screen.getByRole("button", { name: "Send mock message" }));

    expect(screen.getByText("new user message")).toBeInTheDocument();
    expect(screen.getByText("new assistant reply")).toBeInTheDocument();
  });

  it("clears attach params after send while preserving non-attach params", async () => {
    const user = userEvent.setup();
    const onReplacePane = vi.fn();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 0,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return { data: [], page: { next_cursor: null } };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderConversationPane(
      "/conversations/conv-1?foo=bar&attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line",
      { onReplacePane }
    );
    await screen.findByRole("button", { name: "Send mock message" });

    await user.click(screen.getByRole("button", { name: "Send mock message" }));

    expect(onReplacePane).toHaveBeenCalledWith(
      "pane-conversation",
      "/conversations/conv-1?foo=bar"
    );
  });

  it("keeps URL-attached context stable across host rerenders", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 0,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return { data: [], page: { next_cursor: null } };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    const { rerender } = render(
      <PaneRuntimeProvider
        paneId="pane-conversation"
        href="/conversations/conv-1?attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line"
        routeId="conversation"
        resourceRef="conversation:conv-1"
        pathParams={{ id: "conv-1" }}
        onNavigatePane={() => {}}
        onReplacePane={() => {}}
        onOpenInNewPane={() => {}}
      >
        <ConversationPaneBody />
      </PaneRuntimeProvider>
    );

    await screen.findByTestId("chat-transcript");
    await user.click(screen.getByRole("button", { name: "Linked context" }));
    await screen.findByRole("dialog", { name: "Linked context" });
    expect(screen.getByText("quoted line")).toBeInTheDocument();

    rerender(
      <PaneRuntimeProvider
        paneId="pane-conversation"
        href="/conversations/conv-1?attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line"
        routeId="conversation"
        resourceRef="conversation:conv-1"
        pathParams={{ id: "conv-1" }}
        onNavigatePane={() => {}}
        onReplacePane={() => {}}
        onOpenInNewPane={() => {}}
      >
        <ConversationPaneBody />
      </PaneRuntimeProvider>
    );

    await screen.findByText("quoted line");
  });

  it("renders linked context in the secondary drawer surface", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 0,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return { data: [], page: { next_cursor: null } };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderConversationPane(
      "/conversations/conv-1?attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=highlighted%20quote"
    );

    await user.click(await screen.findByRole("button", { name: "Linked context" }));
    expect(await screen.findByRole("dialog", { name: "Linked context" })).toBeInTheDocument();
    expect(screen.getByText("highlighted quote")).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize pane" })).not.toBeInTheDocument();
  });

  it("shows persisted linked context from prior user messages in context pane", async () => {
    const user = userEvent.setup();

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/conversations/conv-1") {
        return {
          data: {
            id: "conv-1",
            title: "Chat title",
            sharing: "private",
            message_count: 1,
            created_at: "2026-03-30T00:00:00.000Z",
            updated_at: "2026-03-30T00:00:00.000Z",
          },
        };
      }
      if (path.startsWith("/api/conversations/conv-1/messages")) {
        return {
          data: [
            {
              id: "msg-user",
              seq: 1,
              role: "user",
              content: "What does this mean?",
              contexts: [
                {
                  type: "highlight",
                  id: "hl-1",
                  preview: "Persisted quote",
                  color: "yellow",
                  media_id: "media-1",
                  media_title: "Source",
                  media_kind: "pdf",
                },
              ],
              status: "complete",
              error_code: null,
              created_at: "2026-03-30T00:00:00.000Z",
              updated_at: "2026-03-30T00:00:00.000Z",
            },
          ],
          page: { next_cursor: null },
        };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderConversationPane("/conversations/conv-1");

    await user.click(await screen.findByRole("button", { name: "Linked context" }));
    const contextPane = await screen.findByTestId("conversation-context-pane");
    expect(within(contextPane).getByText("Persisted quote")).toBeInTheDocument();
    expect(within(contextPane).getByText(/Message #1/)).toBeInTheDocument();
    await user.click(within(contextPane).getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Open source" })).toBeInTheDocument();
  });
});
