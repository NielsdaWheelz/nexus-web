"use client";
// One fetch-free editing session per surface over the tab's canonical graph/texts
// and sole write queue. Occurrence prefixes own view/history; edge paths own facts.
// Captured placements advance only through acknowledged queue proof; retries reuse
// sealed bytes. Refused writes retain drafts and report to the originating scope.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  useFeedback,
  type FeedbackOffer,
} from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import {
  ApiError,
  isApiError,
  isSameSystemApiDefect,
  isStaleBuild,
  STALE_BUILD_FEEDBACK,
} from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  docFromBody,
  emptyBody,
  parseBody,
  sameBody,
  type NoteBody,
} from "./noteBody";
import * as model from "./outline";
import * as store from "./texts";
import {
  enqueueWrite,
  captureWriteSerial,
  advanceLinksVersion,
  sealOutlinePosition,
  nudgeWrites,
} from "./writes";
import {
  isDeletedResource,
  subscribeLinkMutations,
  acknowledgeGraphCommands,
  endpointForResource,
  announceLinkDeletions,
  type Position,
  type InsertionSource,
  type InsertionOut,
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
type Reply = Schema<"OutlineCommandsOut">;
// A source edge introduced by an earlier queued intent supplies its own receipt
// fence. Keeping that cell live does not change the bytes once the head is sealed.
type CapturedLinksVersion = number | model.PendingPositionProof;
const graph: model.Graph = new Map();
const latest = new Map<string, model.OutlineData>();
const reviewedRefs = new Set<string>();
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
    refused: (error: unknown) => void;
  }
>();
function hasCarriedStructure(ref: string): boolean {
  return [...carried.values()].some((entry) => entry.refs.has(ref));
}
let observingLinks = false;
let jobSerial = 0;
let cancelledBefore = 0;
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
    serial: number;
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
      return;
    }
    if (mutation.kind === "deleted") {
      if (mutation.origin === graph) return;
      const ids = new Set([mutation.linkId]);
      const endpoints = linkedEndpoints(ids);
      dropLinks(ids, endpoints);
      publish({ kind: "links", ids, preserve: null });
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
    else if (node.content.kind === "page" && node === live.source)
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
    has_link_note: connection.link_note !== null,
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
const version = (ref: string) => store.readText(ref)?.acked?.version ?? 1;
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
  checked: (ref: string, position?: model.OutlinePosition | null) => number,
  removed: ReadonlyMap<string, string> = new Map(),
  bodyBases: Map<string, number | null> = new Map(),
  removalBodies: ReadonlyMap<string, NoteBody> = new Map(),
): Schema<"OutlineCommandsRequest">["commands"] {
  const position = (
    ref: string,
    captured: model.OutlinePosition | null,
  ): Position | null => {
    if (captured === null) return null;
    const version = checked(ref, captured);
    // checked resolves the originating acknowledgement before using its edge id.
    const after =
      captured.expected_links_version === null &&
      captured.after === captured.proof.requestedEdgeId
        ? captured.proof.acknowledged!.edgeId
        : captured.after;
    return { after, expected_links_version: version };
  };
  return edits.map((edit) => {
    switch (edit.kind) {
      case "insert_note":
        return {
          kind: "insert_note",
          link_id: edit.link_id,
          note_id: edit.note_id,
          source:
            edit.position?.expected_links_version === null
              ? { kind: "resource", ref: edit.position.proof.sourceRef }
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
              ? { kind: "resource", ref: edit.position.proof.sourceRef }
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
        const expected_version = version(ref);
        bodyBases.set(ref, expected_version);
        return { ...edit, expected_version };
      }
      case "set_title":
        return { ...edit, expected_version: version(`page:${edit.page_id}`) };
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
        if (edit.kind === "consume_note") {
          if (expected_body_version === null)
            throw new ApiError(
              409,
              "E_RESOURCE_CONFLICT",
              "the consumed note version is unavailable",
            );
          return { ...edit, kind: "consume_note", expected_body_version };
        }
        return { ...edit, kind: "remove", expected_body_version };
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
  captured: ReadonlyMap<string, CapturedLinksVersion> = new Map(
    [...graph].map(([ref, value]) => [ref, value.links_version]),
  ),
  dependency = captureWriteSerial(),
  onRefused: (error: unknown) => void = () => undefined,
  bodyBases: Map<string, number | null> = new Map(),
  removalBodies: ReadonlyMap<string, NoteBody> = new Map(),
  onAcknowledged: (reply: Reply, serial: number) => void = () => undefined,
) {
  const serial = ++jobSerial;
  carried.set(serial, { texts, refs, refused: onRefused });
  const release = () => {
    carried.delete(serial);
  };
  enqueueWrite<Reply>({
    cancelled: () => [...refs].some(isDeletedResource),
    cancel() {
      refuse(
        new ApiError(
          404,
          "E_NOT_FOUND",
          "a resource used by this change is no longer available",
        ),
        serial,
      );
    },
    build() {
      if (serial <= cancelledBefore) return null;
      const checked = (
        ref: string,
        position?: model.OutlinePosition | null,
      ) => {
        if (position !== undefined && position !== null)
          return sealOutlinePosition(ref, position, dependency).position
            .expected_links_version;
        const minted = edits.some(
          (edit) =>
            edit.kind === "insert_note" && model.noteRef(edit.note_id) === ref,
        );
        const observed = captured.get(ref);
        if (typeof observed === "object")
          return sealOutlinePosition(
            ref,
            {
              after: observed.requestedEdgeId,
              expected_links_version: null,
              proof: observed,
            },
            dependency,
          ).position.expected_links_version;
        const base = observed ?? (minted ? 1 : null);
        if (base === null)
          throw new ApiError(
            409,
            "E_RESOURCE_CONFLICT",
            "the insertion position is no longer loaded",
          );
        const advanced = advanceLinksVersion(ref, base, dependency);
        if (advanced === null)
          throw new ApiError(
            409,
            "E_RESOURCE_CONFLICT",
            "placement changed; refresh before trying this edit again",
          );
        return advanced;
      };
      const commands = wireEdits(
        edits,
        checked,
        removed,
        bodyBases,
        removalBodies,
      );
      return {
        path: "/api/resource-graph/commands",
        method: "POST",
        body: { commands },
      };
    },
    settle(reply, writeSerial) {
      release();
      acknowledge(reply, edits);
      onAcknowledged(reply, writeSerial);
      acknowledgeGraphCommands(reply);
      receive(reply.outlines);
      publishChange("Notes");
      publish();
    },
    fail(error) {
      handleUnauthenticatedApiError(error);
      // The queue calls fail only after an unsent build failure or a definitive
      // rejection. Uncertain writes stay queued and retain their projection.
      refuse(error, serial);
    },
    finalize() {
      release();
      receive([]);
      publish();
    },
  });
}
/** Only carried body writes are acknowledged. Canonical nodes merely read or reused
 * by an insertion are adopted, preserving dirty drafts and opening unopened texts.
 * Deleted notes stop saving unless a later queued write recreates them. */
function acknowledge(reply: Reply, edits: readonly model.Edit[]) {
  const later = [...carried.values()];
  for (const ref of reply.deleted)
    if (!later.some((entry) => entry.texts.has(ref))) store.setGone(ref);
  const inserted = new Set(
    edits.flatMap((e) =>
      e.kind === "insert_note" ? [model.noteRef(e.note_id)] : [],
    ),
  );
  const written = new Set(
    edits.flatMap((edit) =>
      edit.kind === "set_body" || edit.kind === "insert_note"
        ? [model.noteRef(edit.note_id)]
        : [],
    ),
  );
  const targets = reply.outlines.flatMap((outline) =>
    outline.items.map(({ connection, content }) => ({
      item: connection.other,
      content,
    })),
  );
  for (const node of [
    ...reply.nodes,
    ...targets.filter((t) => inserted.has(t.item.ref)),
  ]) {
    if (isDeletedResource(node.item.ref)) continue;
    const body = bodyOf(node);
    if (body && node.content.kind === "note") {
      if (written.has(node.item.ref))
        store.acknowledgeText(node.item.ref, body, node.content.body_version);
      else store.adoptText(node.item.ref, body, node.content.body_version);
    }
  }
}
/** Cancel this write and every queued structure write; reload; reset their texts. */
function refuse(error: unknown, serial: number) {
  const texts = new Set<string>();
  const refs = new Set<string>();
  for (const [at, entry] of [...carried].reverse()) {
    if (at < serial) continue;
    entry.refused(error);
    entry.texts.forEach((ref) => texts.add(ref));
    entry.refs.forEach((ref) => refs.add(ref));
  }
  carried.clear();
  reviewedRefs.clear();
  cancelledBefore = jobSerial;
  latest.clear();
  for (const ref of texts) store.resetText(ref);
  publishChange("Notes");
  publish({ kind: "refused", refs, texts });
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
  creator: store.Creator;
}) {
  const parent = graph.get(endpoint);
  if (!parent || parent.links.length) return;
  const target = model.newNoteNode(noteId, body);
  const link = {
    link_id: linkId,
    has_link_note: false,
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
export type Selection =
  | {
      kind: "text";
      key: string;
      anchor: number;
      head: number;
    }
  | {
      kind: "blocks";
      anchor: string;
      keys: readonly string[];
    }
  | null;
export interface NoteEdit {
  referenceBase?: store.ReferenceBase;
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
  selBefore: Selection;
  selAfter: Selection;
} & (
  | {
      kind: "text";
      ref: string;
      before: NoteBody;
      after: NoteBody;
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
      dependency: number;
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
      zoom: [] as string[],
      focused: null as string | null,
    },
    history: { current: { items: [], index: 0 } as History },
  }));
  const owner = retained.owner;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const view = retained.value.view;
  const history = retained.value.history;
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
  const focusSerial = useRef(0);
  const [activeReference, setActiveReference] = useState<string | null>(null);
  const selectedNow = useRef(selection);
  selectedNow.current = selection;
  const boundaryNext = useRef(true);
  const interaction = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
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
    [],
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
      if (invalidated?.kind === "links")
        history.current = retainHistory(
          history.current,
          (item) =>
            item === invalidated.preserve ||
            !dependsOnEdges(item, invalidated.ids),
        );
      if (invalidated?.kind === "resources" || invalidated?.kind === "refused")
        history.current = retainHistory(history.current, (item) =>
          item.kind === "text"
            ? !(
                invalidated.kind === "refused"
                  ? invalidated.texts
                  : invalidated.refs
              ).has(item.ref)
            : ![...item.refs].some((ref) => invalidated.refs.has(ref)),
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
      dependency?: number;
      onAcknowledged?: (reply: Reply, serial: number) => void;
      inverse?: readonly model.Edit[];
      resources?: ReadonlyMap<string, ResourceItem>;
      occurrences?: readonly OccurrenceIntent[];
    } = {},
  ) {
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
    const dependency = options.dependency ?? captureWriteSerial();
    for (const [ref, version] of options.captured ?? [])
      captured.set(ref, version);
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
        proof.acknowledged === null ||
        typeof observed !== "number" ||
        proof.acknowledged.linksVersion > observed
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
        else store.createText(ref, body, null);
        texts.add(ref);
      }
    }
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
                serial: dependency,
              }
            : undefined,
        proof: {
          requestedEdgeId: edgeId,
          originSourceRef: occurrence.originSourceRef,
          sourceRef: endpoint,
          acknowledged: null,
        },
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
    // Reversed refusal rollback keeps overlays causal; insert this batch's
    // recovery at its captured boundary so retries remain in submission order.
    const failedBefore = failed.read().length;
    sendEdits(
      commands,
      removed,
      texts,
      refs,
      captured,
      dependency,
      (error) => {
        reportRefusal(error);
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
      (reply, writeSerial) => {
        invalidateResourceOutlines(refs);
        const generation = captureResourceOutlineRead();
        for (const admission of admissions) {
          const pending = admission.pending;
          pending.acknowledged = true;
          pending.generation = generation;
          const fact = reply.link_versions.find(
            (value) => value.ref === pending.sourceRef,
          );
          if (fact && pending.proof)
            pending.proof.acknowledged = {
              edgeId: pending.edgeId,
              linksVersion: fact.links_version,
              serial: writeSerial,
            };
          if (admission.sourceEdgeId !== null) {
            if (
              pendingOccurrences.get(admission.sourceEdgeId) ===
              admission.sourcePending
            )
              pendingOccurrences.delete(admission.sourceEdgeId);
            if (admission.removal) admission.removal.generation = generation;
          }
        }
        const insertions = commands.filter(
          (edit) => edit.kind === "insert_note" || edit.kind === "insert_link",
        );
        const reused = new Set<string>();
        reply.insertions.forEach((result, index) => {
          const edit = insertions[index];
          if (!edit) return;
          if (!result.created) reused.add(edit.link_id);
          const connection = result.connection;
          const owner =
            connection.source.ref === connection.other.ref
              ? connection.target.ref
              : connection.source.ref;
          const occurrence = occurrences.find(
            (value) => value.edgeId === edit.link_id,
          );
          const actualKey = occurrence?.projection
            ? createdKey(
                occurrence.projection,
                connection.other.ref,
                connection.edge_id,
              )
            : occurrence?.key;
          const pending = admissions.find(
            (value) => value.edgeId === edit.link_id,
          )?.pending;
          if (pending) {
            pending.sourceRef = owner;
            pending.item = connection.other;
            pending.ref = connection.other.ref;
            pending.edgeId = connection.edge_id;
            if (actualKey) pending.key = actualKey;
            const fact = reply.link_versions.find(
              (value) => value.ref === owner,
            );
            if (fact && pending.proof) {
              pending.proof.sourceRef = owner;
              pending.proof.acknowledged = {
                edgeId: connection.edge_id,
                linksVersion: fact.links_version,
                serial: writeSerial,
              };
            }
            const outline = reply.outlines.find(
              (value) => value.source.item.ref === owner,
            );
            const at =
              outline?.items.findIndex(
                (value) => value.connection.edge_id === connection.edge_id,
              ) ?? -1;
            if (
              connection.origin === "user" &&
              connection.link_note === null &&
              connection.mutation?.kind === "unlink" &&
              outline &&
              at >= 0
            ) {
              pending.authoredPosition = {
                after: outline.items[at - 1]?.connection.edge_id ?? null,
                linksVersion: outline.links_version,
                serial: writeSerial,
              };
            }
            if (!result.created)
              pending.position = pending.authoredPosition
                ? {
                    after: pending.authoredPosition.after,
                    expected_links_version:
                      pending.authoredPosition.linksVersion,
                  }
                : null;
            if (
              connection.edge_id !== edit.link_id &&
              pendingOccurrences.get(edit.link_id) === pending
            ) {
              pendingOccurrences.delete(edit.link_id);
              pendingOccurrences.set(connection.edge_id, pending);
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
                  ? { target: connection.other.ref }
                  : {}),
              };
            return { ...command, endpoint: owner };
          };
          if (recorded) {
            recorded.occurrences = recorded.occurrences.map((value) =>
              value.edgeId === edit.link_id
                ? {
                    ...value,
                    edgeId: connection.edge_id,
                    key: actualKey ?? value.key,
                    item: connection.other,
                  }
                : value,
            );
            recorded.refs = new Set([
              ...recorded.refs,
              owner,
              connection.other.ref,
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
        });
        if (recorded) advanceHistoryPositions(recorded, reply, writeSerial);
        options.onAcknowledged?.(reply, writeSerial);
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
    );
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
              inverse: edits.map((edit) => ({
                kind: "unlink",
                link_id: edit.link_id,
                require_unannotated: true,
              })),
              ...context,
            }
          : {
              kind: "structure",
              forward: edits,
              inverse,
              bodies,
              versions: new Map(captured),
              dependency,
              ...context,
            };
      items.push(recorded);
      history.current = { ...history.current, items, index: items.length };
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
    writeSerial: number,
  ) {
    const advance = (edit: model.Edit): model.Edit => {
      if (!("position" in edit) || edit.position === null) return edit;
      const endpoint =
        edit.kind === "relink" ? edit.destination : edit.endpoint;
      const fact = reply.link_versions.find((value) => value.ref === endpoint);
      return fact
        ? {
            ...edit,
            position: {
              ...edit.position,
              expected_links_version: fact.links_version,
            },
          }
        : edit;
    };
    if (item.kind === "structure") {
      const versions = new Map(item.versions);
      for (const fact of reply.link_versions)
        versions.set(fact.ref, fact.links_version);
      item.versions = versions;
      item.dependency = writeSerial;
      item.forward = item.forward.map(advance);
      item.inverse = item.inverse.map(advance);
    } else
      item.forward = item.forward.map(
        (edit) =>
          advance(edit) as Extract<
            model.Edit,
            {
              kind: "insert_link";
            }
          >,
      );
  }
  function restoreSelection(selected: Selection) {
    if (!ownsSurface()) return;
    if (selected?.kind === "text")
      focusRow(selected.key, { anchor: selected.anchor, head: selected.head });
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
    const ids = new Set(commands.map((command) => command.link_id));
    if (
      !ids.size ||
      ids.size > 1000 ||
      [...ids].some((id) => pendingUnlinks.has(id))
    )
      return false;
    const endpoints = linkedEndpoints(ids);
    const before = selectedNow.current;
    const generation = interaction.current;
    ids.forEach((id) => pendingUnlinks.add(id));
    const release = () => ids.forEach((id) => pendingUnlinks.delete(id));
    let uncertainty: FeedbackOffer | null = null;
    enqueueWrite<Reply>({
      build: () => ({
        path: "/api/resource-graph/commands",
        method: "POST",
        body: { commands },
        link_refs: [...endpoints],
      }),
      settle() {
        uncertainty?.withdraw();
        dropLinks(ids, endpoints);
        release();
        for (const id of ids) pendingOccurrences.delete(id);
        publish({ kind: "links", ids, preserve });
        announceLinkDeletions({ linkIds: [...ids], origin: graph });
        publishChange("Notes");
        if (
          ownsSurface() &&
          selectedNow.current === before &&
          interaction.current === generation
        ) {
          const at = rows.findIndex((row) => ids.has(row.link.link_id));
          const next = [
            ...rows.slice(Math.max(0, at)),
            ...rows.slice(0, Math.max(0, at)).reverse(),
          ].find((row) => !ids.has(row.link.link_id));
          setSelection(null);
          if (next) focusRow(next.key, "end", "control");
        }
        feedback.receipt({
          tone: "Success",
          title:
            ids.size === 1
              ? "link removed; notes kept"
              : `${ids.size} links removed; notes kept`,
        });
      },
      fail(error) {
        if (preserve)
          history.current = retainHistory(
            history.current,
            (item) => item !== preserve,
          );
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        if (
          !isStaleBuild(error) &&
          ![
            "E_RESOURCE_CONFLICT",
            "E_FORBIDDEN",
            "E_NOT_FOUND",
            "E_INVALID_REQUEST",
          ].includes(error.code)
        )
          throw error;
        const ordinarySingle =
          ids.size === 1 &&
          !commands.some((command) => command.require_unannotated);
        const content = isStaleBuild(error)
          ? STALE_BUILD_FEEDBACK
          : ordinarySingle
            ? ({
                tone: "Warning",
                requestId: error.requestId,
                title: "this connection can’t be removed here",
              } as const)
            : ({
                tone: "Warning",
                requestId: error.requestId,
                title:
                  commands.some((command) => command.require_unannotated) &&
                  error.code === "E_RESOURCE_CONFLICT"
                    ? "this link has a note. use remove link to disconnect it."
                    : "some selected items cannot be unlinked. nothing was removed.",
              } as const);
        feedback.offer({
          key: `outline-unlink:${owner}`,
          announcement: "Polite",
          content,
          actions:
            ordinarySingle && !isStaleBuild(error)
              ? [
                  {
                    label: "refresh connections",
                    onClick: () => publishChange("Notes"),
                  },
                ]
              : undefined,
        });
        publishChange("Notes");
      },
      finalize() {
        uncertainty?.withdraw();
        release();
        publish();
      },
      retrying(error) {
        if (uncertainty !== null) return;
        uncertainty = feedback.offer({
          key: `connection-remove:${[...ids].join(":")}`,
          announcement: "Polite",
          content: {
            tone: "Warning",
            title: "couldn’t confirm removal",
            requestId: isApiError(error) ? error.requestId : undefined,
          },
          actions: [{ label: "retry removal", onClick: nudgeWrites }],
        });
      },
    });
    boundaryNext.current = true;
    publish();
    return true;
  }
  function step(redo: boolean) {
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
        return typeof current !== "object" ||
          !sameBody(current, redo ? body.before : body.after)
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
    const selected = redo ? item.selAfter : item.selBefore;
    if (item.kind === "text")
      store.replaceText(item.ref, redo ? item.after : item.before);
    else if (item.kind === "structure") {
      if (
        !commit(
          redo ? item.forward : item.inverse,
          selected,
          false,
          selection,
          {
            occurrences: item.occurrences,
            captured: item.versions,
            dependency: item.dependency,
            onAcknowledged: (reply, serial) =>
              advanceHistoryPositions(item, reply, serial),
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
          onAcknowledged: (reply, serial) =>
            advanceHistoryPositions(item, reply, serial),
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
  function unlinkOccurrences(rows: readonly model.Row[]): boolean {
    if (!rows.length || !rows.every(canUnlink)) {
      feedback.receipt({
        tone: "Warning",
        title: "some selected items cannot be unlinked. nothing was removed.",
      });
      return false;
    }
    return sendUnlink({
      commands: [...new Set(rows.map((row) => row.link.link_id))].map(
        (link_id) => ({ kind: "unlink", link_id, require_unannotated: false }),
      ),
      preserve: null,
      rows,
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
    const receipt = pending.proof?.acknowledged;
    const version = advanceLinksVersion(
      pending.sourceRef,
      receipt?.linksVersion ?? captured.linksVersion,
      receipt?.serial ?? captured.serial,
    );
    if (version === null) return null;
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
    result: InsertionOut,
    source: string,
    captured: Position | null,
    outlines: readonly model.WireOutline[],
    key: string,
    writeSerial: number,
  ) {
    receive(outlines);
    const connection = result.connection;
    const item =
      connection.source.ref === source ? connection.target : connection.source;
    const outline = outlines.find((value) => value.source.item.ref === source);
    const at =
      outline?.items.findIndex(
        (value) => value.connection.edge_id === connection.edge_id,
      ) ?? -1;
    const authorized =
      connection.origin === "user" &&
      connection.link_note === null &&
      connection.mutation?.kind === "unlink";
    const authoredPosition =
      authorized && at >= 0 && outline
        ? {
            after: outline.items[at - 1]?.connection.edge_id ?? null,
            linksVersion: outline.links_version,
            serial: writeSerial,
          }
        : authorized && result.created && captured !== null
          ? {
              after: captured.after,
              linksVersion: captured.expected_links_version,
              serial: writeSerial,
            }
          : undefined;
    pendingOccurrences.set(connection.edge_id, {
      key,
      ref: item.ref,
      edgeId: connection.edge_id,
      sourceRef: source,
      item,
      body: null,
      position: captured,
      acknowledged: true,
      generation: captureResourceOutlineRead(),
      authoredPosition,
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
          link_id: connection.edge_id,
          position: captured,
          require_created: true,
        };
        const items = history.current.items.slice(0, history.current.index);
        items.push({
          kind: "creation",
          occurrences: [
            { edgeId: connection.edge_id, key, item, originSourceRef: source },
          ],
          forward: [forward],
          inverse: [
            {
              kind: "unlink",
              link_id: connection.edge_id,
              require_unannotated: true,
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
    const creator = action.creator;
    const canFocus = ownsSurface();
    const generation = interaction.current;
    const focused = document.activeElement;
    if (creator && store.readText(creator.noteRef)?.acked === null) {
      const made = await store.materializeText({
        ref: creator.noteRef,
        body: creator.base,
        cancelled: () => action.cancelled,
      });
      const current = store.readText(creator.noteRef)?.value;
      if (
        action.cancelled ||
        typeof current !== "object" ||
        !sameBody(current, creator.base)
      ) {
        actions.set((prior) => prior.filter((item) => item !== action));
        return null;
      }
      if (!made) {
        action.phase = "failed";
        actions.set((prior) => [...prior]);
        reportRefusal(null);
        return null;
      }
    }
    if (action.cancelled) return null;
    const endpoint = sourceRef(action.destination.source);
    const ref = model.noteRef(action.noteId);
    const key = createdKey(action.destination, ref, action.linkId);
    if (action.kind === "reference") {
      const target = action.target;
      if (target === null) return null;
      return new Promise((resolve) =>
        queueReferenceInsertion({
          input: {
            kind: "insert_link",
            require_created: false,
            source: action.destination.source,
            target,
            position: action.destination.position,
            link_id: action.linkId,
          },
          prelude: action.publication
            ? wireEdits(publicationEdits(action.publication), () => 1)
            : [],
          serial: captureWriteSerial(),
          settle(reply, writeSerial) {
            acknowledge(reply, []);
            const result = reply.insertions.at(-1)!;
            const connection = result.connection;
            const actualSource =
              connection.source.ref === connection.other.ref
                ? connection.target.ref
                : connection.source.ref;
            const actual = connection.other;
            const actualKey = createdKey(
              action.destination,
              actual.ref,
              result.connection.edge_id,
            );
            rememberReference(
              result,
              actualSource,
              action.destination.position === null
                ? null
                : {
                    after: action.destination.position.after,
                    expected_links_version: reply.link_versions.find(
                      (fact) => fact.ref === actualSource,
                    )!.links_version,
                  },
              reply.outlines,
              actualKey,
              writeSerial,
            );
            const pending = pendingOccurrences.get(result.connection.edge_id);
            invalidateResourceOutlines(new Set([endpoint, actualSource]));
            if (pending) {
              pending.originSourceRef = endpoint;
              pending.generation = captureResourceOutlineRead();
              const fact = reply.link_versions.find(
                (value) => value.ref === actualSource,
              );
              if (fact)
                pending.proof = {
                  requestedEdgeId: connection.edge_id,
                  originSourceRef: endpoint,
                  sourceRef: actualSource,
                  acknowledged: {
                    edgeId: connection.edge_id,
                    linksVersion: fact.links_version,
                    serial: writeSerial,
                  },
                };
            }
            actions.set((prior) => prior.filter((item) => item !== action));
            if (
              canFocus &&
              ownsSurface() &&
              interaction.current === generation &&
              (document.activeElement === focused ||
                (focused !== null &&
                  !focused.isConnected &&
                  document.activeElement === document.body))
            )
              focusRow(actualKey, "end", "reference");
            feedback.receipt({
              tone: result.created ? "Success" : "Info",
              title: result.created ? "linked" : "already linked",
            });
            resolve({
              key: actualKey,
              noteRef: actual.ref,
              ref: actual.ref,
              edgeId: result.connection.edge_id,
              sourceRef: actualSource,
            });
          },
          fail(error) {
            action.phase = "failed";
            actions.set((prior) => [...prior]);
            reportRefusal(error);
            resolve(null);
          },
          retrying() {
            publish();
          },
        }),
      );
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
    const after: Selection = source.item.ref.startsWith("note_block:")
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
      focusRow(
        key,
        "end",
        source.item.ref.startsWith("note_block:") ? "text" : "reference",
      );
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
          has_link_note: false,
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
      const actual =
        view.focused !== null &&
        view.focused === model.occurrenceKey(occurrencePrefix, path)
          ? {
              ancestors: new Map([[endpoint, { kind: "root" as const }]]),
              traversedEdgeIds: new Set<string>(),
            }
          : inherited;
      return model.outlineRows({
        graph: projection,
        endpoint,
        occurrencePrefix,
        path,
        view,
        branch: actual,
      });
    },
    editBody({
      occurrence,
      edit,
    }: {
      occurrence: BodyOccurrence;
      edit: NoteEdit;
    }) {
      const ref = occurrence.noteRef;
      if (isDeletedResource(ref)) return;
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
        sameBody(top.after, edit.before)
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
      store.editText(ref, edit.after, edit.referenceBase);
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
      creator,
      publication,
    }: {
      destination: OutlineDestination;
      body?: NoteBody;
      creator?: BodyCreator;
      publication?: DailyPublication;
    }) {
      return startAction({
        kind: "note",
        destination,
        body,
        creator,
        publication,
      });
    },
    insertReference({
      destination,
      target,
      creator,
      publication,
    }: {
      destination: OutlineDestination;
      target: Schema<"InsertLink">["target"];
      creator?: BodyCreator;
      publication?: DailyPublication;
    }) {
      return startAction({
        kind: "reference",
        destination,
        target,
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
    },
    clearSelection() {
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
    focusBranch(key: string) {
      if (activeReference !== null) return;
      view.focused = key;
      rerender();
    },
    showAll() {
      if (activeReference !== null) return;
      view.focused = null;
      rerender();
    },
    reveal(target: OutlineTarget) {
      focusRow(target.kind === "root" ? "" : target.key);
    },
    zoom(row: model.Row) {
      view.zoom = [...row.path];
      focusRow("");
      rerender();
    },
    zoomOut() {
      view.zoom = view.zoom.slice(0, -1);
      focusRow("");
      rerender();
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
        commit(joined.edits, { kind: "text", key: joined.earlier.key, ...at })
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
    drop({
      row,
      target,
      placement: side,
    }: {
      row: model.Row;
      target: model.Row;
      placement: "before" | "after" | "inside";
    }) {
      const edits = model.dropEdits(graph, row, target, side);
      const source = placement(row);
      const edit = edits?.[0];
      if (!source || !edit) return;
      if (edit.kind === "move") commit(edits!, selection);
      else if (edit.kind === "relink") {
        if (side === "inside") view.folds.set(target.key, true);
        session.relinkPlacement({
          placement: source,
          destination: {
            source: { kind: "resource", ref: edit.destination },
            position: edit.position,
            occurrencePrefix: target.occurrencePrefix,
            path: side === "inside" ? target.path : target.path.slice(0, -1),
          },
        });
      }
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
      const dependency = captureWriteSerial();
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
        dependency,
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
