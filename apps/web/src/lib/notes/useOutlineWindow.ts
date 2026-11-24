"use client";
/** One coherent set of data-only branch proofs. Only the root session admits
 * writing; disclosed branches never open documents independently. */
import {useMemo} from "react";
import type {AuthoredQuery, LinkState, QueryResult, QueryRow, ResourceProjection, OutlineWindowSlice} from "@nexus/authored/types";
import {classifyOutlineOccurrence, type OutlineBranch} from "@/lib/resources/outlineProjection";
import {useAuthoredQuery} from "./hooks";
import type {WritingRuntime} from "./runtime";

export interface OutlineWindow {
  readonly ref: string;
  readonly branch: OutlineBranch;
  data: Pick<QueryResult, "store_revision" | "scope_available"> & Pick<OutlineWindowSlice, "next_cursor" | "previous_cursor"> & {hasRawRows: boolean};
  rows: QueryRow[];
  beforeEdge: LinkState | null;
  afterEdge: LinkState | null;
  tailEdge: LinkState | null;
  childAvailability: ReadonlyMap<string, boolean | null>;
  rootResource: ResourceProjection | null;
  editableRefs: ReadonlySet<string>;
}
type OutlineQuery = Omit<Extract<AuthoredQuery, {kind: "outline_windows"}>, "kind">;
export function useOutlineWindows(query: OutlineQuery, branch: OutlineBranch, runtime: WritingRuntime | null) {
  const read = useAuthoredQuery({kind: "outline_windows", ...query});
  const ref = query.ref;
  const count = query.ranges.length;
  const windows = useMemo((): readonly OutlineWindow[] | null => {
    const data = read.data;
    if (!runtime || !data) return null;
    if (data.outline_windows === null || data.outline_windows.length !== count) throw new Error("outline windows result length mismatch");
    return data.outline_windows.map((_, index) => projectOutlineWindow(data, ref, branch, index));
  }, [runtime, read.data, ref, branch, count]);
  return {windows, loading: read.pending || windows === null && read.error === null, error: read.error, occurrence: read.occurrence, retry: read.retry};
}

/** Decode the same bounded proof for a reactive read and an explicit destination admission. */
export function projectOutlineWindow(result: QueryResult, ref: string, branch: OutlineBranch, index: number): OutlineWindow {
  // justify-service-invariant-check: the closed query owns slice completeness and raw-row alignment.
  const slice = result.outline_windows?.[index];
  if (!slice) throw new Error("outline window slice is missing");
  const {proof, next_cursor, previous_cursor} = slice;
  if (slice.children.length !== slice.rows.length) throw new Error("outline availability result length mismatch");
  const rows: QueryRow[] = [];
  const childAvailability = new Map<string, boolean | null>();
  const editableRefs = new Set<string>();
  for (const [index, row] of slice.rows.entries()) {
    if (row.link === null) throw new Error("outline row is missing its link");
    const kind = classifyOutlineOccurrence({branch, targetRef: row.resource.ref, edgeId: row.link.link_id}).kind;
    if (kind === "omit") continue;
    rows.push(row);
    childAvailability.set(row.link.link_id, slice.children[index]!);
    if (kind === "resource" && (row.resource.kind === "note" || row.resource.kind === "page")) editableRefs.add(row.resource.ref);
  }
  const data = {store_revision: result.store_revision, scope_available: result.scope_available, next_cursor, previous_cursor, hasRawRows: slice.rows.length > 0};
  return {ref, branch, data, rows, beforeEdge: proof.before, afterEdge: proof.after, tailEdge: proof.tail,
    childAvailability, rootResource: proof.root, editableRefs};
}
