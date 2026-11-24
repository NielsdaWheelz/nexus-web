/** Sparse branch geometry retains identities and measurements, never writing.
 * The controller remains the only occurrence tree and command owner. */
import type {LinkState, OutlineRange} from "@nexus/authored/types";
import type {OutlineEdge, OutlineWindow} from "./useOutlineWindow";

/** `height` is a measurement of the mounted row, or null: an unmeasured item takes the estimate when read. */
export type BranchPart = {kind: "row"; link: string} | {
  kind: "gap"; key: string; height: number; range: OutlineRange; direction: "before" | "after";
  links?: readonly string[]; ranks?: {start: number; end: number}; waiting?: true;
};
export interface RowMetric {id: string; anchor: string | null; parent: string | null; link: string | null; top: number; height: number; gap: boolean}

function rangeAroundRank(total: number, rank: number, limit: number): OutlineRange {
  return {start_rank: Math.max(0, Math.min(total - limit, rank - Math.floor(limit / 2))), cursor: null, anchor_link_id: null, limit};
}

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
  if (windows.length === 1) return first;
  const resources = new Map(windows.flatMap(window => [...window.resources]));
  const childAvailability = new Map(windows.flatMap(window => [...window.childAvailability]));
  const oversizedRefs = new Set(windows.flatMap(window => [...window.oversizedRefs]));
  const rows = [...new Map(windows.flatMap(window => window.rows.map(row => [row.link!.link_id, row] as const))).values()]
    .sort((a, b) => ordered({link: a.link!.link_id, position: position(a.link!, first.ref)}, {link: b.link!.link_id, position: position(b.link!, first.ref)}));
  const parts = [...windows].sort((a, b) => {
    const left = a.rows[0]?.link, right = b.rows[0]?.link;
    return left && right ? ordered({link: left.link_id, position: position(left, first.ref)}, {link: right.link_id, position: position(right, first.ref)}) : 0;
  });
  const head = parts[0]!, tail = parts.at(-1)!;
  return {...first, rows, resources, childAvailability, oversizedRefs, editableRefs: new Set(windows.flatMap(window => [...window.editableRefs])),
    beforeEdge: head.beforeEdge, afterEdge: tail.afterEdge, tailEdge: tail.tailEdge,
    // The merged command view may join disjoint slices. Each original slice owns its ranks.
    data: {...first.data, start_rank: null, rows, children: rows.map(row => childAvailability.get(row.link!.link_id) ?? null),
      previous_cursor: head.data.previous_cursor, next_cursor: tail.data.next_cursor,
      proof: {...first.data.proof, before: head.beforeEdge?.link ?? null, after: tail.afterEdge?.link ?? null, tail: tail.tailEdge?.link ?? null, resources: [...resources.values()], oversized_refs: [...oversizedRefs]}}};
}

export class OutlineViewport {
  private branches: ReadonlyMap<string, readonly string[]> | null = null;
  private readonly ranked = new Map<string, {revision: string; branch: OutlineWindow["branch"]; total: number; ranks: Map<string, number>}>();
  private readonly branchHeights = new Map<string, Map<string, number>>();
  private readonly heights = new Map<string, number>();
  private committed: readonly RowMetric[] = [];
  private version = 0;
  /** The smallest height measured on a mounted writing row since typography last changed. Gaps, hidden
   * rows and estimates are never measurements. */
  private smallest: number | null = null;
  /** The root's computed line height: one line of the outline's type. The controller owns it; it is 0
   * until a view is laid out. */
  pitch = 0;
  /** One unmeasured row. */
  get estimate(): number {return this.smallest ?? this.pitch;}
  get revision(): number {return this.version;}
  get metrics(): readonly RowMetric[] {return this.committed;}
  get height(): number {const last = this.committed.at(-1); return last ? last.top + last.height : 0;}
  invalidateMeasurements(): void {
    this.heights.clear(); this.smallest = null;
    this.branchHeights.clear();
  }
  setBranches(branches: ReadonlyMap<string, readonly string[]> | null): boolean {
    if (branches === this.branches) return false;
    if (branches !== null && branches.size === this.branches?.size && [...branches].every(([parent, ids]) => {
      const previous = this.branches?.get(parent);
      return previous?.length === ids.length && ids.every((id, rank) => previous[rank] === id);
    })) return false;
    this.branches = branches;
    if (branches !== null) for (const [parent, sizes] of this.branchHeights) {
      const links = branches.get(parent);
      if (!links) {this.branchHeights.delete(parent); continue;}
      const remaining = new Set(links);
      for (const link of sizes.keys()) if (!remaining.has(link)) sizes.delete(link);
    }
    return true;
  }
  estimatedHeight(parent: string): number {
    if (this.branches !== null)
      return (this.branches.get(parent) ?? []).reduce((height, link) => height + this.rowHeight(parent, link), 0);
    return this.rankedHeight(parent, 0, this.ranked.get(parent)?.total ?? 0);
  }
  forgetBranch(parent: string): void {
    this.ranked.delete(parent);
    this.branchHeights.delete(parent);
  }
  private rankedHeight(parent: string, start: number, end: number): number {
    let height = (end - start) * this.estimate;
    for (const [link, rank] of this.ranked.get(parent)?.ranks ?? []) {
      if (rank >= start && rank < end) height += this.rowHeight(parent, link) - this.estimate;
    }
    return height;
  }
  rowHeight(parent: string, link: string): number {
    return this.branchHeights.get(parent)?.get(link) ?? this.estimate;
  }
  layout(parent: string, windows: readonly OutlineWindow[]): readonly BranchPart[] {
    if (this.branches === null) {
      const window = windows[0];
      if (window === undefined) return [];
      const first = window.data;
      let observed = this.ranked.get(parent);
      if (observed?.revision !== first.store_revision || observed.branch !== window.branch) {
        observed = {revision: first.store_revision, branch: window.branch, total: first.total, ranks: new Map()};
        this.ranked.set(parent, observed);
      }
      const shown = new Map<number, string>();
      for (const {data, rows} of windows) if (data.start_rank !== null) {
        for (const [index, row] of rows.entries()) {
          const link = row.link!.link_id, rank = data.start_rank + index;
          observed.ranks.set(link, rank);
          shown.set(rank, link);
        }
      }
      const parts: BranchPart[] = [];
      let from = 0;
      const gap = (to: number) => {
        if (to <= from) return;
        parts.push({kind: "gap", key: `${parent}:${from}:${to}`, direction: from === 0 ? "before" : "after",
          height: this.rankedHeight(parent, from, to), ranks: {start: from, end: to},
          range: rangeAroundRank(first.total, Math.floor((from + to - 1) / 2), 48)});
      };
      for (const [rank, link] of [...shown].sort(([left], [right]) => left - right)) {
        gap(rank);
        parts.push({kind: "row", link});
        from = rank + 1;
      }
      gap(first.total);
      return parts;
    }
    const items = this.branches.get(parent) ?? [];
    const shown = new Set(windows.flatMap(window => window.rows.map(row => row.link!.link_id)));
    const result: BranchPart[] = [];
    let from = 0;
    const gap = (to: number) => {
      if (to <= from) return;
      const prior = items[from - 1], next = items[to];
      const links = items.slice(from, to);
      result.push({kind: "gap", key: `${parent}:${prior ?? "start"}:${next ?? "end"}`,
        direction: prior ? "after" : "before", links,
        range: {start_rank: null, cursor: null, anchor_link_id: links[Math.floor((links.length - 1) / 2)], limit: 48},
        height: links.reduce((height, link) => height + this.rowHeight(parent, link), 0)});
    };
    for (let index = 0; index < items.length; index++) {
      if (!shown.has(items[index]!)) continue;
      gap(index);
      result.push({kind: "row", link: items[index]!});
      from = index + 1;
    }
    gap(items.length);
    return result;
  }
  measured(parent: string, link: string, height: number): void {
    if (height <= 0) return;
    let sizes = this.branchHeights.get(parent);
    if (!sizes) {sizes = new Map(); this.branchHeights.set(parent, sizes);}
    sizes.set(link, height);
  }
  rangeAt(parent: string, gap: Extract<BranchPart, {kind: "gap"}>, offset: number, limit: number): OutlineRange {
    if (gap.ranks !== undefined) {
      const {start, end} = gap.ranks;
      let lo = start, hi = end - 1;
      while (lo < hi) {
        const middle = Math.floor((lo + hi) / 2);
        if (this.rankedHeight(parent, start, middle + 1) <= offset) lo = middle + 1;
        else hi = middle;
      }
      const total = this.ranked.get(parent)!.total;
      return rangeAroundRank(total, lo, limit);
    }
    let anchor_link_id = gap.range.anchor_link_id;
    for (const link of gap.links ?? []) {
      anchor_link_id = link;
      offset -= this.rowHeight(parent, link);
      if (offset < 0) break;
    }
    return {...gap.range, anchor_link_id, limit};
  }
  publish(rows: readonly {id: string; anchor: string | null; parent: string | null; link: string | null; gapHeight: number | null}[], elements: ReadonlyMap<string, HTMLElement>): void {
    let top = 0;
    const next = rows.map(row => {
      const element = elements.get(row.id);
      const measured = row.gapHeight === null && element?.isConnected ? element.getBoundingClientRect().height : null;
      if (measured !== null && measured > 0) {this.heights.set(row.id, measured); this.smallest = Math.min(this.smallest ?? measured, measured);}
      const height = row.gapHeight ?? measured ?? this.heights.get(row.id) ?? this.estimate;
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
    if (this.branches === null) {
      const total = this.ranked.get(parent)?.total ?? 0;
      return total === 0 ? null : rangeAroundRank(total, Math.floor(fraction * total), 48);
    }
    const items = this.branches.get(parent);
    if (!items?.length) return null;
    const index = Math.max(0, Math.min(items.length - 1, Math.floor(fraction * items.length)));
    return {start_rank: null, cursor: null, anchor_link_id: items[index]!, limit: 48};
  }
}
