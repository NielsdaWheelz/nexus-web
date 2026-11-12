"use client";
import { excerptTextParts } from "@nexus/authored/excerpt";

// The media pane's annotations. Highlights, their annotations and the media's
// whole-document links are local authored state: the account database owns them online
// too, and they never wait on the network. The server's document map remains a separate,
// separately failable section of derived evidence: source references, embeds and
// quoted messages and assistant links. Mounted X owners are read separately and their offsets enter only
// occurrences at that publication generation. Authored echoes never replace local rows.
// Restored admission retries mounted remote evidence under its original account binding.
// A failed re-read over a shown section says nothing: the section stands until a read lands.
import { apiFetch, captureApiAccount, isCurrentApiAccount } from "@/lib/api/client";
import { changeStamp } from "@/lib/api/changes";
import { requestWithRetry } from "@/lib/api/retry";
import { remoteReady, subscribeAdmission } from "@/lib/native/admission";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { AuthoredQuery, AuthoredStore, LinkState, QueryResult, ResourceProjection } from "@nexus/authored/types";
import type { RailMarker } from "@/lib/documentReader/chrome/MapRail";
import { createReaderAnnotations, sourceUnits, type AnnotationsState, type ReaderAnnotation } from "@/lib/documentReader/annotations";
import type { Decorations, Mark, MarkAnchor, NoteRef } from "@/lib/documentReader/DocumentReader";
import { localPoint, structureOf, type ReaderDocument } from "@/lib/documentReader/model";
import { localResourceLabel } from "@/lib/resources/localResource";
import { evidenceRootKey, markerFacet, rootCounts, rootExtent, rootItem, type EvidenceRoot } from "./evidence/model";

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
  readonly remoteRead: { readonly failed: boolean; readonly running: boolean };
  readonly decorations: Pick<Decorations, "identity" | "marks" | "noteRefs">;
  readonly markers: readonly RailMarker[];
}

/** Server facts whose authority is now the local authored graph. */
const AUTHORED_ORIGINS = new Set<Schema<"ReaderDirectFactOut">["origin"]>(["user", "note_body"]);
const PAGE = 100;

/** Remote roots keep source identity; only proven mounted occurrences receive placement. */
function remoteRoots(wire: WireDocumentMap, doc: ReaderDocument | null, mediaId: string): EvidenceRoot[] {
  const source = { media_id: wire.media_id, identity: wire.identity, apparatus_source: wire.evidence.apparatus_source };
  return wire.evidence.roots.flatMap(root => {
    if (root.content.kind === "Highlight" && root.content.is_owner) return [];
    const facts = root.direct_facts.filter(fact => !AUTHORED_ORIGINS.has(fact.origin));
    if (root.content.kind === "Resource" && facts.length === 0) return [];
    const original = root.resolution;
    let resolutions: EvidenceRoot["resolution"][] = [original];
    if (original?.kind === "Resolved") {
      const locator = original.anchor.locator;
      if (locator.type === "x_capture_offsets") {
        const mounted = doc?.kind === "text" ? doc.units.filter(unit => unit.xPost?.owner?.capture_id === locator.capture_id && unit.xPost.owner.fragment_id === locator.fragment_id) : [];
        resolutions = mounted.length ? mounted.map(unit => ({ ...original, anchor: { ...original.anchor, locator: { ...locator, fragment_id: unit.id } } }))
          : [{ kind: "Unavailable", reason: "Unanchorable" }];
      } else if (wire.media_id !== mediaId) {
        const mounted = doc?.kind === "text" && "fragment_id" in locator && "start_offset" in locator && "end_offset" in locator
          ? sourceUnits(doc, mediaId, wire.media_id).filter(entry => wire.publication_generation !== null &&
              entry.generation === wire.publication_generation && entry.fragment === locator.fragment_id &&
              locator.start_offset >= entry.unit.sourceStartOffset && locator.end_offset <= entry.unit.sourceStartOffset + entry.unit.length)
          : [];
        resolutions = mounted.length && "fragment_id" in locator
          ? mounted.map(({unit}) => ({ ...original, anchor: { ...original.anchor, locator: { ...locator, fragment_id: unit.id } } }))
          : [{ kind: "Unavailable", reason: "Unanchorable" }];
      } else {
        const unit = "fragment_id" in locator && doc?.kind === "text" ? doc.units.find(unit => unit.id === locator.fragment_id) : null;
        const mounted = doc !== null && doc.identity === wire.identity && ("fragment_id" in locator
          ? unit && "end_offset" in locator && localPoint(doc, { unit: unit.id, offset: locator.end_offset }) !== null : true);
        if (!mounted) resolutions = [{ kind: "Unavailable", reason: "Unanchorable" }];
      }
    }
    return resolutions.map(resolution => ({ ...root,
      resolution: resolution?.kind === "Resolved" && (doc === null || !rootExtent(resolution, doc))
        ? { kind: "Unavailable" as const, reason: "Unanchorable" as const } : resolution,
      direct_facts: facts, continuation: null, authored_placement: null, source,
    }));
  });
}

/** A canonical row keeps one coherent source/content/placement; facts dedupe by
 * edge identity. Decoration occurrences are projected before this row selection. */
function mergeRemoteRoots(occurrences: readonly EvidenceRoot[]): EvidenceRoot[] {
  const roots = new Map<string, EvidenceRoot>(), ranks = new Map<string, number>();
  for (const incoming of occurrences) {
    const key = evidenceRootKey(incoming);
    const rank = incoming.resolution?.kind === "Resolved" ? incoming.content.kind === "Resource" ? 2 : 3 : incoming.resolution ? 1 : 0;
    const previous = roots.get(key);
    if (!previous) { roots.set(key, incoming); ranks.set(key, rank); continue; }
    const preferred = previous.content.kind === "Resource" && incoming.content.kind !== "Resource" ? incoming
      : previous.content.kind !== "Resource" && incoming.content.kind === "Resource" ? previous
      : rank > ranks.get(key)! ? incoming : previous;
    const facts = new Map([...previous.direct_facts, ...incoming.direct_facts].map(fact => [fact.edge_id, fact]));
    roots.set(key, { ...preferred, direct_facts: [...facts.values()] });
    ranks.set(key, Math.max(rank, ranks.get(key)!));
  }
  return [...roots.values()];
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
  const account = captureApiAccount();
  const sourceRef = `media:${mediaId}`;
  const local = createReaderAnnotations(store, mediaId);
  const listeners = new Set<() => void>();
  let doc: ReaderDocument | null = null;
  let bound = false;
  let wires: WireDocumentMap[] = [];
  let links: MediaAnnotationsState["links"] = { status: "loading" };
  let remote: MediaAnnotationsState["remote"] = { status: "loading" };
  let remoteFailed = false;
  let remoteReading = false;
  let chatStamp = changeStamp("Chats");
  let state: MediaAnnotationsState = { remoteRead: { failed: false, running: true }, local: local.getState(), links, remote, decorations: { identity: "", marks: [], noteRefs: [] }, markers: [] };
  let controller = new AbortController();
  let stops: (() => void)[] = [];
  let linkReads = 0;

  function remoteMediaIds(_mounted: ReaderDocument): string[] {
    return [mediaId];
  }

  function project(remoteReadSucceeded = false) {
    const wire = wires.find(wire => wire.media_id === mediaId);
    const occurrences = wires.flatMap(wire => remoteRoots(wire, doc, mediaId));
    const roots = mergeRemoteRoots(occurrences);
    if (wire && (remoteReadSucceeded || remote.status !== "failed")) remote = { status: "ready", data: { ...wire,
      status: wires.some(wire => wire.status === "partial") ? "partial" : roots.length || wire.embeds.length ? "ready" : wire.status,
      evidence: { ...wire.evidence, roots, counts: rootCounts(roots) } } };
    const localState = local.getState();
    const noteRefs: NoteRef[] = [];
    const markers: RailMarker[] = [];
    const shared: Mark[] = [];
    if (doc) {
      const structure = structureOf(doc, null);
      const at = (anchor: MarkAnchor, end: boolean) => anchor.kind === "text"
        ? structure.fraction({ kind: "text", unit: anchor.unit, offset: end ? anchor.end : anchor.start })
        : structure.fraction({ kind: "pdf", page: anchor.page, y: 0 });
      for (const annotation of localState.annotations) if (annotation.placement.kind === "placed")
        markers.push({ id: annotation.id, position: at(annotation.placement.anchor, false), end: at(annotation.placement.anchor, true),
          kind: "Highlight", tone: "Highlight", label: "highlight", preview: localResourceLabel(annotation.projection) });
      for (const root of occurrences) {
        const extent = root.resolution?.kind === "Resolved" ? rootExtent(root.resolution, doc) : null;
        if (!extent) continue;
        if (root.content.kind === "Highlight") shared.push({ id: root.content.highlight_id, color: root.content.color, anchor: extent.anchor });
        if (root.content.kind === "SourceReference" && extent.anchor.kind === "text") {
          const { unit, start, end } = extent.anchor;
          noteRefs.push({ key: root.content.stable_key, unit, start, end });
        }
      }
      for (const root of roots) {
        const key = evidenceRootKey(root);
        const extent = root.resolution?.kind === "Resolved" ? rootExtent(root.resolution, doc) : null;
        if (!extent || extent.kind === "pdf") {
          const marker = wire?.identity === doc.identity ? wire.markers.find(item => item.item_id === key && (extent !== null || item.kind === "GeneratedCitation")) : null;
          if (marker) markers.push({ id: marker.item_id, position: marker.position, end: marker.end_position,
            kind: marker.kind, tone: marker.tone, label: marker.label, preview: marker.preview });
          continue;
        }
        const item = rootItem(root), facet = markerFacet(root);
        const body = item.preview.body;
        markers.push({ id: key, position: structure.fraction(extent.start), end: structure.fraction(extent.end),
          kind: root.content.kind === "Highlight" || root.content.kind === "SourceReference" ? root.content.kind
            : facet === "citations" ? "GeneratedCitation" : facet === "links" ? "Link" : "MachineLink",
          tone: facet === "highlights" ? "Highlight" : facet === "citations" ? "Citation" : facet === "links" ? "Link" : "MachineLink", label: item.label,
          preview: body.kind === "passage" ? (body.excerpt.kind === "content" ? excerptTextParts(body.excerpt.body).exact : "table excerpt") : body.kind === "prose" ? body.excerpt.text : null });
      }
      if (wire && wire.identity === doc.identity) markers.push(...wire.markers.filter(marker => marker.item_id.startsWith("embed:")).map(marker => ({
        id: marker.item_id, position: marker.position, end: marker.end_position, kind: marker.kind, tone: marker.tone, label: marker.label, preview: marker.preview })));
      markers.sort((a, b) => a.position - b.position);
    }
    state = { remoteRead: { failed: remoteFailed, running: remoteReading }, local: localState, links, remote, decorations: { identity: doc?.identity ?? "", marks: [...localState.marks, ...shared], noteRefs }, markers };
    for (const listener of listeners) listener();
  }

  async function readRemote() {
    if (!isCurrentApiAccount(account)) return;
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal, mounted = doc;
    if (mounted === null) return;
    remoteReading = true;
    if (remote.status === "failed") remote = { ...remote, retrying: true };
    project();
    try {
      const primaryCaptures = new Set(mounted.kind === "text" ? mounted.units.flatMap(unit => unit.xPost?.owner && unit.xPost.relation === "primary" ? [unit.xPost.owner.capture_id] : []) : []);
      const captureIds = mounted.kind === "text" ? [...new Set(mounted.units.flatMap(unit => unit.xPost?.owner && (unit.xPost.relation === "primary" || unit.xPost.relation === "embedded") ? [unit.xPost.owner.capture_id] : []))] : [];
      const [mediaMaps, captureMaps] = await Promise.all([
        Promise.all(remoteMediaIds(mounted).map(async id => {
          const { data } = await requestWithRetry(attempt => apiFetch<ApiJson<"/media/{media_id}/document-map", "get">>(`/api/media/${id}/document-map`, { signal: attempt }), signal);
          return data;
        })),
        Promise.all(captureIds.map(async id => {
          const { data } = await requestWithRetry(attempt => apiFetch<ApiJson<"/x/captures/{capture_id}/document-map", "get">>(`/api/x/captures/${id}/document-map`, { signal: attempt }), signal);
          // An embedded post's annotations belong here; its own citations do not.
          const roots = primaryCaptures.has(id) ? data.evidence.roots : data.evidence.roots.flatMap(root => {
            const direct_facts = root.direct_facts.filter(fact => fact.origin !== "citation" || fact.ordinal === null);
            return root.content.kind === "Resource" && direct_facts.length === 0 ? [] : [{ ...root, direct_facts }];
          });
          return { ...data, evidence: { ...data.evidence, roots }, media_id: mediaId, identity: mounted.identity };
        })),
      ]);
      const next = [...mediaMaps, ...captureMaps];
      if (signal.aborted || doc !== mounted || !isCurrentApiAccount(account)) return;
      wires = next;
      remoteFailed = false;
      project(true);
    } catch (error) {
      if (signal.aborted || doc !== mounted || !isCurrentApiAccount(account)) return;
      handleUnauthenticatedApiError(error);
      controller.abort();
      remoteFailed = true;
      if (remote.status !== "ready") remote = { status: "failed", error, retrying: false };
    } finally {
      if (controller.signal === signal && doc === mounted && isCurrentApiAccount(account)) {
        remoteReading = false;
        project();
      }
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
      if (read !== linkReads || links.status === "ready") return;
      links = { status: "failed", error, retrying: false };
    }
    project();
  }

  return {
    /** null: this device cannot show the source; local annotations still list. */
    bind(next: ReaderDocument | null) {
      if (bound && next === doc) return;
      controller.abort();
      bound = true;
      doc = next;
      local.bind(next);
      if (next !== null) {
        const wanted = new Set(remoteMediaIds(next));
        wires = wires.filter(wire => wanted.has(wire.media_id));
        if (listeners.size) void readRemote();
      }
      project();
    },
    getState: () => state,
    invalidateChats(stamp: string) {
      const changed = chatStamp !== stamp;
      chatStamp = stamp;
      if (changed && doc !== null && listeners.size) void readRemote();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stops = [
          local.subscribe(project),
          subscribeAdmission(() => { if (remoteReady() && doc !== null && isCurrentApiAccount(account)) void readRemote(); }),
          store.evidence_changed(() => { if (doc !== null) void readRemote(); }),
          store.subscribe({ kind: "adjacency", ref: sourceRef, cursor: null, limit: 1 }, () => void readLinks(), reportError),
          store.subscribe({ kind: "backlinks", ref: sourceRef, cursor: null, limit: 1 }, () => void readLinks(), reportError),
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
