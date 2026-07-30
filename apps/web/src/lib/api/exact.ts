import { isRecord } from "@/lib/validation";

export function asRecord(
  raw: unknown,
  context: string,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new TypeError(`${context} must be an object`);
  }
  return raw;
}

export function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(record);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new TypeError(
      `${context} must contain exactly [${expected.join(", ")}]`,
    );
  }
}

export function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}
