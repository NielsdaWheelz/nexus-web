import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDailyNotePage,
  isLocalDate,
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
              revision: 1,
              blocks: [],
            },
          },
        });
      }
      if (
        url.pathname === "/api/notes/daily/2026-05-06/quick-capture" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          data: {
            id: "block-1",
            page_id: "page-today",
            parent_block_id: null,
            order_key: "a",
            block_kind: "bullet",
            body_pm_json: { type: "paragraph" },
            body_markdown: "capture",
            body_text: "capture",
            collapsed: false,
            revision: 1,
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
      quickCaptureDailyNote({ localDate: "2026-05-06", bodyMarkdown: "capture" })
    ).resolves.toMatchObject({ id: "block-1", bodyText: "capture" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/notes/daily/2026-05-06/quick-capture?"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body_markdown: "capture" }),
      })
    );
  });

  it("sends the hard-cutover document save shape and normalizes revisions", async () => {
    let requestBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/notes/pages/page-1/document");
      expect(init?.method).toBe("PATCH");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        data: {
          clientMutationId: "mutation-1",
          page: {
            id: "page-1",
            title: "Page",
            description: null,
            revision: 3,
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
                revision: 2,
                children: [],
              },
            ],
          },
        },
      });
    });

    const result = await saveNotePageDocument("page-1", {
      clientMutationId: "mutation-1",
      basePageRevision: 2,
      focusBlockId: null,
      topLevelParentBlockId: null,
      blocks: [
        {
          id: "block-1",
          parentBlockId: null,
          beforeBlockId: null,
          afterBlockId: null,
          blockKind: "bullet",
          bodyPmJson: { type: "paragraph" },
          collapsed: false,
          baseRevision: 1,
        },
      ],
      deletedBlocks: [{ id: "block-2", baseRevision: 1 }],
    });

    expect(requestBody).toEqual({
      client_mutation_id: "mutation-1",
      base_page_revision: 2,
      focus_block_id: null,
      top_level_parent_block_id: null,
      blocks: [
        {
          id: "block-1",
          parent_block_id: null,
          before_block_id: null,
          after_block_id: null,
          block_kind: "bullet",
          body_pm_json: { type: "paragraph" },
          collapsed: false,
          base_revision: 1,
        },
      ],
      deleted_blocks: [{ id: "block-2", base_revision: 1 }],
    });
    expect(result.page.revision).toBe(3);
    expect(result.page.blocks[0]?.revision).toBe(2);
  });
});
