import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  createUserEdge,
  deleteUserEdge,
  listEdgesForRef,
  resolveResourceRefs,
  type EdgeOut,
} from "./edges";

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

const edge: EdgeOut = {
  id: "edge-1",
  kind: "context",
  origin: "user",
  source_ref: "page:11111111-1111-4111-8111-111111111111",
  target_ref: "media:22222222-2222-4222-8222-222222222222",
  source_order_key: null,
  target_order_key: null,
  ordinal: null,
  snapshot: null,
  source_label: "Page",
  source_missing: false,
  target_label: "Media",
  target_missing: false,
  created_at: "2026-01-01T00:00:00Z",
};

describe("resource graph edges client", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("lists edges for a resource ref", async () => {
    apiFetchMock.mockResolvedValueOnce({ data: [edge] });

    await expect(
      listEdgesForRef("page:11111111-1111-4111-8111-111111111111"),
    ).resolves.toEqual([edge]);

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/resource-graph/edges?ref=page%3A11111111-1111-4111-8111-111111111111",
    );
  });

  it("passes abort signals on edge reads", async () => {
    const controller = new AbortController();
    apiFetchMock.mockResolvedValueOnce({ data: [] });

    await listEdgesForRef("media:22222222-2222-4222-8222-222222222222", {
      signal: controller.signal,
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/resource-graph/edges?ref=media%3A22222222-2222-4222-8222-222222222222",
      { signal: controller.signal },
    );
  });

  it("creates user edges without exposing order or origin writes", async () => {
    apiFetchMock.mockResolvedValueOnce({ data: edge });

    await expect(
      createUserEdge({
        sourceRef: edge.source_ref,
        targetRef: edge.target_ref,
        kind: "supports",
      }),
    ).resolves.toEqual(edge);

    expect(apiFetchMock).toHaveBeenCalledWith("/api/resource-graph/edges", {
      method: "POST",
      body: JSON.stringify({
        source_ref: edge.source_ref,
        target_ref: edge.target_ref,
        kind: "supports",
      }),
    });
  });

  it("deletes user edges through the BFF route", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);

    await deleteUserEdge("edge-1");

    expect(apiFetchMock).toHaveBeenCalledWith("/api/resource-graph/edges/edge-1", {
      method: "DELETE",
    });
  });

  it("resolves resource refs through the BFF route", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: [{ ref: edge.target_ref, label: "Media", summary: "", missing: false }],
    });

    await expect(resolveResourceRefs([edge.target_ref])).resolves.toEqual([
      { ref: edge.target_ref, label: "Media", summary: "", missing: false },
    ]);

    expect(apiFetchMock).toHaveBeenCalledWith("/api/resource-graph/resolve", {
      method: "POST",
      body: JSON.stringify({ refs: [edge.target_ref] }),
    });
  });

  it("resolves empty ref lists without calling the backend", async () => {
    await expect(resolveResourceRefs([])).resolves.toEqual([]);

    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
