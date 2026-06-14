import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalDate } from "@/lib/localDate";
import {
  fetchDailyNotePage,
  quickCaptureDailyNote,
  saveResourceSurface,
} from "./api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("notes api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("validates ISO local dates", () => {
    expect(isLocalDate("2026-05-06")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("05/06/2026")).toBe(false);
  });

  it("uses durable daily-note endpoints", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/notes/daily/2026-05-06") {
          return jsonResponse({
            data: {
              localDate: "2026-05-06",
              page: {
                id: "page-today",
                title: "May 6, 2026",
                surface: null,
                blocks: [],
              },
            },
          });
        }
        if (
          url.pathname === "/api/notes/quick-capture" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return jsonResponse({
            data: {
              id: "block-1",
              parent_block_id: null,
              order_key: "a",
              body_pm_json: body.body_pm_json ?? { type: "paragraph" },
              body_text: "capture",
              collapsed: false,
              children: [],
            },
          });
        }
        throw new Error(`Unexpected fetch call: ${url.pathname}`);
      });

    await expect(fetchDailyNotePage("2026-05-06")).resolves.toMatchObject({
      id: "page-today",
    });
    await expect(
      quickCaptureDailyNote({
        localDate: "2026-05-06",
        blockId: "block-client-1",
        clientMutationId: "mutation-client-1",
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: "capture" }],
        },
      }),
    ).resolves.toMatchObject({ id: "block-1", bodyText: "capture" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/notes/quick-capture?"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "block-client-1",
          client_mutation_id: "mutation-client-1",
          body_pm_json: {
            type: "paragraph",
            content: [{ type: "text", text: "capture" }],
          },
          local_date: "2026-05-06",
        }),
      }),
    );

    await expect(
      quickCaptureDailyNote({
        localDate: "2026-05-06",
        blockId: "block-client-2",
        clientMutationId: "mutation-client-2",
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: "capture" }],
        },
      }),
    ).resolves.toMatchObject({ id: "block-1", bodyText: "capture" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/notes/quick-capture?"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "block-client-2",
          client_mutation_id: "mutation-client-2",
          body_pm_json: {
            type: "paragraph",
            content: [{ type: "text", text: "capture" }],
          },
          local_date: "2026-05-06",
        }),
      }),
    );
  });

  it("saves surfaces through resource item mutations", async () => {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null }> =
      [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      if (url.pathname.endsWith("/body")) {
        return jsonResponse({
          data: { bodyPmJson: { type: "paragraph" }, bodyText: "body", versions: {} },
        });
      }
      if (url.pathname.endsWith("/adjacency")) {
        return jsonResponse({ data: { changedEdgeIds: ["edge-1"] } });
      }
      if (url.pathname === "/api/notes/pages/page-1") {
        return jsonResponse({
          data: {
            id: "page-1",
            title: "Page",
            surface: null,
            blocks: [
              {
                id: "block-1",
                parent_block_id: null,
                order_key: "0000000001",
                body_pm_json: { type: "paragraph" },
                body_text: "body",
                collapsed: false,
                children: [],
              },
            ],
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const result = await saveResourceSurface("page-1", {
      clientMutationId: "mutation-1",
      baseVersions: [{ ref: "page:page-1", lane: "title", version: 1 }],
      focusBlockId: null,
      blocks: [
        {
          id: "block-1",
          bodyPmJson: { type: "paragraph" },
        },
      ],
      adjacency: [
        {
          parent: { scheme: "page", id: "page-1" },
          children: [
            {
              blockId: "block-1",
              sourceOrderKey: "0000000001",
              collapsed: false,
            },
          ],
        },
      ],
      deletedBlockIds: ["block-2"],
    });

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["PATCH", "/api/resource-items/note_block%3Ablock-1/body"],
      ["PUT", "/api/resource-items/page%3Apage-1/adjacency"],
      ["GET", "/api/notes/pages/page-1"],
    ]);
    expect(calls[0]?.body).toEqual({
      client_mutation_id: "mutation-1",
      base_versions: [],
      body_pm_json: { type: "paragraph" },
    });
    expect(calls[1]?.body).toEqual({
      client_mutation_id: "mutation-1",
      base_versions: [],
      ordered_targets: [{ ref: "note_block:block-1", source_order_key: "0000000001" }],
    });
    expect(result.page.blocks[0]?.id).toBe("block-1");
    expect(result.changedEdgeIds).toEqual(["edge-1"]);
  });

  it("rejects legacy revision fields in note responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          id: "page-1",
          title: "Page",
          surface: null,
          revision: 7,
          blocks: [],
        },
      }),
    );

    await expect(
      saveResourceSurface("page-1", {
        clientMutationId: "mutation-1",
        baseVersions: [],
        focusBlockId: null,
        blocks: [],
        adjacency: [],
        deletedBlockIds: [],
      }),
    ).rejects.toThrow("note page includes legacy artifact identity");
  });
});
