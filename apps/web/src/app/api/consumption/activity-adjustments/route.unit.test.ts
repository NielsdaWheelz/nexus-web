import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { postActivityAdjustmentWithProxy } from "@/lib/consumption/historyBff.server";

const proxyToFastAPI = vi.fn();

const REQUEST = {
  kind: "Add",
  clientMutationId: "30000000-0000-4000-8000-000000000001",
  mediaRef: "media:11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-08-10T18:00:00.000Z",
  durationMs: 5_000,
} as const;

describe("POST /api/consumption/activity-adjustments", () => {
  beforeEach(() => {
    proxyToFastAPI.mockReset();
    proxyToFastAPI.mockResolvedValue(
      Response.json({
        data: {
          outcome: "Added",
          adjustmentHandle: {
            kind: "Present",
            value: "nca1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
          },
        },
      }),
    );
  });

  it("forwards only the strict decoded public adjustment", async () => {
    const response = await postActivityAdjustmentWithProxy(
      new Request(
        "https://nexus.example/api/consumption/activity-adjustments",
        { method: "POST", body: JSON.stringify(REQUEST) },
      ),
      proxyToFastAPI,
    );

    expect(response.status).toBe(200);
    const [forwarded, path] = proxyToFastAPI.mock.calls[0] as [Request, string];
    expect(path).toBe("/consumption/activity-adjustments");
    await expect(forwarded.json()).resolves.toEqual(REQUEST);
  });

  it("rejects extra same-system fields before proxying", async () => {
    const response = await postActivityAdjustmentWithProxy(
      new Request(
        "https://nexus.example/api/consumption/activity-adjustments",
        {
          method: "POST",
          body: JSON.stringify({ ...REQUEST, deviceId: "not-public" }),
        },
      ),
      proxyToFastAPI,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "E_INVALID_REQUEST" },
    });
    expect(proxyToFastAPI).not.toHaveBeenCalled();
  });
});
