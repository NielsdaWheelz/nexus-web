/** Sparse branch geometry retains identities and measurements, never writing.
 * The controller remains the only occurrence tree and command owner. */
import type {LinkState, OutlineRange} from "@nexus/authored/types";
import type {OutlineEdge, OutlineWindow} from "./useOutlineWindow";

interface Item {link: string; position: string; height: number}
interface Branch {items: Item[]; first: boolean; last: boolean; joined: Set<string>}
export type BranchPart = {kind: "row"; link: string} | {kind: "gap"; key: string; height: number; range: OutlineRange; direction: "before" | "after"; waiting?: true};
export interface RowMetric {id: string; anchor: string | null; parent: string | null; link: string | null; top: number; height: number; gap: boolean}

const ESTIMATE = 32;
function position(link: LinkState, ref: string): string {return (link.endpoint_a === ref ? link.position_a : link.position_b)?.value ?? "";}
function ordered(a: {position: string; link: string}, b: {position: string; link: string}): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.link < b.link ? -1 : a.link > b.link ? 1 : 0;
}

export function provesEmptyOutline(window: OutlineWindow): boolean {
  return window.data.scope_available && window.data.rows.length === 0 && window.data.next_cursor === null && window.data.previous_cursor === null &&
    window.beforeEdge === null && window.afterEdge === null && window.tailEdge === null;
}

export function continuationLink(window: OutlineWindow, edge: OutlineEdge, direction: "before" | "after"): string | null {
  if (window.rows.some(row => row.link?.link_id === edge.link.link_id)) return edge.link.link_id;
  const boundary = {link: edge.link.link_id, position: position(edge.link, window.ref)};
  const rows = window.rows.filter(row => {
    const compared = ordered({link: row.link!.link_id, position: position(row.link!, window.ref)}, boundary);
    return direction === "after" ? compared > 0 : compared < 0;
  });
  return (direction === "after" ? rows[0] : rows.at(-1))?.link?.link_id ?? null;
}

export function mergeOutlineWindows(windows: readonly OutlineWindow[]): OutlineWindow {
  const first = windows[0];
  if (!first || windows.some(window => window.ref !== first.ref || window.branch !== first.branch || window.data.store_revision !== first.data.store_revision || window.data.scope_available !== first.data.scope_available))
    throw new Error("outline windows must share one branch and revision");
  const resources = new Map(windows.flatMap(window => [...window.resources]));
  const childAvailability = new Map(windows.flatMap(window => [...window.childAvailability]));
  const rows = [...new Map(windows.flatMap(window => window.rows.map(row => [row.link!.link_id, row] as const))).values()]
    .sort((a, b) => ordered({link: a.link!.link_id, position: position(a.link!, first.ref)}, {link: b.link!.link_id, position: position(b.link!, first.ref)}));
  const parts = [...windows].sort((a, b) => {
    const left = a.rows[0]?.link, right = b.rows[0]?.link;
    return left && right ? ordered({link: left.link_id, position: position(left, first.ref)}, {link: right.link_id, position: position(right, first.ref)}) : 0;
  });
  const head = parts[0]!, tail = parts.at(-1)!;
  return {...first, rows, resources, childAvailability, editableRefs: new Set(windows.flatMap(window => [...window.editableRefs])),
    beforeEdge: head.beforeEdge, afterEdge: tail.afterEdge, tailEdge: tail.tailEdge,
    data: {...first.data, rows, children: rows.map(row => childAvailability.get(row.link!.link_id) ?? null),
      previous_cursor: head.data.previous_cursor, next_cursor: tail.data.next_cursor,
      proof: {...first.data.proof, before: head.beforeEdge?.link ?? null, after: tail.afterEdge?.link ?? null, tail: tail.tailEdge?.link ?? null, resources: [...resources.values()]}}};
}

export class OutlineViewport {
  private readonly branches = new Map<string, Branch>();
  private readonly heights = new Map<string, number>();
  private committed: readonly RowMetric[] = [];
  private version = 0;
  get revision(): number {return this.version;}
  get metrics(): readonly RowMetric[] {return this.committed;}
  get height(): number {const last = this.committed.at(-1); return last ? last.top + last.height : 0;}
  invalidateMeasurements(): void {
    this.heights.clear();
    for (const branch of this.branches.values()) for (const item of branch.items) item.height = ESTIMATE;
  }
  estimatedHeight(parent: string): number {
    const branch = this.branches.get(parent);
    return branch ? (branch.items.length + (branch.first ? 0 : 24) + (branch.last ? 0 : 24)) * ESTIMATE : 0;
  }
  admit(parent: string, windows: readonly OutlineWindow[]): void {
    const sample = windows[0]!;
    if (!sample.data.scope_available) {this.branches.delete(parent); return;}
    const prior = this.branches.get(parent) ?? {items: [], first: false, last: false, joined: new Set<string>()};
    const live = new Set(windows.flatMap(window => window.rows.map(row => row.link!.link_id)));
    const items = new Map(prior.items.map(item => [item.link, item]));
    for (const window of windows) {
      const head = window.rows[0]?.link, tail = window.rows.at(-1)?.link;
      if (provesEmptyOutline(window)) {items.clear(); prior.joined.clear(); prior.first = true; prior.last = true;}
      if (head && tail) for (const item of items.values()) {
        const afterStart = window.beforeEdge === null || ordered(item, {link: head.link_id, position: position(head, sample.ref)}) >= 0;
        const beforeEnd = window.afterEdge === null || ordered(item, {link: tail.link_id, position: position(tail, sample.ref)}) <= 0;
        if (afterStart && beforeEnd && !live.has(item.link)) items.delete(item.link);
      }
      for (const link of [...window.rows.map(row => row.link!), ...[window.beforeEdge, window.afterEdge, window.tailEdge].flatMap(edge => edge ? [edge.link] : [])])
        items.set(link.link_id, {link: link.link_id, position: position(link, sample.ref), height: items.get(link.link_id)?.height ?? ESTIMATE});
      if (window.beforeEdge === null && window.rows.length) prior.first = true;
      if (window.afterEdge === null && window.rows.length) prior.last = true;
    }
    for (const window of windows) {
      const links = [...(window.beforeEdge ? [window.beforeEdge.link.link_id] : []), ...window.rows.map(row => row.link!.link_id), ...(window.afterEdge ? [window.afterEdge.link.link_id] : [])];
      for (let index = 1; index < links.length; index++) prior.joined.add(`${links[index - 1]}/${links[index]}`);
    }
    prior.items = [...items.values()].sort(ordered); this.branches.set(parent, prior);
  }
  layout(parent: string, windows: readonly OutlineWindow[]): readonly BranchPart[] {
    const branch = this.branches.get(parent);
    if (!branch) return [];
    const shown = new Set(windows.flatMap(window => window.rows.map(row => row.link!.link_id)));
    const connected = branch.joined;
    const result: BranchPart[] = [];
    const items = branch.items;
    const gap = (from: number, to: number, unknown: boolean) => {
      if (to <= from && !unknown) return;
      const prior = items[from - 1], next = items[to];
      const direction = prior ? "after" : "before";
      const anchor = items[from + Math.floor(Math.max(0, to - from - 1) / 2)]?.link ?? next?.link ?? prior?.link ?? null;
      const range = {cursor: null, anchor_link_id: anchor, limit: 48};
      result.push({kind: "gap", key: `${parent}:${prior?.link ?? "start"}:${next?.link ?? "end"}`, direction, range,
        height: items.slice(from, to).reduce((height, item) => height + item.height, unknown ? 24 * ESTIMATE : 0)});
    };
    let from = 0;
    for (let index = 0; index < items.length; index++) {
      if (!shown.has(items[index]!.link)) continue;
      const previous = result.findLast(part => part.kind === "row");
      const unknown = index === 0 ? !branch.first : previous?.kind === "row" ? !connected.has(`${previous.link}/${items[index]!.link}`) && from === index :
        !branch.first || items.slice(from, index + 1).some((item, at, all) => at > 0 && !connected.has(`${all[at - 1]!.link}/${item.link}`));
      gap(from, index, unknown);
      result.push({kind: "row", link: items[index]!.link}); from = index + 1;
    }
    const trailing = items.slice(from);
    const unknown = !branch.last || trailing.some((item, index) => index > 0 && !connected.has(`${trailing[index - 1]!.link}/${item.link}`));
    gap(from, items.length, unknown);
    return result;
  }
  coalesce(parent: string, ranges: readonly OutlineRange[]): OutlineRange[] {
    const branch = this.branches.get(parent);
    const result: OutlineRange[] = [];
    for (const range of ranges) {
      if (result.some(candidate => JSON.stringify(candidate) === JSON.stringify(range))) continue;
      let merged = false;
      if (branch && range.cursor === null) for (const [index, candidate] of result.entries()) {
        if (candidate.cursor !== null) continue;
        const left = candidate.anchor_link_id === null ? 0 : branch.items.findIndex(item => item.link === candidate.anchor_link_id);
        const right = range.anchor_link_id === null ? 0 : branch.items.findIndex(item => item.link === range.anchor_link_id);
        if (left < 0 || right < 0 || branch.items.slice(Math.min(left, right), Math.max(left, right) + 1).some((item, at, all) => at > 0 && !branch.joined.has(`${all[at - 1]!.link}/${item.link}`))) continue;
        const from = Math.min(candidate.anchor_link_id === null ? 0 : Math.max(0, left - Math.floor(candidate.limit / 2)), range.anchor_link_id === null ? 0 : Math.max(0, right - Math.floor(range.limit / 2)));
        const to = Math.max(candidate.anchor_link_id === null ? candidate.limit : left + Math.ceil(candidate.limit / 2), range.anchor_link_id === null ? range.limit : right + Math.ceil(range.limit / 2));
        if (to - from > 48) continue;
        const anchor = from === 0 && branch.first ? null : branch.items[from + Math.floor((to - from) / 2)]?.link;
        if (anchor === undefined) continue;
        result[index] = {cursor: null, anchor_link_id: anchor, limit: to - from}; merged = true; break;
      }
      if (!merged) result.push(range);
    }
    return result;
  }
  measured(parent: string, link: string, height: number): void {
    const item = this.branches.get(parent)?.items.find(item => item.link === link);
    if (item) item.height = height;
  }
  publish(rows: readonly {id: string; anchor: string | null; parent: string | null; link: string | null; gapHeight: number | null}[], elements: ReadonlyMap<string, HTMLElement>): void {
    let top = 0;
    const next = rows.map(row => {
      const element = elements.get(row.id);
      const height = row.gapHeight ?? (element?.isConnected ? element.getBoundingClientRect().height : this.heights.get(row.id)) ?? ESTIMATE;
      this.heights.set(row.id, height);
      const metric = {id: row.id, anchor: row.anchor, parent: row.parent, link: row.link, top, height, gap: row.gapHeight !== null};
      top += height;
      return metric;
    });
    if (next.length === this.committed.length && next.every((metric, index) => {
      const previous = this.committed[index]!;
      return metric.id === previous.id && metric.anchor === previous.anchor && metric.parent === previous.parent && metric.link === previous.link &&
        metric.top === previous.top && metric.height === previous.height && metric.gap === previous.gap;
    })) return;
    this.committed = next;
    this.version++;
  }
  rangeFor(parent: string, fraction: number): OutlineRange | null {
    const items = this.branches.get(parent)?.items;
    if (!items?.length) return null;
    const index = Math.max(0, Math.min(items.length - 1, Math.floor(fraction * items.length)));
    return {cursor: null, anchor_link_id: items[index]!.link, limit: 48};
  }
}
