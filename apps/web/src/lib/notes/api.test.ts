import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalDate } from "@/lib/localDate";
import {
  fetchDailyNotePage,
  quickCaptureDailyNote,
  saveNotePageDocument,
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/notes/daily/2026-05-06") {
        return jsonResponse({
          data: {
            localDate: "2026-05-06",
            page: {
              id: "page-today",
              title: "May 6, 2026",
              description: null,
              documentVersion: 1,
              blocks: [],
            },
          },
        });
      }
      if (url.pathname === "/api/notes/quick-capture" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          data: {
            id: "block-1",
            page_id: "page-today",
            parent_block_id: null,
            order_key: "a",
            block_kind: "bullet",
            body_pm_json: body.body_pm_json ?? { type: "paragraph" },
            body_markdown: "capture",
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
        bodyMarkdown: "capture",
      })
    ).resolves.toMatchObject({ id: "block-1", bodyText: "capture" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/notes/quick-capture?"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "block-client-1",
          client_mutation_id: "mutation-client-1",
          body_markdown: "capture",
          local_date: "2026-05-06",
        }),
      })
    );

    await expect(
      quickCaptureDailyNote({
        localDate: "2026-05-06",
        blockId: "block-client-2",
        clientMutationId: "mutation-client-2",
        bodyPmJson: { type: "paragraph", content: [{ type: "text", text: "capture" }] },
      })
    ).resolves.toMatchObject({ id: "block-1", bodyText: "capture" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/notes/quick-capture?"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "block-client-2",
          client_mutation_id: "mutation-client-2",
          body_pm_json: { type: "paragraph", content: [{ type: "text", text: "capture" }] },
          local_date: "2026-05-06",
        }),
      })
    );
  });

  it("sends the current document save shape", async () => {
    let requestBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/notes/pages/page-1/document");
      expect(init?.method).toBe("PATCH");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        data: {
          clientMutationId: "mutation-1",
          documentVersion: 2,
          changedBlockIds: ["block-1"],
          changedEdgeIds: ["edge-1"],
          reindexJobId: null,
          page: {
            id: "page-1",
            title: "Page",
            description: null,
            documentVersion: 2,
            blocks: [
              {
                id: "block-1",
                page_id: "page-1",
                parent_block_id: null,
                order_key: "0000000001",
                block_kind: "bullet",
                body_pm_json: { type: "paragraph" },
                body_markdown: "body",
                body_text: "body",
                collapsed: false,
                children: [],
              },
            ],
          },
        },
      });
    });

    const result = await saveNotePageDocument("page-1", {
      clientMutationId: "mutation-1",
      baseDocumentVersion: 1,
      focusBlockId: null,
      blocks: [
        {
          id: "block-1",
          blockKind: "bullet",
          bodyPmJson: { type: "paragraph" },
        },
      ],
      containment: [
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

    expect(requestBody).toEqual({
      client_mutation_id: "mutation-1",
      base_document_version: 1,
      title: null,
      focus_block_id: null,
      blocks: [
        {
          id: "block-1",
          block_kind: "bullet",
          body_pm_json: { type: "paragraph" },
        },
      ],
      containment: [
        {
          parent: { scheme: "page", id: "page-1" },
          children: [
            {
              block_id: "block-1",
              source_order_key: "0000000001",
              collapsed: false,
            },
          ],
        },
      ],
      deleted_block_ids: ["block-2"],
    });
    expect(result.page.blocks[0]?.id).toBe("block-1");
    expect(result.documentVersion).toBe(2);
  });

  it("rejects legacy revision fields in note responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          clientMutationId: "mutation-1",
          documentVersion: 1,
          page: {
            id: "page-1",
            title: "Page",
            description: null,
            documentVersion: 1,
            revision: 7,
            blocks: [],
          },
        },
      }),
    );

    await expect(
      saveNotePageDocument("page-1", {
        clientMutationId: "mutation-1",
        baseDocumentVersion: 1,
        focusBlockId: null,
        blocks: [],
        containment: [],
        deletedBlockIds: [],
      }),
    ).rejects.toThrow("note page includes legacy artifact identity");
  });
});
