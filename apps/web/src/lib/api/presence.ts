/**
 * Owned-absence wire encoding (spec `lectern-player-lifecycle-hard-cutover.md`
 * §4): the one repository-wide forward encoding for a field whose absence is
 * a normal, successful outcome.
 *
 *   Presence<T> = { kind: "Absent" } | { kind: "Present"; value: T }
 *
 * The field is always present on the wire; `null`, omission, and alternate
 * casing are rejected. `decodePresence` is the same-system transport decoder
 * boundary (`docs/rules/boundaries.md`): decode once at the client boundary,
 * then pass the owned `Presence<T>` through model/view code unchanged. This
 * module is intentionally minimal.
 */

import { isRecord } from "@/lib/validation";

export type Presence<T> = { kind: "Absent" } | { kind: "Present"; value: T };

export function present<T>(value: T): Presence<T> {
  return { kind: "Present", value };
}

export function absent<T>(): Presence<T> {
  return { kind: "Absent" };
}

/**
 * Strictly decode a `Presence<T>` wire value. Rejects `null`/`undefined`,
 * non-object payloads, any `kind` other than the exact literals `"Absent"` or
 * `"Present"`, a `Present` missing `value`, and any extra keys on either
 * variant. `decodeValue` decodes the inner `value` for the `Present` case and
 * may itself throw to reject an invalid value.
 */
export function decodePresence<T>(
  raw: unknown,
  decodeValue: (value: unknown) => T,
): Presence<T> {
  if (!isRecord(raw)) {
    throw new Error(
      `Invalid Presence: expected an object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  const keys = Object.keys(raw);
  if (raw.kind === "Absent") {
    if (keys.length !== 1) {
      throw new Error(
        `Invalid Presence: "Absent" must have no keys besides "kind", got [${keys.join(", ")}]`,
      );
    }
    return { kind: "Absent" };
  }
  if (raw.kind === "Present") {
    if (keys.length !== 2 || !("value" in raw)) {
      throw new Error(
        `Invalid Presence: "Present" must have exactly "kind" and "value", got [${keys.join(", ")}]`,
      );
    }
    return { kind: "Present", value: decodeValue(raw.value) };
  }
  throw new Error(
    `Invalid Presence: "kind" must be "Absent" or "Present", got ${JSON.stringify(raw.kind)}`,
  );
}

/** Unwrap a decoded `Presence<T>` for view code that needs a plain fallback value. */
export function presenceValueOr<T>(presence: Presence<T>, fallback: T): T {
  return presence.kind === "Present" ? presence.value : fallback;
}
