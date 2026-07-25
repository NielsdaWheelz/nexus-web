import { describe, expect, it } from "vitest";
import { decodeActivityRequest } from "./activityContract";

const request = {
  clientMutationId: "00000000-0000-4000-8000-000000000001",
  mediaRef: "media:00000000-0000-4000-8000-000000000002",
  deviceClass: "Desktop",
  batch: {
    modality: "Reading",
    spans: [
      {
        occurredAt: "2026-07-24T00:00:00.000Z",
        durationMs: 10,
        progressStart: { kind: "Present", value: 0.1 },
        progressEnd: { kind: "Present", value: 0.2 },
        wordStart: { kind: "Present", value: 2 },
        wordEnd: { kind: "Present", value: 4 },
      },
    ],
  },
};

describe("decodeActivityRequest", () => {
  it("accepts the one canonical browser activity shape", () => {
    expect(decodeActivityRequest(request)).toMatchObject({
      mediaRef: request.mediaRef,
      batch: { modality: "Reading" },
    });
  });

  it("rejects raw nullable measurement fields and extra keys", () => {
    expect(() =>
      decodeActivityRequest({
        ...request,
        batch: {
          ...request.batch,
          spans: [{ ...request.batch.spans[0], wordStart: null }],
        },
      }),
    ).toThrow();
    expect(() => decodeActivityRequest({ ...request, deviceId: "forbidden" })).toThrow();
  });
});
