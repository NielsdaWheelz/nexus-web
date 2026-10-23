"use client";
// One fetch-free editing session per surface over the tab's canonical graph/texts
// and sole write queue. Occurrence prefixes own view/history; edge paths own facts.
// Captured placements advance only through acknowledged queue proof; retries reuse
// sealed bytes. Refused writes retain drafts and report to the originating scope.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  useFeedback,
} from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import {
  ApiError,
  isApiError,
} from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  bodyHasContent,
  docFromBody,
  emptyBody,
  parseBody,
  sameBody,
  type NoteBody,
} from "./noteBody";
import * as model from "./outline";
import * as store from "./texts";
import { admitWriting, captureLane, readDraft, readWriting, subscribeWritingBindings, type AuthoredSnapshot, type LaneDependency, type WritingAck, type WritingCommand, type WritingPosition, type Publication, type RestoreNoteProof, type ReferenceConsumption } from "./journal";
import {
  isDeletedResource,
  subscribeLinkMutations,
  endpointForResource,
  type Position,
  type InsertionSource,
  type WritingInsertion,
  insertionTarget,
} from "@/lib/resourceGraph/links";
import { queueReferenceInsertion } from "@/lib/resourceGraph/useReferenceInput";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import {
  captureResourceOutlineRead,
  isResourceOutlineReadCurrent,
  invalidateResourceOutlines,
  type ResourceOutlineRead,
} from "@/lib/resourceGraph/useResourceOutline";
import type { ResourceItem } from "@/lib/resources/items";
import type {
  OutlineBranch,
  OutlineTarget,
} from "@/lib/resources/outlineProjection";
import { enterOutlineOccurrence } from "@/lib/resources/outlineProjection";
type Reply = WritingAck;
type Admission = { intent_id: string; draft_id: string | null };
type Restore = Extract<WritingCommand, { kind: "restore_note" }>["removed_by"];
/** Exact pending deletion owners retain their own inverse; foreign histories expire. */
const historyDeletionOwners = new Map<string, Set<Item>>();
function holdHistoryDeletions(item: Item | null, keys: readonly string[], owned: WeakSet<Item>): (ack?: Reply) => void {
  if (item === null) return () => undefined;
  owned.add(item);
  for (const key of keys) {
    let owners = historyDeletionOwners.get(key);
    if (!owners) { owners = new Set(); historyDeletionOwners.set(key, owners); }
    owners.add(item);
  }
  return (ack) => {
    const awaiting = ack ? new Set([...ack.removed_link_ids.map(id => `link:${id}`), ...ack.deleted_refs]) : null;
    for (const key of keys) {
      if (awaiting?.has(key)) continue;
      const owners = historyDeletionOwners.get(key);
      owners?.delete(item);
      if (owners?.size === 0) historyDeletionOwners.delete(key);
    }
  };
}
function removalProofs(refs: Iterable<string>, reply: Reply): ReadonlyMap<string, RestoreNoteProof> {
  const proofs = new Map<string, RestoreNoteProof>();
  for (const ref of refs) {
    if (!ref.startsWith("note_block:")) continue;
    const original_note_id = model.noteIdOf(ref);
    if (reply.deleted_refs.includes(ref)) proofs.set(original_note_id, { kind: "observed", original_note_id, outcome: { kind: "deleted" } });
    else {
      const note = reply.notes.find(note => note.id === original_note_id);
      if (note) proofs.set(original_note_id, { kind: "observed", original_note_id,
        outcome: { kind: "retained", note: { id: note.id, body_pm_json: note.body_pm_json, body_version: note.body_version } } });
    }
  }
  return proofs;
}
function remapKey(key: string, refs: ReadonlyMap<string, string>, edges: ReadonlyMap<string, string>): string {
  return key.split("/").map(part => refs.get(part) ?? edges.get(part) ?? part).join("/");
}
function remapEdit(edit: model.Edit, refs: ReadonlyMap<string, string>, edges: ReadonlyMap<string, string>): model.Edit {
  const ref = (value: string) => refs.get(value) ?? value;
  const edge = (value: string) => edges.get(value) ?? value;
  const position = (value: model.OutlinePosition | null): model.OutlinePosition | null => {
    if (value === null) return null;
    return value.expected_links_version === null ? { ...value, after: edge(value.after) } : { ...value, after: value.after === null ? null : edge(value.after) };
  };
  const source = (value: InsertionSource): InsertionSource => value.kind === "resource" ? { ...value, ref: ref(value.ref) } : value;
  switch (edit.kind) {
    case "set_body": return { ...edit, note_id: model.noteIdOf(ref(model.noteRef(edit.note_id))) };
    case "set_title": return edit;
    case "ensure_daily": return edit;
    case "insert_note": return { ...edit, endpoint: ref(edit.endpoint), source: source(edit.source), note_id: model.noteIdOf(ref(model.noteRef(edit.note_id))), link_id: edge(edit.link_id), position: position(edit.position) };
    case "insert_link": return { ...edit, endpoint: ref(edit.endpoint), source: source(edit.source), target: ref(edit.target), link_id: edge(edit.link_id), position: position(edit.position) };
    case "move": return { ...edit, endpoint: ref(edit.endpoint), link_id: edge(edit.link_id), after: edit.after === null ? null : edge(edit.after) };
    case "relink": return { ...edit, endpoint: ref(edit.endpoint), destination: ref(edit.destination), link_id: edge(edit.link_id), new_link_id: edge(edit.new_link_id), position: position(edit.position) };
    case "remove": case "consume_note": return { ...edit, endpoint: ref(edit.endpoint), link_id: edge(edit.link_id) };
  }
}
function remapResource(item: ResourceItem, refs: ReadonlyMap<string, string>): ResourceItem {
  const ref = refs.get(item.ref);
  if (!ref) return item;
  return { ...item, ref, action_ref: refs.get(item.action_ref) ?? item.action_ref,
    activation: { ...item.activation, resource_ref: ref, href: ref.startsWith("note_block:") ? `/notes/${model.noteIdOf(ref)}` : item.activation.href } };
}
function remapGraph(refs: ReadonlyMap<string, string>, edges: ReadonlyMap<string, string>): void {
  for (const [ref, outline] of [...graph]) {
    const targetRef = refs.get(ref) ?? ref;
    const source = { ...outline.source, item: remapResource(outline.source.item, refs) };
    const links = outline.links.map(link => ({ ...link, link_id: edges.get(link.link_id) ?? link.link_id, target: { ...link.target, item: remapResource(link.target.item, refs) } }));
    if (targetRef !== ref) graph.delete(ref);
    const canonical = targetRef !== ref ? graph.get(targetRef) : undefined;
    graph.set(targetRef, canonical ? { ...canonical, links: [...canonical.links, ...links.filter(link => !canonical.links.some(existing => existing.link_id === link.link_id))] } : { ...outline, source, links });
  }
  for (const pending of pendingOccurrences.values()) {
    pending.ref = refs.get(pending.ref) ?? pending.ref;
    pending.sourceRef = refs.get(pending.sourceRef) ?? pending.sourceRef;
    pending.item = remapResource(pending.item, refs);
  }
}

// A source edge introduced by an earlier queued intent supplies its own receipt
// fence. Keeping that cell live does not change the bytes once the head is sealed.
type CapturedLinksVersion = number | (Admission & { version: number });
const graph: model.Graph = new Map();
const latest = new Map<string, model.OutlineData>();
const insertionCapabilities = new Map<string, InsertionSource | null>();
const reviewedRefs = new Set<string>();
/** A surface may undo only its own uninterrupted title/body history. */
const textHistoryOwners = new Map<string, string>();
type Invalidation =
  | {
      kind: "resources";
      refs: ReadonlySet<string>;
    }
  | {
      kind: "refused";
      refs: ReadonlySet<string>;
      texts: ReadonlySet<string>;
    }
  | {
      kind: "links";
      ids: ReadonlySet<string>;
      preserve: Item | null;
    };
const listeners = new Set<(invalidated: Invalidation | null) => void>();
const pendingUnlinks = new Set<string>();
/** The texts and resource dependencies of each unsettled structure write. */
const carried = new Map<
  number,
  {
    texts: ReadonlySet<string>;
    refs: ReadonlySet<string>;
  }
>();
function hasCarriedStructure(ref: string): boolean {
  return [...carried.values()].some((entry) => entry.refs.has(ref));
}
let observingLinks = false;
let jobSerial = 0;
export interface PendingOccurrence {
  key: string;
  ref: string;
  edgeId: string;
  sourceRef: string;
  item: ResourceItem;
  body: NoteBody | null;
  position: model.OutlinePosition | null;
  acknowledged: boolean;
}
type PendingRemoval = { sourceRef: string; generation: number | null };
type PendingRecord = PendingOccurrence & {
  generation: number | null;
  originSourceRef?: string;
  adjacencyReadAcknowledged?: boolean;
  proof?: model.PendingPositionProof;
  authoredPosition?: {
    after: string | null;
    linksVersion: number;
  };
};
const pendingRemovals = new Map<string, PendingRemoval>();
const pendingOccurrences = new Map<string, PendingRecord>();
/** Existing loaded outlines own the dirty evidence used when a pane loses its root. */
export function outlineTextRefs(ref: string): string[] {
  const refs = new Set<string>();
  const pending = [ref];
  while (pending.length) {
    const current = pending.pop()!;
    if (refs.has(current)) continue;
    refs.add(current);
    for (const link of graph.get(current)?.links ?? [])
      pending.push(link.target.item.ref);
  }
  return [...refs];
}
export const hasUnsavedOutline = (ref: string): boolean =>
  outlineTextRefs(ref).some(store.hasUnsavedText);
function publish(invalidated: Invalidation | null = null) {
  const defects: unknown[] = [];
  for (const listener of listeners) {
    try {
      listener(invalidated);
    } catch (error) {
      defects.push(error);
    }
  }
  if (defects.length)
    queueMicrotask(() => {
      throw new AggregateError(defects, "outline observers failed");
    });
}
/** Snapshot endpoints before removal, including an unloaded reverse endpoint. */
function linkedEndpoints(ids: ReadonlySet<string>): Set<string> {
  const endpoints = new Set<string>();
  for (const entries of [graph, latest]) {
    for (const [ref, outline] of entries) {
      for (const link of outline.links) {
        if (!ids.has(link.link_id)) continue;
        endpoints.add(ref);
        endpoints.add(link.target.item.ref);
      }
    }
  }
  return endpoints;
}
/** An acknowledged edge removal invalidates old reads and their retained replies. */
function dropLinks(ids: ReadonlySet<string>, endpoints: ReadonlySet<string>) {
  invalidateResourceOutlines(endpoints);
  for (const ref of endpoints) reviewedRefs.delete(ref);
  for (const entries of [graph, latest]) {
    for (const [ref, outline] of entries) {
      if (outline.links.some((link) => ids.has(link.link_id)))
        entries.set(ref, {
          ...outline,
          links: outline.links.filter((link) => !ids.has(link.link_id)),
        });
    }
  }
}
function liveOutline(outline: model.OutlineData): model.OutlineData | null {
  if (isDeletedResource(outline.source.item.ref)) return null;
  return {
    ...outline,
    links: outline.links.filter(
      (link) =>
        !isDeletedResource(link.target.item.ref) ||
        store.hasUnsavedText(link.target.item.ref),
    ),
  };
}
/** The retained graph outlives its panes, so its invalidation subscription does too. */
function observeLinks() {
  if (observingLinks) return;
  observingLinks = true;
  subscribeLinkMutations((mutation) => {
    if (mutation.kind === "resource_deleted") {
      store.setGone(mutation.ref);
      for (const [id, pending] of pendingOccurrences)
        if (pending.ref === mutation.ref || pending.sourceRef === mutation.ref)
          pendingOccurrences.delete(id);
      for (const entries of [graph, latest]) {
        for (const [ref, outline] of entries) {
          const live = liveOutline(outline);
          if (live) entries.set(ref, live);
          else if (entries !== graph || !hasUnsavedOutline(ref))
            entries.delete(ref);
        }
      }
      publish({ kind: "resources", refs: new Set([mutation.ref]) });
      historyDeletionOwners.delete(mutation.ref);
      return;
    }
    if (mutation.kind === "deleted") {
      if (mutation.origin === graph) return;
      const ids = new Set([mutation.linkId]);
      const endpoints = linkedEndpoints(ids);
      dropLinks(ids, endpoints);
      publish({ kind: "links", ids, preserve: null });
      historyDeletionOwners.delete(`link:${mutation.linkId}`);
      return;
    }
    if (mutation.kind === "created" || mutation.kind === "context_detached")
      return;
    assertNever(mutation);
  });
}
function adopt(outline: model.OutlineData) {
  const live = liveOutline(outline);
  if (!live) {
    if (!hasUnsavedOutline(outline.source.item.ref))
      graph.delete(outline.source.item.ref);
    store.setGone(outline.source.item.ref);
    return;
  }
  const prior = graph.get(live.source.item.ref);
  // A daily envelope or an already-running branch read can finish after a newer
  // write reply. Older adjacency cannot remove acknowledged links or their undo.
  if (!prior || live.links_version >= prior.links_version) {
    const removed =
      prior && live.complete && !hasCarriedStructure(live.source.item.ref)
        ? new Set(
            prior.links
              .filter(
                (link) =>
                  !live.links.some((next) => next.link_id === link.link_id),
              )
              .map((link) => link.link_id),
          )
        : new Set<string>();
    graph.set(live.source.item.ref, live);
    reviewedRefs.add(live.source.item.ref);
    if (removed.size) publish({ kind: "links", ids: removed, preserve: null });
  }
  for (const node of [live.source, ...live.links.map((l) => l.target)]) {
    const body = bodyOf(node);
    if (body && node.content.kind === "note")
      store.adoptText(node.item.ref, body, node.content.body_version);
    else if (node.content.kind === "page")
      store.adoptText(
        node.item.ref,
        node.content.title,
        node.content.title_version,
      );
  }
}
function adoptBranch(
  source: model.OutlineNode,
  items: readonly Schema<"OutlineOccurrenceOut">[],
  version: number,
  complete: boolean,
  generation: number,
) {
  if (!isResourceOutlineReadCurrent(source.item.ref, generation)) return;
  const links = items.map(({ connection, content }) => ({
    link_id: connection.edge_id,
    target: { item: connection.other, content },
    connection,
  }));
  const outline = { source, links, links_version: version, complete };
  if (!hasCarriedStructure(source.item.ref)) adopt(outline);
  else latest.set(source.item.ref, outline);
  publish();
}
/** Hold each outline only while an unsettled structure write depends on its source. */
function receive(outlines: readonly model.WireOutline[]) {
  for (const wire of outlines) {
    const outline = model.projectOutline(wire);
    const live = liveOutline(outline);
    if (live) latest.set(live.source.item.ref, live);
    else latest.delete(outline.source.item.ref);
  }
  for (const [ref, outline] of latest) {
    if (hasCarriedStructure(ref)) continue;
    adopt(outline);
    latest.delete(ref);
  }
}
function bodyOf(node: model.OutlineNode): NoteBody | null {
  if (node.content.kind !== "note") return null;
  const { body_pm_json, body_text } = node.content;
  return { body_pm_json, body_text };
}
const textBody = (noteId: string): NoteBody => {
  const value = store.readText(model.noteRef(noteId))?.value;
  return typeof value === "object" ? value : emptyBody();
};
/** Capture link targets before an optimistic edit can remove or move them. */
function editReferences(edits: readonly model.Edit[]): Set<string> {
  const refs = new Set<string>();
  for (const edit of edits) {
    if (edit.kind === "set_body" || edit.kind === "insert_note")
      refs.add(model.noteRef(edit.note_id));
    if (edit.kind === "set_title") refs.add(`page:${edit.page_id}`);
    if (edit.kind === "insert_link") refs.add(edit.target);
    if (edit.kind === "relink") refs.add(edit.destination);
    if (!("endpoint" in edit)) continue;
    refs.add(edit.endpoint);
    const target = graph
      .get(edit.endpoint)
      ?.links.find((link) => link.link_id === edit.link_id)?.target.item.ref;
    if (target) refs.add(target);
    const after =
      "position" in edit
        ? (edit.position?.after ?? null)
        : "after" in edit
          ? edit.after
          : null;
    if (after !== null) {
      const endpoint =
        edit.kind === "relink" ? edit.destination : edit.endpoint;
      const preceding = graph
        .get(endpoint)
        ?.links.find((link) => link.link_id === after)?.target.item.ref;
      if (preceding) refs.add(preceding);
    }
  }
  return refs;
}
/** The single adapter from local structural intent to graph commands. */
function wireEdits(
  edits: readonly model.Edit[],
  checked: (ref: string, position?: model.OutlinePosition | null) => LaneDependency,
  removed: ReadonlyMap<string, string> = new Map(),
  bodyBases: Map<string, number | null> = new Map(),
  removalBodies: ReadonlyMap<string, NoteBody> = new Map(),
  restores: ReadonlyMap<string, Restore> = new Map(),
): WritingCommand[] {
  const position = (ref: string, captured: model.OutlinePosition | null): WritingPosition | null => {
    if (captured === null) return null;
    if (captured.expected_links_version === null) return {
      after: captured.after,
      predecessor: { kind: "insertion", ...captured.proof },
    };
    return { after: captured.after, expected_links_version: checked(ref, captured) };
  };
  return edits.map((edit): WritingCommand => {
    switch (edit.kind) {
      case "insert_note":
        if (restores.has(edit.note_id)) return {
          kind: "restore_note", removed_by: restores.get(edit.note_id)!, note_id: edit.note_id, link_id: edit.link_id,
          source: edit.source, body_pm_json: edit.body_pm_json, position: position(edit.endpoint, edit.position),
        };
        return {
          kind: "insert_note",
          link_id: edit.link_id,
          note_id: edit.note_id,
          source:
            edit.position?.expected_links_version === null
              ? { kind: "resource", ref: edit.position.proof.source_ref }
              : edit.source,
          body_pm_json: edit.body_pm_json,
          position: position(edit.endpoint, edit.position),
        };
      case "insert_link": {
        const target = endpointForResource(edit.target);
        if (target === null)
          throw new ApiError(
            400,
            "E_LINK_CAPABILITY",
            "this resource cannot be linked",
          );
        return {
          kind: "insert_link",
          require_created: edit.require_created,
          link_id: edit.link_id,
          source:
            edit.position?.expected_links_version === null
              ? { kind: "resource", ref: edit.position.proof.source_ref }
              : edit.source,
          target,
          position: position(edit.endpoint, edit.position),
        };
      }
      case "move":
        return {
          kind: "move",
          endpoint: edit.endpoint,
          edge_id: edit.link_id,
          after: edit.after,
          expected_links_version: checked(edit.endpoint),
        };
      case "relink":
        return {
          ...edit,
          position: position(edit.destination, edit.position),
          expected_source_links_version: checked(edit.endpoint),
        };
      case "set_body": {
        const ref = model.noteRef(edit.note_id);
        const base = store.readText(ref)?.acked?.version ?? null;
        bodyBases.set(ref, base);
        const expected_version = store.textDependency(ref, "body");
        if (expected_version === null) throw new ApiError(409, "E_RESOURCE_CONFLICT", "this note has no confirmed or pending body version");
        return { ...edit, expected_version };
      }
      case "set_title":
        {
        const expected_version = store.textDependency(`page:${edit.page_id}`, "title");
        if (expected_version === null) throw new ApiError(409, "E_RESOURCE_CONFLICT", "this page has no confirmed or pending title version");
        return { ...edit, expected_version };
      }
      case "consume_note":
      case "remove": {
        const note = removed.get(edit.link_id);
        const acknowledged = note ? store.readText(note)?.acked : null;
        const capturedBody = note ? removalBodies.get(note) : null;
        const sameAcknowledgedBody =
          capturedBody &&
          acknowledged &&
          typeof acknowledged.value !== "string" &&
          sameBody(capturedBody, acknowledged.value);
        const expected_body_version = sameAcknowledgedBody
          ? acknowledged.version
          : note
            ? (bodyBases.get(note) ?? null)
            : null;
        const expected = (note ? store.textDependency(note, "body") : null) ??
          (expected_body_version === null ? null : { kind: "observed" as const, ref: note!, lane: "body" as const, version: expected_body_version });
        if (edit.kind === "consume_note") {
          if (expected === null)
            throw new ApiError(
              409,
              "E_RESOURCE_CONFLICT",
              "the consumed note version is unavailable",
            );
          return { ...edit, kind: "consume_note", expected_links_version: checked(edit.endpoint), expected_body_version: expected };
        }
        return { ...edit, kind: "remove", expected_links_version: checked(edit.endpoint), expected_body_version: expected };
      }
      case "ensure_daily":
        return edit;
    }
  });
}
/**
 * Send one structure batch. Captured adjacency versions advance only through
 * acknowledged predecessor proof. Removed bodies retain their captured base;
 * `removed` names the note each remove's link pointed at.
 */
function sendEdits(
  edits: readonly model.Edit[],
  removed: ReadonlyMap<string, string>,
  texts: ReadonlySet<string>,
  refs: ReadonlySet<string>,
  captured: ReadonlyMap<string, CapturedLinksVersion> = new Map([...graph].map(([ref, value]) => [ref, value.links_version])),
  onRefused: (error: unknown) => void = () => undefined,
  bodyBases: Map<string, number | null> = new Map(),
  removalBodies: ReadonlyMap<string, NoteBody> = new Map(),
  onAcknowledged: (reply: Reply) => void = () => undefined,
  restores: ReadonlyMap<string, Restore> = new Map(),
  consumed_reference: ReferenceConsumption | null = null,
): { intent_id: string; draft_id: string | null } | null {
  const serial = ++jobSerial;
  carried.set(serial, { texts, refs });
  const release = () => carried.delete(serial);
  try {
    const checked = (ref: string, position?: model.OutlinePosition | null): LaneDependency => {
      if (position?.expected_links_version === null) return {
        kind: "result", intent_id: position.proof.intent_id, draft_id: position.proof.draft_id, ref, lane: "links", version: position.proof.version,
      };
      const observed = captured.get(ref) ?? position?.expected_links_version;
      if (typeof observed === "object" && observed !== null) return {
        kind: "result", intent_id: observed.intent_id, draft_id: observed.draft_id, ref, lane: "links", version: observed.version,
      };
      const minted = edits.some(edit => edit.kind === "insert_note" && model.noteRef(edit.note_id) === ref);
      const base = observed ?? (minted ? 1 : null);
      if (base === null) throw new ApiError(409, "E_RESOURCE_CONFLICT", "the insertion position is no longer loaded");
      return captureLane(ref, "links", base);
    };
    const commands = wireEdits(edits, checked, removed, bodyBases, removalBodies, restores);
    const admitted = admitWriting({ kind: "outline", commands }, Promise.all([...texts].map(store.snapshotText)), consumed_reference);
    void admitted.settled.then(reply => {
      release();
      acknowledge(reply, edits);
      onAcknowledged(reply);
      receive([]);
      publish();
    }, error => {
      release();
      handleUnauthenticatedApiError(error);
      onRefused(error);
      publish({ kind: "refused", refs, texts });
    });
    void admitted.durable.catch(() => publish());
    const anchor = [...texts].map(ref => store.textDraft(ref)?.draft_id).find(id => id !== undefined) ?? null;
    return { intent_id: admitted.intent_id, draft_id: anchor };
  } catch (error) {
    release();
    onRefused(error);
    publish({ kind: "refused", refs, texts });
    return null;
  }
}
/** Only carried body writes are acknowledged. Canonical nodes merely read or reused
 * by an insertion are adopted, preserving dirty drafts and opening unopened texts.
 * Deleted notes stop saving unless a later queued write recreates them. */
function acknowledge(reply: Reply, edits: readonly model.Edit[]) {
  const written = new Set(edits.flatMap(edit => edit.kind === "set_body" || edit.kind === "insert_note" ? [model.noteRef(edit.note_id)] : []));
  for (const note of reply.notes) {
    const ref = model.noteRef(note.id);
    const value = { body_pm_json: note.body_pm_json, body_text: note.body_text };
    if (written.has(ref)) store.acknowledgeText(ref, value, note.body_version);
    else store.adoptText(ref, value, note.body_version);
  }
  for (const page of reply.pages) store.adoptText(`page:${page.id}`, page.title, page.title_version);
}
function retirePendingOccurrences({
  endpoint,
  edgeIds,
  generation,
  complete,
}: {
  endpoint: string;
  edgeIds: ReadonlySet<string>;
  generation: number;
  complete: boolean;
}) {
  if (!complete) return;
  let changed = false;
  for (const [id, pending] of pendingOccurrences)
    if (
      pending.sourceRef === endpoint &&
      pending.acknowledged &&
      pending.generation !== null &&
      generation >= pending.generation &&
      edgeIds.has(id)
    ) {
      pending.adjacencyReadAcknowledged = true;
      if (
        pending.originSourceRef !== undefined &&
        pending.originSourceRef !== pending.sourceRef
      )
        continue;
      pendingOccurrences.delete(id);
      changed = true;
    }
  for (const [id, pending] of pendingRemovals)
    if (
      pending.sourceRef === endpoint &&
      pending.generation !== null &&
      generation >= pending.generation &&
      !edgeIds.has(id)
    ) {
      pendingRemovals.delete(id);
      changed = true;
    }
  if (changed) publish();
}
function adoptReadEvidence(
  read: Pick<
    ResourceOutlineRead,
    | "source"
    | "items"
    | "version"
    | "complete"
    | "generation"
    | "status"
    | "insertionSource"
  >,
) {
  if (
    read.source === null ||
    read.version === null ||
    !isResourceOutlineReadCurrent(read.source.item.ref, read.generation)
  )
    return;
  insertionCapabilities.set(read.source.item.ref, read.insertionSource);
  // A materialized owner stays projected until the original candidate's own
  // post-ack read exposes that owner. Its exact connections remain separate.
  let aliasesRetired = false;
  if (read.status === "ready" && read.insertionSource?.kind === "resource")
    for (const [id, pending] of pendingOccurrences) {
      if (
        pending.originSourceRef !== read.source.item.ref ||
        pending.sourceRef === pending.originSourceRef ||
        pending.sourceRef !== read.insertionSource.ref ||
        !pending.acknowledged ||
        pending.generation === null ||
        read.generation < pending.generation
      )
        continue;
      delete pending.originSourceRef;
      if (pending.adjacencyReadAcknowledged) {
        pendingOccurrences.delete(id);
        aliasesRetired = true;
      }
    }
  adoptBranch(
    read.source,
    read.items,
    read.version,
    read.complete,
    read.generation,
  );
  if (aliasesRetired) publish();
  if (read.status === "ready" && read.complete)
    retirePendingOccurrences({
      endpoint: read.source.item.ref,
      edgeIds: new Set(read.items.map((item) => item.connection.edge_id)),
      generation: read.generation,
      complete: true,
    });
}
/** A latent day is a frozen creation capability, never a canonical page/version. */
export function openLatentDaily(outline: model.WireOutline): void {
  const ref = outline.source.item.ref;
  if (graph.has(ref)) return;
  graph.set(ref, { source: outline.source, links: [], links_version: outline.links_version, complete: true });
  if (outline.source.content.kind === "page") store.adoptText(ref, outline.source.content.title, null);
  reviewedRefs.add(ref);
  publish();
}
export interface PageCreation {
  page_id: string;
  note_id: string;
  link_id: string;
  title: string;
}
export function pagePublication(creation: PageCreation): Extract<Publication, { kind: "page" }> {
  const title = store.readText(`page:${creation.page_id}`)?.value;
  return { kind: "page", request: {
    id: creation.page_id, title: typeof title === "string" && title.trim() ? title : "untitled",
    initial_item: { kind: "note", note_id: creation.note_id, link_id: creation.link_id, body_pm_json: textBody(creation.note_id).body_pm_json },
  } };
}
/** An unpublished page starts in the SAME outline and editor tree it will publish. */
export function openPageDraft(creation: PageCreation): void {
  const ref = `page:${creation.page_id}`;
  if (graph.has(ref)) return;
  const body = emptyBody();
  const note = model.newNoteNode(creation.note_id, body);
  const source: model.OutlineNode = {
    item: { ref, action_ref: ref, label: creation.title || "untitled", missing: false,
      activation: { resource_ref: ref, kind: "route", href: `/pages/${creation.page_id}`, unavailable_reason: null },
      preview: { body: { kind: "named", title: creation.title, media_kind: null, contributors: null, image_url: null }, source: null, annotation: null } },
    content: { kind: "page", title: creation.title, title_version: 1, daily_date: null },
  };
  store.adoptText(ref, creation.title, null);
  store.createText(note.item.ref, body, null);
  const publication = pagePublication(creation);
  store.setCreator(ref, publication);
  store.setCreator(note.item.ref, publication);
  const link = { link_id: creation.link_id, target: note, connection: null, noteAuthority: "local" as const };
  graph.set(ref, { source, links: [link], links_version: 1, complete: true });
  graph.set(note.item.ref, { source: note, links: [{ ...link, target: source }], links_version: 1, complete: false });
  reviewedRefs.add(ref);
  publish();
}
/** A host-owned unpublished draft is a genuine client-minted occurrence. Opening
 * it changes no server state and claims no complete adjacency for its note. */
export function openOutlineDraft({
  endpoint,
  linkId,
  noteId,
  body,
  creator,
}: {
  endpoint: string;
  linkId: string;
  noteId: string;
  body: NoteBody;
  creator: Publication;
}) {
  const parent = graph.get(endpoint);
  if (!parent || parent.links.length) return;
  const target = model.newNoteNode(noteId, body);
  const link = {
    link_id: linkId,
    target,
    connection: null,
  };
  graph.set(endpoint, { ...parent, links: [link] });
  graph.set(target.item.ref, {
    source: target,
    links: [{ ...link, target: parent.source }],
    links_version: 1,
    complete: false,
  });
  store.createText(target.item.ref, body, creator);
  publish();
}

interface DirectOccurrence {
  destination: OutlineDestination | null;
  placement: OutlinePlacement | null;
  indentDestination: (OutlineDestination & {source: Schema<"LinkResourceEndpoint">}) | null;
  editable: boolean;
  unlink: (() => void) | null;
}
export type OutlineCommand = "insert" | "indent" | "outdent" | "move_up" | "move_down" | "undo" | "redo";
export type OutlineCommandState = { enabled: boolean; reason: string | null };
export interface OutlineEditorCommands {
  key: string;
  insertLabel: string;
  commandState(command: OutlineCommand): OutlineCommandState;
  executeCommand(command: OutlineCommand): void;
}
const sameTextValue = (a: store.TextValue, b: store.TextValue): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : sameBody(a, b);
export type Selection =
  | {
      kind: "text";
      key: string;
      anchor: number;
      head: number;
      direction?: "forward" | "backward" | "none";
    }
  | {
      kind: "blocks";
      anchor: string;
      keys: readonly string[];
    }
  | null;
export interface NoteEdit {
  editBase?: store.TextEditBase;
  before: NoteBody;
  after: NoteBody;
  selectionBefore: {
    anchor: number;
    head: number;
  };
  selectionAfter: {
    anchor: number;
    head: number;
  };
  source: "input" | "composition" | "paste" | "format" | "attachment";
}
export type FocusSelection =
  | {
      anchor: number;
      head: number;
      direction?: "forward" | "backward" | "none";
    }
  | "end";
export interface FocusRequest {
  readonly key: string;
  readonly target: "text" | "reference" | "control";
  readonly selection: FocusSelection;
  readonly serial: number;
}
export interface BodyOccurrence {
  key: string;
  noteRef: string;
}
export interface BodyCreator {
  noteRef: string;
  base: NoteBody;
}
export interface OutlineDestination {
  source: InsertionSource;
  position: model.OutlinePosition | null;
  occurrencePrefix: string;
  path: readonly string[];
  rootOccurrencePrefix?: string;
}
export interface OutlinePlacement {
  endpoint: string;
  link_id: string;
  position: Position;
  key: string;
  item: ResourceItem;
}
export interface DailyPublication {
  local_date: string;
  page_id: string;
  note_id: string;
  link_id: string;
}
/** Display evidence belongs to an admitted occurrence, never an endpoint read.
 * History keeps both relink placements so inverse commands can project immediately. */
type OccurrenceIntent = {
  edgeId: string;
  key: string;
  item: ResourceItem;
  originSourceRef: string;
  projection?: Pick<
    OutlineDestination,
    "occurrencePrefix" | "path" | "rootOccurrencePrefix"
  >;
};
type BodySides = {
  ref: string;
  before: NoteBody;
  after: NoteBody;
}[];
type Item = {
  lastAdmission?: Admission;
  removalProofs?: ReadonlyMap<string, RestoreNoteProof>;
  selBefore: Selection;
  selAfter: Selection;
} & (
  | {
      kind: "text";
      ref: string;
      before: store.TextValue;
      after: store.TextValue;
      write?: (value: string, editBase?: store.TextEditBase) => void;
      at: number;
    }
  | {
      kind: "structure";
      forward: readonly model.Edit[];
      inverse: readonly model.Edit[];
      refs: ReadonlySet<string>;
      occurrences: readonly OccurrenceIntent[];
      bodies: BodySides;
      versions: ReadonlyMap<string, CapturedLinksVersion>;
    }
  | {
      kind: "creation";
      forward: readonly Extract<
        model.Edit,
        {
          kind: "insert_link";
        }
      >[];
      inverse: readonly model.Unlink[];
      refs: ReadonlySet<string>;
      occurrences: readonly OccurrenceIntent[];
    }
);
type History = {
  items: Item[];
  index: number;
};
type FailedIntent = {
  inverse: readonly model.Edit[];
  occurrences: readonly OccurrenceIntent[];
  publication: DailyPublication | null;
  edits: readonly model.Edit[];
  drafts: readonly {
    ref: string;
    body: NoteBody;
  }[];
  bodyBases: ReadonlyMap<string, number | null>;
  removalBodies: ReadonlyMap<string, NoteBody>;
  before: Selection;
  after: Selection;
};
type ChildAction = {
  kind: "note" | "split" | "reference";
  occurrence: BodyOccurrence | null;
  creator: BodyCreator | null;
  destination: OutlineDestination;
  body: NoteBody;
  left: NoteBody | null;
  target: Schema<"InsertLink">["target"] | null;
  targetItem: ResourceItem | null;
  authored: Promise<AuthoredSnapshot[]> | null;
  consumed_reference: ReferenceConsumption | null;
  noteId: string;
  linkId: string;
  publication: DailyPublication | null;
  phase: "creating" | "failed";
  cancelled: boolean;
};
function linkDependencies(
  commands: readonly (model.Edit | model.Unlink)[],
): Set<string> {
  const ids = new Set<string>();
  for (const command of commands) {
    if ("link_id" in command) ids.add(command.link_id);
    if ("new_link_id" in command) ids.add(command.new_link_id);
    const after =
      "position" in command
        ? command.position?.after
        : "after" in command
          ? command.after
          : null;
    if (after) ids.add(after);
  }
  return ids;
}
function retainHistory(
  history: History,
  retain: (item: Item) => boolean,
): History {
  return {
    ...history,
    items: history.items.filter(retain),
    index: history.items.slice(0, history.index).filter(retain).length,
  };
}
function dependsOnEdges(item: Item, edges: ReadonlySet<string>): boolean {
  return (
    item.kind !== "text" &&
    [...linkDependencies([...item.forward, ...item.inverse])].some((id) =>
      edges.has(id),
    )
  );
}
function sourceRef(source: InsertionSource): string {
  return source.kind === "resource"
    ? source.ref
    : source.kind === "daily_page"
      ? `page:${source.page_id}`
      : source.kind === "passage"
        ? source.candidate_ref
        : `highlight:${source.highlight_id}`;
}
function publicationEdits(publication: DailyPublication): model.Edit[] {
  const endpoint = `page:${publication.page_id}`;
  return [
    {
      kind: "ensure_daily",
      local_date: publication.local_date,
      page_id: publication.page_id,
    },
    {
      kind: "insert_note",
      endpoint,
      source: { kind: "resource", ref: endpoint },
      link_id: publication.link_id,
      note_id: publication.note_id,
      position: { after: null, expected_links_version: 1 },
      body_pm_json: textBody(publication.note_id).body_pm_json,
    },
  ];
}
/** The host supplies reads and exact destinations; this hook never fetches. */
export function useOutlineSession({
  scope,
  inheritedBranch,
}: {
  scope: string;
  inheritedBranch: OutlineBranch;
}) {
  const feedback = useFeedback();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const retained = useResourceDraft(`Notes.Session:${scope}`, () => ({
    view: {
      folds: new Map<string, boolean>(),
    },
    history: { current: { items: [], index: 0 } as History },
    focusSerial: { current: 0 },
  }));
  const owner = retained.owner;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const view = retained.value.view;
  const history = retained.value.history;
  const deletionItems = useRef(new WeakSet<Item>());
  const failed = useResourceDraft<readonly FailedIntent[]>(
    `Notes.FailedStructure:${scope}`,
    () => [],
  );
  const actions = useResourceDraft<readonly ChildAction[]>(
    `Notes.ChildActions:${scope}`,
    () => [],
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const focusSerial = retained.value.focusSerial;
  const [activeReference, setActiveReference] = useState<string | null>(null);
  const directOccurrences = useRef(new Map<string, DirectOccurrence>());
  const [commandOwner, setCommandOwner] = useState(false);
  const editorCommands = useRef<OutlineEditorCommands | null>(null);
  const surfaces = useRef(new Map<object, {
    rows: readonly model.Row[];
    rootEndpoint: string;
    editable: boolean;
    destination(row: model.Row): OutlineDestination | null;
    publication?: DailyPublication;
  }>());
  const composerDraft = useResourceDraft<{
    destination: OutlineDestination; publication?: DailyPublication; serial: number;
    displayAfter: string | null;
    body: NoteBody; selection: {anchor: number; head: number}; problem: string | null;
  } | null>(`Notes.Composer:${scope}`, () => null, value => ({
    changed: value !== null && bodyHasContent(value.body), unconfirmed: false, stopsBrowserWork: false,
  }));
  const composer = composerDraft.value;
  const setComposer = composerDraft.set;
  function adoptComposerPredecessor(reply: WritingAck) {
    const current = composerDraft.read();
    const position = current?.destination.position;
    if (!current || position?.expected_links_version !== null || position.after !== position.proof.requested_link_id) return;
    const insertion = reply.insertions.find(value => value.requested_link_id === position.proof.requested_link_id &&
      value.source_ref === position.proof.source_ref);
    if (!insertion) return;
    // Only the display follows canonical identity; admission retains the original proof.
    setComposer(value => value?.serial === current.serial
      ? { ...value, displayAfter: insertion.canonical_link_id } : value);
  }
  const selectedNow = useRef(selection);
  selectedNow.current = selection;
  const boundaryNext = useRef(true);
  const interaction = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const heldItems = deletionItems.current;
    return () => {
      live.current = false;
      for (const [key, owners] of historyDeletionOwners) {
        for (const item of owners) if (heldItems.has(item)) owners.delete(item);
        if (owners.size === 0) historyDeletionOwners.delete(key);
      }
      history.current = { items: [], index: 0 };
    };
  }, [history, owner]);
  const ownsSurface = () => live.current && currentOwner.current === owner;
  const focusRow = useCallback(
    (
      key: string,
      at: FocusSelection = "end",
      target: "text" | "reference" | "control" = "text",
    ) => {
      setFocus({ key, target, selection: at, serial: ++focusSerial.current });
      setSelection(null);
    },
    [focusSerial],
  );
  const markInteraction = useCallback(
    (
      focusedReference: string | null = null,
      eventKind?: "pointerdown" | "keydown" | "focusin",
    ) => {
      interaction.current += 1;
      setFocus((current) =>
        eventKind === "pointerdown" ||
        eventKind === "keydown" ||
        (current?.target === "reference" && current.key !== focusedReference)
          ? null
          : current,
      );
    },
    [],
  );
  useEffect(() => {
    observeLinks();
    const changed = (invalidated: Invalidation | null) => {
      const preserved = new Set(invalidated?.kind === "links"
        ? [...invalidated.ids].flatMap(id => [...historyDeletionOwners.get(`link:${id}`) ?? []])
        : invalidated?.kind === "resources" ? [...invalidated.refs].flatMap(ref => [...historyDeletionOwners.get(ref) ?? []]) : []);
      if (invalidated?.kind === "links")
        history.current = retainHistory(
          history.current,
          (item) =>
            item === invalidated.preserve || preserved.has(item) ||
            !dependsOnEdges(item, invalidated.ids),
        );
      if (invalidated?.kind === "resources" || invalidated?.kind === "refused")
        history.current = retainHistory(history.current, (item) =>
          preserved.has(item) || (item.kind === "text"
            ? !(
                invalidated.kind === "refused"
                  ? invalidated.texts
                  : invalidated.refs
              ).has(item.ref)
            : ![...item.refs].some((ref) => invalidated.refs.has(ref))),
        );
      if (invalidated) boundaryNext.current = true;
      rerender();
    };
    listeners.add(changed);
    return () => {
      listeners.delete(changed);
    };
  }, [history]);
  function reportRefusal(error: unknown) {
    feedback.offer({
      key: `notes-outline-refused:${owner}`,
      announcement: "Assertive",
      content: {
        tone: "Danger",
        title: "that change couldn’t be saved",
        message:
          "your drafts are kept in the original outline. review its refreshed source and position before retrying.",
        requestId: isApiError(error) ? error.requestId : undefined,
      },
    });
  }
  /** Apply, send and (unless replaying history) record one structure batch. */
  function commit(
    edits: readonly model.Edit[],
    after: Selection,
    record = true,
    before = selection,
    options: {
      publication?: DailyPublication;
      captured?: ReadonlyMap<string, CapturedLinksVersion>;
      restores?: ReadonlyMap<string, Restore>;
      preserve?: Item;
      consumed_reference?: ReferenceConsumption | null;
      freshNotes?: ReadonlySet<string>;
      onAdmitted?: (admission: Admission) => void;
      onAcknowledged?: (reply: Reply) => void;
      inverse?: readonly model.Edit[];
      resources?: ReadonlyMap<string, ResourceItem>;
      occurrences?: readonly OccurrenceIntent[];
    } = {},
  ) {
    if (readWriting().paused) return false;
    if (!edits.length && !options.publication) return false;
    const occurrences = options.occurrences ?? [];
    const refs = editReferences(edits);
    if ([...refs].some(isDeletedResource)) {
      feedback.offer({
        key: "outline-write",
        announcement: "Polite",
        content: {
          tone: "Neutral",
          title: "a note used by this change was deleted",
        },
      });
      return false;
    }
    const removed = new Map<string, string>();
    for (const edit of edits) {
      if (edit.kind !== "remove" && edit.kind !== "consume_note") continue;
      const link = graph
        .get(edit.endpoint)
        ?.links.find((l) => l.link_id === edit.link_id);
      if (link?.target.content.kind === "note")
        removed.set(edit.link_id, link.target.item.ref);
    }
    const removalBodies = new Map(
      [...removed.values()].map((ref) => [
        ref,
        structuredClone(textBody(model.noteIdOf(ref))),
      ]),
    );
    const captured = new Map<string, CapturedLinksVersion>(
      [...graph].map(([ref, value]) => [ref, value.links_version]),
    );

    for (const edit of edits)
      if (
        "position" in edit &&
        edit.position !== null &&
        edit.position.expected_links_version !== null
      )
        captured.set(
          edit.kind === "relink" ? edit.destination : edit.endpoint,
          edit.position.expected_links_version,
        );
    for (const [ref, version] of options.captured ?? []) captured.set(ref, version);
    for (const edit of edits) {
      if (
        edit.kind !== "move" &&
        edit.kind !== "relink" &&
        edit.kind !== "remove" &&
        edit.kind !== "consume_note"
      )
        continue;
      const pending = pendingOccurrences.get(edit.link_id);
      const proof = pending?.proof;
      if (
        !pending ||
        !proof ||
        (pending.sourceRef !== edit.endpoint &&
          pending.originSourceRef !== edit.endpoint)
      )
        continue;
      const observed = captured.get(edit.endpoint);
      if (
        !pending.acknowledged ||
        typeof observed !== "number" ||
        (pending.authoredPosition?.linksVersion ?? 0) > observed
      )
        captured.set(edit.endpoint, proof);
    }
    const materialization = options.publication
      ? publicationEdits(options.publication)
      : [];
    if (options.publication)
      captured.set(`page:${options.publication.page_id}`, 1);
    const bodies: BodySides = edits.flatMap((edit) => {
      if (edit.kind !== "set_body" && edit.kind !== "insert_note") return [];
      const ref = model.noteRef(edit.note_id);
      const before = store.readText(ref)?.value;
      return [
        {
          ref,
          before:
            typeof before === "object"
              ? structuredClone(before)
              : parseBody(edit.body_pm_json),
          after: parseBody(edit.body_pm_json),
        },
      ];
    });
    for (const [ref, body] of removalBodies)
      if (!bodies.some((side) => side.ref === ref))
        bodies.push({ ref, before: body, after: body });
    const next = new Map(graph);
    model.applyEdits(next, materialization, textBody);
    const appliedInverse = model.applyEdits(next, edits, textBody, (ref) => {
      const known = node(ref);
      if (known) return known;
      const item =
        options.resources?.get(ref) ??
        occurrences.find((value) => value.item.ref === ref)?.item;
      return item ? { item, content: { kind: "resource" } } : null;
    });
    const inverse = options.inverse ?? appliedInverse;
    if (
      [...linkDependencies([...materialization, ...edits, ...inverse])].some(
        (id) => pendingUnlinks.has(id),
      )
    ) {
      feedback.receipt({
        tone: "Neutral",
        title: "wait for the link removal to finish",
      });
      return false;
    }
    graph.clear();
    for (const [ref, value] of next) graph.set(ref, value);
    const texts = new Set<string>();
    for (const edit of [...materialization, ...edits]) {
      if (edit.kind === "set_body" || edit.kind === "insert_note") {
        const ref = model.noteRef(edit.note_id);
        const body = parseBody(edit.body_pm_json);
        if (edit.kind === "set_body") store.carryText(ref, body);
        else if (options.freshNotes?.has(edit.note_id) && !store.readText(ref)) store.createFreshText(ref, body, null);
        else store.createText(ref, body, null);
        texts.add(ref);
      }
    }
    // A pending insertion must not reappear while its inverse removal waits.
    // The marker belongs to this exact operation; an older callback cannot
    // clear a later removal or restore an already retired occurrence.
    const removals = edits.flatMap(edit => {
      if (edit.kind !== "remove" && edit.kind !== "consume_note") return [];
      const marker: PendingRemoval = { sourceRef: edit.endpoint, generation: null };
      const previous = pendingRemovals.get(edit.link_id);
      const occurrence = pendingOccurrences.get(edit.link_id);
      pendingRemovals.set(edit.link_id, marker);
      return [{ edgeId: edit.link_id, marker, previous, occurrence }];
    });
    const admissions: {
      edgeId: string;
      pending: PendingRecord;
      previousPending: PendingRecord | undefined;
      displacedRemoval: PendingRemoval | undefined;
      sourceEdgeId: string | null;
      sourcePending: PendingRecord | undefined;
      removal: PendingRemoval | null;
      previousRemoval: PendingRemoval | undefined;
    }[] = [];
    // Every structural entry point, including inverse and retry, admits overlays
    // here. The supplied key/item is placement evidence, never adjacency authority.
    for (const edit of edits) {
      if (
        edit.kind !== "insert_note" &&
        edit.kind !== "insert_link" &&
        edit.kind !== "relink"
      )
        continue;
      const edgeId = edit.kind === "relink" ? edit.new_link_id : edit.link_id;
      const occurrence = occurrences.find((value) => value.edgeId === edgeId);
      if (!occurrence) continue;
      const endpoint =
        edit.kind === "relink" ? edit.destination : edit.endpoint;
      const ref =
        edit.kind === "insert_note"
          ? model.noteRef(edit.note_id)
          : edit.kind === "insert_link"
            ? edit.target
            : occurrence.item.ref;
      const pending: PendingRecord = {
        key: occurrence.key,
        ref,
        edgeId,
        sourceRef: endpoint,
        originSourceRef: occurrence.originSourceRef,
        item: occurrence.item,
        body: edit.kind === "insert_note" ? parseBody(edit.body_pm_json) : null,
        position: edit.position,
        acknowledged: false,
        generation: null,
        authoredPosition:
          edit.position !== null &&
          edit.position.expected_links_version !== null &&
          (edit.kind !== "insert_link" || edit.require_created)
            ? {
                after: edit.position.after,
                linksVersion: edit.position.expected_links_version,
              }
            : undefined,

      };
      const removal: PendingRemoval | null =
        edit.kind === "relink"
          ? { sourceRef: edit.endpoint, generation: null }
          : null;
      admissions.push({
        edgeId,
        pending,
        previousPending: pendingOccurrences.get(edgeId),
        displacedRemoval: pendingRemovals.get(edgeId),
        sourceEdgeId: edit.kind === "relink" ? edit.link_id : null,
        sourcePending:
          edit.kind === "relink"
            ? pendingOccurrences.get(edit.link_id)
            : undefined,
        removal,
        previousRemoval:
          edit.kind === "relink"
            ? pendingRemovals.get(edit.link_id)
            : undefined,
      });
      pendingRemovals.delete(edgeId);
      pendingOccurrences.set(edgeId, pending);
      if (edit.kind === "relink" && removal)
        pendingRemovals.set(edit.link_id, removal);
      if (occurrence.projection)
        view.folds.set(
          model.occurrenceKey(
            occurrence.projection.occurrencePrefix,
            occurrence.projection.path,
          ),
          true,
        );
    }
    const commands = [...materialization, ...edits];
    editReferences(materialization).forEach((ref) => refs.add(ref));
    const bodyBases = new Map(
      edits.flatMap((edit) =>
        edit.kind === "set_body"
          ? [
              [
                model.noteRef(edit.note_id),
                store.readText(model.noteRef(edit.note_id))?.acked?.version ??
                  null,
              ] as const,
            ]
          : [],
      ),
    );
    for (const ref of removed.values())
      bodyBases.set(ref, store.readText(ref)?.acked?.version ?? null);
    let recorded: Exclude<
      Item,
      {
        kind: "text";
      }
    > | null = null;
    const previousHistory = history.current;
    if (record) {
      const items = history.current.items.slice(0, history.current.index);
      const context = {
        refs: new Set([...refs, ...editReferences(inverse)]),
        selBefore: before,
        selAfter: after,
        occurrences,
      };
      recorded =
        edits.length > 0 &&
        edits.every(
          (edit) => edit.kind === "insert_note" || edit.kind === "insert_link",
        )
          ? {
              kind: "creation",
              forward: edits.map((edit) =>
                edit.kind === "insert_link"
                  ? { ...edit, require_created: true }
                  : {
                      kind: "insert_link",
                      endpoint: edit.endpoint,
                      link_id: edit.link_id,
                      target: model.noteRef(edit.note_id),
                      source: edit.source,
                      position: edit.position,
                      require_created: true,
                    },
              ),
              inverse: edits.map(edit => {
                const observed = captured.get(edit.endpoint);
                const version = typeof observed === "number" ? observed : observed?.version;
                return {
                  kind: "unlink", link_id: edit.link_id,
                  expected: version === undefined ? null : { endpoint: edit.endpoint, links_version: version },
                };
              }),
              ...context,
            }
          : {
              kind: "structure",
              forward: edits,
              inverse,
              bodies,
              versions: new Map(captured),
              ...context,
            };
      items.push(recorded);
      history.current = { ...history.current, items, index: items.length };
    }
    const protectedItem = recorded ?? options.preserve ?? null;
    const releaseHistory = holdHistoryDeletions(protectedItem, [
      ...edits.flatMap(edit => edit.kind === "remove" || edit.kind === "consume_note" || edit.kind === "relink" ? [`link:${edit.link_id}`] : []),
      ...removed.values(),
    ], deletionItems.current);
    // Reversed refusal rollback keeps overlays causal; insert this batch's
    // recovery at its captured boundary so retries remain in submission order.
    const failedBefore = failed.read().length;
    const admission = sendEdits(
      commands,
      removed,
      texts,
      refs,
      captured,
      (error) => {
        releaseHistory();
        reportRefusal(error);
        for (const removal of [...removals].reverse()) {
          if (pendingRemovals.get(removal.edgeId) !== removal.marker) continue;
          if (removal.previous) pendingRemovals.set(removal.edgeId, removal.previous);
          else pendingRemovals.delete(removal.edgeId);
        }
        for (const admission of [...admissions].reverse()) {
          if (pendingOccurrences.get(admission.edgeId) === admission.pending) {
            if (admission.previousPending)
              pendingOccurrences.set(
                admission.edgeId,
                admission.previousPending,
              );
            else pendingOccurrences.delete(admission.edgeId);
          }
          if (
            admission.sourceEdgeId !== null &&
            pendingRemovals.get(admission.sourceEdgeId) === admission.removal
          ) {
            if (admission.previousRemoval)
              pendingRemovals.set(
                admission.sourceEdgeId,
                admission.previousRemoval,
              );
            else pendingRemovals.delete(admission.sourceEdgeId);
          }
          if (
            admission.displacedRemoval &&
            !pendingRemovals.has(admission.edgeId)
          )
            pendingRemovals.set(admission.edgeId, admission.displacedRemoval);
        }
        const drafts = [...texts].flatMap((ref) => {
          const value = store.readText(ref)?.value;
          return value && typeof value !== "string"
            ? [{ ref, body: structuredClone(value) }]
            : [];
        });
        failed.set((prior) => [
          ...prior.slice(0, failedBefore),
          {
            edits: structuredClone(edits),
            inverse,
            occurrences,
            publication: options.publication ?? null,
            drafts,
            bodyBases: new Map(bodyBases),
            removalBodies,
            before,
            after,
          },
          ...prior.slice(failedBefore),
        ]);
      },
      bodyBases,
      removalBodies,
      (reply) => {
        adoptComposerPredecessor(reply);
        invalidateResourceOutlines(refs);
        const generation = captureResourceOutlineRead();
        for (const removal of removals) {
          if (pendingRemovals.get(removal.edgeId) !== removal.marker) continue;
          removal.marker.generation = generation;
          if (pendingOccurrences.get(removal.edgeId) === removal.occurrence)
            pendingOccurrences.delete(removal.edgeId);
        }
        for (const admission of admissions) {
          const pending = admission.pending;
          pending.acknowledged = true;
          pending.generation = generation;
          if (admission.sourceEdgeId !== null) {
            if (
              pendingOccurrences.get(admission.sourceEdgeId) ===
              admission.sourcePending
            )
              pendingOccurrences.delete(admission.sourceEdgeId);
            if (admission.removal) admission.removal.generation = generation;
          }
        }
        const reused = new Set<string>();
        for (const result of reply.insertions) {
          const edit = commands.find(edit => (edit.kind === "insert_note" || edit.kind === "insert_link") && edit.link_id === result.requested_link_id);
          if (!edit || (edit.kind !== "insert_note" && edit.kind !== "insert_link")) continue;
          if (!result.created) reused.add(edit.link_id);
          const link = reply.links.find(link => link.link_id === result.canonical_link_id);
          if (!link) continue;
          const owner = result.source_ref;
          const targetRef = link.source_ref === owner ? link.target_ref : link.source_ref;
          const occurrence = occurrences.find(value => value.edgeId === edit.link_id);
          const pending = admissions.find(value => value.edgeId === edit.link_id)?.pending;
          const priorItem = node(targetRef)?.item ?? pending?.item ?? occurrence?.item;
          if (!priorItem) continue;
          const item = priorItem.ref === targetRef ? priorItem : {
            ...priorItem, ref: targetRef,
            action_ref: priorItem.action_ref === priorItem.ref ? targetRef : priorItem.action_ref,
            activation: { ...priorItem.activation, resource_ref: targetRef },
          };
          const actualKey = occurrence?.projection ? createdKey(occurrence.projection, targetRef, result.canonical_link_id) : occurrence?.key;
          if (pending) {
            pending.sourceRef = owner;
            pending.item = item;
            pending.ref = targetRef;
            pending.edgeId = result.canonical_link_id;
            if (actualKey) pending.key = actualKey;
            const fact = reply.lanes.find(value => value.ref === owner && value.lane === "links");
            const placement = reply.placements.find(value => value.endpoint === owner && value.link_id === result.canonical_link_id);
            pending.authoredPosition = fact && fact.checked_from_version !== null && placement ? { after: placement.after_link_id, linksVersion: fact.version } : undefined;
            pending.position = pending.authoredPosition ? { after: pending.authoredPosition.after, expected_links_version: pending.authoredPosition.linksVersion } : null;
            if (result.canonical_link_id !== edit.link_id && pendingOccurrences.get(edit.link_id) === pending) {
              pendingOccurrences.delete(edit.link_id);
              pendingOccurrences.set(result.canonical_link_id, pending);
            }
          }
          const rewrite = (command: model.Edit): model.Edit => {
            if (!("link_id" in command) || command.link_id !== edit.link_id)
              return command;
            if (
              command.kind === "insert_note" ||
              command.kind === "insert_link"
            )
              return {
                ...command,
                endpoint: owner,
                source: { kind: "resource", ref: owner },
                ...(command.kind === "insert_link"
                  ? { target: targetRef }
                  : {}),
              };
            return { ...command, endpoint: owner };
          };
          if (recorded) {
            recorded.occurrences = recorded.occurrences.map((value) =>
              value.edgeId === edit.link_id
                ? {
                    ...value,
                    edgeId: result.canonical_link_id,
                    key: actualKey ?? value.key,
                    item,
                  }
                : value,
            );
            recorded.refs = new Set([
              ...recorded.refs,
              owner,
              targetRef,
            ]);
            if (recorded.kind === "creation")
              recorded.forward = recorded.forward.map(
                (command) =>
                  rewrite(command) as Extract<
                    model.Edit,
                    { kind: "insert_link" }
                  >,
              );
            else {
              recorded.forward = recorded.forward.map(rewrite);
              recorded.inverse = recorded.inverse.map(rewrite);
            }
          }
        }
        if (recorded) advanceHistoryPositions(recorded, reply);
        if (protectedItem && protectedItem.lastAdmission?.intent_id === admission?.intent_id)
          protectedItem.removalProofs = removalProofs(removed.values(), reply);
        options.onAcknowledged?.(reply);
        releaseHistory(reply);
        if (!recorded || reused.size === 0) return;
        const keep = (edit: model.Edit | model.Unlink) =>
          !("link_id" in edit && reused.has(edit.link_id));
        switch (recorded.kind) {
          case "structure":
            recorded.forward = recorded.forward.filter(keep);
            recorded.inverse = recorded.inverse.filter(keep);
            break;
          case "creation":
            recorded.forward = recorded.forward.filter(keep);
            recorded.inverse = recorded.inverse.filter(keep);
            break;
          default:
            assertNever(recorded);
        }
        if (recorded.forward.length === 0 && recorded.inverse.length === 0) {
          const prior = history.current;
          const at = prior.items.indexOf(recorded);
          history.current = {
            ...prior,
            items: prior.items.filter((item) => item !== recorded),
            index: prior.index - (at >= 0 && at < prior.index ? 1 : 0),
          };
        }
      },
      options.restores,
      options.consumed_reference,
    );
    if (!admission) { releaseHistory(); history.current = previousHistory; return false; }
    if (recorded) recorded.lastAdmission = admission;
    options.onAdmitted?.(admission);
    if (admission) for (const value of admissions) {
      const capturedVersion = captured.get(value.pending.sourceRef);
      const version = typeof capturedVersion === "number" ? capturedVersion : capturedVersion?.version;
      if (version !== undefined) value.pending.proof = {
        ...admission, requested_link_id: value.edgeId, source_ref: value.pending.sourceRef, version,
      };
    }
    boundaryNext.current = true;
    publish();
    return true;
  }
  function advanceHistoryPositions(
    item: Exclude<
      Item,
      {
        kind: "text";
      }
    >,
    reply: Reply,
  ) {
    const advance = (edit: model.Edit): model.Edit => {
      if (!("position" in edit) || edit.position === null) return edit;
      const endpoint =
        edit.kind === "relink" ? edit.destination : edit.endpoint;
      const fact = reply.lanes.find((value) => value.ref === endpoint && value.lane === "links");
      const base = edit.position.expected_links_version === null ? edit.position.proof.version : edit.position.expected_links_version;
      return fact && (fact.checked_from_version === base || fact.version === base)
        ? {
            ...edit,
            position: {
              ...edit.position,
              expected_links_version: fact.version,
            },
          }
        : edit;
    };
    if (item.kind === "structure") {
      const versions = new Map(item.versions);
      for (const fact of reply.lanes) {
        const original = versions.get(fact.ref);
        const base = typeof original === "number" ? original : original?.version;
        if (fact.lane === "links" && base !== undefined && (fact.checked_from_version === base || fact.version === base)) versions.set(fact.ref, fact.version);
      }
      item.versions = versions;
      item.forward = item.forward.map(advance);
      item.inverse = item.inverse.map(advance);
    } else {
      item.forward = item.forward.map(
        (edit) =>
          advance(edit) as Extract<
            model.Edit,
            {
              kind: "insert_link";
            }
          >,
      );
      item.inverse = item.inverse.map(edit => {
        if (edit.expected === null) return edit;
        const captured = edit.expected;
        const fact = reply.lanes.find(value => value.ref === captured.endpoint && value.lane === "links");
        return fact && (fact.checked_from_version === captured.links_version || fact.version === captured.links_version)
          ? { ...edit, expected: { ...captured, links_version: fact.version } }
          : edit;
      });
    }
  }
  function restoreSelection(selected: Selection) {
    if (!ownsSurface()) return;
    if (selected?.kind === "text")
      focusRow(selected.key, { anchor: selected.anchor, head: selected.head, direction: selected.direction });
    else setSelection(selected);
  }
  function sendUnlink({
    commands,
    preserve,
    rows = [],
  }: {
    commands: readonly model.Unlink[];
    preserve: Item | null;
    rows?: readonly model.Row[];
  }): boolean {
    if (readWriting().paused) return false;
    const ids = new Set(commands.map((command) => command.link_id));
    if (
      !ids.size ||
      ids.size > 1000 ||
      [...ids].some((id) => pendingUnlinks.has(id))
    )
      return false;
    const endpoints = linkedEndpoints(ids);
    ids.forEach((id) => pendingUnlinks.add(id));
    const releaseHistory = holdHistoryDeletions(preserve, [...ids].map(id => `link:${id}`), deletionItems.current);
    const release = () => { ids.forEach((id) => pendingUnlinks.delete(id)); };
    dropLinks(ids, endpoints);
    const admitted = admitWriting({ kind: "outline", commands: commands.map(command => ({
      ...command,
      expected: command.expected === null ? null : {
        endpoint: command.expected.endpoint,
        links_version: captureLane(command.expected.endpoint, "links", command.expected.links_version),
      },
    })) }, []);
    if (preserve) preserve.lastAdmission = { intent_id: admitted.intent_id, draft_id: null };
    void admitted.settled.then(reply => {
      if (preserve && preserve.kind !== "text") {
        advanceHistoryPositions(preserve, reply);
        if (preserve.lastAdmission?.intent_id === admitted.intent_id) preserve.removalProofs = removalProofs(endpoints, reply);
      }
      for (const id of ids) pendingOccurrences.delete(id);
      publish({ kind: "links", ids, preserve });
      releaseHistory(reply);
    }, error => {
      releaseHistory();
      if (preserve) history.current = retainHistory(history.current, item => item !== preserve);
      if (!handleUnauthenticatedApiError(error)) reportRefusal(error);
      invalidateResourceOutlines(endpoints);
      publish({ kind: "refused", refs: endpoints, texts: new Set() });
    }).finally(() => { release(); publish(); });
    void admitted.durable.catch(error => { reportRefusal(error); publish(); });
    boundaryNext.current = true;
    if (ownsSurface() && rows.length > 0) {
      const at = rows.findIndex(row => ids.has(row.link.link_id));
      const next = [...rows.slice(Math.max(0, at)), ...rows.slice(0, Math.max(0, at)).reverse()].find(row => !ids.has(row.link.link_id));
      setSelection(null);
      if (next) focusRow(next.key, "end", "control");
    }
    publish();
    return true;
  }
  const remapHistory = useCallback((refs: ReadonlyMap<string, string>, edges: ReadonlyMap<string, string>): void => {
    const selection = (value: Selection): Selection => value === null ? null : value.kind === "text" ? { ...value, key: remapKey(value.key, refs, edges) } : {
      ...value, anchor: remapKey(value.anchor, refs, edges), keys: value.keys.map(key => remapKey(key, refs, edges)),
    };
    for (const item of history.current.items) {
      item.selBefore = selection(item.selBefore);
      item.selAfter = selection(item.selAfter);
      if (item.kind === "text") { item.ref = refs.get(item.ref) ?? item.ref; continue; }
      item.refs = new Set([...item.refs].map(ref => refs.get(ref) ?? ref));
      item.occurrences = item.occurrences.map(value => ({ ...value,
        edgeId: edges.get(value.edgeId) ?? value.edgeId, key: remapKey(value.key, refs, edges), item: remapResource(value.item, refs), originSourceRef: refs.get(value.originSourceRef) ?? value.originSourceRef,
        ...(value.projection ? { projection: { ...value.projection, path: value.projection.path.map(edge => edges.get(edge) ?? edge), occurrencePrefix: remapKey(value.projection.occurrencePrefix, refs, edges) } } : {}),
      }));
      if (item.kind === "structure") {
        item.forward = item.forward.map(edit => remapEdit(edit, refs, edges));
        item.inverse = item.inverse.map(edit => remapEdit(edit, refs, edges));
        item.bodies = item.bodies.map(body => ({ ...body, ref: refs.get(body.ref) ?? body.ref }));
        item.versions = new Map([...item.versions].map(([ref, value]) => [refs.get(ref) ?? ref, value]));
      } else {
        item.forward = item.forward.map(edit => ({ ...edit, endpoint: refs.get(edit.endpoint) ?? edit.endpoint, target: refs.get(edit.target) ?? edit.target, link_id: edges.get(edit.link_id) ?? edit.link_id,
          source: edit.source.kind === "resource" ? { ...edit.source, ref: refs.get(edit.source.ref) ?? edit.source.ref } : edit.source,
          position: edit.position === null ? null : edit.position.expected_links_version === null ? { ...edit.position, after: edges.get(edit.position.after) ?? edit.position.after } : { ...edit.position, after: edit.position.after === null ? null : edges.get(edit.position.after) ?? edit.position.after },
        }));
        item.inverse = item.inverse.map(edit => ({ ...edit, link_id: edges.get(edit.link_id) ?? edit.link_id,
          expected: edit.expected === null ? null : { ...edit.expected, endpoint: refs.get(edit.expected.endpoint) ?? edit.expected.endpoint },
        }));
      }
    }
  }, [history]);
  const readActions = actions.read;
  useEffect(() => subscribeWritingBindings(bindings => {
    const refs = new Map(bindings.map(binding => [binding.from_ref, binding.to_ref]));
    remapGraph(refs, new Map());
    remapHistory(refs, new Map());
    for (const action of readActions()) {
      if (action.creator) action.creator.noteRef = refs.get(action.creator.noteRef) ?? action.creator.noteRef;
      if (action.occurrence) action.occurrence.noteRef = refs.get(action.occurrence.noteRef) ?? action.occurrence.noteRef;
      const ref = refs.get(model.noteRef(action.noteId));
      if (ref) action.noteId = model.noteIdOf(ref);
    }
    publish();
  }), [readActions, remapHistory]);
  function step(redo: boolean) {
    if (readWriting().paused) return;
    const { items, index } = history.current;
    const item = redo ? items[index] : items[index - 1];
    if (!item) return;
    if (
      item.kind !== "text" &&
      [...linkDependencies([...item.forward, ...item.inverse])].some((id) =>
        pendingUnlinks.has(id),
      )
    ) {
      feedback.receipt({
        tone: "Neutral",
        title: "wait for the link removal to finish",
      });
      return;
    }
    const bodies =
      item.kind === "text"
        ? [{ ref: item.ref, before: item.before, after: item.after }]
        : item.kind === "structure"
          ? item.bodies
          : [];
    const changed = new Set(
      bodies.flatMap((body) => {
        const current = store.readText(body.ref)?.value;
        return current === undefined ||
          (item.kind === "text" && textHistoryOwners.get(body.ref) !== owner) ||
          !sameTextValue(current, redo ? body.before : body.after)
          ? [body.ref]
          : [];
      }),
    );
    if (changed.size) {
      history.current = retainHistory(history.current, (entry) =>
        entry.kind === "text"
          ? !changed.has(entry.ref)
          : ![...entry.refs].some((ref) => changed.has(ref)),
      );
      boundaryNext.current = true;
      feedback.receipt({
        tone: "Neutral",
        title: `this note changed since that edit; ${redo ? "redo" : "undo"} wasn’t applied`,
      });
      return;
    }
    const restores = new Map<string, Restore>();
    if (item.kind !== "text" && (item.kind === "structure" || redo)) {
      const next = redo ? item.forward : item.kind === "structure" ? item.inverse : [];
      const refs = new Map<string, string>();
      const edges = new Map<string, string>();
      for (const edit of next) {
        if (edit.kind === "insert_note") {
          if (!item.lastAdmission) { reportRefusal(null); return; }
          const id = crypto.randomUUID();
          refs.set(model.noteRef(edit.note_id), model.noteRef(id));
          restores.set(id, item.removalProofs?.get(edit.note_id) ?? { kind: "pending", ...item.lastAdmission, original_note_id: edit.note_id });
          edges.set(edit.link_id, crypto.randomUUID());
        } else if (edit.kind === "insert_link") edges.set(edit.link_id, crypto.randomUUID());
        else if (edit.kind === "relink") edges.set(edit.new_link_id, crypto.randomUUID());
      }
      remapHistory(refs, edges);
    }
    const selected = redo ? item.selAfter : item.selBefore;
    if (item.kind === "text") {
      const value = redo ? item.after : item.before;
      if (typeof value === "string" && item.write) item.write(value);
      else store.replaceText(item.ref, value);
    }
    else if (item.kind === "structure") {
      if (
        !commit(
          redo ? item.forward : item.inverse,
          selected,
          false,
          selection,
          {
            occurrences: item.occurrences,
            preserve: item,
            captured: item.versions,
            restores,
            freshNotes: new Set(restores.keys()),
            onAdmitted: admission => { item.lastAdmission = admission; },
            onAcknowledged: reply => advanceHistoryPositions(item, reply),
          },
        )
      )
        return;
    } else if (!redo) {
      history.current = { ...history.current, index: index - 1 };
      if (!sendUnlink({ commands: item.inverse, preserve: item }))
        history.current = { ...history.current, index };
      return;
    } else {
      if (
        item.forward.some(
          (edit) => edit.position !== null && !reviewedRefs.has(edit.endpoint),
        )
      ) {
        feedback.receipt({
          tone: "Neutral",
          title: "wait for the linked resources to refresh",
        });
        return;
      }
      const forward = item.forward.map((edit) =>
        edit.position === null
          ? edit
          : {
              ...edit,
              position: {
                ...edit.position,
                expected_links_version: graph.get(edit.endpoint)!.links_version,
              },
            },
      );
      if (
        !commit(forward, selected, false, selection, {
          occurrences: item.occurrences,
          preserve: item,
          onAdmitted: admission => { item.lastAdmission = admission; },
          onAcknowledged: reply => advanceHistoryPositions(item, reply),
        })
      )
        return;
    }
    history.current = { ...history.current, index: index + (redo ? 1 : -1) };
    restoreSelection(selected);
    boundaryNext.current = true;
  }
  function canUnlink(row: model.Row): boolean {
    return (
      activeReference === null &&
      row.terminal === null &&
      !isDeletedResource(row.endpoint) &&
      !pendingUnlinks.has(row.link.link_id) &&
      row.link.connection?.origin === "user" &&
      row.link.connection.mutation?.kind === "unlink" &&
      graph
        .get(row.endpoint)
        ?.links.some((link) => link.link_id === row.link.link_id) === true
    );
  }
  function unlinkOccurrences(rows: readonly model.Row[], focusRows: readonly model.Row[] = rows): boolean {
    if (!rows.length || !rows.every(canUnlink)) {
      feedback.receipt({
        tone: "Warning",
        title: "some selected items cannot be unlinked. nothing was removed.",
      });
      return false;
    }
    return sendUnlink({
      commands: [...new Map(rows.map(row => [row.link.link_id, row])).values()].map(row => ({
        kind: "unlink", link_id: row.link.link_id,
        expected: { endpoint: row.endpoint, links_version: graph.get(row.endpoint)!.links_version },
      })),
      preserve: null,
      rows: focusRows,
    });
  }
  function position({
    endpoint,
    edgeId,
    side,
  }: {
    endpoint: string;
    edgeId: string | null;
    side: "before" | "after";
  }): model.OutlinePosition | null {
    if (edgeId !== null && pendingUnlinks.has(edgeId)) return null;
    const outline = graph.get(endpoint);
    const pending = edgeId === null ? null : pendingOccurrences.get(edgeId);
    const owned =
      pending &&
      (pending.sourceRef === endpoint || pending.originSourceRef === endpoint);
    if (outline && reviewedRefs.has(endpoint)) {
      const at =
        edgeId === null
          ? outline.links.length
          : outline.links.findIndex((link) => link.link_id === edgeId);
      if (at >= 0 && (edgeId !== null || outline.complete)) {
        const after =
          edgeId !== null && side === "after"
            ? edgeId
            : (outline.links[at - 1]?.link_id ?? null);
        return after !== null && pendingUnlinks.has(after)
          ? null
          : { after, expected_links_version: outline.links_version };
      }
    }
    if (owned && side === "after" && pending.proof)
      return {
        after: pending.edgeId,
        expected_links_version: null,
        proof: pending.proof,
      };
    return null;
  }
  function pendingPlacement(
    occurrence: PendingOccurrence,
  ): OutlinePlacement | null {
    const pending = pendingOccurrences.get(occurrence.edgeId);
    if (
      !pending ||
      pendingRemovals.has(occurrence.edgeId) ||
      pendingUnlinks.has(occurrence.edgeId) ||
      pending.ref !== occurrence.ref ||
      endpointForResource(pending.sourceRef)?.kind !== "resource" ||
      endpointForResource(pending.ref)?.kind !== "resource" ||
      isDeletedResource(pending.ref) ||
      isDeletedResource(pending.sourceRef)
    )
      return null;
    const captured = pending.authoredPosition;
    if (!captured) return null;
    const version = captured.linksVersion;
    return {
      endpoint: pending.sourceRef,
      link_id: pending.edgeId,
      position: { after: captured.after, expected_links_version: version },
      key: pending.key,
      item: pending.item,
    };
  }
  function placement(row: model.Row): OutlinePlacement | null {
    if (!model.arrangementRow(row)) return null;
    const pending = pendingOccurrences.get(row.link.link_id);
    const ownPending =
      row.link.connection === null &&
      pending !== undefined &&
      pending.ref === row.link.target.item.ref &&
      (pending.sourceRef === row.endpoint ||
        pending.originSourceRef === row.endpoint);
    if (ownPending) return pendingPlacement(pending);
    const captured = position({
      endpoint: row.endpoint,
      edgeId: row.link.link_id,
      side: "before",
    });
    if (
      captured === null ||
      captured.expected_links_version === null ||
      row.link.connection?.origin !== "user" ||
      row.link.connection.mutation?.kind !== "unlink"
    )
      return null;
    return {
      endpoint: row.endpoint,
      link_id: row.link.link_id,
      position: captured,
      key: row.key,
      item: row.link.target.item,
    };
  }
  function node(ref: string): model.OutlineNode | null {
    const source = graph.get(ref)?.source;
    if (source) return source;
    for (const outline of graph.values()) {
      const target = outline.links.find(
        (link) => link.target.item.ref === ref,
      )?.target;
      if (target) return target;
    }
    return null;
  }
  function captureDestination(
    destination: OutlineDestination,
  ): OutlineDestination {
    return {
      source: structuredClone(destination.source),
      position:
        destination.position?.expected_links_version === null
          ? { ...destination.position }
          : structuredClone(destination.position),
      occurrencePrefix: destination.occurrencePrefix,
      path: [...destination.path],
      rootOccurrencePrefix: destination.rootOccurrencePrefix,
    };
  }
  function occurrenceProjection(
    destination: OutlineDestination,
  ): NonNullable<OccurrenceIntent["projection"]> {
    return {
      occurrencePrefix: destination.occurrencePrefix,
      path: destination.path,
      rootOccurrencePrefix: destination.rootOccurrencePrefix,
    };
  }
  function createdKey(
    destination: Pick<
      OutlineDestination,
      "occurrencePrefix" | "path" | "rootOccurrencePrefix"
    >,
    ref: string,
    linkId: string,
  ): string {
    return destination.rootOccurrencePrefix === undefined
      ? model.occurrenceKey(destination.occurrencePrefix, [
          ...destination.path,
          linkId,
        ])
      : model.resourceOccurrenceKey(destination.rootOccurrencePrefix, ref);
  }
  function rememberReference(
    result: WritingInsertion,
    item: ResourceItem,
    reply: WritingAck,
    key: string,
  ) {
    adoptComposerPredecessor(reply);
    const source = result.source_ref;
    const fact = reply.lanes.find(value => value.ref === source && value.lane === "links");
    const placement = reply.placements.find(value => value.endpoint === source && value.link_id === result.canonical_link_id);
    const captured = fact && fact.checked_from_version !== null && placement ? { after: placement.after_link_id, expected_links_version: fact.version } : null;
    pendingOccurrences.set(result.canonical_link_id, {
      key, ref: item.ref, edgeId: result.canonical_link_id, sourceRef: source,
      item, body: null, position: captured, acknowledged: true,
      generation: captureResourceOutlineRead(),
      authoredPosition: captured ? { after: captured.after, linksVersion: captured.expected_links_version } : undefined,
    });
    if (result.created) {
      if (ownsSurface()) {
        const forward: Extract<
          model.Edit,
          {
            kind: "insert_link";
          }
        > = {
          kind: "insert_link",
          endpoint: source,
          source: { kind: "resource", ref: source },
          target: item.ref,
          link_id: result.canonical_link_id,
          position: captured,
          require_created: true,
        };
        const items = history.current.items.slice(0, history.current.index);
        items.push({
          kind: "creation",
          occurrences: [
            { edgeId: result.canonical_link_id, key, item, originSourceRef: source },
          ],
          forward: [forward],
          inverse: [
            {
              kind: "unlink",
              link_id: result.canonical_link_id,

              expected: captured ? { endpoint: source, links_version: captured.expected_links_version } : null,
            },
          ],
          refs: new Set([source, item.ref]),
          selBefore: selection,
          selAfter: { kind: "blocks", anchor: key, keys: [key] },
        });
        history.current = { ...history.current, items, index: items.length };
      }
    }
    publish();
  }
  async function admitAction(action: ChildAction): Promise<{
    key: string;
    noteRef: string;
    ref: string;
    edgeId: string;
    sourceRef: string;
  } | null> {
    if (readWriting().paused) return null;
    const creator = action.creator;
    const canFocus = ownsSurface();
    const generation = interaction.current;
    const focused = document.activeElement;
    if (creator && action.kind === "reference" && store.readText(creator.noteRef)?.acked === null) {
      await store.snapshotText(creator.noteRef);
      const handle = store.textDraft(creator.noteRef);
      const context = handle ? readDraft(handle.draft_id)?.context : null;
      const publication = context?.kind === "body" ? context.publication : null;
      if (publication?.kind === "page" && publication.request.initial_item.kind === "note" && action.target && action.targetItem) {
        const request = publication.request;
        const pageRef = `page:${request.id}`;
        const title = store.readText(pageRef)?.value;
        const item = action.targetItem;
        const linkId = request.initial_item.link_id;
        const endpoint = graph.get(pageRef);
        if (!endpoint) return null;
        const key = createdKey(action.destination, item.ref, linkId);
        graph.set(pageRef, { ...endpoint, links: [{ link_id: linkId, target: node(item.ref) ?? { item, content: { kind: "resource" } }, connection: null }] });
        store.setCreator(creator.noteRef, null);
        const pending: PendingRecord = { key, ref: item.ref, edgeId: linkId, sourceRef: pageRef, item, body: null, position: { after: null, expected_links_version: 1 }, acknowledged: false, generation: null };
        pendingOccurrences.set(linkId, pending);
        const firstPage: Extract<Publication, { kind: "page" }> = { kind: "page", request: { ...request, title: typeof title === "string" && title.trim() ? title : "untitled", initial_item: { kind: "resource", link_id: linkId, target: action.target } } };
        const admitted = admitWriting(firstPage, Promise.all([store.snapshotPageTitle(firstPage), ...(action.authored ? [action.authored] : [])]).then(parts => parts.flat()));
        pending.proof = { intent_id: admitted.intent_id, draft_id: handle?.draft_id ?? null, requested_link_id: linkId, source_ref: pageRef, version: 1 };
        actions.set(prior => prior.filter(item => item !== action));
        publish();
        void admitted.settled.then(reply => {
          const result = reply.insertions.find(value => value.requested_link_id === linkId);
          if (!result) throw new ApiError(409, "E_WRITING_DEPENDENCY_GONE", "the saved first item is no longer available");
          const targetRef = insertionTarget(reply, result);
          const actual = item.ref === targetRef ? item : { ...item, ref: targetRef, activation: { ...item.activation, resource_ref: targetRef } };
          pendingOccurrences.delete(linkId);
          rememberReference(result, actual, reply, createdKey(action.destination, targetRef, result.canonical_link_id));
        }, error => { action.phase = "failed"; actions.set(prior => [...prior, action]); reportRefusal(error); });
        void admitted.durable.catch(reportRefusal);
        return { key, noteRef: item.ref, ref: item.ref, edgeId: linkId, sourceRef: pageRef };
      }
    }
    let parentAdmission: Admission | null = null;
    if (creator && store.readText(creator.noteRef)?.acked === null) {
      const made = store.materializeText({
        ref: creator.noteRef,
        body: creator.base,
      });
      if (!made) {
        action.phase = "failed";
        actions.set((prior) => [...prior]);
        reportRefusal(null);
        return null;
      }
      parentAdmission = { intent_id: made.intent_id, draft_id: store.textDraft(creator.noteRef)?.draft_id ?? null };
      void made.durable.catch(reportRefusal);
      void made.settled.catch(reportRefusal);
    }
    if (action.cancelled) return null;
    const endpoint = sourceRef(action.destination.source);
    const parentVersion = action.destination.position?.expected_links_version ?? graph.get(endpoint)?.links_version;
    const parentDependency: LaneDependency | null = parentAdmission && parentVersion !== undefined && parentVersion !== null
      ? { kind: "result", ...parentAdmission, ref: endpoint, lane: "links", version: parentVersion }
      : null;
    const ref = model.noteRef(action.noteId);
    const key = createdKey(action.destination, ref, action.linkId);
    if (action.kind === "reference") {
      const target = action.target;
      if (target === null) return null;
      const item = action.targetItem;
      if (!item) return null;
      const provisionalKey = createdKey(action.destination, item.ref, action.linkId);
      const pending: PendingRecord = {
        key: provisionalKey, ref: item.ref, edgeId: action.linkId,
        sourceRef: endpoint, item, body: null, position: action.destination.position,
        acknowledged: false, generation: null,
      };
      pendingOccurrences.set(action.linkId, pending);
      const admitted = queueReferenceInsertion({
        input: { kind: "insert_link", require_created: false, source: action.destination.source, target, position: action.destination.position, link_id: action.linkId },
        prelude: action.publication ? wireEdits(publicationEdits(action.publication), ref => ({ kind: "observed", ref, lane: "links", version: 1 })) : [],
        authored: action.authored ?? [],
        dependency: parentDependency,
      });
      const sourceVersion = graph.get(endpoint)?.links_version;
      if (sourceVersion !== undefined) pending.proof = { intent_id: admitted.intent_id, draft_id: null, requested_link_id: action.linkId, source_ref: endpoint, version: sourceVersion };
      publish();
      actions.set(prior => prior.filter(item => item !== action));
      void admitted.settled.then(reply => {
        const result = reply.insertions.find(value => value.requested_link_id === action.linkId);
        if (!result) throw new ApiError(409, "E_WRITING_DEPENDENCY_GONE", "the saved link is no longer available");
        const targetRef = insertionTarget(reply, result);
        const actual = item.ref === targetRef ? item : { ...item, ref: targetRef, action_ref: item.action_ref === item.ref ? targetRef : item.action_ref, activation: { ...item.activation, resource_ref: targetRef } };
        const actualKey = createdKey(action.destination, targetRef, result.canonical_link_id);
        pendingOccurrences.delete(action.linkId);
        rememberReference(result, actual, reply, actualKey);
        invalidateResourceOutlines(new Set([endpoint, result.source_ref]));
      }, error => { action.phase = "failed"; actions.set(prior => [...prior, action]); reportRefusal(error); });
      void admitted.durable.catch(reportRefusal);
      if (canFocus && ownsSurface() && interaction.current === generation) focusRow(provisionalKey, "end", "reference");
      return { key: provisionalKey, noteRef: item.ref, ref: item.ref, edgeId: action.linkId, sourceRef: endpoint };
    }

    const body = action.body;
    const newNode = model.newNoteNode(action.noteId, body);
    const edits: model.Edit[] = [];
    if (action.kind === "split" && action.occurrence && action.left)
      edits.push({
        kind: "set_body",
        note_id: model.noteIdOf(action.occurrence.noteRef),
        body_pm_json: action.left.body_pm_json,
      });
    edits.push({
      kind: "insert_note",
      endpoint,
      source: action.destination.source,
      link_id: action.linkId,
      note_id: action.noteId,
      position: action.destination.position,
      body_pm_json: body.body_pm_json,
    });
    const end = docFromBody(body).firstChild!.content.size + 1;
    const selected: Selection = {
      kind: "text",
      key,
      anchor: action.kind === "split" ? 1 : end,
      head: action.kind === "split" ? 1 : end,
    };
    const leftEnd = action.left
      ? docFromBody(action.left).firstChild!.content.size + 1
      : 1;
    const admitted = commit(
      edits,
      selected,
      true,
      action.occurrence
        ? {
            kind: "text",
            key: action.occurrence.key,
            anchor: leftEnd,
            head: leftEnd,
          }
        : selection,
      {
        publication: action.publication ?? undefined,
        consumed_reference: action.consumed_reference,
        freshNotes: new Set([action.noteId]),
        captured: parentDependency?.kind === "result" ? new Map([[endpoint, {
          ...parentAdmission!, version: parentDependency.version,
        }]]) : undefined,
        occurrences: [
          {
            edgeId: action.linkId,
            key,
            item: newNode.item,
            originSourceRef: endpoint,
            projection: occurrenceProjection(action.destination),
          },
        ],
      },
    );
    if (
      admitted &&
      canFocus &&
      ownsSurface() &&
      interaction.current === generation &&
      (document.activeElement === focused ||
        (focused !== null &&
          !focused.isConnected &&
          document.activeElement === document.body))
    )
      focusRow(key, { anchor: selected.anchor, head: selected.head });
    actions.set((prior) => prior.filter((item) => item !== action));
    return admitted
      ? { key, noteRef: ref, ref, edgeId: action.linkId, sourceRef: endpoint }
      : null;
  }
  function startAction(input: {
    kind: ChildAction["kind"];
    occurrence?: BodyOccurrence;
    destination: OutlineDestination;
    body?: NoteBody;
    left?: NoteBody;
    target?: Schema<"InsertLink">["target"];
    targetItem?: ResourceItem;
    authored?: Promise<AuthoredSnapshot[]>;
    consumed_reference?: ReferenceConsumption | null;
    creator?: BodyCreator;
    publication?: DailyPublication;
  }) {
    const action: ChildAction = {
      kind: input.kind,
      occurrence: input.occurrence ?? null,
      creator: input.creator ?? null,
      destination: captureDestination(input.destination),
      body: structuredClone(input.body ?? emptyBody()),
      left: input.left ? structuredClone(input.left) : null,
      target: input.target ? structuredClone(input.target) : null,
      targetItem: input.targetItem ?? null,
      authored: input.authored ?? null,
      consumed_reference: input.consumed_reference ?? null,
      noteId: crypto.randomUUID(),
      linkId: crypto.randomUUID(),
      publication: input.publication ?? null,
      phase: "creating",
      cancelled: false,
    };
    if (action.creator || action.kind === "reference")
      actions.set((prior) => [...prior, action]);
    return admitAction(action);
  }
  function relinkPlacement({
    placement: source,
    destination,
  }: {
    placement: OutlinePlacement;
    destination: OutlineDestination & {
      source: Schema<"LinkResourceEndpoint">;
    };
  }): boolean {
    if (
      isDeletedResource(source.item.ref) ||
      isDeletedResource(source.endpoint) ||
      source.item.ref === destination.source.ref ||
      pendingUnlinks.has(source.link_id)
    )
      return false;
    const newLink = crypto.randomUUID();
    const key = createdKey(destination, source.item.ref, newLink);
    const body = store.readText(source.item.ref)?.value;
    const end =
      typeof body === "object"
        ? docFromBody(body).firstChild!.content.size + 1
        : 1;
    const activeText = selection?.kind === "text" && selection.key === source.key ? selection : null;
    const after: Selection = activeText ? {...activeText, key} : source.item.ref.startsWith("note_block:")
      ? { kind: "text", key, anchor: end, head: end }
      : { kind: "blocks", anchor: key, keys: [key] };
    const before: Selection =
      selection?.kind === "text" && selection.key === source.key
        ? selection
        : source.item.ref.startsWith("note_block:")
          ? { kind: "text", key: source.key, anchor: end, head: end }
          : { kind: "blocks", anchor: source.key, keys: [source.key] };
    const admitted = commit(
      [
        {
          kind: "relink",
          endpoint: source.endpoint,
          link_id: source.link_id,
          destination: destination.source.ref,
          new_link_id: newLink,
          position: destination.position,
        },
      ],
      after,
      true,
      before,
      {
        occurrences: [
          {
            edgeId: source.link_id,
            key: source.key,
            item: source.item,
            originSourceRef:
              pendingOccurrences.get(source.link_id)?.originSourceRef ??
              source.endpoint,
          },
          {
            edgeId: newLink,
            key,
            item: source.item,
            originSourceRef: destination.source.ref,
            projection: occurrenceProjection(destination),
          },
        ],
        captured: new Map([
          [source.endpoint, source.position.expected_links_version],
        ]),
        inverse: [
          {
            kind: "relink",
            endpoint: destination.source.ref,
            link_id: newLink,
            destination: source.endpoint,
            new_link_id: source.link_id,
            position: source.position,
          },
        ],
      },
    );
    if (admitted && ownsSurface()) {
      view.folds.set(
        model.occurrenceKey(destination.occurrencePrefix, destination.path),
        true,
      );
      if (after.kind === "text") focusRow(key, {anchor: after.anchor, head: after.head, direction: after.direction});
      else {setSelection(after); setFocus(null);}

    }
    return admitted;
  }
  function movePlacement({
    placement: source,
    destination,
  }: {
    placement: OutlinePlacement;
    destination: OutlineDestination;
  }): boolean {
    if (
      destination.source.kind !== "resource" ||
      destination.source.ref !== source.endpoint ||
      destination.position === null ||
      destination.position.expected_links_version !==
        source.position.expected_links_version
    )
      return false;
    return commit(
      [
        {
          kind: "move",
          endpoint: source.endpoint,
          link_id: source.link_id,
          after: destination.position.after,
        },
      ],
      selection,
      true,
      selection,
      {
        captured: new Map([
          [source.endpoint, destination.position.expected_links_version],
        ]),
        inverse: [
          {
            kind: "move",
            endpoint: source.endpoint,
            link_id: source.link_id,
            after: source.position.after,
          },
        ],
      },
    );
  }
  function retryProblem(intent: FailedIntent): string | null {
    if (carried.size > 0) return "wait for the current outline to load";
    const minted = new Set(
      intent.edits.flatMap((edit) =>
        edit.kind === "insert_note" ? [model.noteRef(edit.note_id)] : [],
      ),
    );
    for (const [ref, base] of intent.bodyBases) {
      const saved = store.readText(ref)?.acked;
      const captured = intent.removalBodies.get(ref);
      if (
        saved?.version !== base &&
        !(
          captured &&
          saved &&
          typeof saved.value === "object" &&
          sameBody(captured, saved.value)
        )
      )
        return "a note changed; copy the kept text and resolve its body conflict first";
    }
    for (const edit of intent.edits) {
      if (!("endpoint" in edit)) continue;
      if (!minted.has(edit.endpoint) && !reviewedRefs.has(edit.endpoint))
        return "open the original source and wait for its refreshed items";
      const endpoint =
        edit.kind === "relink" ? edit.destination : edit.endpoint;
      const captured = "position" in edit ? edit.position : null;
      if (
        captured !== null &&
        captured.after !== null &&
        !graph
          .get(endpoint)
          ?.links.some((link) => link.link_id === captured.after) &&
        !intent.edits.some(
          (prior) => "link_id" in prior && prior.link_id === captured.after,
        )
      )
        return "the original predecessor is not loaded; the change cannot move to another slot";
    }
    return null;
  }
  const session = {
    scope,
    view,
    selection,
    focus,
    activeReference,
    pendingUnlinks: new Set(pendingUnlinks),
    removedEdgeIds: new Set([...pendingUnlinks, ...pendingRemovals.keys()]),
    outline: (endpoint: string) => graph.get(endpoint) ?? null,
    inheritedBranch,
    node,
    position,
    placement,
    pendingPlacement,
    canUnlink,
    markInteraction,
    focusRow,
    unlinkOccurrences,
    movePlacement,
    relinkPlacement,
    adoptOutline: adoptReadEvidence,
    adoptRootOccurrences: retirePendingOccurrences,
    pendingOccurrences(endpoint: string): readonly PendingOccurrence[] {
      return [...pendingOccurrences.values()].filter(
        (pending) =>
          !pendingRemovals.has(pending.edgeId) &&
          (pending.sourceRef === endpoint ||
            pending.originSourceRef === endpoint),
      );
    },
    projectChildren({
      endpoint,
      occurrencePrefix,
      path,
      branch,
    }: {
      endpoint: string;
      occurrencePrefix: string;
      path: readonly string[];
      branch: OutlineBranch;
    }): model.Row[] {
      const projection = new Map<string, Pick<model.OutlineData, "links">>(
        graph,
      );
      const links = [...(projection.get(endpoint)?.links ?? [])]
        .filter((link) => !pendingRemovals.has(link.link_id))
        .map((link) => {
          const pending = pendingOccurrences.get(link.link_id);
          return pending &&
            pending.ref === link.target.item.ref &&
            pending.ref.startsWith("note_block:")
            ? {
                ...link,
                noteAuthority:
                  pending.body === null
                    ? ("current" as const)
                    : ("local" as const),
              }
            : link;
        });
      for (const pending of pendingOccurrences.values()) {
        if (
          pendingRemovals.has(pending.edgeId) ||
          (pending.sourceRef !== endpoint &&
            pending.originSourceRef !== endpoint) ||
          links.some((link) => link.link_id === pending.edgeId)
        )
          continue;
        const target =
          node(pending.ref) ??
          (pending.body === null
            ? { item: pending.item, content: { kind: "resource" as const } }
            : model.newNoteNode(model.noteIdOf(pending.ref), pending.body));
        const link: model.OutlineLink = {
          noteAuthority: pending.ref.startsWith("note_block:")
            ? pending.body === null
              ? "current"
              : "local"
            : null,
          link_id: pending.edgeId,
          target,
          connection: null,
        };
        const after = pending.position?.after;
        const at =
          pending.position === null
            ? links.length
            : after === null
              ? 0
              : links.findIndex((current) => current.link_id === after) + 1;
        links.splice(at, 0, link);
      }
      projection.set(endpoint, { links });
      const inherited = branch.ancestors.has(endpoint)
        ? branch
        : enterOutlineOccurrence({
            branch,
            ref: endpoint,
            target: path.length
              ? {
                  kind: "occurrence",
                  key: model.occurrenceKey(occurrencePrefix, path),
                }
              : { kind: "root" },
            edgeIds: [],
          });
      return model.outlineRows({
        graph: projection,
        endpoint,
        occurrencePrefix,
        path,
        view,
        branch: inherited,
      });
    },
    commandOwner,
    composer,
    get insertLabel() { return editorCommands.current?.insertLabel ?? "insert item"; },
    insertionCapability: (ref: string) => insertionCapabilities.get(ref) ?? null,
    registerOccurrence(key: string, occurrence: DirectOccurrence) {
      directOccurrences.current.set(key, occurrence);
      return () => {if (directOccurrences.current.get(key) === occurrence) directOccurrences.current.delete(key);};
    },
    unlinkSelectedOccurrence() {
      if (selection?.kind !== "blocks" || selection.keys.length !== 1) return;
      directOccurrences.current.get(selection.keys[0]!)?.unlink?.();
    },
    registerSurface(owner: object, surface: {
      rows: readonly model.Row[]; rootEndpoint: string; editable: boolean;
      destination(row: model.Row): OutlineDestination | null; publication?: DailyPublication;
    }) {
      surfaces.current.set(owner, surface);
      return () => { surfaces.current.delete(owner); };
    },
    bindEditor(commands: OutlineEditorCommands) {
      editorCommands.current = commands;
      setSelection(prior => prior?.kind === "blocks" ? null : prior);
      setCommandOwner(true);
    },
    releaseEditor(commands: OutlineEditorCommands) {
      if (editorCommands.current === commands) editorCommands.current = null;
    },
    refreshCommands() { rerender(); },
    revokeCommands() {
      setCommandOwner(false);
      setSelection(null);
      setFocus(null);
      editorCommands.current = null;
    },
    openComposer(destination: OutlineDestination, publication?: DailyPublication) {
      if (activeReference !== null) return;
      if (composer !== null) {
        setCommandOwner(true);
        setFocus({key: `insertion:${scope}`, target: "text", selection: "end", serial: ++focusSerial.current});
        return;
      }
      setSelection(null);
      editorCommands.current = null;
      setComposer({ destination: captureDestination(destination), publication, serial: ++focusSerial.current,
        displayAfter: destination.position?.after ?? null,
        body: emptyBody(), selection: {anchor: 1, head: 1}, problem: null });
      setCommandOwner(true);
    },
    closeComposer() { setComposer(null); },
    isActiveEditor(key: string) {return ownsSurface() && editorCommands.current?.key === key;},
    editComposer(body: NoteBody, selection: {anchor: number; head: number}) {
      setComposer(prior => prior ? {...prior, body, selection, problem: null} : null);
    },
    composerProblem(problem: string) {setComposer(prior => prior ? {...prior, problem} : null);},
    readComposer: composerDraft.read,

    commandState(command: OutlineCommand): OutlineCommandState {
      if (!ownsSurface() || !commandOwner) return {enabled: false, reason: "select an item or edit text first"};
      if (editorCommands.current && selection?.kind !== "blocks")
        return editorCommands.current.commandState(command);
      if (activeReference !== null) return {enabled: false, reason: "finish linking or return to prose first"};
      if (command === "undo" || command === "redo") return session.historyState(command);
      if (selection?.kind !== "blocks" || selection.keys.length !== 1)
        return {enabled: false, reason: "select one occurrence"};
      return session.occurrenceCommandState(selection.keys[0]!, command);
    },
    historyState(command: "undo" | "redo"): OutlineCommandState {
      const enabled = command === "undo" ? history.current.index > 0 : history.current.index < history.current.items.length;
      return {enabled, reason: enabled ? null : `nothing to ${command}`};
    },
    occurrenceCommandState(key: string, command: Exclude<OutlineCommand, "undo" | "redo">): OutlineCommandState {
      if (activeReference !== null) return {enabled: false, reason: "finish linking or return to prose first"};
      const surface = [...surfaces.current.values()].find(surface => surface.rows.some(row => row.key === key));
      const row = surface?.rows.find(row => row.key === key);
      if (!surface || !row) {
        const direct = directOccurrences.current.get(key);
        if (!direct?.editable) return {enabled: false, reason: "this outline is read only"};
        const enabled = command === "insert" ? direct.destination !== null
          : command === "indent" ? direct.placement !== null && direct.indentDestination !== null : false;
        return {enabled, reason: enabled ? null : "open the complete source outline to arrange this occurrence"};
      }
      if (!surface.editable) return {enabled: false, reason: "this outline is read only"};
      if (command === "insert") return {enabled: surface.destination(row) !== null, reason: surface.destination(row) ? null : "the insertion position is unavailable"};
      if (!placement(row)) return {enabled: false, reason: "this occurrence cannot be rearranged"};
      const enabled = command === "indent" ? model.indentParent(surface.rows, row) !== null
        : command === "outdent" ? model.outdentEdits(graph, surface.rootEndpoint, row) !== null
        : model.moveEdits(graph, surface.rows, row, command === "move_up" ? -1 : 1) !== null;
      return {enabled, reason: enabled ? null : "no complete permitted position in this direction"};
    },
    executeCommand(command: OutlineCommand) {
      if (!session.commandState(command).enabled) return;
      if (editorCommands.current && selection?.kind !== "blocks") {
        editorCommands.current.executeCommand(command); return;
      }
      if (command === "undo") { session.undo(); return; }
      if (command === "redo") { session.redo(); return; }
      if (selection?.kind !== "blocks" || selection.keys.length !== 1) return;
      session.executeOccurrenceCommand(selection.keys[0]!, command);
    },
    executeOccurrenceCommand(key: string, command: Exclude<OutlineCommand, "undo" | "redo">) {
      if (!session.occurrenceCommandState(key, command).enabled) return;
      const surface = [...surfaces.current.values()].find(surface => surface.rows.some(row => row.key === key));
      const row = surface?.rows.find(row => row.key === key);
      if (!surface || !row) {
        const direct = directOccurrences.current.get(key);
        if (command === "insert" && direct?.destination) session.openComposer(direct.destination);
        else if (command === "indent" && direct?.placement && direct.indentDestination)
          session.relinkPlacement({placement: direct.placement, destination: direct.indentDestination});
        return;
      }
      if (command === "insert") {
        const target = surface.destination(row);
        if (target) session.openComposer(target, surface.publication);
      } else if (command === "indent") session.indent({row, rows: surface.rows});
      else if (command === "outdent") session.outdent({row, rootEndpoint: surface.rootEndpoint});
      else session.move({row, rows: surface.rows, direction: command === "move_up" ? -1 : 1});
    },
    setTextSelection(key: string, at: {anchor: number; head: number; direction?: "forward" | "backward" | "none"}) {
      // Blur/native selection can arrive after structural selection took ownership.
      if (editorCommands.current?.key !== key) return;
      setSelection({kind: "text", key, ...at});
    },
    selectOccurrence(key: string, extend = false, siblingKeys: readonly string[] = [key]) {
      const surface = [...surfaces.current.values()].find(surface => surface.rows.some(row => row.key === key));
      if (surface) session.select({key, rows: surface.rows, extend});
      else if (directOccurrences.current.has(key)) {
        const prior = selection?.kind === "blocks" ? selection : null;
        const anchor = extend && prior ? prior.anchor : key;
        const [a,b] = [siblingKeys.indexOf(anchor), siblingKeys.indexOf(key)];
        setSelection({kind: "blocks", anchor, keys: a >= 0 && b >= 0 ? siblingKeys.slice(Math.min(a,b), Math.max(a,b)+1) : [key]});
        editorCommands.current = null;
        setCommandOwner(true);
        boundaryNext.current = true;
      }
    },
    editTitle({ occurrence, before, after, selectionBefore, selectionAfter, editBase, write }: {
      occurrence: BodyOccurrence; before: string; after: string;
      selectionBefore: {anchor: number; head: number; direction?: "forward" | "backward" | "none"}; selectionAfter: {anchor: number; head: number; direction?: "forward" | "backward" | "none"};
      editBase?: store.TextEditBase; write?: (value: string, editBase?: store.TextEditBase) => void;
    }) {
      if (readWriting().paused) return;
      if (textHistoryOwners.get(occurrence.noteRef) !== owner)
        history.current = retainHistory(history.current, item => item.kind !== "text" || item.ref !== occurrence.noteRef);
      textHistoryOwners.set(occurrence.noteRef, owner);
      const {items, index} = history.current;
      const top = items[index - 1];
      const now = Date.now();
      const selAfter: Selection = {kind: "text", key: occurrence.key, ...selectionAfter};
      if (!boundaryNext.current && top?.kind === "text" && top.ref === occurrence.noteRef && sameTextValue(top.after, before) && now-top.at < 1000)
        Object.assign(top, {after, at: now, selAfter, write});
      else {
        const next = items.slice(0,index);
        next.push({kind: "text", ref: occurrence.noteRef, before, after, at: now, write,
          selBefore: {kind: "text", key: occurrence.key, ...selectionBefore}, selAfter});
        history.current = {items: next, index: next.length};
      }
      boundaryNext.current = false;
      setSelection(selAfter);
      if (write) write(after, editBase);
      else store.editText(occurrence.noteRef, after, editBase, selectionAfter.direction === "backward"
        ? { anchor: selectionAfter.head, head: selectionAfter.anchor }
        : { anchor: selectionAfter.anchor, head: selectionAfter.head });
    },
    editBody({
      occurrence,
      edit,
    }: {
      occurrence: BodyOccurrence;
      edit: NoteEdit;
    }) {
      if (readWriting().paused) return;
      const ref = occurrence.noteRef;
      if (isDeletedResource(ref)) return;
      if (textHistoryOwners.get(ref) !== owner)
        history.current = retainHistory(history.current, item => item.kind !== "text" || item.ref !== ref);
      textHistoryOwners.set(ref, owner);
      for (const action of actions.read())
        if (action.creator?.noteRef === ref) action.cancelled = true;
      actions.set((prior) => prior.filter((action) => !action.cancelled));
      const { items, index } = history.current;
      const top = items[index - 1];
      const now = Date.now();
      const selAfter: Selection = {
        kind: "text",
        key: occurrence.key,
        ...edit.selectionAfter,
      };
      if (
        !boundaryNext.current &&
        edit.source === "input" &&
        top?.kind === "text" &&
        top.ref === ref &&
        now - top.at < 1000 &&
        sameTextValue(top.after, edit.before)
      )
        Object.assign(top, { after: edit.after, at: now, selAfter });
      else {
        const next = items.slice(0, index);
        next.push({
          kind: "text",
          ref,
          before: edit.before,
          after: edit.after,
          at: now,
          selBefore: {
            kind: "text",
            key: occurrence.key,
            ...edit.selectionBefore,
          },
          selAfter,
        });
        history.current = {
          ...history.current,
          items: next,
          index: next.length,
        };
      }
      boundaryNext.current = edit.source !== "input";
      store.editText(ref, edit.after, edit.editBase, edit.selectionAfter);
    },
    splitNote({
      occurrence,
      left,
      right,
      destination,
      publication,
    }: {
      occurrence: BodyOccurrence;
      left: NoteBody;
      right: NoteBody;
      destination: OutlineDestination;
      publication?: DailyPublication;
    }) {
      const text = store.readText(occurrence.noteRef);
      if (!text || typeof text.value !== "object" || text.gone || text.conflict)
        return Promise.resolve(null);
      return startAction({
        kind: "split",
        occurrence,
        left,
        body: right,
        destination,
        publication,
        creator:
          text.acked === null &&
          publication === undefined &&
          ![...carried.values()].some((entry) =>
            entry.texts.has(occurrence.noteRef),
          )
            ? { noteRef: occurrence.noteRef, base: structuredClone(text.value) }
            : undefined,
      });
    },
    insertNote({
      destination,
      body = emptyBody(),
      consumed_reference,
      creator,
      publication,
    }: {
      destination: OutlineDestination;
      body?: NoteBody;
      consumed_reference?: ReferenceConsumption | null;
      creator?: BodyCreator;
      publication?: DailyPublication;
    }) {
      return startAction({
        kind: "note",
        destination,
        body,
        consumed_reference,
        creator,
        publication,
      });
    },
    insertReference({
      destination,
      target,
      targetItem,
      authored,
      creator,
      publication,
    }: {
      destination: OutlineDestination;
      target: Schema<"InsertLink">["target"];
      targetItem: ResourceItem;
      authored: Promise<AuthoredSnapshot[]>;
      creator?: BodyCreator;
      publication?: DailyPublication;
    }) {
      return startAction({
        kind: "reference",
        destination,
        target,
        targetItem,
        authored,
        creator,
        publication,
      });
    },
    undo: () => step(false),
    redo: () => step(true),
    boundary: () => {
      boundaryNext.current = true;
    },
    select({
      key,
      rows,
      extend = false,
    }: {
      key: string;
      rows: readonly model.Row[];
      extend?: boolean;
    }) {
      if (extend && selection?.kind === "blocks") {
        const keys = rows.map((row) => row.key);
        const [a, b] = [keys.indexOf(selection.anchor), keys.indexOf(key)];
        setSelection({
          kind: "blocks",
          anchor: selection.anchor,
          keys: keys.slice(Math.min(a, b), Math.max(a, b) + 1),
        });
      } else setSelection({ kind: "blocks", anchor: key, keys: [key] });
      boundaryNext.current = true;
      editorCommands.current = null;
      setCommandOwner(true);
    },
    clearSelection() {
      setCommandOwner(false);
      setSelection(null);
      setFocus(null);
    },
    setReferenceActive(key: string, active: boolean) {
      if (ownsSurface())
        setActiveReference((current) =>
          active ? key : current === key ? null : current,
        );
    },
    toggle({ key, open }: { key: string; open: boolean }) {
      if (activeReference !== null) return;
      view.folds.set(key, open);
      rerender();
    },
    reveal(target: OutlineTarget) {
      focusRow(target.kind === "root" ? "" : target.key);
    },
    join({
      row,
      rows,
      direction,
    }: {
      row: model.Row;
      rows: readonly model.Row[];
      direction: "backward" | "forward";
    }) {
      const joined = model.joinEdits(graph, rows, row, direction, textBody);
      if (!joined) return;
      if ("refused" in joined) {
        feedback.receipt({ tone: "Neutral", title: joined.refused });
        return;
      }
      const at = { anchor: joined.caret, head: joined.caret };
      if (
        commit(joined.edits, { kind: "text", key: joined.earlier.key, ...at }, true, selection, {
          occurrences: rows.filter(candidate => joined.edits.some(edit => edit.kind === "consume_note" && edit.link_id === candidate.link.link_id)).map(candidate => ({
            edgeId: candidate.link.link_id, key: candidate.key,
            item: candidate.link.target.item, originSourceRef: candidate.endpoint,
          })),
        })
      )
        focusRow(joined.earlier.key, at);
    },
    indent({ row, rows }: { row: model.Row; rows: readonly model.Row[] }) {
      const parent = model.indentParent(rows, row);
      const source = placement(row);
      if (!parent || !source) return;
      view.folds.set(parent.key, true);
      session.relinkPlacement({
        placement: source,
        destination: {
          source: { kind: "resource", ref: parent.link.target.item.ref },
          position: null,
          occurrencePrefix: parent.occurrencePrefix,
          path: parent.path,
        },
      });
    },
    outdent({ row, rootEndpoint }: { row: model.Row; rootEndpoint: string }) {
      const edits = model.outdentEdits(graph, rootEndpoint, row);
      const source = placement(row);
      const edit = edits?.[0];
      if (!source || edit?.kind !== "relink") return;
      session.relinkPlacement({
        placement: source,
        destination: {
          source: { kind: "resource", ref: edit.destination },
          position: edit.position,
          occurrencePrefix: row.occurrencePrefix,
          path: row.path.slice(0, -2),
        },
      });
    },
    move({
      row,
      rows,
      direction,
    }: {
      row: model.Row;
      rows: readonly model.Row[];
      direction: -1 | 1;
    }) {
      const edits = model.moveEdits(graph, rows, row, direction);
      if (edits && placement(row)) commit(edits, selection);
    },
    consume(row: model.Row) {
      if (
        model.structuralRow(row) &&
        row.link.connection?.origin === "user" &&
        row.link.connection.mutation?.kind === "unlink"
      )
        commit(
          [
            {
              kind: "remove",
              endpoint: row.endpoint,
              link_id: row.link.link_id,
            },
          ],
          null,
          true,
          selection,
          { occurrences: [{
            edgeId: row.link.link_id, key: row.key,
            item: row.link.target.item, originSourceRef: row.endpoint,
          }] },
        );
    },
    persisted(ref: string) {
      return store.readText(ref)?.acked != null;
    },
    copy({
      rows,
      clipboard,
      cut,
    }: {
      rows: readonly model.Row[];
      clipboard: DataTransfer;
      cut: boolean;
    }) {
      if (!rows.length || (cut && !rows.every(canUnlink))) return false;
      model.copyRows(rows, textBody, clipboard);
      return !cut || unlinkOccurrences(rows);
    },
    async paste({
      destination: requestedDestination,
      items,
      resources,
      publication,
    }: {
      destination: OutlineDestination;
      items: readonly model.ClipItem[];
      resources: Promise<readonly ResourceItem[]>;
      publication?: DailyPublication;
    }) {
      const destination = captureDestination(requestedDestination);
      const generation = interaction.current;
      const origin = ownsSurface();
      const before = selection;
      const resolvedItems = await resources;
      if (!origin || !ownsSurface() || !items.length) return false;
      const endpoint = sourceRef(destination.source);
      const resolved = new Map(resolvedItems.map((item) => [item.ref, item]));
      if (
        items.some(
          (item) =>
            item.kind === "resource" &&
            node(item.ref) === null &&
            !resolved.has(item.ref),
        )
      ) {
        feedback.receipt({
          tone: "Warning",
          title: "paste not applied; a copied item couldn’t be found",
        });
        return false;
      }
      const edits = model.pasteEdits(
        graph,
        items,
        endpoint,
        destination.source,
        destination.position,
      );
      const contexts: OutlineDestination[] = [];
      const occurrences: OccurrenceIntent[] = [];
      edits.forEach((edit, index) => {
        if (edit.kind !== "insert_note" && edit.kind !== "insert_link") return;
        const item = items[index]!;
        const parent =
          item.parent === null ? destination : contexts[item.parent]!;
        const ref =
          edit.kind === "insert_note"
            ? model.noteRef(edit.note_id)
            : edit.target;
        const resource =
          edit.kind === "insert_note"
            ? model.newNoteNode(edit.note_id, parseBody(edit.body_pm_json)).item
            : (resolved.get(ref) ?? node(ref)?.item);
        if (!resource)
          throw new Error("an admitted paste requires its resolved resource");
        const key = createdKey(parent, ref, edit.link_id);
        occurrences.push({
          edgeId: edit.link_id,
          key,
          item: resource,
          originSourceRef: edit.endpoint,
          projection: occurrenceProjection(parent),
        });
        contexts[index] = {
          source: { kind: "resource", ref },
          position: null,
          occurrencePrefix:
            parent.rootOccurrencePrefix === undefined
              ? parent.occurrencePrefix
              : key,
          path:
            parent.rootOccurrencePrefix === undefined
              ? [...parent.path, edit.link_id]
              : [],
        };
      });
      const last = occurrences.at(-1)!;
      const lastEdit = edits.at(-1)!;
      const body =
        lastEdit.kind === "insert_note"
          ? parseBody(lastEdit.body_pm_json)
          : store.readText(last.item.ref)?.value;
      const end =
        typeof body === "object"
          ? docFromBody(body).firstChild!.content.size + 1
          : 1;
      const after: Selection = last.item.ref.startsWith("note_block:")
        ? { kind: "text", key: last.key, anchor: end, head: end }
        : { kind: "blocks", anchor: last.key, keys: [last.key] };
      const admitted = commit(edits, after, true, before, {
        freshNotes: new Set(edits.flatMap(edit => edit.kind === "insert_note" ? [edit.note_id] : [])),
        captured:
          destination.position === null ||
          destination.position.expected_links_version === null
            ? new Map()
            : new Map([
                [endpoint, destination.position.expected_links_version],
              ]),
        resources: resolved,
        occurrences,
        publication,
      });
      if (admitted && ownsSurface() && interaction.current === generation)
        focusRow(
          last.key,
          "end",
          last.item.ref.startsWith("note_block:") ? "text" : "reference",
        );
      return admitted;
    },
    failedIntents: [
      ...failed.value.map((intent) => ({
        drafts: intent.drafts,
        placements: intent.edits.flatMap((edit) =>
          "endpoint" in edit
            ? [
                {
                  source:
                    graph.get(edit.endpoint)?.source.item.label ??
                    "original item (not loaded)",
                  after:
                    "position" in edit && edit.position?.after
                      ? "original predecessor"
                      : "the start",
                },
              ]
            : [],
        ),
        problem: retryProblem(intent),
      })),
      ...actions.value
        .filter((action) => action.phase === "failed")
        .map((action) => ({
          drafts: [
            ...(action.creator
              ? [{ ref: action.creator.noteRef, body: action.creator.base }]
              : []),
            { ref: model.noteRef(action.noteId), body: action.body },
          ],
          placements: [],
          problem: null,
        })),
    ],
    retryFailed() {
      const intent = failed.read()[0];
      if (!intent) {
        const action = actions
          .read()
          .find((action) => action.phase === "failed");
        if (action) {
          // its failed write broke the position chain: it goes again at the reviewed position.
          const { position, source } = action.destination;
          const version = graph.get(sourceRef(source))?.links_version;
          if (position !== null && version !== undefined)
            action.destination = {
              ...action.destination,
              position: { ...position, expected_links_version: version },
            };
          action.phase = "creating";
          void admitAction(action);
        }
        return;
      }
      if (retryProblem(intent) !== null) return;
      const drafts = new Map(
        intent.drafts.map((draft) => [draft.ref, draft.body]),
      );
      const edits = intent.edits.map((edit) => {
        let next = edit;
        if (edit.kind === "insert_note" || edit.kind === "set_body")
          next = {
            ...edit,
            body_pm_json:
              drafts.get(model.noteRef(edit.note_id))?.body_pm_json ??
              edit.body_pm_json,
          };
        if ("position" in next && next.position !== null) {
          const endpoint =
            next.kind === "relink" ? next.destination : next.endpoint;
          const version = graph.get(endpoint)?.links_version;
          if (version !== undefined)
            next = {
              ...next,
              position: { ...next.position, expected_links_version: version },
            };
        }
        return next;
      });
      failed.set((prior) => prior.slice(1));
      commit(edits, intent.after, true, intent.before, {
        publication: intent.publication ?? undefined,
        occurrences: intent.occurrences,
        inverse: intent.inverse,
      });
    },
  };
  return session;
}
export type OutlineSession = ReturnType<typeof useOutlineSession>;
