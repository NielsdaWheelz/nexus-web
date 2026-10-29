/** Selection names displayed occurrences; plans change their incoming placements. */
import type {FocusSelection} from "./editorTypes";
import type {WritingDocument} from "./runtime";

export type BlockRange = {anchor_id: string; head_id: string; row_ids: readonly string[]};
export type InputBookmark = {kind: "text"; row_id: string; ref: string; range: FocusSelection; root?: true;
  resolveBefore?: (document: WritingDocument) => FocusSelection;
  resolve: ((document: WritingDocument) => FocusSelection) | null} | ({kind: "blocks"} & BlockRange) | null;
export type Placement = {row_id: string; ref: string; parent_id: string; parent_ref: string; after_id: string | null; before_id: string | null};
export type PlacementDelta = {before: Placement; after: Placement | null};
export type RangeCommand = "indent" | "outdent" | "remove";
export type RangePlan = {command: RangeCommand; changes: readonly PlacementDelta[]; selection_before: InputBookmark; selection_after: InputBookmark};
export type RangeReason = "unavailable" | "gap" | "scope" | "no_preceding" | "top_level" | "invalid_parent" | "shared_edge" | "collision" | "changed" | "capacity" | "retired";
export interface SelectionRow {
  row_id: string; ref: string | null; link_id: string | null; parent_id: string | null; parent_ref: string; scope_id: string;
  kind: "body" | "title" | "reference"; root: boolean; tail: boolean; selectable: boolean; eligible_parent: boolean; ready: boolean; gap: boolean;
}
export type RangeSnapshot = {rows: readonly SelectionRow[]};
type Refusal = {kind: "refusal"; reason: RangeReason};

export function rangeSelection(snapshot: RangeSnapshot, anchor_id: string, head_id: string): {kind: "selection"; selection: BlockRange} | Refusal {
  const anchor = snapshot.rows.find(row => row.row_id === anchor_id), head = snapshot.rows.find(row => row.row_id === head_id);
  if (!anchor?.selectable || !head?.selectable) return {kind: "refusal", reason: "unavailable"};
  if (anchor.scope_id !== head.scope_id) return {kind: "refusal", reason: "scope"};
  const order = snapshot.rows.filter(row => row.scope_id === anchor.scope_id), from = order.indexOf(anchor), to = order.indexOf(head);
  const rows = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (rows.some(row => row.gap)) return {kind: "refusal", reason: "gap"};
  return {kind: "selection", selection: {anchor_id, head_id, row_ids: rows.filter(row => row.selectable).map(row => row.row_id)}};
}

export function planRange(command: RangeCommand, snapshot: RangeSnapshot, selection: InputBookmark): {kind: "plan"; plan: RangePlan} | Refusal {
  const ids = selection?.kind === "blocks" ? selection.row_ids : selection ? [selection.row_id] : [];
  const rows = new Map(snapshot.rows.map(row => [row.row_id, row])), selected = new Set(ids);
  const members = ids.flatMap(id => {const row = rows.get(id); return row ? [row] : [];});
  if (!members.length || members.length !== ids.length || members.some(row => !row.selectable || !row.ready || row.ref === null || row.parent_id === null))
    return {kind: "refusal", reason: "unavailable"};
  if (members.some(row => row.scope_id !== members[0]!.scope_id)) return {kind: "refusal", reason: "scope"};
  const span = snapshot.rows.filter(row => row.scope_id === members[0]!.scope_id);
  const selectedAt = members.map(row => span.indexOf(row));
  if (span.slice(Math.min(...selectedAt), Math.max(...selectedAt) + 1).some(row => row.gap)) return {kind: "refusal", reason: "gap"};
  const beneath = (row: SelectionRow, ancestors: ReadonlySet<string>) => {
    let parent = row.parent_id;
    while (parent !== null) {if (ancestors.has(parent)) return true; parent = rows.get(parent)?.parent_id ?? null;}
    return false;
  };
  const roots = snapshot.rows.filter(row => selected.has(row.row_id) && !beneath(row, selected));
  const placement = (row: SelectionRow): Placement => {
    const siblings = snapshot.rows.filter(peer => peer.parent_id === row.parent_id && peer.selectable), at = siblings.indexOf(row);
    return {row_id: row.row_id, ref: row.ref!, parent_id: row.parent_id!, parent_ref: row.parent_ref,
      after_id: siblings[at - 1]?.row_id ?? null, before_id: siblings[at + 1]?.row_id ?? null};
  };
  const changes: PlacementDelta[] = [];
  if (command === "remove") for (const row of roots) changes.push({before: placement(row), after: null});
  else {
    const rootIds = new Set(roots.map(row => row.row_id));
    const runs: SelectionRow[][] = [], outdentedAfter = new Map<string, string>();
    for (const row of roots) {
      const siblings = snapshot.rows.filter(peer => peer.parent_id === row.parent_id && (peer.selectable || peer.gap));
      const previous = siblings[siblings.indexOf(row) - 1], run = runs[runs.length - 1];
      if (run && previous === run[run.length - 1]) run.push(row); else runs.push([row]);
    }
    for (const run of runs) {
      const first = run[0]!, last = run[run.length - 1]!;
      const siblings = snapshot.rows.filter(row => row.parent_id === first.parent_id && (row.selectable || row.gap));
      const at = siblings.indexOf(first), preceding = siblings[at - 1], parent = rows.get(first.parent_id!);
      let destination: SelectionRow, after_id: string | null, before_id: string | null;
      if (command === "indent") {
        if (preceding?.gap) return {kind: "refusal", reason: "gap"};
        if (!preceding || rootIds.has(preceding.row_id)) return {kind: "refusal", reason: "no_preceding"};
        if (!preceding.eligible_parent || !preceding.ready || preceding.ref === null) return {kind: "refusal", reason: "invalid_parent"};
        destination = preceding; after_id = null; before_id = null;
      } else {
        if (!parent?.parent_id || parent.root) return {kind: "refusal", reason: "top_level"};
        const grandparent = rows.get(parent.parent_id);
        if (!grandparent?.ref) return {kind: "refusal", reason: "unavailable"};
        const peers = snapshot.rows.filter(row => row.parent_id === parent.parent_id && (row.selectable || row.gap));
        const next = peers[peers.indexOf(parent) + 1];
        if (next?.gap) return {kind: "refusal", reason: "gap"};
        destination = grandparent; after_id = outdentedAfter.get(parent.row_id) ?? parent.row_id; before_id = next?.row_id ?? null;
      }
      if (siblings.slice(at, siblings.indexOf(last) + 1).some(row => row.gap)) return {kind: "refusal", reason: "gap"};
      for (const row of run) {
        if (destination.ref === row.ref || destination.row_id === row.row_id || beneath(destination, new Set([row.row_id])))
          return {kind: "refusal", reason: "invalid_parent"};
        changes.push({before: placement(row), after: {row_id: row.row_id, ref: row.ref!, parent_id: destination.row_id,
          parent_ref: destination.ref!, after_id, before_id}});
        after_id = row.row_id;
      }
      if (command === "outdent") outdentedAfter.set(first.parent_id!, last.row_id);
    }
  }
  const edges = new Map<string, PlacementDelta>(), pairs = new Map<string, string>();
  for (const change of changes) {
    const edge = rows.get(change.before.row_id)!.link_id;
    if (edge !== null) {
      const other = edges.get(edge);
      if (other && (other.after !== null || change.after !== null) && (other.before.ref !== change.before.ref || other.before.parent_ref !== change.before.parent_ref || other.after?.parent_ref !== change.after?.parent_ref ||
        (other.after?.after_id ? rows.get(other.after.after_id)?.ref : null) !== (change.after?.after_id ? rows.get(change.after.after_id)?.ref : null) ||
        (other.after?.before_id ? rows.get(other.after.before_id)?.ref : null) !== (change.after?.before_id ? rows.get(change.after.before_id)?.ref : null)))
        return {kind: "refusal", reason: "shared_edge"};
      edges.set(edge, change);
    }
    if (change.after) {
      const pair = [change.after.ref, change.after.parent_ref].sort().join("\n"), other = pairs.get(pair);
      if (other !== undefined && (edge === null || other !== edge)) return {kind: "refusal", reason: "collision"};
      pairs.set(pair, edge ?? change.before.row_id);
    }
  }
  let selection_after = selection;
  if (command === "remove") {
    const removed = new Set(roots.map(row => row.row_id));
    const survives = (row: SelectionRow) => !removed.has(row.row_id) && !beneath(row, removed);
    const first = snapshot.rows.indexOf(roots[0]!), last = snapshot.rows.reduce((at, row, index) => row.root || survives(row) ? at : index, first);
    const following = snapshot.rows.slice(last + 1).find(row => row.scope_id === members[0]!.scope_id && row.selectable && survives(row));
    const previous = snapshot.rows.slice(0, first).reverse().find(row => row.scope_id === members[0]!.scope_id && row.selectable && survives(row));
    const fallback = snapshot.rows.find(row => row.scope_id === members[0]!.scope_id && row.tail && row.parent_id === row.scope_id && row.ready && survives(row))
      ?? snapshot.rows.find(row => row.scope_id === members[0]!.scope_id && row.root && row.ready);
    const target = following ?? previous ?? fallback;
    selection_after = target ? target.kind === "reference" ? {kind: "blocks", anchor_id: target.row_id, head_id: target.row_id, row_ids: [target.row_id]}
      : {kind: "text", row_id: target.row_id, ref: target.ref ?? target.parent_ref, range: target === following || target === fallback ? {anchor: 1, head: 1} : "end", resolve: null} : null;
  }
  return {kind: "plan", plan: {command, changes, selection_before: selection, selection_after}};
}

export function rangeReasonMessage(reason: RangeReason): string {
  switch (reason) {
    case "unavailable": return "select an available item";
    case "gap": return "show the missing items before selecting across this gap";
    case "scope": return "select items in the same outline";
    case "no_preceding": return "no preceding item to nest under";
    case "top_level": return "some selected items are already at the top level";
    case "invalid_parent": return "this item cannot be nested under that parent";
    case "shared_edge": return "selected appearances need different changes to the same relationship";
    case "collision": return "an item is already linked under that parent";
    case "changed": return "the outline changed. try again.";
    case "capacity": return "close a branch or select fewer items";
    case "retired": return "this outline is no longer open";
  }
}
