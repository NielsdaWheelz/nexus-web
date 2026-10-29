import type { OrderRevision } from "@/lib/collections/order";
import type { PanePresentationLocator } from "@/lib/panes/paneRouteModel";
import { recentValueForHref } from "@/lib/panes/paneRouteModel";
import { normalizeVisitTitleHint } from "@/lib/workspace/model";
import { expectExactRecord, expectOrderRevision, isCanonicalUuid } from "@/lib/validation";

export type RecentTarget = PanePresentationLocator | { kind: "preview"; target: string } | { kind: "x_capture"; capture_id: string };
export type RecentValue = { target: RecentTarget; href: string; title_hint: string | null; detail_hint: string | null };
export type RecentEntry = RecentValue & { used_revision: OrderRevision };
export type RecentSnapshot = { format_version: 1; account_id: string; epoch: string; revision: OrderRevision; entries: RecentEntry[] };
export type RecentObservation = { snapshot: RecentSnapshot; write_failure: "failed" | "unconfirmed" | null };
export type RecentReconcile = { target: RecentTarget; expected_used_revision: OrderRevision; replacement: RecentValue | null };

export function recentTargetKey(target: RecentTarget): string {
  switch (target.kind) {
    case "resource_ref": return `resource_ref:${target.ref}`;
    case "contributor_handle": return `contributor_handle:${target.handle}`;
    case "daily_date": return `daily_date:${target.local_date}`;
    case "preview": return `preview:${target.target}`;
    case "x_capture": return `x_capture:${target.capture_id}`;
  }
}
export function parseRecentSnapshot(raw: unknown): RecentSnapshot {
  const row = expectExactRecord(raw, ["format_version", "account_id", "epoch", "revision", "entries"], "recent snapshot");
  if (row.format_version !== 1 || !isCanonicalUuid(row.account_id) || !isCanonicalUuid(row.epoch) || !Array.isArray(row.entries) || row.entries.length > 100) throw new TypeError("invalid recent snapshot");
  const snapshotRevision = expectOrderRevision(row.revision);
  const seen = new Set<string>();
  let previous = BigInt(snapshotRevision) + 1n;
  const entries = row.entries.map(rawEntry => {
    const entry = expectExactRecord(rawEntry, ["target", "href", "title_hint", "detail_hint", "used_revision"], "recent entry");
    const usedRevision = expectOrderRevision(entry.used_revision);
    if (typeof entry.href !== "string" || BigInt(usedRevision) < 2n || BigInt(usedRevision) >= previous || (entry.title_hint !== null && typeof entry.title_hint !== "string") || (entry.detail_hint !== null && typeof entry.detail_hint !== "string")) throw new TypeError("invalid recent entry");
    previous = BigInt(usedRevision);
    if (normalizeVisitTitleHint(entry.title_hint) !== entry.title_hint || normalizeVisitTitleHint(entry.detail_hint) !== entry.detail_hint) throw new TypeError("invalid recent hints");
    const value = recentValueForHref(entry.href, entry.title_hint);
    if (!value || value.href !== entry.href) throw new TypeError("invalid recent target");
    const target = expectExactRecord(entry.target, Object.keys(value.target), "recent target");
    if (Object.entries(value.target).some(([key, part]) => target[key] !== part)) throw new TypeError("invalid recent target");
    const key = recentTargetKey(value.target);
    if (seen.has(key)) throw new TypeError("duplicate recent target");
    seen.add(key);
    return { ...value, detail_hint: entry.detail_hint, used_revision: usedRevision };
  });
  return { format_version: 1, account_id: row.account_id, epoch: row.epoch, revision: snapshotRevision, entries };
}
export function parseRecentObservation(raw: unknown): RecentObservation {
  const row = expectExactRecord(raw, ["snapshot", "write_failure"], "recent observation");
  if (row.write_failure !== null && row.write_failure !== "failed" && row.write_failure !== "unconfirmed") throw new TypeError("invalid recent failure");
  return { snapshot: parseRecentSnapshot(row.snapshot), write_failure: row.write_failure };
}
export function applyRecent(snapshot: RecentSnapshot, op: { kind: "use"; value: RecentValue } | { kind: "reconcile"; input: RecentReconcile }): RecentSnapshot {
  const entries = snapshot.entries.slice();
  const sourceKey = recentTargetKey(op.kind === "use" ? op.value.target : op.input.target);
  const index = entries.findIndex(entry => recentTargetKey(entry.target) === sourceKey);
  if (op.kind === "use") {
    if (index >= 0) entries.splice(index, 1);
    const next = String(BigInt(snapshot.revision) + 1n);
    expectOrderRevision(next);
    entries.unshift({ ...op.value, title_hint: normalizeVisitTitleHint(op.value.title_hint), detail_hint: normalizeVisitTitleHint(op.value.detail_hint), used_revision: next });
    return parseRecentSnapshot({ ...snapshot, revision: next, entries: entries.slice(0, 100) });
  }
  if (index < 0 || entries[index]!.used_revision !== op.input.expected_used_revision) return snapshot;
  const source = entries[index]!;
  entries.splice(index, 1);
  const replacement = op.input.replacement;
  if (replacement !== null) {
    const destination = entries.findIndex(entry => recentTargetKey(entry.target) === recentTargetKey(replacement.target));
    const existing = destination < 0 ? null : entries[destination]!;
    if (existing !== null) entries.splice(destination, 1);
    const winner = existing !== null && BigInt(existing.used_revision) > BigInt(source.used_revision) ? existing : {
      ...replacement, title_hint: existing?.title_hint ?? replacement.title_hint,
      detail_hint: existing?.detail_hint ?? replacement.detail_hint, used_revision: source.used_revision,
    };
    entries.push(winner);
    entries.sort((a, b) => BigInt(a.used_revision) > BigInt(b.used_revision) ? -1 : 1);
  }
  if (JSON.stringify(entries) === JSON.stringify(snapshot.entries)) return snapshot;
  return parseRecentSnapshot({ ...snapshot, revision: String(BigInt(snapshot.revision) + 1n), entries });
}
