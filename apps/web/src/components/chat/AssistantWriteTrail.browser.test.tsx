import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_PROJECTION_HEADER } from "@/lib/api/client";
import {
  TOOL_PROJECTION_REVISION,
  type ToolEffect,
  type ToolResultKind,
} from "@/lib/conversations/toolContractProjection";
import type { MessageToolCall } from "@/lib/conversations/types";
import AssistantWriteTrail from "./AssistantWriteTrail";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_CALL_ID = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

function currentToolCall(input: {
  id: string;
  canonicalToolId: string;
  effect: ToolEffect;
  resultKind: ToolResultKind;
  activityLabel: string;
  resultRefs: Array<Record<string, unknown>>;
}): MessageToolCall {
  return {
    id: input.id,
    conversation_id: CONVERSATION_ID,
    user_message_id: "44444444-4444-4444-8444-444444444444",
    assistant_message_id: ASSISTANT_MESSAGE_ID,
    record_kind: "current_execution",
    canonical_tool_id: input.canonicalToolId,
    provider_wire_name: null,
    effect: input.effect,
    result_kind: input.resultKind,
    activity_label: input.activityLabel,
    error_type: null,
    tool_call_index: 1,
    scope: "conversation_context",
    requested_types: [],
    result_refs: input.resultRefs,
    selected_context_refs: [],
    provider_request_ids: [],
    status: "complete",
    reverted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    retrievals: [],
  };
}

describe("Assistant canonical Write trust trail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers owner-scoped Undo for the canonical mutation and renders its returned state", async () => {
    const write = currentToolCall({
      id: TOOL_CALL_ID,
      canonicalToolId: "nexus.queue.add",
      effect: "Write",
      resultKind: "mutation",
      activityLabel: "Adding to the queue",
      resultRefs: [
        {
          kind: "queue",
          id: "55555555-5555-4555-8555-555555555555",
          label: "The Left Hand of Darkness",
        },
      ],
    });
    const read = currentToolCall({
      id: "66666666-6666-4666-8666-666666666666",
      canonicalToolId: "nexus.resource.read",
      effect: "Read",
      resultKind: "retrieval",
      activityLabel: "Reading a resource",
      resultRefs: [],
    });
    const requests: Array<{
      method: string;
      path: string;
      projection: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          path: new URL(String(input), window.location.origin).pathname,
          projection: new Headers(init?.headers).get(TOOL_PROJECTION_HEADER),
        });
        return new Response(
          JSON.stringify({
            data: {
              ...write,
              reverted_at: "2026-08-17T00:01:00Z",
              updated_at: "2026-08-17T00:01:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    render(
      <AssistantWriteTrail
        conversationId={CONVERSATION_ID}
        toolCalls={[read, write]}
      />,
    );

    const trail = screen.getByRole("list", { name: "Assistant actions" });
    const rows = within(trail).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Queued")).toBeVisible();
    expect(
      within(rows[0]).getByText("The Left Hand of Darkness"),
    ).toBeVisible();
    expect(screen.queryByText("Reading a resource")).toBeNull();

    await userEvent.click(
      within(rows[0]).getByRole("button", {
        name: "Undo: Queued The Left Hand of Darkness",
      }),
    );

    await waitFor(() => expect(within(rows[0]).getByText("Undone")).toBeVisible());
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/api/conversations/${CONVERSATION_ID}/tool-calls/${TOOL_CALL_ID}/undo`,
        projection: TOOL_PROJECTION_REVISION,
      },
    ]);
    expect(within(rows[0]).queryByRole("button", { name: /Undo:/ })).toBeNull();
  });
});
