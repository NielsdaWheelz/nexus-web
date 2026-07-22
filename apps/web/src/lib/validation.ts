// Cross-cutting boundary validation primitives. Type guards and predicates
// that callers reach for when narrowing an `unknown` from an external surface
// (URL params, JSON payloads, SSE frames) into something the domain trusts.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function expectExactRecord(
  raw: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const value = expectRecord(raw, name);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(`${name} must contain exactly [${keys.join(", ")}]`);
  }
  return value;
}

export function expectRecord(
  raw: unknown,
  name: string,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new TypeError(`${name} must be an object`);
  }
  return raw;
}

export function expectArray<T>(
  raw: unknown,
  decode: (value: unknown, index: number) => T,
  name: string,
): T[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`${name} must be an array`);
  }
  return raw.map(decode);
}

export function expectOneOf<const T extends readonly string[]>(
  raw: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof raw !== "string" || !values.includes(raw)) {
    throw new TypeError(`${name} must be one of [${values.join(", ")}]`);
  }
  return raw as T[number];
}

export function expectString(raw: unknown, name: string): string {
  if (typeof raw !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return raw;
}

export function expectNullableString(
  raw: unknown,
  name: string,
): string | null {
  if (raw !== null && typeof raw !== "string") {
    throw new TypeError(`${name} must be a string or null`);
  }
  return raw;
}

export function expectBoolean(raw: unknown, name: string): boolean {
  if (typeof raw !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return raw;
}

export function expectFiniteNumber(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new TypeError(`${name} must be finite`);
  }
  return raw;
}

export function expectInteger(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return raw;
}

export function expectNonnegativeInteger(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new TypeError(`${name} must be a nonnegative integer`);
  }
  return raw;
}

export function expectNullableInteger(
  raw: unknown,
  name: string,
): number | null {
  if (raw === null) {
    return null;
  }
  return expectInteger(raw, name);
}

export function expectNullableNonnegativeInteger(
  raw: unknown,
  name: string,
): number | null {
  const value = expectNullableInteger(raw, name);
  if (value !== null && value < 0) {
    throw new TypeError(`${name} must be nonnegative or null`);
  }
  return value;
}
