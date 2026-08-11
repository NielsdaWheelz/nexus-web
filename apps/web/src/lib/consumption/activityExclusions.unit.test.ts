import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/client";
import { parseMediaRef } from "./activityContract";
import {
  decodeActivityExclusionRequest,
  parseActivityDeviceHandle,
  parseActivityExclusionHandle,
  submitActivityExclusion,
} from "./activityExclusions";
import { consumptionProjectionSnapshot } from "./projectionRevision";

const MEDIA_REF = parseMediaRef(
  "media:11111111-1111-4111-8111-111111111111",
);
const EXCLUSION_HANDLE = parseActivityExclusionHandle(
  "nce1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Consumption activity exclusions wire contract", () => {
  it("accepts only the exact Exclude and Restore lifecycle shapes", () => {
    expect(
      decodeActivityExclusionRequest({
        kind: "Exclude",
        clientMutationId: "30000000-0000-4000-8000-000000000002",
        mediaRef: MEDIA_REF,
        modality: "Listening",
        deviceHandle: parseActivityDeviceHandle(
          "ncd1.CCCCCCCCCCCCCCCCCCCCCC",
        ),
        startedAt: "2026-08-10T17:00:00Z",
        endedAt: "2026-08-10T18:00:00.123000Z",
      }),
    ).toMatchObject({ kind: "Exclude", modality: "Listening" });
    expect(
      decodeActivityExclusionRequest({
        kind: "Restore",
        clientMutationId: "30000000-0000-4000-8000-000000000003",
        exclusionHandle: EXCLUSION_HANDLE,
      }),
    ).toEqual({
      kind: "Restore",
      clientMutationId: "30000000-0000-4000-8000-000000000003",
      exclusionHandle: EXCLUSION_HANDLE,
    });
    expect(() =>
      decodeActivityExclusionRequest({ kind: "Unknown" }),
    ).toThrow("kind is invalid");
    expect(() =>
      decodeActivityExclusionRequest({
        kind: "Restore",
        clientMutationId: "30000000-0000-4000-8000-000000000003",
        exclusionHandle: EXCLUSION_HANDLE,
        unexpected: true,
      }),
    ).toThrow("invalid shape");
  });

  it("forwards one strict exclusion and publishes only after a valid result", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: { outcome: "Restored", exclusionHandle: EXCLUSION_HANDLE },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const revisionBefore = consumptionProjectionSnapshot().revision;
    const request = {
      kind: "Restore" as const,
      clientMutationId: "30000000-0000-4000-8000-000000000005",
      exclusionHandle: EXCLUSION_HANDLE,
    };

    await expect(submitActivityExclusion(request)).resolves.toEqual({
      outcome: "Restored",
      exclusionHandle: EXCLUSION_HANDLE,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/consumption/activity-exclusions",
      expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
    );
    expect(consumptionProjectionSnapshot().revision).toBe(revisionBefore + 1);

    fetch.mockResolvedValueOnce(
      Response.json({
        data: {
          outcome: "Restored",
          exclusionHandle: EXCLUSION_HANDLE,
          extra: true,
        },
      }),
    );
    const revisionBeforeDefect = consumptionProjectionSnapshot().revision;
    await expect(submitActivityExclusion(request)).rejects.toMatchObject({
      code: "E_INVALID_RESPONSE",
    } satisfies Partial<ApiError>);
    expect(consumptionProjectionSnapshot().revision).toBe(revisionBeforeDefect);
  });
});
