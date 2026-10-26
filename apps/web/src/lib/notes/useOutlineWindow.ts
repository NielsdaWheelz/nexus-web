"use client";
/** One bounded data-only branch proof. The root outline admits and retains all
 * writing together; a disclosed branch never opens documents independently. */
import {useEffect, useState} from "react";
import type {AuthoredQuery, LinkState, QueryResult, QueryRow, ResourceProjection} from "@nexus/authored/types";
import {useAuthoredAccountId} from "@/lib/authored/provider";
import {classifyOutlineOccurrence, type OutlineBranch} from "@/lib/resources/outlineProjection";
import {useAuthoredQuery} from "./hooks";
import type {WritingRuntime} from "./runtime";

export interface OutlineEdge {link: LinkState; resource: ResourceProjection}
export interface OutlineWindow {
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
  const effective = {...query, limit: Math.min(48, query.limit)};
  const read = useAuthoredQuery(effective);
  const key = JSON.stringify([accountId, effective, [...branch.ancestors], [...branch.traversedEdgeIds]]);
  const enteringEdge = [...branch.traversedEdgeIds].at(-1) ?? null;
  const [publication, publish] = useState<{key: string; runtime: WritingRuntime; window: OutlineWindow} | null>(null);
  const [failure, fail] = useState<{key: string; error: unknown} | null>(null);
  const current = publication?.key === key && publication.runtime === runtime ? publication.window : null;
  useEffect(() => {
    if (!runtime || !read.data) return;
    let retired = false;
    const data = read.data;
    fail(null);
    void (async () => {
      const rows = data.rows.filter(row => classifyOutlineOccurrence({branch, targetRef: row.resource.ref, edgeId: row.link?.link_id ?? null}).kind !== "omit");
      const store = await runtime.store;
      const first = rows[0]?.link, last = rows.at(-1)?.link;
      const boundaries = await Promise.all([
        ...(first && last ? [
          store.query({kind: "positions", ref: query.ref, exclude_link_id: enteringEdge, at: {kind: "neighbors", link_id: first.link_id, side: "before"}}),
          store.query({kind: "positions", ref: query.ref, exclude_link_id: enteringEdge, at: {kind: "neighbors", link_id: last.link_id, side: "after"}}),
        ] : []),
        store.query({kind: "positions", ref: query.ref, exclude_link_id: enteringEdge, at: {kind: "tail"}}),
      ]);
      if (retired || boundaries.some(result => result.store_revision !== data.store_revision)) return;
      const links = [
        first && last ? boundaries[0]!.positions.find(link => link.link_id !== first.link_id) ?? null : null,
        first && last ? boundaries[1]!.positions.find(link => link.link_id !== last.link_id) ?? null : null,
        boundaries.at(-1)!.positions[0] ?? null,
      ];
      const resources = new Map(rows.map(row => [row.resource.ref, row.resource]));
      const refs = [...new Set([query.ref, ...links.flatMap(link => link ? [link.endpoint_a === query.ref ? link.endpoint_b : link.endpoint_a] : [])])].filter(ref => !resources.has(ref));
      if (refs.length) {
        const peers = await store.query({kind: "resolve", refs});
        if (retired || peers.store_revision !== data.store_revision) return;
        for (const row of peers.rows) resources.set(row.resource.ref, row.resource);
      }
      const edges = links.map(link => {
        if (!link) return null;
        const resource = resources.get(link.endpoint_a === query.ref ? link.endpoint_b : link.endpoint_a);
        if (!resource) throw new Error("outline neighbour is missing from its proven revision");
        return {link, resource};
      });
      const childAvailability = new Map<string, boolean | null>();
      if (rows.length) {
        const children = await store.query({kind: "outline_children", occurrences: rows.map(row => ({ref: row.resource.ref,
          excluded_link_ids: [...new Set([...branch.traversedEdgeIds, row.link!.link_id])].sort()}))});
        if (retired || children.store_revision !== data.store_revision) return;
        if (children.children.length !== rows.length) throw new Error("outline availability result length mismatch");
        rows.forEach((row, index) => childAvailability.set(row.link!.link_id, children.children[index]!));
      }
      const editableRefs = new Set([...rows.map(row => ({link: row.link!, resource: row.resource})), ...edges.filter((edge): edge is OutlineEdge => edge !== null)]
        .filter(({link, resource}) => (resource.kind === "note" || resource.kind === "page") && classifyOutlineOccurrence({branch, targetRef: resource.ref, edgeId: link.link_id}).kind === "resource").map(({resource}) => resource.ref));
      if (!retired) publish({key, runtime, window: {data, rows, beforeEdge: edges[0]!, afterEdge: edges[1]!, tailEdge: edges[2]!, childAvailability, resources,
        rootResource: resources.get(query.ref) ?? null, editableRefs}});
    })().catch(error => {if (!retired) fail({key, error});});
    return () => {retired = true;};
  }, [runtime, key, query.ref, enteringEdge, branch, read.data]);
  const error = read.error ?? (failure?.key === key ? failure.error : null);
  return {window: current, loading: error === null && (current === null || current.data !== read.data), error, retry: read.retry};
}
