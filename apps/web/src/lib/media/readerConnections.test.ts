import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { listReaderConnections } from "./readerConnections";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

describe("reader connections client", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("sends explicit origin and source-scheme filters", async () => {
    const signal = new AbortController().signal;
    apiFetchMock.mockResolvedValueOnce({
      data: { anchored: [], unanchored: [], next_cursor: null },
    });

    await expect(
      listReaderConnections("media-1", {
        origins: ["citation", "note_body"],
        sourceSchemes: ["message"],
        limit: 20,
        cursor: "cursor-1",
        signal,
      }),
    ).resolves.toEqual({ anchored: [], unanchored: [], next_cursor: null });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/media/media-1/reader-connections?origin=citation&origin=note_body&source_scheme=message&limit=20&cursor=cursor-1",
      { signal },
    );
  });
});
