"use client";

// The media pane's annotations. Highlights, their attached notes and the media's
// whole-document links are local authored state: the account database owns them online
// too, and they never wait on the network. The server's document map remains a separate,
// separately failable section of derived evidence: source references, embeds and
// assistant links. Authored facts it echoes are dropped, so it never replaces local rows.
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { AuthoredQuery, AuthoredStore, LinkState, QueryResult, ResourceProjection } from "@nexus/authored/types";
import type { RailMarker } from "@/lib/documentReader/chrome/MapRail";
import { createReaderAnnotations, type AnnotationsState, type ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { Decorations, Mark, MarkAnchor, NoteRef } from "@/lib/documentReader/DocumentReader";
import { localPoint, structureOf, type ReaderDocument } from "@/lib/documentReader/model";
import { markerFacet, rootCounts, rootExtent, rootItem, type EvidenceRoot } from "./evidence/model";

type WireDocumentMap = Schema<"ReaderDocumentMapOut">;
/** The derived server sections, already stripped of authored facts. */
export type RemoteMap = Omit<WireDocumentMap, "evidence"> & {
  readonly evidence: Omit<WireDocumentMap["evidence"], "roots"> & { readonly roots: EvidenceRoot[] };
};
/** A whole-document link: an ordinary authored link, or a note body referencing the media. */
export interface LocalLink {
  readonly resource: ResourceProjection;
  /** null: a note body references the media; no link exists to unlink. */
  readonly link: LinkState | null;
}
export type Section<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: unknown; readonly retrying: boolean }
  | { readonly status: "ready"; readonly data: T };
export interface MediaAnnotationsState {
  readonly local: AnnotationsState;
  readonly links: Section<readonly LocalLink[]>;
  readonly remote: Section<RemoteMap>;
  readonly decorations: Pick<Decorations, "identity" | "marks" | "noteRefs">;
  readonly markers: readonly RailMarker[];
}

/** Server facts whose authority is now the local authored graph. */
const AUTHORED_ORIGINS = new Set<Schema<"ReaderDirectFactOut">["origin"]>(["user", "highlight_note", "note_body"]);
const PAGE = 100;

/** Remote roots enter the mounted publication only at its exact identity. */
function remoteRoots(wire: WireDocumentMap, doc: ReaderDocument | null): EvidenceRoot[] {
  const source = { media_id: wire.media_id, identity: wire.identity, apparatus_source: wire.evidence.apparatus_source };
  return wire.evidence.roots.flatMap(root => {
    // the viewer's own highlights are local; library members' stay server-owned and read-only.
    if (root.content.kind === "Highlight" && root.content.is_owner) return [];
    const facts = root.direct_facts.filter(fact => !AUTHORED_ORIGINS.has(fact.origin));
    if (root.content.kind === "Resource" && facts.length === 0) return [];
    let resolution = root.resolution;
    if (resolution?.kind === "Resolved") {
      const locator = resolution.anchor.locator;
      const unit = "fragment_id" in locator && doc?.kind === "text" ? doc.units.find(unit => unit.id === locator.fragment_id) : null;
      const mounted = doc !== null && doc.identity === wire.identity && ("fragment_id" in locator
        ? unit && "end_offset" in locator && localPoint(doc, { unit: unit.id, offset: locator.end_offset }) !== null : true);
      if (!mounted || !rootExtent(resolution, doc)) resolution = { kind: "Unavailable", reason: "Unanchorable" };
    }
    return [{ ...root, resolution, direct_facts: facts, continuation: null, authored_placement: null, source }];
  });
}

async function readAll(store: AuthoredStore, query: (cursor: string | null) => AuthoredQuery): Promise<QueryResult["rows"]> {
  const rows: QueryResult["rows"] = [];
  for (let cursor: string | null = null; ;) {
    const page: QueryResult = await store.query(query(cursor));
    rows.push(...page.rows);
    if (page.next_cursor === null) return rows;
    cursor = page.next_cursor;
  }
}

export function createMediaAnnotations(store: AuthoredStore, mediaId: string) {
  const sourceRef = `media:${mediaId}`;
  const local = createReaderAnnotations(store, mediaId);
  const listeners = new Set<() => void>();
  let doc: ReaderDocument | null = null;
  let bound = false;
  let wire: WireDocumentMap | null = null;
  let links: MediaAnnotationsState["links"] = { status: "loading" };
  let remote: MediaAnnotationsState["remote"] = { status: "loading" };
  let state: MediaAnnotationsState = { local: local.getState(), links, remote, decorations: { identity: "", marks: [], noteRefs: [] }, markers: [] };
  let controller = new AbortController();
  let stops: (() => void)[] = [];
  let linkReads = 0;

  function project(remoteReadSucceeded = false) {
    const roots = wire ? remoteRoots(wire, doc) : [];
    if (wire && (remoteReadSucceeded || remote.status !== "failed")) remote = { status: "ready", data: { ...wire, evidence: { ...wire.evidence, roots, counts: rootCounts(roots) } } };
    const localState = local.getState();
    const noteRefs: NoteRef[] = [];
    const markers: RailMarker[] = [];
    const shared: Mark[] = [];
    if (doc) {
      const structure = structureOf(doc, null);
      const at = (anchor: MarkAnchor, end: boolean) => anchor.kind === "text"
        ? structure.fraction({ kind: "text", unit: anchor.unit, offset: end ? anchor.end : anchor.start })
        : structure.fraction({ kind: "pdf", page: anchor.page, y: (end ? Math.max : Math.min)(...anchor.quads.flatMap(quad => [quad.y1, quad.y3])) });
      for (const annotation of localState.annotations) if (annotation.placement.kind === "placed")
        markers.push({ id: annotation.id, position: at(annotation.placement.anchor, false), end: at(annotation.placement.anchor, true),
          tone: "Highlight", label: "highlight", preview: annotation.selection.quote_exact });
      for (const root of roots) {
        const extent = root.resolution?.kind === "Resolved" ? rootExtent(root.resolution, doc) : null;
        if (!extent) continue;
        if (root.content.kind === "Highlight") shared.push({ id: root.content.highlight_id, color: root.content.color, anchor: extent.anchor });
        if (root.content.kind === "SourceReference" && extent.anchor.kind === "text") {
          const { unit, start, end } = extent.anchor;
          noteRefs.push({ key: root.content.stable_key, unit, start, end });
        }
        const item = rootItem(root), body = item.preview.body, facet = markerFacet(root);
        markers.push({ id: root.ref, position: structure.fraction(extent.start), end: structure.fraction(extent.end),
          tone: facet === "highlights" ? "Highlight" : facet === "citations" ? "Citation" : facet === "links" ? "Link" : "MachineLink", label: item.label,
          preview: body.kind === "passage" ? body.exact.text : body.kind === "prose" ? body.excerpt.text : null });
      }
      if (wire && wire.identity === doc.identity) markers.push(...wire.markers.filter(marker => marker.item_id.startsWith("embed:")).map(marker => ({
        id: marker.item_id, position: marker.position, end: marker.end_position, tone: marker.tone, label: marker.label, preview: marker.preview })));
      markers.sort((a, b) => a.position - b.position);
    }
    state = { local: localState, links, remote, decorations: { identity: doc?.identity ?? "", marks: [...localState.marks, ...shared], noteRefs }, markers };
    for (const listener of listeners) listener();
  }

  async function readRemote() {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    if (remote.status === "failed") { remote = { ...remote, retrying: true }; project(); }
    try {
      const { data } = await apiFetch<ApiJson<"/media/{media_id}/document-map", "get">>(`/api/media/${mediaId}/document-map`, { signal });
      if (signal.aborted) return;
      wire = data;
      project(true);
    } catch (error) {
      if (signal.aborted || handleUnauthenticatedApiError(error)) return;
      remote = { status: "failed", error, retrying: false };
      project();
    }
  }

  async function readLinks() {
    const read = ++linkReads;
    try {
      const [adjacent, referencing] = await Promise.all([
        readAll(store, cursor => ({ kind: "adjacency", ref: sourceRef, cursor, limit: PAGE })),
        readAll(store, cursor => ({ kind: "backlinks", ref: sourceRef, cursor, limit: PAGE })),
      ]);
      if (read !== linkReads) return;
      const linked = adjacent.flatMap(({ resource, link }) => link && resource.source_ref !== sourceRef ? [{ resource, link }] : []);
      const seen = new Set(linked.map(entry => entry.resource.ref));
      links = { status: "ready", data: [...linked, ...referencing.flatMap(({ resource }) => seen.has(resource.ref) ? [] : [{ resource, link: null }])] };
    } catch (error) {
      if (read !== linkReads) return;
      links = { status: "failed", error, retrying: false };
    }
    project();
  }

  return {
    /** null: this device cannot show the source; local annotations still list. */
    bind(next: ReaderDocument | null) {
      if (bound && next === doc) return;
      const reread = !bound || next?.identity !== doc?.identity;
      bound = true;
      doc = next;
      local.bind(next);
      if (listeners.size && reread && next !== null) void readRemote();
      project();
    },
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stops = [
          local.subscribe(project),
          store.annotations_changed(() => { if (doc !== null) void readRemote(); }),
          store.subscribe({ kind: "adjacency", ref: sourceRef, cursor: null, limit: 1 }, () => void readLinks()),
          store.subscribe({ kind: "backlinks", ref: sourceRef, cursor: null, limit: 1 }, () => void readLinks()),
        ];
        if (doc !== null) void readRemote();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        for (const stop of stops) stop();
        stops = [];
        controller.abort();
        linkReads++;
      };
    },
    refresh() {
      local.retry();
      void readLinks();
      if (doc !== null) void readRemote();
    },
    annotation: (id: string): ReaderAnnotation | null => local.annotation(id),
  };
}
export type MediaAnnotations = ReturnType<typeof createMediaAnnotations>;
