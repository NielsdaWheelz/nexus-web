"use client";
/** One bounded data-only branch proof. The root outline admits and retains all
 * writing together; a disclosed branch never opens documents independently. */
import {useMemo} from "react";
import type {AuthoredQuery, LinkState, QueryResult, QueryRow, ResourceProjection} from "@nexus/authored/types";
import {useAuthoredAccountId} from "@/lib/authored/provider";
import {classifyOutlineOccurrence, type OutlineBranch} from "@/lib/resources/outlineProjection";
import {useAuthoredQuery} from "./hooks";
import type {WritingRuntime} from "./runtime";

export interface OutlineEdge {link: LinkState; resource: ResourceProjection}
export interface OutlineWindow {
  readonly ref: string;
  readonly branch: OutlineBranch;
  data: QueryResult;
  rows: QueryRow[];
  beforeEdge: OutlineEdge | null;
  afterEdge: OutlineEdge | null;
  tailEdge: OutlineEdge | null;
  childAvailability: ReadonlyMap<string, boolean | null>;
  resources: ReadonlyMap<string, ResourceProjection>;
  rootResource: ResourceProjection | null;
  editableRefs: ReadonlySet<string>;
}
type OutlineQuery = Extract<AuthoredQuery, {kind: "adjacency" | "adjacency_window"}>;
export function useOutlineWindow(query: OutlineQuery, branch: OutlineBranch, runtime: WritingRuntime | null) {
  const accountId = useAuthoredAccountId();
  const traversed = [...branch.traversedEdgeIds];
  const effective: Extract<AuthoredQuery, {kind: "outline_window"}> = {kind: "outline_window", ref: query.ref,
    cursor: query.cursor, anchor_link_id: query.kind === "adjacency_window" ? query.link_id : null,
    limit: Math.min(48, query.limit), excluded_link_ids: traversed, entering_link_id: traversed.at(-1) ?? null};
  const read = useAuthoredQuery(effective);
  const key = JSON.stringify([accountId, effective, [...branch.ancestors]]);
  const window = useMemo((): OutlineWindow | null => {
    if (!runtime || !read.data) return null;
    const data = read.data, proof = data.outline_window;
    // justify-service-invariant-check: the closed query owns proof completeness and raw-row alignment.
    if (proof === null) throw new Error("outline window proof is missing");
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
      const resource = resources.get(link.endpoint_a === query.ref ? link.endpoint_b : link.endpoint_a);
      if (!resource) throw new Error("outline neighbour is missing from its proven revision");
      return {link, resource};
    });
    const childAvailability = new Map(rows.map(row => [row.link!.link_id, rawChildren.get(row.link!.link_id)!]));
    const editableRefs = new Set([...rows.map(row => ({link: row.link!, resource: row.resource})), ...edges.filter((edge): edge is OutlineEdge => edge !== null)]
      .filter(({link, resource}) => (resource.kind === "note" || resource.kind === "page") && classifyOutlineOccurrence({branch: captured, targetRef: resource.ref, edgeId: link.link_id}).kind === "resource").map(({resource}) => resource.ref));
    return {ref: query.ref, branch: captured, data, rows, beforeEdge: edges[0]!, afterEdge: edges[1]!, tailEdge: edges[2]!,
      childAvailability, resources, rootResource: resources.get(query.ref) ?? null, editableRefs};
    // The serialized account/query/branch key owns the captured projection identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, key, branch, read.data]);
  return {window, loading: read.error === null && (window === null || window.data !== read.data), error: read.error, retry: read.retry};
}
