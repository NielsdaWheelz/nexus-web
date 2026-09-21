import {
  TOOL_CONTRACT_PROJECTION,
  type ToolEffect,
  type ToolErrorType,
  type ToolRecordKind,
  type ToolResultKind,
} from "@/lib/conversations/toolContractProjection";
import type { MessageToolCall } from "@/lib/conversations/types";
import {
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

function requireProjectionField(
  value: Record<string, unknown>,
  field: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    throw new Error(`Invalid tool projection: missing ${field}`);
  }
  return value[field];
}

export type ToolProjectionFields = Pick<
  MessageToolCall,
  | "record_kind"
  | "canonical_tool_id"
  | "provider_wire_name"
  | "effect"
  | "result_kind"
  | "activity_label"
  | "error_type"
>;

export function decodeToolProjectionFields(
  raw: unknown,
): ToolProjectionFields {
  const value = expectRecord(raw, "tool projection");
  const recordKind = expectOneOf(
    requireProjectionField(value, "record_kind"),
    TOOL_CONTRACT_PROJECTION.record_kinds,
    "record_kind",
  ) as ToolRecordKind;
  const canonicalToolId = expectNullableString(
    requireProjectionField(value, "canonical_tool_id"),
    "canonical_tool_id",
  );
  const providerWireName = expectNullableString(
    requireProjectionField(value, "provider_wire_name"),
    "provider_wire_name",
  );
  const rawEffect = requireProjectionField(value, "effect");
  const effect =
    rawEffect === null
      ? null
      : (expectOneOf(
          rawEffect,
          TOOL_CONTRACT_PROJECTION.effects,
          "effect",
        ) as ToolEffect);
  const resultKind = expectOneOf(
    requireProjectionField(value, "result_kind"),
    TOOL_CONTRACT_PROJECTION.result_kinds,
    "result_kind",
  ) as ToolResultKind;
  const activityLabel = expectString(
    requireProjectionField(value, "activity_label"),
    "activity_label",
  );
  if (activityLabel.length === 0) {
    throw new Error("Invalid tool projection: activity_label is empty");
  }
  const rawErrorType = requireProjectionField(value, "error_type");
  const errorType =
    rawErrorType === null
      ? null
      : (expectOneOf(
          rawErrorType,
          TOOL_CONTRACT_PROJECTION.error_types,
          "error_type",
        ) as ToolErrorType);

  const projection = {
    activity_label: activityLabel,
    canonical_tool_id: canonicalToolId,
    effect,
    error_type: errorType,
    provider_wire_name: providerWireName,
    record_kind: recordKind,
    result_kind: resultKind,
  };
  if (recordKind === "attached_context") {
    if (
      canonicalToolId !== null ||
      providerWireName !== null ||
      effect !== null ||
      errorType !== null
    ) {
      throw new Error("Invalid tool projection: tagged field must be null");
    }
  } else if (canonicalToolId === null || effect === null) {
    throw new Error("Invalid tool projection: tagged field must be non-null");
  } else if (
    recordKind === "historical_execution" &&
    (providerWireName !== null || errorType !== null)
  ) {
    throw new Error("Invalid tool projection: tagged field must be null");
  }
  if (
    (recordKind === "attached_context" && resultKind !== "attached_context") ||
    ((recordKind === "current_execution" ||
      recordKind === "historical_execution") &&
      resultKind === "attached_context")
  ) {
    throw new Error(
      "Invalid tool projection: result kind disagrees with record kind",
    );
  }

  return projection;
}
