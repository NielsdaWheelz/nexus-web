import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { createNotePage } from "./api";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

describe("notes create client", () => {
  beforeEach(() => apiFetchMock.mockReset());

  it("posts the caller-owned replay identity in the strict create body", async () => {
    const pageId = "00000000-0000-4000-8000-000000000212";
    apiFetchMock.mockResolvedValueOnce({
      data: {
        id: pageId,
        title: "Research",
        updated_at: "2026-07-27T12:00:00Z",
        daily_note: null,
      },
    });

    await expect(
      createNotePage({ pageId, title: "Research" }),
    ).resolves.toMatchObject({
      id: pageId,
      title: "Research",
      dailyNote: null,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/notes/pages", {
      method: "POST",
      body: JSON.stringify({ page_id: pageId, title: "Research" }),
    });

    apiFetchMock.mockResolvedValueOnce({
      data: {
        id: "00000000-0000-4000-8000-000000000299",
        title: "Research",
        daily_note: null,
      },
    });
    await expect(
      createNotePage({ pageId, title: "Research" }),
    ).rejects.toThrow(/does not match requested page/);
  });
});
