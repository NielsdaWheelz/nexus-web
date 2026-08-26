"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  commandResourceSurface,
  fetchResourceSurface,
  resourceSurfaceCommandId,
  updateResourceSurfaceNoteBody,
  updateResourceSurfaceTitle,
} from "@/lib/resourceSurface/api";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import { appendDailyDraftText, captureDailySurface, createDailyDraft, dailyDraftBodyChanged, draftNoteRef, loadDailySurface, pendingDailyBody, surfaceContainsDailyDraft, type DailySurfaceSessionOptions } from "@/lib/resourceSurface/dailySurfacePersistence";
import {
  clearPersistedResourceSurfaceDraft,
  pendingResourceSurfaceBodies,
  persistResourceSurfaceDraft,
  readResourceSurfaceDraft,
  type ResourceSurfaceDraftIntent as Intent,
  type ResourceSurfacePendingBody as PendingBody,
  type ResourceSurfacePendingTitle as PendingTitle,
} from "@/lib/resourceSurface/draftStore";
import {
  createResourceSurfaceIntent,
  materializeResourceSurfaceIntent,
  projectResourceSurface,
  rebindAcknowledgedResourceSurfaceIntents,
  resourceSurfaceLaneVersion,
  resourceSurfaceOccurrenceForRef,
  resourceSurfacePendingOccurrenceId,
  type ResourceSurfaceCommand,
} from "@/lib/resourceSurface/model";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";
import { acknowledgeDailyDraftHandoff, clearDailyDraft, readDailyDraft, writeDailyDraft, type DailyDraft, type DailyDraftHandoff } from "@/lib/notes/dailyDraftStore";
import { noteBodyHasContent } from "@/lib/notes/prosemirror/bodyContent";
import { copyText } from "@/lib/ui/copyText";

const IDLE_DELAY_MS = 1500;
const MAX_WAIT_MS = 5000;

type Status = "clean" | "dirty" | "saving" | "recovered" | "failed";

export interface ResourceSurfaceSession {
  surface: ResourceSurface;
  status: Status;
  hasRecoveredDraft: boolean;
  updateTitle(title: string): void;
  updateBody(input: { occurrenceId: string; bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }): void;
  updateSourceNoteBody(input: { bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }): void;
  command(command: ResourceSurfaceCommand): string | null;
  flush(): void;
  retry(): void;
  reload(): Promise<void>;
  copyRecovery(): Promise<void>;
}

export interface DailyResourceSurfaceSession extends Omit<ResourceSurfaceSession, "surface" | "updateSourceNoteBody"> {
  surface: ResourceSurface | null; title: string | null;
  provisional: { occurrenceId: string; noteRef: string; bodyPmJson: Record<string, unknown>; bodyText: string } | null;
  inputHandoff: DailyDraftHandoff;
  acknowledgeInputHandoff(handoffId: string): void;
}

type PersistedSessionOptions = {
  sourceRef: string;
  initialSurface: ResourceSurface;
  onError?: (error: unknown) => void;
  onTitleMutationStarted?: () => MountedEditorMutationLease | null;
  onSourceBodyMutationStarted?: () => MountedEditorMutationLease | null;
};

export function useResourceSurfaceSession(input: PersistedSessionOptions): ResourceSurfaceSession;
export function useResourceSurfaceSession(input: DailySurfaceSessionOptions): DailyResourceSurfaceSession;
export function useResourceSurfaceSession(input: PersistedSessionOptions | DailySurfaceSessionOptions): ResourceSurfaceSession | DailyResourceSurfaceSession;
export function useResourceSurfaceSession(input: PersistedSessionOptions | DailySurfaceSessionOptions): ResourceSurfaceSession | DailyResourceSurfaceSession {
  const daily = "daily" in input ? input.daily : null;
  const sessionKey = "daily" in input ? input.sessionKey : input.sourceRef;
  const initialMaterialized =
    "daily" in input ? input.initialMaterialized ?? null : null;
  const initialSurface =
    "daily" in input ? initialMaterialized?.surface ?? null : input.initialSurface;
  const [surface, setSurface] = useState<ResourceSurface | null>(initialSurface);
  const [status, setStatus] = useState<Status>("clean");
  const [hasRecoveredDraft, setHasRecoveredDraft] = useState(false);
  const [dailyTitle, setDailyTitle] = useState<string | null>(null);
  const acknowledgedRef = useRef<ResourceSurface | null>(initialSurface);
  const sourceRefRef = useRef<string | null>(
    "daily" in input ? initialMaterialized?.sourceRef ?? null : input.sourceRef,
  );
  const dailyDraftRef = useRef<DailyDraft | null>(null);
  const captureSnapshotRef = useRef<DailyDraft | null>(null);
  const dailyCapturedRef = useRef(false);
  const recoveredPausedRef = useRef(false);
  const claimedDeliveryIdsRef = useRef<Set<string>>(new Set());
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
  const inputRef = useRef(input);
  const onErrorRef = useRef(input.onError);
  inputRef.current = input;
  onErrorRef.current = input.onError;

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
    const acknowledgedSurface = acknowledgedRef.current;
    return acknowledgedSurface === null
      ? null
      : projectResourceSurface({
          acknowledgedSurface,
          intents: intentsRef.current,
          title: titleRef.current,
          bodies: bodiesRef.current,
        });
  }, []);

  const publish = useCallback(() => setSurface(derived()), [derived]);
  const restoreMaterializedDaily = useCallback((
    sourceRef: string,
    ownerSurface: ResourceSurface,
    dailyDraft: DailyDraft | null,
  ) => {
    const resourceDraft = readResourceSurfaceDraft(sourceRef);
    const acknowledged = resourceDraft?.acknowledged_surface ?? ownerSurface;
    acknowledgedRef.current = acknowledged;
    sourceRefRef.current = sourceRef;
    intentsRef.current = resourceDraft?.commands ?? [];
    titleRef.current = resourceDraft?.title
      ? {
          value: resourceDraft.title.value,
          clientMutationId: resourceDraft.title.client_mutation_id,
        }
      : undefined;
    bodiesRef.current = pendingResourceSurfaceBodies(resourceDraft);
    if (dailyDraft) {
      const ref = draftNoteRef(dailyDraft.noteId);
      bodiesRef.current.set(
        ref,
        pendingDailyBody(
          dailyDraft,
          bodiesRef.current.get(ref)?.clientMutationId ??
            resourceSurfaceCommandId(),
        ),
      );
    }
    dailyCapturedRef.current = surfaceContainsDailyDraft(
      acknowledged,
      dailyDraft,
    );
    return resourceDraft !== null;
  }, []);
  const store = useCallback(() => {
    const currentInput = inputRef.current;
    if ("daily" in currentInput) {
      const dailyDraft = dailyDraftRef.current;
      if (dailyDraft) writeDailyDraft(dailyDraft);
      else clearDailyDraft(currentInput.daily.accountId, currentInput.daily.localDate);
      const sourceRef = sourceRefRef.current;
      const acknowledged = acknowledgedRef.current;
      if (sourceRef && acknowledged) {
        persistResourceSurfaceDraft({
          sourceRef,
          acknowledgedSurface: acknowledged,
          commands: intentsRef.current,
          title: titleRef.current,
          bodies: bodiesRef.current,
          ...(
            dailyDraft && !dailyCapturedRef.current
              ? { omittedBodyRef: draftNoteRef(dailyDraft.noteId) }
              : {}
          ),
        });
      }
      return;
    }
    const sourceRef = sourceRefRef.current;
    if (!sourceRef || !acknowledgedRef.current) return;
    const hasPending = persistResourceSurfaceDraft({
      sourceRef,
      acknowledgedSurface: acknowledgedRef.current,
      commands: intentsRef.current,
      title: titleRef.current,
      bodies: bodiesRef.current,
    });
    if (!hasPending) {
      setHasRecoveredDraft(false);
    }
  }, []);

  const clearDailyIfSaved = useCallback(() => {
    const draft = dailyDraftRef.current;
    if (!draft || !dailyCapturedRef.current || bodiesRef.current.has(draftNoteRef(draft.noteId)) || draft.handoff.kind !== "None") return false;
    dailyDraftRef.current = null; setHasRecoveredDraft(false);
    return true;
  }, []);

  const clearTimers = useCallback(() => { if (idleRef.current !== null) window.clearTimeout(idleRef.current); if (maxRef.current !== null) window.clearTimeout(maxRef.current); idleRef.current = null; maxRef.current = null; }, []);

  const saveIntrinsics = useCallback(() => {
    clearTimers();
    if (stoppedRef.current) {
      store();
      settleStatus();
      return;
    }
    const ack = acknowledgedRef.current;
    const sourceRef = sourceRefRef.current;
    const generation = generationRef.current;
    const title = titleRef.current;
    const bodies = [...bodiesRef.current];
    const currentInput = inputRef.current;
    const draft = dailyDraftRef.current;
    const captureReady = Boolean(
      "daily" in currentInput &&
        draft &&
        !dailyCapturedRef.current &&
        !recoveredPausedRef.current &&
        noteBodyHasContent(draft),
    );
    if (ack && sourceRef && !captureReady && title !== undefined && ack.source.content.kind === "page_title" && !intrinsicActiveRef.current.has(ack.source.item.ref)) {
      intrinsicActiveRef.current.add(ack.source.item.ref);
      setStatus("saving");
      const titleMutation =
        currentInput.onTitleMutationStarted?.() ?? null;
      void updateResourceSurfaceTitle({
        sourceRef,
        clientMutationId: title.clientMutationId,
        baseVersion: resourceSurfaceLaneVersion(ack.source.item, "title"),
        title: title.value,
      }).then(async (item) => {
        try {
          if (generation !== generationRef.current) return;
          const current = acknowledgedRef.current;
          if (!current) return;
          acknowledgedRef.current = {
            ...current,
            source: {
              ...current.source,
              item,
              content: current.source.content.kind === "page_title"
                ? { kind: "page_title", title: title.value }
                : current.source.content,
            },
          };
          if (titleRef.current === title) titleRef.current = undefined;
          publish();
          store();
        } finally {
          // The request committed authoritatively. A route transition may have
          // invalidated this local session, but it cannot erase the accepted
          // action's reconciliation responsibility.
          await titleMutation?.committed();
        }
      }).catch((error) => {
        titleMutation?.failed();
        if (generation !== generationRef.current) return;
        if (handleUnauthenticatedApiError(error)) return;
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
      const isDailyDraft = draft && ref === draftNoteRef(draft.noteId);
      if (isDailyDraft && recoveredPausedRef.current) continue;
      if ("daily" in currentInput && isDailyDraft && !dailyCapturedRef.current) {
        if (!captureReady || activeRef.current || intrinsicActiveRef.current.size) continue;
        const snapshot = captureSnapshotRef.current ?? draft;
        const captureGeneration = ++generationRef.current;
        captureSnapshotRef.current = snapshot; intrinsicActiveRef.current.add(ref); setStatus("saving");
        void captureDailySurface(currentInput.daily, snapshot).then((result) => {
          if (captureGeneration !== generationRef.current) return;
          acknowledgedRef.current = result.surface;
          sourceRefRef.current = `page:${result.pageId}`;
          dailyCapturedRef.current = true; captureSnapshotRef.current = null;
          if (bodiesRef.current.get(ref) === body) bodiesRef.current.delete(ref);
          clearDailyIfSaved();
          setDailyTitle(result.surface.source.content.kind === "page_title" ? result.surface.source.content.title : null);
          publish(); store();
        }).catch((error) => {
          if (captureGeneration !== generationRef.current) return;
          if (handleUnauthenticatedApiError(error)) return;
          stoppedRef.current = true; setStatus("failed"); store();
          onErrorRef.current?.(error);
        }).finally(() => {
          if (captureGeneration !== generationRef.current) return;
          intrinsicActiveRef.current.delete(ref);
          if (!stoppedRef.current) saveIntrinsics(); settleStatus();
        });
        break;
      }
      if (!ack || !sourceRef) continue;
      if (intrinsicActiveRef.current.has(ref)) continue;
      const sourceItem =
        ack.source.item.ref === ref
          ? ack.source.item
          : resourceSurfaceOccurrenceForRef(ack, ref)?.target.item;
      if (!sourceItem) continue;
      intrinsicActiveRef.current.add(ref);
      setStatus("saving");
      const sourceBodyMutation =
        ack.source.item.ref === ref
          ? currentInput.onSourceBodyMutationStarted?.() ?? null
          : null;
      void updateResourceSurfaceNoteBody({
        noteRef: ref,
        clientMutationId: body.clientMutationId,
        baseVersion: resourceSurfaceLaneVersion(sourceItem, "body"),
        bodyPmJson: body.bodyPmJson,
      }).then(async (result) => {
        try {
          if (generation !== generationRef.current) return;
          const currentAck = acknowledgedRef.current;
          if (!currentAck) return;
          if (bodiesRef.current.get(ref) === body) bodiesRef.current.delete(ref);
          if (currentAck.source.item.ref === ref) {
            acknowledgedRef.current = {
              ...currentAck,
              source: {
                ...currentAck.source,
                item: result.item,
                content: currentAck.source.content.kind === "note_body"
                  ? { kind: "note_body", bodyPmJson: body.bodyPmJson, bodyText: result.bodyText }
                  : currentAck.source.content,
              },
            };
          } else {
            acknowledgedRef.current = {
              ...currentAck,
              orderedItems: currentAck.orderedItems.map((row) =>
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
          clearDailyIfSaved();
          publish();
          store();
        } finally {
          await sourceBodyMutation?.committed();
        }
      }).catch((error) => {
        sourceBodyMutation?.failed();
        if (generation !== generationRef.current) return;
        if (handleUnauthenticatedApiError(error)) return;
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
  }, [clearDailyIfSaved, clearTimers, publish, settleStatus, store]);

  const pump = useCallback(() => {
    const acknowledged = acknowledgedRef.current;
    const sourceRef = sourceRefRef.current;
    if (
      !acknowledged ||
      !sourceRef ||
      activeRef.current ||
      intrinsicActiveRef.current.size > 0 ||
      stoppedRef.current ||
      !intentsRef.current.length
    ) {
      return;
    }
    const intent = intentsRef.current[0]!;
    const command = materializeResourceSurfaceIntent(acknowledged, intent);
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
      const left = acknowledged.orderedItems.find((item) => item.occurrenceId === command.occurrenceId);
      if (left && intrinsicActiveRef.current.has(left.target.item.ref)) return;
    }
    activeRef.current = true; setStatus("saving");
    const generation = generationRef.current;
    const bases: Array<{ ref: string; lane: "body" | "outgoing_edges"; version: number }> = [{ ref: acknowledged.source.item.ref, lane: "outgoing_edges", version: resourceSurfaceLaneVersion(acknowledged.source.item, "outgoing_edges") }];
    if (command.type === "split_note") { const row = acknowledged.orderedItems.find((item) => item.occurrenceId === command.occurrenceId); if (!row) { stoppedRef.current = true; activeRef.current = false; setStatus("failed"); return; } bases.push({ ref: row.target.item.ref, lane: "body" as const, version: resourceSurfaceLaneVersion(row.target.item, "body") }); }
    void commandResourceSurface({ sourceRef, clientMutationId: intent.clientMutationId, baseVersions: bases, command }).then((next) => {
      if (generation !== generationRef.current) return;
      const remainingIntents = intentsRef.current.filter(
        (item) => item !== intent,
      );
      intentsRef.current = rebindAcknowledgedResourceSurfaceIntents({
        previousSurface: acknowledged,
        acknowledgedSurface: next,
        completedIntent: intent,
        remainingIntents,
      });
      acknowledgedRef.current = next;
      activeRef.current = false;
      publish();
      store();
      saveIntrinsics();
      settleStatus();
      pumpRef.current();
    }).catch((error) => {
      if (generation !== generationRef.current) return;
      if (handleUnauthenticatedApiError(error)) return;
      activeRef.current = false;
      stoppedRef.current = true;
      requiresRebaseRef.current ||= (
        isApiError(error) && error.code === "E_RESOURCE_CONFLICT"
      );
      setStatus("failed");
      store();
      onErrorRef.current?.(error);
    });
  }, [publish, saveIntrinsics, settleStatus, store]);
  pumpRef.current = pump;

  const schedule = useCallback(() => { if (idleRef.current !== null) window.clearTimeout(idleRef.current); idleRef.current = window.setTimeout(saveIntrinsics, IDLE_DELAY_MS); if (maxRef.current === null) maxRef.current = window.setTimeout(saveIntrinsics, MAX_WAIT_MS); }, [saveIntrinsics]);

  const loadDailyOwner = useCallback(async () => {
    const currentInput = inputRef.current;
    if (!("daily" in currentInput)) return;
    const generation = ++generationRef.current;
    try {
      const load = await loadDailySurface(currentInput.daily);
      if (generation !== generationRef.current) return;
      setDailyTitle(load.title);
      let resourceRecovered = false;
      if (load.kind === "Latent") {
        acknowledgedRef.current = null; sourceRefRef.current = null;
        dailyCapturedRef.current = false; setSurface(null);
      } else {
        const draft = dailyDraftRef.current;
        resourceRecovered = restoreMaterializedDaily(
          load.sourceRef,
          load.surface,
          draft,
        );
        if (draft && !dailyCapturedRef.current) currentInput.beforePrepend?.(draftNoteRef(draft.noteId));
        publish();
        setHasRecoveredDraft(
          recoveredPausedRef.current || resourceRecovered,
        );
      }
      stoppedRef.current = false;
      setStatus(
        recoveredPausedRef.current || resourceRecovered
          ? "recovered"
          : dailyDraftRef.current
            ? "dirty"
            : "clean",
      );
    } catch (error) {
      if (generation !== generationRef.current) return;
      if (handleUnauthenticatedApiError(error)) return;
      stoppedRef.current = true; setStatus("failed"); onErrorRef.current?.(error);
    }
  }, [publish, restoreMaterializedDaily]);

  useEffect(() => {
    const currentInput = inputRef.current;
    if ("daily" in currentInput) {
      const draft = currentInput.draftSnapshot === undefined ? readDailyDraft(currentInput.daily.accountId, currentInput.daily.localDate) : currentInput.draftSnapshot;
      dailyDraftRef.current = draft; recoveredPausedRef.current = Boolean(draft);
      const materialized = currentInput.initialMaterialized;
      captureSnapshotRef.current = null;
      claimedDeliveryIdsRef.current.clear();
      intentsRef.current = [];
      titleRef.current = undefined;
      bodiesRef.current = new Map();
      intrinsicActiveRef.current.clear();
      stoppedRef.current = false;
      requiresRebaseRef.current = false;
      activeRef.current = false;
      if (materialized) {
        const resourceRecovered = restoreMaterializedDaily(
          materialized.sourceRef,
          materialized.surface,
          draft,
        );
        setDailyTitle(
          materialized.surface.source.content.kind === "page_title"
            ? materialized.surface.source.content.title
            : null,
        );
        setHasRecoveredDraft(Boolean(draft) || resourceRecovered);
        setStatus(Boolean(draft) || resourceRecovered ? "recovered" : "clean");
        publish();
      } else {
        acknowledgedRef.current = null;
        sourceRefRef.current = null;
        dailyCapturedRef.current = false;
        if (draft) {
          bodiesRef.current.set(
            draftNoteRef(draft.noteId),
            pendingDailyBody(draft, resourceSurfaceCommandId()),
          );
        }
        setHasRecoveredDraft(Boolean(draft));
        setStatus(draft ? "recovered" : "clean");
        void loadDailyOwner();
      }
      return () => { generationRef.current += 1; clearTimers(); };
    }
    generationRef.current += 1;
    const sourceRef = sourceRefRef.current;
    if (!sourceRef || !initialSurface) return clearTimers;
    const draft = readResourceSurfaceDraft(sourceRef);
    acknowledgedRef.current = draft?.acknowledged_surface ?? initialSurface;
    intentsRef.current = draft?.commands ?? [];
    titleRef.current = draft?.title
      ? {
          value: draft.title.value,
          clientMutationId: draft.title.client_mutation_id,
        }
      : undefined;
    bodiesRef.current = pendingResourceSurfaceBodies(draft);
    intrinsicActiveRef.current.clear();
    stoppedRef.current = false;
    requiresRebaseRef.current = false;
    activeRef.current = false;
    publish();
    setHasRecoveredDraft(Boolean(draft));
    setStatus(draft ? "recovered" : "clean");
    return clearTimers;
  }, [
    clearTimers,
    initialSurface,
    loadDailyOwner,
    publish,
    restoreMaterializedDaily,
    sessionKey,
  ]);

  const draftSnapshot = "daily" in input ? input.draftSnapshot : undefined;
  useEffect(() => {
    const currentInput = inputRef.current;
    if (draftSnapshot === undefined || !("daily" in currentInput)) return;
    const previous = dailyDraftRef.current;
    dailyDraftRef.current = draftSnapshot;
    if (previous && previous.noteId !== draftSnapshot?.noteId) bodiesRef.current.delete(draftNoteRef(previous.noteId));
    if (draftSnapshot && dailyDraftBodyChanged(previous, draftSnapshot)) {
      if (!previous || previous.noteId !== draftSnapshot.noteId) { dailyCapturedRef.current = false; captureSnapshotRef.current = null; }
      bodiesRef.current.set(draftNoteRef(draftSnapshot.noteId), pendingDailyBody(draftSnapshot, resourceSurfaceCommandId()));
    }
    if (clearDailyIfSaved()) clearDailyDraft(currentInput.daily.accountId, currentInput.daily.localDate);
    publish();
  }, [clearDailyIfSaved, draftSnapshot, publish, sessionKey]);
  const delivery = "daily" in input ? input.delivery ?? null : null;
  useEffect(() => {
    const currentInput = inputRef.current;
    if (!delivery || !("daily" in currentInput) || claimedDeliveryIdsRef.current.has(delivery.activationId)) return;
    claimedDeliveryIdsRef.current.add(delivery.activationId);
    let draft = dailyDraftRef.current;
    if (!draft) {
      draft = createDailyDraft(currentInput.daily, delivery.entry.noteId, delivery.entry.clientMutationId);
    } else if (
      draft.noteId !== delivery.entry.noteId ||
      draft.clientMutationId !== delivery.entry.clientMutationId
    ) {
      // justify-defect: one prepared daily activation owns one exact draft.
      throw new Error("AppendNote delivery identity does not match the daily draft");
    }
    if (draft.handoff.kind !== "Buffered") {
      const appended = appendDailyDraftText(draft, delivery.entry.initialText);
      if (appended.kind === "Unavailable") {
        // justify-defect: seeded atomic drafts are rejected before dispatch.
        throw new Error("AppendNote delivery cannot append to an atomic daily draft");
      }
      draft = appended.draft;
    }
    dailyDraftRef.current = draft; recoveredPausedRef.current = false;
    dailyCapturedRef.current = false; captureSnapshotRef.current = null;
    bodiesRef.current.set(draftNoteRef(draft.noteId), pendingDailyBody(draft, resourceSurfaceCommandId()));
    store();
    currentInput.onDeliveryClaimed?.(delivery, draft.noteId);
  }, [delivery, store]);

  const updateTitle = useCallback((title: string) => {
    const acknowledged = acknowledgedRef.current;
    if (!acknowledged) return;
    const source = acknowledged.source.item.ref;
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
    const currentSurface = derived();
    const row = currentSurface?.orderedItems.find((item) => item.occurrenceId === input.occurrenceId);
    const dailyDraft = dailyDraftRef.current;
    const provisional = dailyDraft && input.occurrenceId === `daily-provisional:${dailyDraft.noteId}`;
    if (!row && !provisional) return;
    const ref = row?.target.item.ref ?? draftNoteRef(dailyDraft!.noteId);
    const acknowledged = acknowledgedRef.current;
    const acknowledgedContent =
      acknowledged?.source.item.ref === ref
        ? acknowledged.source.content
        : acknowledged
          ? resourceSurfaceOccurrenceForRef(acknowledged, ref)?.target.content
          : undefined;
    if (
      (
        !intrinsicActiveRef.current.has(ref) ||
        !bodiesRef.current.has(ref)
      ) &&
      acknowledgedContent?.kind === "note_body" &&
      acknowledgedContent.bodyText === input.bodyText &&
      JSON.stringify(acknowledgedContent.bodyPmJson) ===
        JSON.stringify(input.bodyPmJson)
    ) {
      const removedPendingBody = bodiesRef.current.delete(ref);
      if (dailyDraft && ref === draftNoteRef(dailyDraft.noteId)) {
        dailyDraftRef.current = {
          ...dailyDraft,
          bodyPmJson: input.bodyPmJson,
          bodyText: input.bodyText,
        };
      }
      const clearedDailyDraft = clearDailyIfSaved();
      if (removedPendingBody || clearedDailyDraft) {
        clearTimers();
        publish();
        store();
        settleStatus();
      }
      return;
    }
    const current = bodiesRef.current.get(ref);
    bodiesRef.current.set(ref, {
      bodyPmJson: input.bodyPmJson,
      bodyText: input.bodyText,
      clientMutationId:
        current && !intrinsicActiveRef.current.has(ref)
          ? current.clientMutationId
          : resourceSurfaceCommandId(),
    });
    if (dailyDraft && ref === draftNoteRef(dailyDraft.noteId)) {
      dailyDraftRef.current = {
        ...dailyDraft, bodyPmJson: input.bodyPmJson, bodyText: input.bodyText,
      };
      recoveredPausedRef.current = false; setHasRecoveredDraft(false);
    }
    publish();
    store();
    setStatus("dirty");
    if (input.flush) saveIntrinsics();
    else schedule();
  }, [
    clearDailyIfSaved,
    clearTimers,
    derived,
    publish,
    saveIntrinsics,
    schedule,
    settleStatus,
    store,
  ]);
  const updateSourceNoteBody = useCallback((input: { bodyPmJson: Record<string, unknown>; bodyText: string; flush?: boolean }) => {
    const currentSurface = derived();
    if (!currentSurface) return;
    const ref = currentSurface.source.item.ref;
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
    const currentInput = inputRef.current;
    if ("daily" in currentInput && !acknowledgedRef.current && next.type === "insert_note") {
      if (dailyDraftRef.current) return null;
      dailyDraftRef.current = createDailyDraft(
        currentInput.daily, next.noteId, resourceSurfaceCommandId(), next.bodyPmJson,
      );
      dailyCapturedRef.current = false; captureSnapshotRef.current = null;
      bodiesRef.current.set(draftNoteRef(next.noteId), pendingDailyBody(dailyDraftRef.current, resourceSurfaceCommandId()));
      recoveredPausedRef.current = false; store();
      return `daily-provisional:${next.noteId}`;
    }
    const before = derived();
    if (!before) return null;
    const clientMutationId = resourceSurfaceCommandId();
    const intent = createResourceSurfaceIntent({
      surface: before,
      command: next,
      clientMutationId,
    });
    if (!intent) {
      const error = new Error(
        "This edit no longer matches the current resource order.",
      );
      stoppedRef.current = true;
      setStatus("failed");
      onErrorRef.current?.(error);
      return null;
    }
    if (next.type === "split_note") {
      const splitOccurrence = before.orderedItems.find(
        (item) => item.occurrenceId === next.occurrenceId,
      );
      if (splitOccurrence === undefined) {
        throw new Error("Split note occurrence is not in the projected surface");
      }
      bodiesRef.current.delete(splitOccurrence.target.item.ref);
    }
    intentsRef.current = [...intentsRef.current, intent];
    publish();
    store();
    setStatus("dirty");
    if (next.type !== "split_note") saveIntrinsics();
    pump();
    return next.type === "insert_note" ||
      next.type === "split_note" ||
      next.type === "insert_resource"
      ? resourceSurfacePendingOccurrenceId(clientMutationId)
      : null;
  }, [derived, publish, pump, saveIntrinsics, store]);
  const flush = useCallback(() => saveIntrinsics(), [saveIntrinsics]);
  const reload = useCallback(async () => {
    clearTimers();
    stoppedRef.current = true;
    generationRef.current += 1;
    const generation = generationRef.current;
    activeRef.current = false;
    intrinsicActiveRef.current.clear();
    if ("daily" in inputRef.current) {
      const currentInput = inputRef.current; dailyDraftRef.current = null; captureSnapshotRef.current = null;
      recoveredPausedRef.current = false; dailyCapturedRef.current = false;
      intentsRef.current = []; titleRef.current = undefined; bodiesRef.current.clear();
      clearDailyDraft(currentInput.daily.accountId, currentInput.daily.localDate);
      const sourceRef = sourceRefRef.current;
      if (sourceRef) clearPersistedResourceSurfaceDraft(sourceRef);
      setHasRecoveredDraft(false);
      await loadDailyOwner();
      return;
    }
    const sourceRef = sourceRefRef.current;
    if (!sourceRef) return;
    let next: ResourceSurface;
    try {
      next = await fetchResourceSurface(sourceRef);
    } catch (error) {
      if (generation === generationRef.current) {
        if (handleUnauthenticatedApiError(error)) return;
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
  }, [clearTimers, loadDailyOwner, publish, store]);
  const retry = useCallback(() => {
    if (requiresRebaseRef.current) {
      clearTimers();
      stoppedRef.current = true;
      generationRef.current += 1;
      const generation = generationRef.current;
      activeRef.current = false;
      intrinsicActiveRef.current.clear();
      const sourceRef = sourceRefRef.current;
      if (!sourceRef) return;
      void fetchResourceSurface(sourceRef).then((next) => {
        if (generation !== generationRef.current) return;
        acknowledgedRef.current = next;
        requiresRebaseRef.current = false;
        stoppedRef.current = false;
        if ("daily" in inputRef.current) {
          dailyCapturedRef.current = surfaceContainsDailyDraft(
            next,
            dailyDraftRef.current,
          );
        }
        publish();
        store();
        saveIntrinsics();
        pumpRef.current();
        settleStatus();
      }).catch((error) => {
        if (generation !== generationRef.current) return;
        if (handleUnauthenticatedApiError(error)) return;
        setStatus("failed");
        onErrorRef.current?.(error);
      });
      return;
    }
    if ("daily" in inputRef.current && dailyDraftRef.current) {
      stoppedRef.current = false; recoveredPausedRef.current = false;
      setHasRecoveredDraft(false); saveIntrinsics(); return;
    }
    if ("daily" in inputRef.current) {
      if (
        intentsRef.current.length > 0 ||
        titleRef.current !== undefined ||
        bodiesRef.current.size > 0
      ) {
        stoppedRef.current = false;
        setHasRecoveredDraft(false);
        saveIntrinsics();
        pump();
        return;
      }
      stoppedRef.current = false;
      void loadDailyOwner();
      return;
    }
    stoppedRef.current = false;
    saveIntrinsics();
    pump();
  }, [
    clearTimers,
    loadDailyOwner,
    publish,
    pump,
    saveIntrinsics,
    settleStatus,
    store,
  ]);
  const copyRecovery = useCallback(async () => {
    const currentInput = inputRef.current;
    const resourceDraft = sourceRefRef.current
      ? readResourceSurfaceDraft(sourceRefRef.current)
      : null;
    const dailyDraft = "daily" in currentInput
      ? readDailyDraft(currentInput.daily.accountId, currentInput.daily.localDate)
      : null;
    const draft = dailyDraft && resourceDraft
      ? { daily: dailyDraft, resource: resourceDraft }
      : dailyDraft ?? resourceDraft;
    if (!draft) return;
    await copyText(JSON.stringify(draft, null, 2));
  }, []);
  useEffect(() => {
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") saveIntrinsics(); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", saveIntrinsics);
    return () => { document.removeEventListener("visibilitychange", flushWhenHidden); window.removeEventListener("pagehide", saveIntrinsics); saveIntrinsics(); };
  }, [saveIntrinsics]);
  if (daily) {
    const draft = draftSnapshot === undefined ? dailyDraftRef.current : draftSnapshot;
    const ref = draft ? draftNoteRef(draft.noteId) : null;
    const canonical = ref && surface
      ? resourceSurfaceOccurrenceForRef(surface, ref)
      : null;
    const pending = ref ? bodiesRef.current.get(ref) : undefined;
    return {
      surface,
      title: surface?.source.content.kind === "page_title" ? surface.source.content.title : dailyTitle,
      provisional: draft && !canonical ? {
        occurrenceId: `daily-provisional:${draft.noteId}`, noteRef: draftNoteRef(draft.noteId),
        bodyPmJson: pending?.bodyPmJson ?? draft.bodyPmJson, bodyText: pending?.bodyText ?? draft.bodyText,
      } : null,
      inputHandoff: draft?.handoff ?? { kind: "None" },
      status, hasRecoveredDraft, updateTitle, updateBody, command, flush, retry, reload, copyRecovery,
      acknowledgeInputHandoff: (handoffId) => { const active = dailyDraftRef.current; if (active?.handoff.kind === "Buffered" && active.handoff.handoffId === handoffId) { recoveredPausedRef.current = false; setHasRecoveredDraft(false); setStatus("dirty"); schedule(); } acknowledgeDailyDraftHandoff(daily.accountId, daily.localDate, handoffId); },
    };
  }
  if (!surface) throw new Error("Persisted resource surface requires a surface");
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
