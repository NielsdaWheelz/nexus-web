import { render, screen } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { openGenerationRunStream } from "@/lib/api/useGenerationRun";
import { proxyToFastAPIWithDeps } from "@/lib/api/proxy";
import {
  TOOL_PROJECTION_REVISION,
  type ToolEffect,
  type ToolErrorType,
  type ToolRecordKind,
  type ToolResultKind,
} from "@/lib/conversations/toolContractProjection";
import {
  createRunningAssistantTrustTrail,
  type ConversationMessage,
  type MessageToolCall,
} from "@/lib/conversations/types";
import { decodeConversationMessage } from "@/lib/conversations/messageWire";
import type { PaneVisitId } from "@/lib/workspace/schema";
import AssistantMessage from "./AssistantMessage";
import ChatComposer from "./ChatComposer";

vi.mock("next/server", () => {
  class BrowserNextResponse extends Response {
    readonly cookies = {
      set: () => undefined,
      delete: () => undefined,
    };

    static json(body: unknown, init?: ResponseInit): BrowserNextResponse {
      const headers = new Headers(init?.headers);
      headers.set("Content-Type", "application/json");
      return new BrowserNextResponse(JSON.stringify(body), {
        ...init,
        headers,
      });
    }
  }

  return { NextResponse: BrowserNextResponse };
});

const PROJECTION_HEADER = "X-Nexus-Tool-Projection";
const RELOAD_REQUIRED_CODE = "E_TOOL_PROJECTION_RELOAD_REQUIRED";
const ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

const PROFILES = {
  default_profile_id: "balanced",
  profiles: [
    {
      id: "fast",
      label: "Fast",
      description: "Quick responses for everyday questions.",
      model_label: "GPT-5.6 Luna",
      effort_label: "Low",
    },
    {
      id: "balanced",
      label: "Balanced",
      description: "The default profile: strong general-purpose reasoning.",
      model_label: "GPT-5.6 Terra",
      effort_label: "Medium",
    },
    {
      id: "deep",
      label: "Deep",
      description: "Slower, deeper reasoning for hard problems.",
      model_label: "GPT-5.6 Sol",
      effort_label: "High",
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, window.location.origin).pathname;
}

function projectionTool(
  recordKind: ToolRecordKind,
  fields: {
    canonicalToolId: string | null;
    providerWireName: string | null;
    effect: ToolEffect | null;
    resultKind: ToolResultKind;
    activityLabel: string;
    errorType: ToolErrorType | null;
  },
): MessageToolCall {
  return {
    id: ID,
    record_kind: recordKind,
    canonical_tool_id: fields.canonicalToolId,
    provider_wire_name: fields.providerWireName,
    effect: fields.effect,
    result_kind: fields.resultKind,
    activity_label: fields.activityLabel,
    error_type: fields.errorType,
    tool_call_index: 0,
    scope: "provider_tool",
    requested_types: [],
    result_refs: [],
    selected_context_refs: [],
    provider_request_ids: [],
    latency_ms: null,
    result_count: 0,
    selected_count: 0,
    status: "complete",
    reverted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    retrievals: [],
  };
}

function assistantMessage(toolCalls: MessageToolCall[]): ConversationMessage {
  const trustTrail = createRunningAssistantTrustTrail({
    assistantMessageId: SECOND_ID,
    conversationId: SECOND_ID,
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T00:00:00Z",
  });
  trustTrail.tool_calls = toolCalls;
  return {
    id: SECOND_ID,
    seq: 2,
    role: "assistant",
    message_document: { type: "message_document", blocks: [] },
    trust_trail: trustTrail,
    citations: [],
    reader_selection: { kind: "Absent" },
    status: "pending",
    can_rerun: false,
    can_regenerate: false,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
  };
}

describe("Chat tool projection protocol", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await page.viewport(1_024, 768);
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("originates, forwards, decodes, and renders one fail-closed projection", async () => {
    expect(TOOL_PROJECTION_REVISION).toMatch(/^[a-f0-9]{64}$/);

    const browserRequests: Array<{
      method: string;
      path: string;
      revision: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        browserRequests.push({
          method: init?.method ?? "GET",
          path: requestPath(input),
          revision: new Headers(init?.headers).get(PROJECTION_HEADER),
        });
        return json({ data: null });
      },
    );

    const projectionRequests: ReadonlyArray<{
      path: ApiPath;
      method?: "GET" | "POST";
    }> = [
      { path: "/api/chat-runs" },
      { path: "/api/chat-runs", method: "POST" },
      { path: `/api/chat-runs/${ID}` },
      { path: `/api/chat-runs/${ID}/cancel`, method: "POST" },
      { path: `/api/conversations/${ID}/messages` },
      { path: `/api/conversations/${ID}/tree` },
      { path: `/api/conversations/${ID}/active-path`, method: "POST" },
      { path: `/api/messages/${ID}/rerun`, method: "POST" },
      { path: `/api/messages/${ID}/regenerate`, method: "POST" },
      {
        path: `/api/conversations/${ID}/tool-calls/${SECOND_ID}/undo`,
        method: "POST",
      },
    ];
    for (const request of projectionRequests) {
      await apiFetch(request.path, { method: request.method });
    }
    await apiFetch("/api/llm-profiles");

    expect(browserRequests).toEqual([
      ...projectionRequests.map((request) => ({
        method: request.method ?? "GET",
        path: new URL(request.path, window.location.origin).pathname,
        revision: TOOL_PROJECTION_REVISION,
      })),
      { method: "GET", path: "/api/llm-profiles", revision: null },
    ]);

    let forwardedRevision: string | null = null;
    await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/chat-runs", {
        headers: { [PROJECTION_HEADER]: TOOL_PROJECTION_REVISION },
      }),
      "/chat-runs",
      {
        readSession: () => ({
          state: "active",
          accessToken: "projection-proof-access-token",
          canRefresh: false,
          expiresAt: 4_102_444_800,
          cookieNames: [],
        }),
        refreshSession: async () => {
          throw new Error(
            "active projection proof unexpectedly refreshed auth",
          );
        },
        fetch: async (_input, init) => {
          forwardedRevision = new Headers(init?.headers).get(PROJECTION_HEADER);
          return json({ data: [] });
        },
        generateRequestId: () => "tool-projection-proof",
        appPublicOrigin: "http://localhost:3000",
        config: {
          fastApiBaseUrl: "http://localhost:8000",
          internalSecret: "projection-proof-internal-secret",
        },
      },
    );
    expect(forwardedRevision).toBe(TOOL_PROJECTION_REVISION);

    let directStreamRevision: string | null = null;
    let completeStream: (() => void) | undefined;
    const streamComplete = new Promise<void>((resolve) => {
      completeStream = resolve;
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/stream-token") {
          return json({
            data: {
              token: "projection-proof-stream-token",
              stream_base_url: "https://stream.nexus.test",
              expires_at: "2026-08-17T00:01:00Z",
            },
          });
        }
        if (path === `/stream/chat-runs/${ID}/events`) {
          directStreamRevision = new Headers(init?.headers).get(
            PROJECTION_HEADER,
          );
          return new Response("id: 1\nevent: done\ndata: {}\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        throw new Error(`Unexpected projection stream request: ${path}`);
      },
    );
    const stopStream = await openGenerationRunStream<{ terminal: true }>(
      "chat-runs",
      ID,
      {
        decode: () => ({ terminal: true }),
        isTerminal: (event) => event.terminal,
        onEvent: () => undefined,
        onError: (error) => {
          throw error;
        },
        onComplete: () => completeStream?.(),
      },
    );
    await streamComplete;
    stopStream();
    expect(directStreamRevision).toBe(TOOL_PROJECTION_REVISION);

    const variants = [
      projectionTool("current_execution", {
        canonicalToolId: "nexus.document.search",
        providerWireName: "nexus.document.search",
        effect: "Read",
        resultKind: "retrieval",
        activityLabel: "Searching this document",
        errorType: "ResourceUnavailable",
      }),
      projectionTool("historical_execution", {
        canonicalToolId: "web.search",
        providerWireName: null,
        effect: "Read",
        resultKind: "retrieval",
        activityLabel: "Searching the web",
        errorType: null,
      }),
      projectionTool("rejected_provider_call", {
        canonicalToolId: null,
        providerWireName: "invented_tool",
        effect: null,
        resultKind: "rejected_provider_call",
        activityLabel: "Skipped an unavailable tool",
        errorType: null,
      }),
      projectionTool("attached_context", {
        canonicalToolId: null,
        providerWireName: null,
        effect: null,
        resultKind: "attached_context",
        activityLabel: "Attached conversation context",
        errorType: null,
      }),
    ] as const;
    expect(
      decodeConversationMessage(
        assistantMessage([...variants]),
      ).trust_trail?.tool_calls.map((tool) => tool.record_kind),
    ).toEqual([
      "current_execution",
      "historical_execution",
      "rejected_provider_call",
      "attached_context",
    ]);
    expect(
      decodeConversationMessage(
        assistantMessage([
          { ...variants[0], error_type: null } as MessageToolCall,
        ]),
      ).trust_trail?.tool_calls[0].error_type,
    ).toBeNull();
    expect(() =>
      decodeConversationMessage(
        assistantMessage([
          {
            ...variants[0],
            error_type: "private_authorization_reason",
          } as unknown as MessageToolCall,
        ]),
      ),
    ).toThrow(/error_type/);
    const { error_type: _missingErrorType, ...missingErrorType } = variants[0];
    expect(() =>
      decodeConversationMessage(
        assistantMessage([
          missingErrorType as unknown as MessageToolCall,
        ]),
      ),
    ).toThrow(/error_type/);
    expect(() =>
      decodeConversationMessage(
        assistantMessage([
          {
            ...variants[0],
            unexpected_projection_field: "must not cross the wire",
          } as unknown as MessageToolCall,
        ]),
      ),
    ).toThrow(/must contain exactly/);

    const activeTool = {
      ...variants[0],
      status: "running" as const,
      error_type: null,
    } as MessageToolCall;
    const view = render(
      withRenderEnvironment(
        <AssistantMessage
          message={assistantMessage([activeTool])}
          messageOrdinal={1}
          forkOptions={[]}
          timestampLabel=""
        />,
      ),
    );
    const activityStatus = screen.getByRole("status");
    expect(activityStatus).toHaveTextContent("Searching this document");
    await vi.waitFor(() => {
      expect(activityStatus).toBeVisible();
    });
    expect(screen.queryByText("Running nexus.document.search")).toBeNull();
    view.unmount();

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === "/api/llm-profiles") return json({ data: PROFILES });
        if (path === "/api/chat-runs" && init?.method === "POST") {
          expect(new Headers(init.headers).get(PROJECTION_HEADER)).toBe(
            TOOL_PROJECTION_REVISION,
          );
          return json(
            {
              error: {
                code: RELOAD_REQUIRED_CODE,
                message: "Tool projection reload required",
                request_id: "projection-reload-proof",
              },
            },
            409,
          );
        }
        throw new Error(`Unexpected reload proof request: ${path}`);
      },
    );
    render(
      withRenderEnvironment(
        <ChatComposer
          conversationId={null}
          draftKey={{
            kind: "NewConversation",
            visitId: "projection-reload-proof" as PaneVisitId,
          }}
          inheritedProfileSelection={null}
          sendCapability={{ kind: "Available" }}
        />,
      ),
    );
    await screen.findByRole("radio", { name: /Balanced/ });
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Ask anything",
    });
    await userEvent.click(composer);
    await userEvent.keyboard("Keep this draft{Enter}");
    const reloadNotice = await screen.findByRole("alert");
    expect(reloadNotice).toHaveTextContent("Reload Nexus to continue");
    expect(
      screen.getByText(
        "This tab is using an older tool contract. Your draft is saved.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload Nexus" })).toBeVisible();
    expect(composer).toHaveValue("Keep this draft");
    expect(composer).toBeDisabled();
  });
});
