import { isRecord } from "@/lib/validation";

export function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

export function isOptionalRecord(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}

function isValidIntRange(start: unknown, end: unknown): boolean {
  return (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start
  );
}

export function isValidOffsetRange(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  start_offset: number;
  end_offset: number;
} {
  return isValidIntRange(value.start_offset, value.end_offset);
}

export function isValidTimeRange(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { t_start_ms: number; t_end_ms: number } {
  return isValidIntRange(value.t_start_ms, value.t_end_ms);
}
