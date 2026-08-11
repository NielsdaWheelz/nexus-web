import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/client";
import {
  decodeActivityAdjustmentRequest,
  parseActivityAdjustmentHandle,
  parseActivityDeviceHandle,
  submitActivityAdjustment,
} from "./activityAdjustments";
import {
  decodeActivityRequest,
  parseActivityCaptureKey,
  parseMediaRef,
  postActivityBatch,
  type ActivityRequest,
} from "./activityContract";
import { consumptionProjectionSnapshot } from "./projectionRevision";

const MEDIA_REF = parseMediaRef(
  "media:11111111-1111-4111-8111-111111111111",
);
const CAPTURE_KEY = parseActivityCaptureKey(
  "20000000-0000-4000-8000-000000000001",
);
const ADJUSTMENT_HANDLE = parseActivityAdjustmentHandle(
  "nca1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
);

function activityRequest(): ActivityRequest {
  return {
    clientMutationId: "30000000-0000-4000-8000-000000000001",
    mediaRef: MEDIA_REF,
    deviceClass: "Desktop",
    batch: {
      modality: "Viewing",
      spans: [
        {
          captureKey: CAPTURE_KEY,
          occurredAt: "2026-08-10T18:00:00.000Z",
          durationMs: 5_000,
        },
      ],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Consumption activity wire contracts", () => {
  it("strictly rejects duplicate capture keys and extra fields", () => {
    const request = activityRequest();
    expect(() =>
      decodeActivityRequest({
        ...request,
        batch: {
          ...request.batch,
          spans: [...request.batch.spans, ...request.batch.spans],
        },
      }),
    ).toThrow("capture keys must be unique");
    expect(() => decodeActivityRequest({ ...request, deviceId: "private" })).toThrow(
      "invalid shape",
    );
  });

  it.each([
    [204, undefined, "Accepted"],
    [401, "E_UNAUTHENTICATED", "AuthenticationLost"],
    [404, "E_MEDIA_NOT_FOUND", "MediaUnavailable"],
    [400, "E_ACTIVITY_EXPIRED", "Expired"],
    [409, "E_ACTIVITY_CAPTURE_CONFLICT", "Defect"],
    [409, "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH", "Defect"],
    [413, "E_CAPTURE_TOO_LARGE", "Defect"],
    [422, "E_INVALID_REQUEST", "Defect"],
    [408, "E_UPSTREAM_TIMEOUT", "Retryable"],
    [429, "E_RATE_LIMITED", "Retryable"],
    [503, "E_UNAVAILABLE", "Retryable"],
  ] as const)(
    "maps HTTP %i %s to %s",
    async (status, code, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          status === 204
            ? new Response(null, { status })
            : Response.json(
                { error: { code, message: code } },
                { status },
              ),
        ),
      );

      await expect(postActivityBatch(JSON.stringify(activityRequest()))).resolves.toEqual(
        { kind: expected },
      );
    },
  );

  it("strictly decodes adjustment requests and opaque handles", () => {
    expect(
      decodeActivityAdjustmentRequest({
        kind: "Exclude",
        clientMutationId: "30000000-0000-4000-8000-000000000002",
        mediaRef: MEDIA_REF,
        modality: "Listening",
        deviceHandle: parseActivityDeviceHandle(
          "ncd1.CCCCCCCCCCCCCCCCCCCCCC",
        ),
        startedAt: "2026-08-10T17:00:00.000Z",
        endedAt: "2026-08-10T18:00:00.000Z",
      }),
    ).toMatchObject({ kind: "Exclude", modality: "Listening" });
    expect(() =>
      decodeActivityAdjustmentRequest({
        kind: "Retract",
        clientMutationId: "30000000-0000-4000-8000-000000000003",
        adjustmentHandle: ADJUSTMENT_HANDLE,
        mediaRef: MEDIA_REF,
      }),
    ).toThrow("invalid shape");
  });

  it("forwards one strict adjustment and publishes only after valid success", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: {
          outcome: "Retracted",
          adjustmentHandle: { kind: "Present", value: ADJUSTMENT_HANDLE },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const revisionBefore = consumptionProjectionSnapshot().revision;
    const request = {
      kind: "Retract" as const,
      clientMutationId: "30000000-0000-4000-8000-000000000004",
      adjustmentHandle: ADJUSTMENT_HANDLE,
    };

    await expect(submitActivityAdjustment(request)).resolves.toEqual({
      outcome: "Retracted",
      adjustmentHandle: { kind: "Present", value: ADJUSTMENT_HANDLE },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/consumption/activity-adjustments",
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
    );
    expect(consumptionProjectionSnapshot().revision).toBe(revisionBefore + 1);

    fetch.mockResolvedValueOnce(
      Response.json({ data: { outcome: "Retracted", extra: true } }),
    );
    const revisionBeforeDefect = consumptionProjectionSnapshot().revision;
    await expect(submitActivityAdjustment(request)).rejects.toMatchObject({
      code: "E_INVALID_RESPONSE",
    } satisfies Partial<ApiError>);
    expect(consumptionProjectionSnapshot().revision).toBe(revisionBeforeDefect);
  });
});
