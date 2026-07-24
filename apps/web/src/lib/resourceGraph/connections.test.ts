import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  queryConnectionSummaries,
  queryConnections,
  type ConnectionActionEndpointOut,
  type ConnectionOut,
  type ConnectionSummaryOut,
} from "./connections";

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>(
      "@/lib/api/client",
    );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

const PAGE_REF = "page:11111111-1111-4111-8111-111111111111";
const MEDIA_REF = "media:22222222-2222-4222-8222-222222222222";

function endpoint({
  ref,
  scheme,
  id,
  label,
  href,
}: {
  ref: string;
  scheme: ConnectionActionEndpointOut["scheme"];
  id: string;
  label: string;
  href: string;
}): ConnectionActionEndpointOut {
  const activation = {
    resourceRef: ref,
    kind: "route" as const,
    href,
    unresolvedReason: null,
  };
  return {
    ref,
    scheme,
    id,
    label,
    description: null,
    activation,
    href,
    missing: false,
    actionTarget: {
      kind: "Resource",
      ref: ref as never,
      activation,
      missing: false,
    },
  };
}

const pageEndpoint = endpoint({
  ref: PAGE_REF,
  scheme: "page",
  id: "11111111-1111-4111-8111-111111111111",
  label: "Page",
  href: "/pages/11111111-1111-4111-8111-111111111111",
});
const mediaEndpoint = endpoint({
  ref: MEDIA_REF,
  scheme: "media",
  id: "22222222-2222-4222-8222-222222222222",
  label: "Media",
  href: "/media/22222222-2222-4222-8222-222222222222",
});

const connection: ConnectionOut = {
  edge_id: "edge-1",
  direction: "outgoing",
  kind: "context",
  origin: "user",
  snapshot: null,
  source_order_key: null,
  target_order_key: null,
  ordinal: null,
  source_ref: PAGE_REF,
  target_ref: MEDIA_REF,
  source: pageEndpoint,
  target: mediaEndpoint,
  other: mediaEndpoint,
  citation: null,
  link_note: null,
  created_at: "2026-01-01T00:00:00Z",
};

function wireConnection(value: ConnectionOut): Record<string, unknown> {
  const wireActivation = (
    activation: ConnectionActionEndpointOut["activation"],
  ) => ({
    resource_ref: activation.resourceRef,
    kind: activation.kind,
    href: activation.href,
    unresolved_reason: activation.unresolvedReason,
  });
  const stripTarget = ({
    actionTarget: _actionTarget,
    ...wire
  }: ConnectionActionEndpointOut) => ({
    ...wire,
    activation: wireActivation(wire.activation),
  });
  return {
    ...value,
    source: stripTarget(value.source),
    target: stripTarget(value.target),
    other: stripTarget(value.other),
  };
}

const undirectedLink: ConnectionOut = {
  ...connection,
  edge_id: "edge-2",
  direction: "undirected",
  link_note: {
    ref: "note_block:33333333-3333-4333-8333-333333333333",
    note_block_id: "33333333-3333-4333-8333-333333333333",
    preview: "Why these connect",
  },
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
      data: { items: [wireConnection(connection)], next_cursor: null },
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

  it("defects when a connection endpoint activation contradicts its ref", async () => {
    const wire = wireConnection(connection);
    const other = wire.other as Record<string, unknown>;
    wire.other = {
      ...other,
      activation: {
        resource_ref: PAGE_REF,
        kind: "route",
        href: "/media/22222222-2222-4222-8222-222222222222",
        unresolved_reason: null,
      },
    };
    apiFetchMock.mockResolvedValueOnce({
      data: { items: [wire], next_cursor: null },
    });

    await expect(
      queryConnections({
        refs: [PAGE_REF],
        direction: "both",
      }),
    ).rejects.toThrow(
      "ConnectionPage.items[0].other.actionTarget.ref must equal",
    );
  });

  it("defects on the removed camelCase activation compatibility shape", async () => {
    const wire = wireConnection(connection);
    const other = wire.other as Record<string, unknown>;
    wire.other = {
      ...other,
      activation: connection.other.activation,
    };
    apiFetchMock.mockResolvedValueOnce({
      data: { items: [wire], next_cursor: null },
    });

    await expect(
      queryConnections({
        refs: [PAGE_REF],
        direction: "both",
      }),
    ).rejects.toThrow("must contain exactly");
  });

  it("defects when the required link_note field is omitted", async () => {
    const { link_note: _linkNote, ...wire } = wireConnection(connection);
    apiFetchMock.mockResolvedValueOnce({
      data: { items: [wire], next_cursor: null },
    });

    await expect(
      queryConnections({
        refs: [PAGE_REF],
        direction: "both",
      }),
    ).rejects.toThrow("must contain exactly");
  });

  it("defects on unowned connection response fields", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: {
        items: [{ ...wireConnection(connection), legacy_href: "/legacy" }],
        next_cursor: null,
      },
    });

    await expect(
      queryConnections({
        refs: [PAGE_REF],
        direction: "both",
      }),
    ).rejects.toThrow("must contain exactly");
  });

  it("carries undirected neutral Links and their folded link_note", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: { items: [wireConnection(undirectedLink)], next_cursor: null },
    });

    await expect(
      queryConnections({
        refs: ["page:11111111-1111-4111-8111-111111111111"],
        direction: "both",
      }),
    ).resolves.toEqual({ items: [undirectedLink], next_cursor: null });
  });

  it("passes abort signals on connection queries", async () => {
    const controller = new AbortController();
    apiFetchMock.mockResolvedValueOnce({
      data: { items: [], next_cursor: null },
    });

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
      queryConnectionSummaries(["media:22222222-2222-4222-8222-222222222222"], {
        signal: controller.signal,
      }),
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
