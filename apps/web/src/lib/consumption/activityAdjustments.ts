import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";
import { publishConsumptionProjectionChange } from "./projectionRevision";
import {
  parseMediaRef,
  type ActivityModality,
  type MediaRef,
} from "./activityContract";

export type ActivityAdjustmentHandle = string & {
  readonly __activityAdjustmentHandle: unique symbol;
};
export type ActivityDeviceHandle = string & {
  readonly __activityDeviceHandle: unique symbol;
};

export type ActivityAdjustmentRequest =
  | {
      readonly kind: "Add";
      readonly clientMutationId: string;
      readonly mediaRef: MediaRef;
      readonly occurredAt: string;
      readonly durationMs: number;
    }
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
      readonly kind: "Retract";
      readonly clientMutationId: string;
      readonly adjustmentHandle: ActivityAdjustmentHandle;
    };

export interface ActivityAdjustmentResult {
  readonly outcome: "Added" | "Excluded" | "Retracted";
  readonly adjustmentHandle: {
    readonly kind: "Present";
    readonly value: ActivityAdjustmentHandle;
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADJUSTMENT_HANDLE_RE =
  /^nca1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
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
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error("clientMutationId must be a canonical UUID");
  }
  return value;
}

function instant(value: unknown, name: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO time`);
  }
  return value;
}

export function parseActivityAdjustmentHandle(
  value: string,
): ActivityAdjustmentHandle {
  if (!ADJUSTMENT_HANDLE_RE.test(value)) {
    throw new Error("Invalid ActivityAdjustmentHandle");
  }
  // justify-type-assertion: the sealed handle grammar above is the complete
  // outward Activity adjustment identity contract.
  return value as ActivityAdjustmentHandle;
}

export function parseActivityDeviceHandle(value: string): ActivityDeviceHandle {
  if (!DEVICE_HANDLE_RE.test(value)) {
    throw new Error("Invalid Activity device handle");
  }
  // justify-type-assertion: the sealed handle grammar above is the complete
  // outward Activity device identity contract.
  return value as ActivityDeviceHandle;
}

export function decodeActivityAdjustmentRequest(
  raw: unknown,
): ActivityAdjustmentRequest {
  const value = object(raw, "ActivityAdjustmentRequest");
  switch (value.kind) {
    case "Add": {
      exact(
        value,
        ["kind", "clientMutationId", "mediaRef", "occurredAt", "durationMs"],
        "ActivityAdjustmentRequest.Add",
      );
      if (
        typeof value.durationMs !== "number" ||
        !Number.isInteger(value.durationMs) ||
        value.durationMs < 1 ||
        value.durationMs > 86_400_000
      ) {
        throw new Error("Add.durationMs is out of range");
      }
      return {
        kind: "Add",
        clientMutationId: clientMutationId(value.clientMutationId),
        mediaRef: parseMediaRef(
          typeof value.mediaRef === "string" ? value.mediaRef : "",
        ),
        occurredAt: instant(value.occurredAt, "Add.occurredAt"),
        durationMs: value.durationMs,
      };
    }
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
        "ActivityAdjustmentRequest.Exclude",
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
      if (startedAt >= endedAt) {
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
    case "Retract":
      exact(
        value,
        ["kind", "clientMutationId", "adjustmentHandle"],
        "ActivityAdjustmentRequest.Retract",
      );
      return {
        kind: "Retract",
        clientMutationId: clientMutationId(value.clientMutationId),
        adjustmentHandle: parseActivityAdjustmentHandle(
          typeof value.adjustmentHandle === "string"
            ? value.adjustmentHandle
            : "",
        ),
      };
    default:
      throw new Error("ActivityAdjustmentRequest.kind is invalid");
  }
}

function decodeActivityAdjustmentResult(raw: unknown): ActivityAdjustmentResult {
  const response = object(raw, "ActivityAdjustmentResponse");
  exact(response, ["data"], "ActivityAdjustmentResponse");
  const data = object(response.data, "ActivityAdjustmentResponse.data");
  exact(
    data,
    ["outcome", "adjustmentHandle"],
    "ActivityAdjustmentResponse.data",
  );
  if (
    data.outcome !== "Added" &&
    data.outcome !== "Excluded" &&
    data.outcome !== "Retracted"
  ) {
    throw new Error("Activity adjustment outcome is invalid");
  }
  const handle = object(
    data.adjustmentHandle,
    "ActivityAdjustmentResponse.data.adjustmentHandle",
  );
  exact(
    handle,
    ["kind", "value"],
    "ActivityAdjustmentResponse.data.adjustmentHandle",
  );
  if (handle.kind !== "Present" || typeof handle.value !== "string") {
    throw new Error("Activity adjustment handle must be Present");
  }
  return {
    outcome: data.outcome,
    adjustmentHandle: {
      kind: "Present",
      value: parseActivityAdjustmentHandle(handle.value),
    },
  };
}

export async function submitActivityAdjustment(
  request: ActivityAdjustmentRequest,
): Promise<ActivityAdjustmentResult> {
  const response = await apiFetch<unknown>(
    "/api/consumption/activity-adjustments",
    { method: "POST", body: JSON.stringify(request) },
  );
  const result = decodeApiPayload(
    response,
    decodeActivityAdjustmentResult,
    "Activity adjustment",
  );
  publishConsumptionProjectionChange();
  return result;
}
