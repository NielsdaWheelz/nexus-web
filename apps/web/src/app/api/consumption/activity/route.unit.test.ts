import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { postActivityWithDependencies } from "@/lib/consumption/historyBff.server";

const proxyToFastAPI = vi.fn();
const dependencies = {
  deviceId: async () => ({
    kind: "Present" as const,
    value: "server-private-device-id",
  }),
  proxy: proxyToFastAPI,
};

function validBody(): Record<string, unknown> {
  return {
    clientMutationId: "30000000-0000-4000-8000-000000000001",
    mediaRef: "media:11111111-1111-4111-8111-111111111111",
    deviceClass: "Desktop",
    batch: {
      modality: "Viewing",
      spans: [
        {
          captureKey: "20000000-0000-4000-8000-000000000001",
          occurredAt: "2026-08-10T18:00:00.000Z",
          durationMs: 5_000,
        },
      ],
    },
  };
}

describe("POST /api/consumption/activity", () => {
  beforeEach(() => {
    proxyToFastAPI.mockReset();
    proxyToFastAPI.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("strictly decodes before injecting the server-owned device id", async () => {
    const response = await postActivityWithDependencies(
      new Request("https://nexus.example/api/consumption/activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      dependencies,
    );

    expect(response.status).toBe(204);
    expect(proxyToFastAPI).toHaveBeenCalledOnce();
    const [forwarded, path] = proxyToFastAPI.mock.calls[0] as [Request, string];
    expect(path).toBe("/consumption/activity");
    await expect(forwarded.json()).resolves.toEqual({
      ...validBody(),
      deviceId: "server-private-device-id",
    });
  });

  it("rejects browser device injection and oversized bodies before proxying", async () => {
    const injected = await postActivityWithDependencies(
      new Request("https://nexus.example/api/consumption/activity", {
        method: "POST",
        body: JSON.stringify({ ...validBody(), deviceId: "attacker" }),
      }),
      dependencies,
    );
    expect(injected.status).toBe(400);
    await expect(injected.json()).resolves.toMatchObject({
      error: { code: "E_INVALID_REQUEST" },
    });

    const oversized = await postActivityWithDependencies(
      new Request("https://nexus.example/api/consumption/activity", {
        method: "POST",
        body: "x".repeat(48_001),
      }),
      dependencies,
    );
    expect(oversized.status).toBe(413);
    expect(proxyToFastAPI).not.toHaveBeenCalled();
  });
});
