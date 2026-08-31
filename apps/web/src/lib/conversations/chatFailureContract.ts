import type { ExpectedChatFailure } from "@/lib/conversations/types";
import {
  expectBoolean,
  expectExactRecord,
  expectOneOf,
} from "@/lib/validation";

export const EXPECTED_CHAT_FAILURE_CODES = [
  "cancelled",
  "context_too_large",
  "invalid_output",
  "incomplete",
  "assistant_unavailable",
  "operator_defect",
] as const;

/** Decode the exact product failure union; old provider/retry fields are defects. */
export function decodeExpectedChatFailure(raw: unknown): ExpectedChatFailure {
  const value = expectExactRecord(
    raw,
    ["code", "can_rerun"],
    "expected chat failure",
  );
  const code = expectOneOf(
    value.code,
    EXPECTED_CHAT_FAILURE_CODES,
    "expected chat failure.code",
  );
  const canRerun = expectBoolean(
    value.can_rerun,
    "expected chat failure.can_rerun",
  );
  switch (code) {
    case "cancelled":
    case "incomplete":
    case "assistant_unavailable":
      return { code, can_rerun: canRerun };
    case "context_too_large":
    case "invalid_output":
    case "operator_defect":
      if (canRerun) {
        throw new TypeError(
          `expected chat failure ${code} must have can_rerun=false`,
        );
      }
      return { code, can_rerun: false };
  }
}

export function decodeNullableExpectedChatFailure(
  raw: unknown,
): ExpectedChatFailure | null {
  return raw === null ? null : decodeExpectedChatFailure(raw);
}
