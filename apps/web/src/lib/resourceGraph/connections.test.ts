import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  queryConnectionSummaries,
  queryConnections,
  type ConnectionOut,
  type ConnectionSummaryOut,
} from "./connections";

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

const connection: ConnectionOut = {
  edge_id: "edge-1",
  direction: "outgoing",
  kind: "context",
  origin: "user",
  snapshot: null,
  source_order_key: null,
  target_order_key: null,
  ordinal: null,
  source_ref: "page:11111111-1111-4111-8111-111111111111",
  target_ref: "media:22222222-2222-4222-8222-222222222222",
  source: {
    ref: "page:11111111-1111-4111-8111-111111111111",
    scheme: "page",
    id: "11111111-1111-4111-8111-111111111111",
    label: "Page",
    description: null,
    activation: {
      resourceRef: "page:11111111-1111-4111-8111-111111111111",
      kind: "route",
      href: "/pages/11111111-1111-4111-8111-111111111111",
      unresolvedReason: null,
    },
    href: "/pages/11111111-1111-4111-8111-111111111111",
    missing: false,
  },
  target: {
    ref: "media:22222222-2222-4222-8222-222222222222",
    scheme: "media",
    id: "22222222-2222-4222-8222-222222222222",
    label: "Media",
    description: null,
    activation: {
      resourceRef: "media:22222222-2222-4222-8222-222222222222",
      kind: "route",
      href: "/media/22222222-2222-4222-8222-222222222222",
      unresolvedReason: null,
    },
    href: "/media/22222222-2222-4222-8222-222222222222",
    missing: false,
  },
  other: {
    ref: "media:22222222-2222-4222-8222-222222222222",
    scheme: "media",
    id: "22222222-2222-4222-8222-222222222222",
    label: "Media",
    description: null,
    activation: {
      resourceRef: "media:22222222-2222-4222-8222-222222222222",
      kind: "route",
      href: "/media/22222222-2222-4222-8222-222222222222",
      unresolvedReason: null,
    },
    href: "/media/22222222-2222-4222-8222-222222222222",
    missing: false,
  },
  citation: null,
  created_at: "2026-01-01T00:00:00Z",
};

const summary: ConnectionSummaryOut = {
  ref: "media:22222222-2222-4222-8222-222222222222",
  total: 1,
  by_kind: { context: 1 },
  last_connected_at: "2026-01-01T00:00:00Z",
  dominant_kind: "context",
  top_peers: [connection.source],
};

describe("resource graph connections client", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("queries hydrated connections through the BFF route", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: { items: [connection], next_cursor: null },
    });

    await expect(
      queryConnections({
        refs: ["page:11111111-1111-4111-8111-111111111111"],
        direction: "both",
        rollup: "owner",
        filters: { origins: ["user"], source_schemes: ["page"] },
        limit: 25,
      }),
    ).resolves.toEqual({ items: [connection], next_cursor: null });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/resource-graph/connections/query",
      {
        method: "POST",
        signal: undefined,
        body: JSON.stringify({
          refs: ["page:11111111-1111-4111-8111-111111111111"],
          direction: "both",
          rollup: "owner",
          filters: { origins: ["user"], source_schemes: ["page"] },
          limit: 25,
        }),
      },
    );
  });

  it("passes abort signals on connection queries", async () => {
    const controller = new AbortController();
    apiFetchMock.mockResolvedValueOnce({ data: { items: [], next_cursor: null } });

    await queryConnections(
      {
        refs: ["media:22222222-2222-4222-8222-222222222222"],
        direction: "incoming",
      },
      { signal: controller.signal },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/resource-graph/connections/query",
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          refs: ["media:22222222-2222-4222-8222-222222222222"],
          direction: "incoming",
        }),
      },
    );
  });

  it("returns an empty summary list without hitting the BFF", async () => {
    await expect(queryConnectionSummaries([])).resolves.toEqual([]);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("queries batched connection summaries through the BFF route", async () => {
    const controller = new AbortController();
    apiFetchMock.mockResolvedValueOnce({ data: { summaries: [summary] } });

    await expect(
      queryConnectionSummaries(
        ["media:22222222-2222-4222-8222-222222222222"],
        { signal: controller.signal },
      ),
    ).resolves.toEqual([summary]);

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/resource-graph/connections/summary",
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          refs: ["media:22222222-2222-4222-8222-222222222222"],
        }),
      },
    );
  });
});
