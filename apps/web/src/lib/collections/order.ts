/** A move names its actor and successor in one revision, never inferred row indexes. */
import { expectExactRecord, isCanonicalUuid } from "@/lib/validation";

export type OrderRevision = string;
export type Collection =
  | { readonly kind: "Library"; readonly id: string }
  | { readonly kind: "Lectern" };
export interface Snapshot {
  readonly revision: OrderRevision;
  readonly ids: readonly string[];
}
export interface Move {
  readonly itemId: string;
  readonly beforeId: string | null;
  readonly expectedRevision: OrderRevision;
}
export type MoveOutcome = "Acknowledged" | "Unconfirmed" | "Superseded" | "Rejected";
export interface PendingMove {
  readonly command: Move;
  readonly phase: "Sending" | "Unconfirmed" | "Checking";
}

export const collectionKey = (collection: Collection): string =>
  collection.kind === "Lectern" ? "lectern" : `library:${collection.id}`;

/** Revisions are bigint decimal strings; their gaps carry no meaning. */
export function compareRevision(a: OrderRevision, b: OrderRevision): number {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}

export function moveBefore(
  ids: readonly string[], itemId: string, beforeId: string | null,
): readonly string[] {
  if (!ids.includes(itemId) || itemId === beforeId ||
      (beforeId !== null && !ids.includes(beforeId))) return ids;
  const next = ids.filter((id) => id !== itemId);
  next.splice(beforeId === null ? next.length : next.indexOf(beforeId), 0, itemId);
  return next.every((id, index) => id === ids[index]) ? ids : next;
}

export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((id) => members.has(id));
}

/** Current metadata supplies every rendered row; ids never recreate withdrawn data. */
export function projectOrder<T>(
  rows: readonly T[], id: (row: T) => string, snapshot: Snapshot | null,
  pending: PendingMove | null,
): readonly T[] {
  if (snapshot === null) return rows;
  const ids = pending?.phase === "Sending"
    ? moveBefore(snapshot.ids, pending.command.itemId, pending.command.beforeId)
    : snapshot.ids;
  const byId = new Map(rows.map((row) => [id(row), row]));
  return ids.flatMap((key) => {
    const row = byId.get(key);
    return row === undefined ? [] : [row];
  });
}

/** session storage is a versioned boundary. malformed records remain for repair. */
export function parsePendingMove(raw: string): Move {
  const value = expectExactRecord(JSON.parse(raw),
    ["item_id", "before_id", "expected_revision"], "pending collection move");
  if (!isCanonicalUuid(value.item_id) ||
      (value.before_id !== null && !isCanonicalUuid(value.before_id)) ||
      value.item_id === value.before_id) {
    throw new TypeError("pending collection move contains invalid ids");
  }
  const revision = value.expected_revision;
  if (typeof revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(revision) ||
      BigInt(revision) > BigInt("9223372036854775807")) {
    throw new TypeError("pending collection move contains an invalid revision");
  }
  return Object.freeze({ itemId: value.item_id, beforeId: value.before_id,
    expectedRevision: revision });
}

export function serializePendingMove(move: Move): string {
  return JSON.stringify({ item_id: move.itemId, before_id: move.beforeId,
    expected_revision: move.expectedRevision });
}
