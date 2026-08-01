import { render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { BranchGraph, ForkOption } from "@/lib/conversations/types";
import ConversationForksPanel from "./ConversationForksPanel";

const childFork: ForkOption = {
  id: "branch-child",
  parent_message_id: "root-assistant",
  user_message_id: "child-user",
  assistant_message_id: "child-assistant",
  leaf_message_id: "child-assistant",
  title: "Child path",
  preview: "Follow the child reply in full",
  branch_anchor_kind: "assistant_selection",
  branch_anchor_preview: "selected assistant passage in full",
  status: "complete",
  message_count: 2,
  created_at: "2026-08-01T12:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
  active: false,
};

const branchGraph: BranchGraph = {
  root_message_id: "root-assistant",
  edges: [],
  nodes: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      if (
        url.pathname === "/api/conversations/conversation-1/forks" &&
        method === "GET"
      ) {
        return json({ data: { forks: [childFork] } });
      }
      if (
        url.pathname ===
          "/api/conversations/conversation-1/forks/branch-child" &&
        method === "DELETE"
      ) {
        return json(
          {
            error: {
              code: "E_CONFLICT",
              message: "Synthetic delete refusal",
            },
          },
          409,
        );
      }
      throw new Error(`Unexpected fork BFF request: ${method} ${url.pathname}`);
    },
  );
});

it("retains the fork but closes destructive confirmation when DELETE fails", async () => {
  render(
    withRenderEnvironment(
      <ConversationForksPanel
        conversationId="conversation-1"
        forkOptionsByParentId={{ "root-assistant": [childFork] }}
        branchGraph={branchGraph}
        switchableLeafIds={new Set([childFork.leaf_message_id])}
        activeLeafMessageId={null}
        selectedPathMessageIds={new Set()}
        onSelectFork={() => {}}
        onSelectGraphLeaf={() => {}}
      />,
    ),
  );

  await screen.findByRole("button", { name: "Switch to fork Child path" });
  await userEvent.click(
    screen.getByRole("button", { name: "Delete fork Child path" }),
  );
  const confirmation = screen.getByRole("group", {
    name: /confirm delete fork.*child path/i,
  });
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "Delete" }),
  );

  expect(await screen.findByText("Fork delete failed.")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Switch to fork Child path" }),
    "Failed deletion removed the fork from the real panel.",
  ).toBeVisible();
  expect(
    screen.queryByRole("group", {
      name: /confirm delete fork.*child path/i,
    }),
    "Failed deletion left a stale destructive confirmation armed.",
  ).toBeNull();
});
