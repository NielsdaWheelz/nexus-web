import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import {
  expectIsoInstant,
  isCanonicalUuid,
  isRecord,
} from "@/lib/validation";
import {
  parseMediaRef,
  type ActivityModality,
  type MediaRef,
} from "./activityContract";
import { publishConsumptionProjectionChange } from "./projectionRevision";

export type ActivityExclusionHandle = string & {
  readonly __activityExclusionHandle: unique symbol;
};
export type ActivityDeviceHandle = string & {
  readonly __activityDeviceHandle: unique symbol;
};

export type ActivityExclusionRequest =
  | {
      readonly kind: "Exclude";
      readonly clientMutationId: string;
      readonly mediaRef: MediaRef;
      readonly modality: ActivityModality;
      readonly deviceHandle: ActivityDeviceHandle;
      readonly startedAt: string;
      readonly endedAt: string;
    }
  | {
      readonly kind: "Restore";
      readonly clientMutationId: string;
      readonly exclusionHandle: ActivityExclusionHandle;
    };

export interface ActivityExclusionResult {
  readonly outcome: "Excluded" | "Restored";
  readonly exclusionHandle: ActivityExclusionHandle;
}

const EXCLUSION_HANDLE_RE =
  /^nce1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
const DEVICE_HANDLE_RE = /^ncd1\.[A-Za-z0-9_-]{22}$/;

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => key in value)) {
    throw new Error(`${name} has an invalid shape`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function clientMutationId(value: unknown): string {
  if (!isCanonicalUuid(value)) {
    throw new Error("clientMutationId must be a canonical UUID");
  }
  return value;
}

function instant(value: unknown, name: string): string {
  return expectIsoInstant(value, name);
}

export function parseActivityExclusionHandle(
  value: string,
): ActivityExclusionHandle {
  if (!EXCLUSION_HANDLE_RE.test(value)) {
    throw new Error("Invalid ActivityExclusionHandle");
  }
  // justify-type-assertion: the sealed handle grammar above is the complete
  // outward Activity exclusion identity contract.
  return value as ActivityExclusionHandle;
}

export function parseActivityDeviceHandle(value: string): ActivityDeviceHandle {
  if (!DEVICE_HANDLE_RE.test(value)) {
    throw new Error("Invalid Activity device handle");
  }
  // justify-type-assertion: the sealed handle grammar above is the complete
  // outward Activity device identity contract.
  return value as ActivityDeviceHandle;
}

export function decodeActivityExclusionRequest(
  raw: unknown,
): ActivityExclusionRequest {
  const value = object(raw, "ActivityExclusionRequest");
  switch (value.kind) {
    case "Exclude": {
      exact(
        value,
        [
          "kind",
          "clientMutationId",
          "mediaRef",
          "modality",
          "deviceHandle",
          "startedAt",
          "endedAt",
        ],
        "ActivityExclusionRequest.Exclude",
      );
      if (
        value.modality !== "Reading" &&
        value.modality !== "Listening" &&
        value.modality !== "Viewing"
      ) {
        throw new Error("Exclude.modality is invalid");
      }
      const startedAt = instant(value.startedAt, "Exclude.startedAt");
      const endedAt = instant(value.endedAt, "Exclude.endedAt");
      if (Date.parse(startedAt) >= Date.parse(endedAt)) {
        throw new Error("Exclude range must be positive");
      }
      return {
        kind: "Exclude",
        clientMutationId: clientMutationId(value.clientMutationId),
        mediaRef: parseMediaRef(
          typeof value.mediaRef === "string" ? value.mediaRef : "",
        ),
        modality: value.modality,
        deviceHandle: parseActivityDeviceHandle(
          typeof value.deviceHandle === "string" ? value.deviceHandle : "",
        ),
        startedAt,
        endedAt,
      };
    }
    case "Restore":
      exact(
        value,
        ["kind", "clientMutationId", "exclusionHandle"],
        "ActivityExclusionRequest.Restore",
      );
      return {
        kind: "Restore",
        clientMutationId: clientMutationId(value.clientMutationId),
        exclusionHandle: parseActivityExclusionHandle(
          typeof value.exclusionHandle === "string" ? value.exclusionHandle : "",
        ),
      };
    default:
      throw new Error("ActivityExclusionRequest.kind is invalid");
  }
}

function decodeActivityExclusionResult(raw: unknown): ActivityExclusionResult {
  const response = object(raw, "ActivityExclusionResponse");
  exact(response, ["data"], "ActivityExclusionResponse");
  const data = object(response.data, "ActivityExclusionResponse.data");
  exact(
    data,
    ["outcome", "exclusionHandle"],
    "ActivityExclusionResponse.data",
  );
  if (data.outcome !== "Excluded" && data.outcome !== "Restored") {
    throw new Error("Activity exclusion outcome is invalid");
  }
  return {
    outcome: data.outcome,
    exclusionHandle: parseActivityExclusionHandle(
      typeof data.exclusionHandle === "string" ? data.exclusionHandle : "",
    ),
  };
}

export async function submitActivityExclusion(
  request: ActivityExclusionRequest,
): Promise<ActivityExclusionResult> {
  const response = await apiFetch<unknown>(
    "/api/consumption/activity-exclusions",
    { method: "POST", body: JSON.stringify(request) },
  );
  const result = decodeApiPayload(
    response,
    decodeActivityExclusionResult,
    "Activity exclusion",
  );
  publishConsumptionProjectionChange();
  return result;
}
