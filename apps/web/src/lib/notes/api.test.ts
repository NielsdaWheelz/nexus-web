import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  createNotePage,
  decodeDailyPageDescriptor,
} from "./api";

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
        updatedAt: "2026-07-27T12:00:00Z",
        dailyPage: null,
      },
    });

    await expect(
      createNotePage({ pageId, title: "Research" }),
    ).resolves.toMatchObject({
      id: pageId,
      title: "Research",
      dailyPage: null,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/notes/pages", {
      method: "POST",
      body: JSON.stringify({ page_id: pageId, title: "Research" }),
    });

    apiFetchMock.mockResolvedValueOnce({
      data: {
        id: "00000000-0000-4000-8000-000000000299",
        title: "Research",
        updatedAt: null,
        dailyPage: null,
      },
    });
    await expect(
      createNotePage({ pageId, title: "Research" }),
    ).rejects.toThrow(/does not match requested page/);
  });
});

describe("daily page decoder", () => {
  it.each(["dailyNote", "daily_note"])(
    "rejects the removed %s locator payload",
    (locatorKey) => {
      expect(() =>
        decodeDailyPageDescriptor({
          kind: "Materialized",
          localDate: "2026-07-30",
          page: {
            id: "00000000-0000-4000-8000-000000000212",
            title: "Thursday, July 30",
            updatedAt: null,
            dailyPage: null,
            [locatorKey]: {
              localDate: "2026-07-30",
              timeZone: "America/Los_Angeles",
            },
          },
          surface: {},
        }),
      ).toThrow(/must contain exactly/);
    },
  );

  it("rejects the removed time-zone field on a latent locator payload", () => {
    expect(() =>
      decodeDailyPageDescriptor({
        kind: "Latent",
        localDate: "2026-07-30",
        defaultTitle: "Thursday, July 30",
        timeZone: "America/Los_Angeles",
      }),
    ).toThrow(/must contain exactly/);
  });
});
