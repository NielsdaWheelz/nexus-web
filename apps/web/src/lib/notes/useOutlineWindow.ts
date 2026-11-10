"use client";
/** One coherent set of data-only branch proofs. Only the root session admits
 * writing; disclosed branches never open documents independently. */
import {useMemo} from "react";
import type {AuthoredQuery, LinkState, QueryResult, QueryRow, ResourceProjection, OutlineWindowSlice} from "@nexus/authored/types";
import {classifyOutlineOccurrence, type OutlineBranch} from "@/lib/resources/outlineProjection";
import {useAuthoredQuery} from "./hooks";
import type {WritingRuntime} from "./runtime";

export interface OutlineEdge {link: LinkState; resource: ResourceProjection}
export interface OutlineWindow {
  readonly ref: string;
  readonly branch: OutlineBranch;
  data: Pick<QueryResult, "store_revision" | "scope_available"> & OutlineWindowSlice;
  rows: QueryRow[];
  beforeEdge: OutlineEdge | null;
  afterEdge: OutlineEdge | null;
  tailEdge: OutlineEdge | null;
  childAvailability: ReadonlyMap<string, boolean | null>;
  resources: ReadonlyMap<string, ResourceProjection>;
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
  const data = {store_revision: result.store_revision, scope_available: result.scope_available, ...slice};
  const proof = slice.proof;
  if (data.children.length !== data.rows.length) throw new Error("outline availability result length mismatch");
  const captured = branch;
  const resources = new Map(data.rows.map(row => [row.resource.ref, row.resource]));
  for (const resource of proof.resources) resources.set(resource.ref, resource);
  const rawChildren = new Map<string, boolean | null>();
  for (const [index, row] of data.rows.entries()) {
    if (row.link === null) throw new Error("outline row is missing its link");
    rawChildren.set(row.link.link_id, data.children[index]!);
  }
  const rows = data.rows.filter(row => classifyOutlineOccurrence({branch: captured, targetRef: row.resource.ref, edgeId: row.link!.link_id}).kind !== "omit");
  const edges = [proof.before, proof.after, proof.tail].map(link => {
    if (!link) return null;
    const resource = resources.get(link.endpoint_a === ref ? link.endpoint_b : link.endpoint_a);
    if (!resource) throw new Error("outline neighbour is missing from its proven revision");
    return {link, resource};
  });
  const childAvailability = new Map(rows.map(row => [row.link!.link_id, rawChildren.get(row.link!.link_id)!]));
  const editableRefs = new Set([...rows.map(row => ({link: row.link!, resource: row.resource})), ...edges.filter((edge): edge is OutlineEdge => edge !== null)]
    .filter(({link, resource}) => (resource.kind === "note" || resource.kind === "page") && classifyOutlineOccurrence({branch: captured, targetRef: resource.ref, edgeId: link.link_id}).kind === "resource").map(({resource}) => resource.ref));
  return {ref, branch: captured, data, rows, beforeEdge: edges[0]!, afterEdge: edges[1]!, tailEdge: edges[2]!,
    childAvailability, resources, rootResource: resources.get(ref) ?? null, editableRefs};
}
