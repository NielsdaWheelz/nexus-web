"use client";

/** One prepared outline view: a bounded local prefix, its exact neighbouring
 * relationships and retained live writing. Graph proofs share one store revision;
 * documents can advance while typing. A refresh keeps the published view until
 * its replacement is ready. Account, query and branch changes withdraw it. */
import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {AuthoredQuery, LinkState, QueryResult, QueryRow, ResourceProjection} from "@nexus/authored/types";
import {useAuthoredAccountId} from "@/lib/authored/provider";
import {classifyOutlineOccurrence, type OutlineBranch} from "@/lib/resources/outlineProjection";
import {useAuthoredPages} from "./hooks";
import type {WritingDocument, WritingRuntime} from "./runtime";

export interface OutlineEdge {link: LinkState; resource: ResourceProjection}
type OutlineQuery = Extract<AuthoredQuery, {kind: "adjacency" | "adjacency_window"}>;
interface Publication {
  key: string;
  runtime: WritingRuntime;
  data: QueryResult;
  rows: QueryRow[];
  beforeEdge: OutlineEdge | null;
  afterEdge: OutlineEdge | null;
  tailEdge: OutlineEdge | null;
  childAvailability: ReadonlyMap<string, boolean | null>;
  documents: ReadonlyMap<string, WritingDocument>;
  release(): void;
}
const EMPTY_ROWS: QueryRow[] = [];
const EMPTY_CHILDREN: ReadonlyMap<string, boolean | null> = new Map();
const EMPTY_DOCUMENTS: ReadonlyMap<string, WritingDocument> = new Map();

export function useOutlineWindow(query: OutlineQuery, branch: OutlineBranch, runtime: WritingRuntime | null) {
  const accountId = useAuthoredAccountId();
  const read = useAuthoredPages({...query, cursor: null, limit: 48});
  const key = JSON.stringify([accountId, {...query, cursor: null, limit: 48}, [...branch.ancestors], [...branch.traversedEdgeIds]]);
  const enteringEdge = [...branch.traversedEdgeIds].at(-1) ?? null;
  const [publication, publish] = useState<Publication | null>(null);
  const [failure, fail] = useState<{key: string; runtime: WritingRuntime; error: unknown} | null>(null);
  const published = useRef<Publication | null>(null);
  const current = publication?.key === key && publication.runtime === runtime ? publication : null;

  useLayoutEffect(() => {
    const previous = published.current;
    published.current = current;
    if (previous !== current) previous?.release();
    // A retired view cannot reappear if navigation returns to the same query.
    if (publication !== null && current === null) publish(null);
  }, [current, publication]);
  useLayoutEffect(() => () => {published.current?.release(); published.current = null;}, []);

  useEffect(() => {
    if (runtime === null || read.data === null) return;
    const data = read.data;
    let retired = false;
    let candidate: Publication | null = null;
    const releases: (() => void)[] = [];
    const release = () => {for (const stop of releases.splice(0)) stop();};
    fail(null);
    void (async () => {
      const rows = data.rows.filter(row => classifyOutlineOccurrence({branch, targetRef: row.resource.ref, edgeId: row.link?.link_id ?? null}).kind !== "omit");
      const store = await runtime.store;
      if (retired) return;
      // Adjacency rows always name a relationship. Terminal refs stay real
      // barriers; neither boundary reads nor child proofs skip them.
      const first = rows[0]?.link, lastRow = rows.at(-1), last = lastRow?.link;
      const needTail = data.next_cursor !== null;
      const boundaries = await Promise.all([
        ...(first && last ? [
          store.query({kind: "positions", ref: query.ref, exclude_link_id: enteringEdge, at: {kind: "neighbors", link_id: first.link_id, side: "before"}}),
          store.query({kind: "positions", ref: query.ref, exclude_link_id: enteringEdge, at: {kind: "neighbors", link_id: last.link_id, side: "after"}}),
        ] : []),
        ...(needTail ? [store.query({kind: "positions", ref: query.ref, exclude_link_id: enteringEdge, at: {kind: "tail"}})] : []),
      ]);
      if (retired || boundaries.some(result => result.store_revision !== data.store_revision)) return;
      const links = [
        first && last ? boundaries[0]!.positions.find(link => link.link_id !== first.link_id) ?? null : null,
        first && last ? boundaries[1]!.positions.find(link => link.link_id !== last.link_id) ?? null : null,
        needTail ? boundaries[first && last ? 2 : 0]!.positions[0] ?? null : null,
      ];
      const resources = new Map(rows.map(row => [row.resource.ref, row.resource]));
      const refs = [...new Set(links.flatMap(link => link ? [link.endpoint_a === query.ref ? link.endpoint_b : link.endpoint_a] : []))].filter(ref => !resources.has(ref));
      if (refs.length) {
        const peers = await store.query({kind: "resolve", refs});
        if (retired || peers.store_revision !== data.store_revision) return;
        for (const row of peers.rows) resources.set(row.resource.ref, row.resource);
      }
      const edges = links.map(link => {
        if (link === null) return null;
        const ref = link.endpoint_a === query.ref ? link.endpoint_b : link.endpoint_a;
        const resource = resources.get(ref);
        if (!resource) throw new Error("outline neighbour is missing from its proven revision");
        return {link, resource};
      });
      const beforeEdge = edges[0]!, afterEdge = edges[1]!;
      const tailEdge = needTail ? edges[2]! : lastRow?.link ? {link: lastRow.link, resource: lastRow.resource} : null;
      const childAvailability = new Map<string, boolean | null>();
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        const occurrences = batch.map(row => ({ref: row.resource.ref,
          excluded_link_ids: [...new Set([...branch.traversedEdgeIds, row.link!.link_id])].sort()}));
        const children = await store.query({kind: "outline_children", occurrences});
        if (retired || children.store_revision !== data.store_revision) return;
        if (children.children.length !== batch.length) throw new Error("outline availability result length mismatch");
        batch.forEach((row, index) => childAvailability.set(row.link!.link_id, children.children[index]!));
      }
      const editable = [...resources.values()].filter(resource => resource.kind === "note" || resource.kind === "page");
      const documents = new Map<string, WritingDocument>();
      await Promise.all([...new Set(editable.map(resource => resource.ref))].map(async ref => {
        const document = await runtime.openDocument(ref);
        if (retired) return;
        releases.push(document.retain());
        documents.set(ref, document);
      }));
      if (retired) return;
      candidate = {key, runtime, data, rows, beforeEdge, afterEdge, tailEdge, childAvailability, documents, release};
      publish(candidate);
    })().catch(error => {
      if (retired) return;
      retired = true;
      release();
      fail({key, runtime, error});
    });
    return () => {
      retired = true;
      if (published.current !== candidate) release();
    };
  }, [runtime, key, query.ref, enteringEdge, branch, read.data]);

  const error = read.error ?? (failure?.key === key && failure.runtime === runtime ? failure.error : null);
  return {
    data: current?.data ?? null,
    rows: current?.rows ?? EMPTY_ROWS,
    beforeEdge: current?.beforeEdge ?? null,
    afterEdge: current?.afterEdge ?? null,
    tailEdge: current?.tailEdge ?? null,
    childAvailability: current?.childAvailability ?? EMPTY_CHILDREN,
    documents: current?.documents ?? EMPTY_DOCUMENTS,
    loading: error === null && (current === null || current.data !== read.data),
    error,
    more: read.more,
    retry: read.retry,
  };
}
