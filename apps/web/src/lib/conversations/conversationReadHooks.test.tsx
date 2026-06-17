import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatsByContextRef } from "./useChatsByContextRef";
import { useConversationContextRefs } from "./useConversationContextRefs";
import type { ConversationListItem } from "./types";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input), "http://localhost");
}

function conversationItem(id: string): ConversationListItem {
  return {
    id,
    title: id,
    message_count: 1,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function contextRef(id: string, conversationId: string): ContextRefOut {
  return {
    id,
    conversation_id: conversationId,
    resource_ref: `media:${id}`,
    activation: {
      resourceRef: `media:${id}`,
      kind: "route",
      href: `/media/${id}`,
      unresolvedReason: null,
    },
    label: id,
    summary: "",
    missing: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("conversation read hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts superseded context-ref chat list loads and drops late responses", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const resourceUri = urlOf(input).searchParams.get("has_context_ref");
        if (resourceUri === "media:a") {
          firstSignal = init?.signal ?? undefined;
          return first.promise;
        }
        if (resourceUri === "media:b") {
          secondSignal = init?.signal ?? undefined;
          return second.promise;
        }
        throw new Error(`Unexpected fetch call: ${urlOf(input).toString()}`);
      }),
    );

    const { result, rerender } = renderHook(
      ({ resourceUri }: { resourceUri: string | null }) =>
        useChatsByContextRef(resourceUri),
      { initialProps: { resourceUri: "media:a" } },
    );
    await waitFor(() => expect(firstSignal).toBeDefined());

    rerender({ resourceUri: "media:b" });
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() => expect(secondSignal).toBeDefined());

    await act(async () => {
      second.resolve(jsonResponse({ data: [conversationItem("conv-b")] }));
    });
    await waitFor(() =>
      expect(result.current.conversations.map((item) => item.id)).toEqual([
        "conv-b",
      ]),
    );

    await act(async () => {
      first.resolve(jsonResponse({ data: [conversationItem("conv-a")] }));
    });
    expect(result.current.conversations.map((item) => item.id)).toEqual([
      "conv-b",
    ]);
  });

  it("aborts superseded conversation context-ref loads and drops late responses", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = urlOf(input).pathname;
        if (path === "/api/conversations/conv-a/context-refs") {
          firstSignal = init?.signal ?? undefined;
          return first.promise;
        }
        if (path === "/api/conversations/conv-b/context-refs") {
          secondSignal = init?.signal ?? undefined;
          return second.promise;
        }
        throw new Error(`Unexpected fetch call: ${path}`);
      }),
    );

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useConversationContextRefs(conversationId),
      { initialProps: { conversationId: "conv-a" } },
    );
    await waitFor(() => expect(firstSignal).toBeDefined());

    rerender({ conversationId: "conv-b" });
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() => expect(secondSignal).toBeDefined());

    await act(async () => {
      second.resolve(jsonResponse({ data: [contextRef("ref-b", "conv-b")] }));
    });
    await waitFor(() =>
      expect(result.current.contextRefs.map((item) => item.id)).toEqual([
        "ref-b",
      ]),
    );

    await act(async () => {
      first.resolve(jsonResponse({ data: [contextRef("ref-a", "conv-a")] }));
    });
    expect(result.current.contextRefs.map((item) => item.id)).toEqual(["ref-b"]);
  });
});
