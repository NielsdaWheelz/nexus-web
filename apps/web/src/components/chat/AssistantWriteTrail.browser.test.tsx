import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_PROJECTION_HEADER } from "@/lib/api/client";
import {
  TOOL_PROJECTION_REVISION,
  type ToolEffect,
  type ToolResultKind,
} from "@/lib/conversations/toolContractProjection";
import type {
  MachineAuthorship,
  MessageToolCall,
} from "@/lib/conversations/types";
import AssistantWriteTrail from "./AssistantWriteTrail";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_CALL_ID = "22222222-2222-4222-8222-222222222222";

function currentToolCall(input: {
  id: string;
  canonicalToolId: string;
  effect: ToolEffect;
  resultKind: ToolResultKind;
  activityLabel: string;
  resultRefs: Array<Record<string, unknown>>;
  toolCallIndex?: number;
  machineAuthorships?: MachineAuthorship[];
}): MessageToolCall {
  return {
    id: input.id,
    record_kind: "current_execution",
    canonical_tool_id: input.canonicalToolId,
    provider_wire_name: null,
    effect: input.effect,
    result_kind: input.resultKind,
    activity_label: input.activityLabel,
    error_type: null,
    tool_call_index: input.toolCallIndex ?? 1,
    scope: "conversation_context",
    requested_types: [],
    result_refs: input.resultRefs,
    selected_context_refs: [],
    machine_authorships: input.machineAuthorships ?? [],
    provider_request_ids: [],
    latency_ms: null,
    result_count: input.resultRefs.length,
    selected_count: 0,
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
      machineAuthorships: [
        {
          target_kind: "queue_item",
          target_id: "55555555-5555-4555-8555-555555555555",
          generation_id: "77777777-7777-4777-8777-777777777777",
          generation_seq: 1,
          tool_position: 1,
          position_path: "generation/1/tool/1",
          effect_id: "88888888-8888-4888-8888-888888888888",
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

  it("shows proven generation positions for every additive write kind", () => {
    const generationId = "77777777-7777-4777-8777-777777777777";
    const cases: Array<{
      canonicalToolId: string;
      activityLabel: string;
      kind: string;
      targetKind: MachineAuthorship["target_kind"];
      target: string;
    }> = [
      {
        canonicalToolId: "nexus.library.add",
        activityLabel: "Adding to a library",
        kind: "entry",
        targetKind: "library_entry",
        target: "Research",
      },
      {
        canonicalToolId: "nexus.note.create",
        activityLabel: "Creating a note",
        kind: "note_block",
        targetKind: "note_block",
        target: "today's note",
      },
      {
        canonicalToolId: "nexus.highlight.create",
        activityLabel: "Creating a highlight",
        kind: "highlight",
        targetKind: "highlight",
        target: "A machine-authored passage",
      },
      {
        canonicalToolId: "nexus.edge.create",
        activityLabel: "Creating a connection",
        kind: "edge",
        targetKind: "resource_edge",
        target: "Related evidence",
      },
      {
        canonicalToolId: "nexus.queue.add",
        activityLabel: "Adding to the queue",
        kind: "queue",
        targetKind: "queue_item",
        target: "Read next",
      },
    ];
    const writes = cases.map((item, offset) => {
      const position = offset + 1;
      const targetId = `00000000-0000-4000-8000-00000000000${position}`;
      const effectId = `10000000-0000-4000-8000-00000000000${position}`;
      return currentToolCall({
        id: `20000000-0000-4000-8000-00000000000${position}`,
        canonicalToolId: item.canonicalToolId,
        effect: "Write",
        resultKind: "mutation",
        activityLabel: item.activityLabel,
        resultRefs: [{ kind: item.kind, id: targetId, label: item.target }],
        toolCallIndex: position,
        machineAuthorships: [
          {
            target_kind: item.targetKind,
            target_id: targetId,
            generation_id: generationId,
            generation_seq: 1,
            tool_position: position,
            position_path: `generation/1/tool/${position}`,
            effect_id: effectId,
          },
        ],
      });
    });

    render(
      <AssistantWriteTrail
        conversationId={CONVERSATION_ID}
        toolCalls={writes}
      />,
    );

    const trail = screen.getByRole("list", { name: "Assistant actions" });
    const rows = within(trail).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    for (const [offset, row] of rows.entries()) {
      expect(
        within(row).getByText(
          `Assistant-created · generation/1/tool/${offset + 1}`,
        ),
      ).toBeVisible();
    }
    expect(within(rows[0]).getByText("Research")).toBeVisible();
    expect(within(rows[1]).getByText("today's note")).toBeVisible();
    expect(within(rows[2]).getByText(/A machine-authored passage/)).toBeVisible();
    expect(within(rows[3]).getByText("Related evidence")).toBeVisible();
    expect(within(rows[4]).getByText("Read next")).toBeVisible();
    expect(screen.queryByText("Authorship unavailable")).toBeNull();
  });

  it("distinguishes an idempotent no-new-target success from authored content", () => {
    render(
      <AssistantWriteTrail
        conversationId={CONVERSATION_ID}
        toolCalls={[
          currentToolCall({
            id: TOOL_CALL_ID,
            canonicalToolId: "nexus.queue.add",
            effect: "Write",
            resultKind: "mutation",
            activityLabel: "Adding to the queue",
            resultRefs: [],
            machineAuthorships: [],
          }),
        ]}
      />,
    );

    expect(screen.getByText("No new target created")).toBeVisible();
    expect(screen.queryByText(/Assistant-created/)).toBeNull();
  });

  it("withholds an unhydrated live write instead of claiming it created no target", () => {
    const liveTool = currentToolCall({
      id: TOOL_CALL_ID,
      canonicalToolId: "nexus.note.create",
      effect: "Write",
      resultKind: "mutation",
      activityLabel: "Creating a note",
      resultRefs: [
        {
          kind: "note_block",
          id: "55555555-5555-4555-8555-555555555555",
          label: "today's note",
        },
      ],
    });
    delete liveTool.machine_authorships;

    render(
      <AssistantWriteTrail
        conversationId={CONVERSATION_ID}
        toolCalls={[liveTool]}
      />,
    );

    expect(screen.queryByRole("list", { name: "Assistant actions" })).toBeNull();
    expect(screen.queryByText("No new target created")).toBeNull();
  });
});
