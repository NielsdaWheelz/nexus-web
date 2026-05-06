import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDailyNotePage, isLocalDate, quickCaptureDailyNote } from "./api";

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
});
