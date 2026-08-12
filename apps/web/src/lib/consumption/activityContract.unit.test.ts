import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeActivityRequest,
  parseActivityCaptureKey,
  parseMediaRef,
  postActivityBatch,
  type ActivityRequest,
} from "./activityContract";

const MEDIA_REF = parseMediaRef(
  "media:11111111-1111-4111-8111-111111111111",
);
const CAPTURE_KEY = parseActivityCaptureKey(
  "20000000-0000-4000-8000-000000000001",
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

});
