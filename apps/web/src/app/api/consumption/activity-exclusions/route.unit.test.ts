import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { postActivityExclusionWithProxy } from "@/lib/consumption/historyBff.server";

const proxyToFastAPI = vi.fn();
const REQUEST = {
  kind: "Exclude",
  clientMutationId: "30000000-0000-4000-8000-000000000001",
  mediaRef: "media:11111111-1111-4111-8111-111111111111",
  modality: "Viewing",
  deviceHandle: "ncd1.CCCCCCCCCCCCCCCCCCCCCC",
  startedAt: "2026-08-10T17:00:00Z",
  endedAt: "2026-08-10T18:00:00.123000Z",
} as const;

describe("POST /api/consumption/activity-exclusions", () => {
  beforeEach(() => {
    proxyToFastAPI.mockReset();
    proxyToFastAPI.mockResolvedValue(
      Response.json({
        data: {
          outcome: "Excluded",
          exclusionHandle: "nce1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        },
      }),
    );
  });

  it("forwards only the strict decoded public exclusion with private no-store", async () => {
    const response = await postActivityExclusionWithProxy(
      new Request("https://nexus.example/api/consumption/activity-exclusions", {
        method: "POST",
        body: JSON.stringify(REQUEST),
      }),
      proxyToFastAPI,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [forwarded, path] = proxyToFastAPI.mock.calls[0] as [Request, string];
    expect(path).toBe("/consumption/activity-exclusions");
    await expect(forwarded.json()).resolves.toEqual(REQUEST);
  });

  it.each([
    [
      "legacy positive-duration command",
      {
        kind: "Add",
        clientMutationId: "30000000-0000-4000-8000-000000000002",
        mediaRef: REQUEST.mediaRef,
        occurredAt: "2026-08-10T18:00:00.000Z",
        durationMs: 5_000,
      },
    ],
    ["extra same-system field", { ...REQUEST, durationMs: 5_000 }],
  ])("rejects %s before proxying", async (_name, body) => {
    const response = await postActivityExclusionWithProxy(
      new Request("https://nexus.example/api/consumption/activity-exclusions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      proxyToFastAPI,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "E_INVALID_REQUEST" },
    });
    expect(proxyToFastAPI).not.toHaveBeenCalled();
  });
});
