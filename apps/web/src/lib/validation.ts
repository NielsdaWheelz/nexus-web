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

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_RFC_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalUuid(raw: unknown): raw is string {
  return typeof raw === "string" && CANONICAL_UUID_RE.test(raw);
}

/** Strict decoder for canonical lowercase UUID wire values. */
export function expectCanonicalUuid(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!isCanonicalUuid(value)) {
    throw new TypeError(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

export function isCanonicalRfcUuid(raw: unknown): raw is string {
  return typeof raw === "string" && CANONICAL_RFC_UUID_RE.test(raw);
}

/** Strict decoder for a lowercase RFC variant UUID with a known version. */
export function expectCanonicalRfcUuid(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!isCanonicalRfcUuid(value)) {
    throw new TypeError(`${name} must be a canonical lowercase RFC UUID`);
  }
  return value;
}

/** The one decoder for a wire string whose contract forbids the empty value. */
export function expectNonemptyString(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

const ISO_INSTANT_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRoundTrippingCalendarDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00Z`);
  return (
    !day.startsWith("0000-") &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
  );
}

/**
 * The one aware-instant grammar for every wire and URL contract. The pattern
 * rejects a naive or date-only timestamp; `Date.parse` rejects an out-of-range
 * month, minute, or second but silently rolls a day past the end of its month
 * and accepts hour 24, so the day is round-tripped and the hour bounded here.
 */
export function isIsoInstant(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const match = ISO_INSTANT_RE.exec(raw);
  return (
    match !== null &&
    isRoundTrippingCalendarDay(match[1]) &&
    Number(match[2]) <= 23 &&
    !Number.isNaN(Date.parse(raw))
  );
}

/** Strict decoder for an aware instant on a same-system wire contract. */
export function expectIsoInstant(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (!isIsoInstant(value)) {
    throw new TypeError(`${name} must be an ISO 8601 aware instant`);
  }
  return value;
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

export function expectPositiveInteger(raw: unknown, name: string): number {
  const value = expectNonnegativeInteger(raw, name);
  if (value === 0) throw new TypeError(`${name} must be positive`);
  return value;
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
