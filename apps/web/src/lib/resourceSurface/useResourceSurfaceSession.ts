"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  commandResourceSurface,
  fetchResourceSurface,
  resourceSurfaceCommandId,
  updateResourceSurfaceNoteBody,
  updateResourceSurfaceTitle,
  type ResourceSurfaceCommand,
} from "@/lib/resourceSurface/api";
import { isApiError } from "@/lib/api/client";
import type { ResourceItem, ResourceSurface, ResourceSurfaceOccurrence } from "@/lib/resources/resourceItems";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { isRecord } from "@/lib/validation";

const IDLE_DELAY_MS = 1500;
const MAX_WAIT_MS = 5000;
const STORAGE_PREFIX = "nexus.resourceSurface:";

type Status = "clean" | "dirty" | "saving" | "recovered" | "failed";
type PositionRef = { kind: "start" } | { kind: "after"; targetRef: string };
type Intent = {
  clientMutationId: string;
  command: ResourceSurfaceCommand;
  occurrenceTargetRef?: string;
  position?: PositionRef;
};
type PendingTitle = {
  value: string;
  clientMutationId: string;
};
type PendingBody = {
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  clientMutationId: string;
};
type Draft = {
  version: 1;
  source_ref: string;
  acknowledged_surface: ResourceSurface;
  commands: Intent[];
  title?: {
    value: string;
    client_mutation_id: string;
  };
  bodies: Record<string, {
    body_pm_json: Record<string, unknown>;
    body_text: string;
    client_mutation_id: string;
  }>;
};

export interface ResourceSurfaceSession {
  surface: ResourceSurface;
  status: Status;
  hasRecoveredDraft: boolean;
  updateTitle(title: string): void;
  updateBody(input: { occurrenceId: string; bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }): void;
  updateSourceNoteBody(input: { bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }): void;
  command(command: ResourceSurfaceCommand): void;
  flush(): void;
  retry(): void;
  reload(): Promise<void>;
  copyRecovery(): Promise<void>;
}

function lane(item: ResourceItem, name: "title" | "body" | "outgoing_edges") {
  const value = item.versionByLane[name];
  if (typeof value !== "number") throw new Error(`Resource surface is missing ${name} version for ${item.ref}`);
  return value;
}

function occurrenceForRef(surface: ResourceSurface, ref: string) {
  return surface.orderedItems.find((item) => item.target.item.ref === ref);
}

function positionFor(surface: ResourceSurface, position: PositionRef) {
  if (position.kind === "start") return { kind: "start" } as const;
  const occurrence = occurrenceForRef(surface, position.targetRef);
  return occurrence ? { kind: "after" as const, occurrenceId: occurrence.occurrenceId } : null;
}

function insertIndex(items: ResourceSurfaceOccurrence[], position: { kind: "start" } | { kind: "after"; occurrenceId: string }) {
  if (position.kind === "start") return 0;
  const index = items.findIndex((item) => item.occurrenceId === position.occurrenceId);
  return index < 0 ? items.length : index + 1;
}

function localOccurrence(surface: ResourceSurface, noteId: string, bodyPmJson: Record<string, unknown>): ResourceSurfaceOccurrence {
  const ref = `note_block:${noteId}`;
  return {
    occurrenceId: `local:${noteId}`,
    target: {
      item: { ...surface.source.item, ref, scheme: "note_block", id: noteId, label: "", summary: "", route: `/notes/${noteId}`, activation: { resourceRef: ref, kind: "route", href: `/notes/${noteId}`, unresolvedReason: null }, versionByLane: { body: 0, outgoing_edges: 0 } },
      content: { kind: "note_body", bodyPmJson, bodyText: "" },
    },
  };
}

function optimistic(surface: ResourceSurface, command: ResourceSurfaceCommand): ResourceSurface {
  if (command.type === "remove_occurrence") return { ...surface, orderedItems: surface.orderedItems.filter((item) => item.occurrenceId !== command.occurrenceId) };
  if (command.type === "move_occurrence") {
    const occurrence = surface.orderedItems.find((item) => item.occurrenceId === command.occurrenceId);
    if (!occurrence) return surface;
    const orderedItems = surface.orderedItems.filter((item) => item !== occurrence);
    orderedItems.splice(insertIndex(orderedItems, command.position), 0, occurrence);
    return { ...surface, orderedItems };
  }
  if (command.type === "insert_note") {
    const orderedItems = [...surface.orderedItems];
    orderedItems.splice(insertIndex(orderedItems, command.position), 0, localOccurrence(surface, command.noteId, command.bodyPmJson));
    return { ...surface, orderedItems };
  }
  if (command.type === "split_note") {
    const orderedItems = surface.orderedItems.map((item) => item.occurrenceId === command.occurrenceId && item.target.content.kind === "note_body" ? { ...item, target: { ...item.target, content: { kind: "note_body" as const, bodyPmJson: command.leftBodyPmJson, bodyText: "" } } } : item);
    const index = orderedItems.findIndex((item) => item.occurrenceId === command.occurrenceId);
    orderedItems.splice(index < 0 ? orderedItems.length : index + 1, 0, localOccurrence(surface, command.noteId, command.rightBodyPmJson));
    return { ...surface, orderedItems };
  }
  const parsedTarget = parseResourceRef(command.targetRef);
  if (parsedTarget === null) {
    throw new TypeError("insert_resource targetRef must be canonical");
  }
  const orderedItems = [...surface.orderedItems];
  orderedItems.splice(insertIndex(orderedItems, command.position), 0, { occurrenceId: `local:${command.targetRef}`, target: { item: { ...surface.source.item, ref: command.targetRef, scheme: parsedTarget.scheme, id: parsedTarget.id, label: "Resource", summary: "", route: null, activation: { resourceRef: command.targetRef, kind: "none", href: null, unresolvedReason: null } }, content: { kind: "resource_summary" } } });
  return { ...surface, orderedItems };
}

function intentFor(
  surface: ResourceSurface,
  command: ResourceSurfaceCommand,
): Intent | null {
  const occurrenceId = command.type === "split_note" || command.type === "move_occurrence" || command.type === "remove_occurrence" ? command.occurrenceId : undefined;
  const occurrenceTargetRef = occurrenceId ? surface.orderedItems.find((item) => item.occurrenceId === occurrenceId)?.target.item.ref : undefined;
  const rawPosition = command.type === "insert_note" || command.type === "insert_resource" || command.type === "move_occurrence" ? command.position : undefined;
  const position: PositionRef | undefined = rawPosition?.kind === "after" ? (() => {
    const target = surface.orderedItems.find((item) => item.occurrenceId === rawPosition.occurrenceId);
    return target ? { kind: "after" as const, targetRef: target.target.item.ref } : undefined;
  })() : rawPosition;
  if (rawPosition?.kind === "after" && !position) return null;
  if (occurrenceId && !occurrenceTargetRef) return null;
  return { clientMutationId: resourceSurfaceCommandId(), command, occurrenceTargetRef, position };
}

function materialize(surface: ResourceSurface, intent: Intent): ResourceSurfaceCommand | null {
  const occurrence = intent.occurrenceTargetRef ? occurrenceForRef(surface, intent.occurrenceTargetRef) : undefined;
  const position = intent.position ? positionFor(surface, intent.position) : undefined;
  const command = intent.command;
  if (command.type === "insert_note" && position) return { ...command, position };
  if (command.type === "insert_resource" && position) return { ...command, position };
  if (command.type === "move_occurrence" && occurrence && position) return { ...command, occurrenceId: occurrence.occurrenceId, position };
  if (command.type === "remove_occurrence" && occurrence) return { ...command, occurrenceId: occurrence.occurrenceId };
  if (command.type === "split_note" && occurrence) return { ...command, occurrenceId: occurrence.occurrenceId };
  return null;
}

function readDraft(sourceRef: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${sourceRef}`);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    const validTitle =
      draft.title === undefined ||
      (
        isRecord(draft.title) &&
        typeof draft.title.value === "string" &&
        typeof draft.title.client_mutation_id === "string"
      );
    const validBodies =
      isRecord(draft.bodies) &&
      Object.values(draft.bodies).every(
        (body) =>
          isRecord(body) &&
          isRecord(body.body_pm_json) &&
          typeof body.body_text === "string" &&
          typeof body.client_mutation_id === "string",
      );
    if (
      draft.version === 1 &&
      draft.source_ref === sourceRef &&
      isRecord(draft.acknowledged_surface) &&
      Array.isArray(draft.commands) &&
      validTitle &&
      validBodies
    ) {
      return draft as Draft;
    }
    window.localStorage.removeItem(`${STORAGE_PREFIX}${sourceRef}`);
  } catch {
    try {
      window.localStorage.removeItem(`${STORAGE_PREFIX}${sourceRef}`);
    } catch {
      // Browser storage is optional recovery state.
    }
  }
  return null;
}

export function useResourceSurfaceSession({ sourceRef, initialSurface, onError }: { sourceRef: string; initialSurface: ResourceSurface; onError?: (error: unknown) => void }): ResourceSurfaceSession {
  const [surface, setSurface] = useState(initialSurface);
  const [status, setStatus] = useState<Status>("clean");
  const [hasRecoveredDraft, setHasRecoveredDraft] = useState(false);
  const acknowledgedRef = useRef(initialSurface);
  const intentsRef = useRef<Intent[]>([]);
  const titleRef = useRef<PendingTitle | undefined>(undefined);
  const bodiesRef = useRef(new Map<string, PendingBody>());
  const activeRef = useRef(false);
  const intrinsicActiveRef = useRef(new Set<string>());
  const stoppedRef = useRef(false);
  const requiresRebaseRef = useRef(false);
  const generationRef = useRef(0);
  const idleRef = useRef<number | null>(null);
  const maxRef = useRef<number | null>(null);
  const pumpRef = useRef<() => void>(() => undefined);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;

  const settleStatus = useCallback(() => {
    if (stoppedRef.current) {
      setStatus("failed");
    } else if (activeRef.current || intrinsicActiveRef.current.size > 0) {
      setStatus("saving");
    } else if (
      intentsRef.current.length > 0 ||
      titleRef.current !== undefined ||
      bodiesRef.current.size > 0
    ) {
      setStatus("dirty");
    } else {
      setStatus("clean");
    }
  }, []);

  const derived = useCallback(() => {
    let next = acknowledgedRef.current;
    for (const intent of intentsRef.current) {
      const command = materialize(next, intent);
      if (command) next = optimistic(next, command);
    }
    if (titleRef.current !== undefined && next.source.content.kind === "page_title") next = { ...next, source: { ...next.source, content: { kind: "page_title", title: titleRef.current.value } } };
    const applyBody = (item: ResourceSurfaceOccurrence) => {
      const body = bodiesRef.current.get(item.target.item.ref);
      return body && item.target.content.kind === "note_body" ? { ...item, target: { ...item.target, content: { kind: "note_body" as const, bodyPmJson: body.bodyPmJson, bodyText: body.bodyText } } } : item;
    };
    next = { ...next, orderedItems: next.orderedItems.map(applyBody) };
    const sourceBody = bodiesRef.current.get(next.source.item.ref);
    if (sourceBody && next.source.content.kind === "note_body") next = { ...next, source: { ...next.source, content: { kind: "note_body", bodyPmJson: sourceBody.bodyPmJson, bodyText: sourceBody.bodyText } } };
    return next;
  }, []);

  const publish = useCallback(() => setSurface(derived()), [derived]);
  const store = useCallback(() => {
    const bodies: Draft["bodies"] = {};
    for (const [ref, body] of bodiesRef.current) {
      bodies[ref] = {
        body_pm_json: body.bodyPmJson,
        body_text: body.bodyText,
        client_mutation_id: body.clientMutationId,
      };
    }
    try {
      if (!intentsRef.current.length && titleRef.current === undefined && !Object.keys(bodies).length) {
        window.localStorage.removeItem(`${STORAGE_PREFIX}${sourceRef}`);
        setHasRecoveredDraft(false);
        return;
      }
      window.localStorage.setItem(`${STORAGE_PREFIX}${sourceRef}`, JSON.stringify({
        version: 1,
        source_ref: sourceRef,
        acknowledged_surface: acknowledgedRef.current,
        commands: intentsRef.current,
        ...(titleRef.current === undefined ? {} : {
          title: {
            value: titleRef.current.value,
            client_mutation_id: titleRef.current.clientMutationId,
          },
        }),
        bodies,
      } satisfies Draft));
    } catch {
      // Browser storage is a recovery aid; unavailable storage must not block editing.
    }
  }, [sourceRef]);

  const clearTimers = useCallback(() => { if (idleRef.current !== null) window.clearTimeout(idleRef.current); if (maxRef.current !== null) window.clearTimeout(maxRef.current); idleRef.current = null; maxRef.current = null; }, []);

  const saveIntrinsics = useCallback(() => {
    clearTimers();
    const ack = acknowledgedRef.current;
    const generation = generationRef.current;
    const title = titleRef.current;
    const bodies = [...bodiesRef.current];
    if (title !== undefined && ack.source.content.kind === "page_title" && !intrinsicActiveRef.current.has(ack.source.item.ref)) {
      intrinsicActiveRef.current.add(ack.source.item.ref);
      setStatus("saving");
      void updateResourceSurfaceTitle({
        sourceRef,
        clientMutationId: title.clientMutationId,
        baseVersion: lane(ack.source.item, "title"),
        title: title.value,
      }).then((item) => {
        if (generation !== generationRef.current) return;
        acknowledgedRef.current = {
          ...acknowledgedRef.current,
          source: {
            ...acknowledgedRef.current.source,
            item,
            content: acknowledgedRef.current.source.content.kind === "page_title"
              ? { kind: "page_title", title: title.value }
              : acknowledgedRef.current.source.content,
          },
        };
        if (titleRef.current === title) titleRef.current = undefined;
        publish();
        store();
      }).catch((error) => {
        if (generation !== generationRef.current) return;
        stoppedRef.current = true;
        requiresRebaseRef.current ||= (
          isApiError(error) && error.code === "E_RESOURCE_CONFLICT"
        );
        setStatus("failed");
        store();
        onErrorRef.current?.(error);
      }).finally(() => {
        if (generation !== generationRef.current) return;
        intrinsicActiveRef.current.delete(ack.source.item.ref);
        if (!stoppedRef.current) saveIntrinsics();
        settleStatus();
      });
    }
    for (const [ref, body] of bodies) {
      if (intrinsicActiveRef.current.has(ref)) continue;
      const sourceItem = ack.source.item.ref === ref ? ack.source.item : occurrenceForRef(ack, ref)?.target.item;
      if (!sourceItem) continue;
      intrinsicActiveRef.current.add(ref);
      setStatus("saving");
      void updateResourceSurfaceNoteBody({
        noteRef: ref,
        clientMutationId: body.clientMutationId,
        baseVersion: lane(sourceItem, "body"),
        bodyPmJson: body.bodyPmJson,
      }).then((result) => {
        if (generation !== generationRef.current) return;
        if (bodiesRef.current.get(ref) === body) bodiesRef.current.delete(ref);
        if (acknowledgedRef.current.source.item.ref === ref) {
          acknowledgedRef.current = {
            ...acknowledgedRef.current,
            source: {
              ...acknowledgedRef.current.source,
              item: result.item,
              content: acknowledgedRef.current.source.content.kind === "note_body"
                ? { kind: "note_body", bodyPmJson: body.bodyPmJson, bodyText: result.bodyText }
                : acknowledgedRef.current.source.content,
            },
          };
        } else {
          acknowledgedRef.current = {
            ...acknowledgedRef.current,
            orderedItems: acknowledgedRef.current.orderedItems.map((row) =>
              row.target.item.ref === ref && row.target.content.kind === "note_body"
                ? {
                    ...row,
                    target: {
                      ...row.target,
                      item: result.item,
                      content: {
                        kind: "note_body",
                        bodyPmJson: body.bodyPmJson,
                        bodyText: result.bodyText,
                      },
                    },
                  }
                : row,
            ),
          };
        }
        publish();
        store();
      }).catch((error) => {
        if (generation !== generationRef.current) return;
        stoppedRef.current = true;
        requiresRebaseRef.current ||= (
          isApiError(error) && error.code === "E_RESOURCE_CONFLICT"
        );
        setStatus("failed");
        store();
        onErrorRef.current?.(error);
      }).finally(() => {
        if (generation !== generationRef.current) return;
        intrinsicActiveRef.current.delete(ref);
        if (!stoppedRef.current) {
          saveIntrinsics();
          pumpRef.current();
        }
        settleStatus();
      });
    }
    settleStatus();
  }, [clearTimers, publish, settleStatus, sourceRef, store]);

  const pump = useCallback(() => {
    if (
      activeRef.current ||
      intrinsicActiveRef.current.size > 0 ||
      stoppedRef.current ||
      !intentsRef.current.length
    ) {
      return;
    }
    const intent = intentsRef.current[0]!;
    const command = materialize(acknowledgedRef.current, intent);
    if (!command) {
      const error = new Error(
        "This edit no longer matches the current resource order.",
      );
      stoppedRef.current = true;
      setStatus("failed");
      store();
      onErrorRef.current?.(error);
      return;
    }
    if (command.type === "split_note") {
      const left = acknowledgedRef.current.orderedItems.find((item) => item.occurrenceId === command.occurrenceId);
      if (left && intrinsicActiveRef.current.has(left.target.item.ref)) return;
    }
    activeRef.current = true; setStatus("saving");
    const generation = generationRef.current;
    const bases: Array<{ ref: string; lane: "body" | "outgoing_edges"; version: number }> = [{ ref: acknowledgedRef.current.source.item.ref, lane: "outgoing_edges", version: lane(acknowledgedRef.current.source.item, "outgoing_edges") }];
    if (command.type === "split_note") { const row = acknowledgedRef.current.orderedItems.find((item) => item.occurrenceId === command.occurrenceId); if (!row) { stoppedRef.current = true; activeRef.current = false; setStatus("failed"); return; } bases.push({ ref: row.target.item.ref, lane: "body" as const, version: lane(row.target.item, "body") }); }
    void commandResourceSurface({ sourceRef, clientMutationId: intent.clientMutationId, baseVersions: bases, command }).then((next) => {
      if (generation !== generationRef.current) return;
      acknowledgedRef.current = next;
      intentsRef.current = intentsRef.current.filter((item) => item !== intent);
      activeRef.current = false;
      publish();
      store();
      saveIntrinsics();
      settleStatus();
      pumpRef.current();
    }).catch((error) => {
      if (generation !== generationRef.current) return;
      activeRef.current = false;
      stoppedRef.current = true;
      requiresRebaseRef.current ||= (
        isApiError(error) && error.code === "E_RESOURCE_CONFLICT"
      );
      setStatus("failed");
      store();
      onErrorRef.current?.(error);
    });
  }, [publish, saveIntrinsics, settleStatus, sourceRef, store]);
  pumpRef.current = pump;

  const schedule = useCallback(() => { if (idleRef.current !== null) window.clearTimeout(idleRef.current); idleRef.current = window.setTimeout(saveIntrinsics, IDLE_DELAY_MS); if (maxRef.current === null) maxRef.current = window.setTimeout(saveIntrinsics, MAX_WAIT_MS); }, [saveIntrinsics]);

  useEffect(() => {
    generationRef.current += 1;
    const draft = readDraft(sourceRef);
    acknowledgedRef.current = draft?.acknowledged_surface ?? initialSurface;
    intentsRef.current = draft?.commands ?? [];
    titleRef.current = draft?.title
      ? {
          value: draft.title.value,
          clientMutationId: draft.title.client_mutation_id,
        }
      : undefined;
    bodiesRef.current = new Map(
      Object.entries(draft?.bodies ?? {}).map(([ref, body]) => [
        ref,
        {
          bodyPmJson: body.body_pm_json,
          bodyText: body.body_text,
          clientMutationId: body.client_mutation_id,
        },
      ]),
    );
    intrinsicActiveRef.current.clear();
    stoppedRef.current = false;
    requiresRebaseRef.current = false;
    activeRef.current = false;
    publish();
    setHasRecoveredDraft(Boolean(draft));
    setStatus(draft ? "recovered" : "clean");
    return clearTimers;
  }, [clearTimers, initialSurface, publish, sourceRef]);

  const updateTitle = useCallback((title: string) => {
    const source = acknowledgedRef.current.source.item.ref;
    titleRef.current = {
      value: title,
      clientMutationId:
        titleRef.current && !intrinsicActiveRef.current.has(source)
          ? titleRef.current.clientMutationId
          : resourceSurfaceCommandId(),
    };
    publish();
    store();
    setStatus("dirty");
    schedule();
  }, [publish, schedule, store]);
  const updateBody = useCallback((input: { occurrenceId: string; bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }) => {
    const row = derived().orderedItems.find((item) => item.occurrenceId === input.occurrenceId);
    if (!row) return;
    const ref = row.target.item.ref;
    const current = bodiesRef.current.get(ref);
    bodiesRef.current.set(ref, {
      bodyPmJson: input.bodyPmJson,
      bodyText: input.bodyText,
      clientMutationId:
        current && !intrinsicActiveRef.current.has(ref)
          ? current.clientMutationId
          : resourceSurfaceCommandId(),
    });
    publish();
    store();
    setStatus("dirty");
    if (input.flush) saveIntrinsics();
    else schedule();
  }, [derived, publish, saveIntrinsics, schedule, store]);
  const updateSourceNoteBody = useCallback((input: { bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }) => {
    const ref = derived().source.item.ref;
    const current = bodiesRef.current.get(ref);
    bodiesRef.current.set(ref, {
      bodyPmJson: input.bodyPmJson,
      bodyText: input.bodyText,
      clientMutationId:
        current && !intrinsicActiveRef.current.has(ref)
          ? current.clientMutationId
          : resourceSurfaceCommandId(),
    });
    publish();
    store();
    setStatus("dirty");
    if (input.flush) saveIntrinsics();
    else schedule();
  }, [derived, publish, saveIntrinsics, schedule, store]);
  const command = useCallback((next: ResourceSurfaceCommand) => {
    const before = derived();
    const intent = intentFor(before, next);
    if (!intent) {
      const error = new Error(
        "This edit no longer matches the current resource order.",
      );
      stoppedRef.current = true;
      setStatus("failed");
      onErrorRef.current?.(error);
      return;
    }
    if (next.type === "split_note" && intent.occurrenceTargetRef) {
      bodiesRef.current.delete(intent.occurrenceTargetRef);
    }
    intentsRef.current = [...intentsRef.current, intent];
    publish();
    store();
    setStatus("dirty");
    if (next.type !== "split_note") saveIntrinsics();
    pump();
  }, [derived, publish, pump, saveIntrinsics, store]);
  const flush = useCallback(() => saveIntrinsics(), [saveIntrinsics]);
  const reload = useCallback(async () => {
    clearTimers();
    stoppedRef.current = true;
    generationRef.current += 1;
    const generation = generationRef.current;
    activeRef.current = false;
    intrinsicActiveRef.current.clear();
    let next: ResourceSurface;
    try {
      next = await fetchResourceSurface(sourceRef);
    } catch (error) {
      if (generation === generationRef.current) {
        setStatus("failed");
        onErrorRef.current?.(error);
      }
      return;
    }
    if (generation !== generationRef.current) return;
    acknowledgedRef.current = next;
    intentsRef.current = [];
    titleRef.current = undefined;
    bodiesRef.current.clear();
    stoppedRef.current = false;
    requiresRebaseRef.current = false;
    publish();
    store();
    setHasRecoveredDraft(false);
    setStatus("clean");
  }, [clearTimers, publish, sourceRef, store]);
  const retry = useCallback(() => {
    if (requiresRebaseRef.current) {
      clearTimers();
      stoppedRef.current = true;
      generationRef.current += 1;
      const generation = generationRef.current;
      activeRef.current = false;
      intrinsicActiveRef.current.clear();
      void fetchResourceSurface(sourceRef).then((next) => {
        if (generation !== generationRef.current) return;
        acknowledgedRef.current = next;
        requiresRebaseRef.current = false;
        stoppedRef.current = false;
        publish();
        store();
        saveIntrinsics();
        pumpRef.current();
        settleStatus();
      }).catch((error) => {
        if (generation !== generationRef.current) return;
        setStatus("failed");
        onErrorRef.current?.(error);
      });
      return;
    }
    stoppedRef.current = false;
    saveIntrinsics();
    pump();
  }, [
    clearTimers,
    publish,
    pump,
    saveIntrinsics,
    settleStatus,
    sourceRef,
    store,
  ]);
  const copyRecovery = useCallback(async () => {
    const draft = readDraft(sourceRef);
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    } catch (error) {
      onErrorRef.current?.(error);
    }
  }, [sourceRef]);
  useEffect(() => {
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") saveIntrinsics(); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", saveIntrinsics);
    return () => { document.removeEventListener("visibilitychange", flushWhenHidden); window.removeEventListener("pagehide", saveIntrinsics); saveIntrinsics(); };
  }, [saveIntrinsics]);
  return {
    surface,
    status,
    hasRecoveredDraft,
    updateTitle,
    updateBody,
    updateSourceNoteBody,
    command,
    flush,
    retry,
    reload,
    copyRecovery,
  };
}
