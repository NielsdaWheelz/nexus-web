"use client";

import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useFeedback } from "@/components/feedback/Feedback";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import {
  resourceActionDescriptors,
  type ResourceActionCommand,
  type ResourceActionPorts,
} from "@/lib/actions/resourceActionMenu";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type { ResourceActionId } from "@/lib/actions/resourceActions";
import {
  adaptResourceActionSnapshotResolveResponse,
  type ResourceActionSnapshot,
} from "@/lib/actions/resourceActionSnapshot";
import {
  createResourceActionSnapshotCache,
  type ResourceActionSnapshotCache,
} from "@/lib/actions/resourceActionSnapshotCache";
import { createResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import { settleDeletedResourcePanes } from "@/lib/actions/resourceDeletionLifecycle";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { LECTERN_MAX_ITEMS } from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import {
  useCompletionUndo,
  type CompletionUndoInput,
} from "@/lib/lectern/useCompletionUndo";
import { offlineAvailable, useOfflineSnapshot } from "@/lib/offline/bridge";
import { IMPORTS_CONFLICT_NOTICE } from "@/lib/status/imports";
import { useShareController } from "@/lib/sharing/controller";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { createMutationIntent, type MutationIntent } from "@/lib/actions/mutationIntent";
import { submitMetadataEnrichment, subscribeMetadataOperationChanges } from "@/lib/media/mediaMetadataOperations";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";

async function resolveActionSnapshots(
  refs: readonly CanonicalResourceRef[],
): Promise<readonly ResourceActionSnapshot[]> {
  const requests: Promise<readonly ResourceActionSnapshot[]>[] = [];
  for (let offset = 0; offset < refs.length; offset += 100) {
    requests.push(
      apiFetch<ApiJson<"/resource-items/action-snapshots/resolve", "post">>(
        "/api/resource-items/action-snapshots/resolve",
        {
          method: "POST",
          body: JSON.stringify({ refs: refs.slice(offset, offset + 100) }),
        },
      ).then((response) =>
        adaptResourceActionSnapshotResolveResponse(response.data),
      ),
    );
  }
  return (await Promise.all(requests)).flat();
}

function createBusyStore() {
  let keys: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const update = (key: string, busy: boolean) => {
    if (keys.has(key) === busy) return;
    const next = new Set(keys);
    if (busy) next.add(key);
    else next.delete(key);
    keys = next;
    for (const listener of listeners) listener();
  };
  return {
    getKeys: () => keys,
    has: (key: string) => keys.has(key),
    add: (key: string) => update(key, true),
    delete: (key: string) => update(key, false),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface ResourceActionRuntime {
  readonly cache: ResourceActionSnapshotCache;
  readonly busy: ReturnType<typeof createBusyStore>;
  readonly invoke: (command: ResourceActionCommand) => void;
  readonly raiseDefect: (error: unknown) => void;
  readonly offerCompletionUndo: (input: CompletionUndoInput) => void;
}
const RuntimeContext = createContext<ResourceActionRuntime | null>(null);
const EnvironmentContext = createContext<ResourceActionEnvironment | null>(
  null,
);
const EMPTY_BUSY_KEYS: ReadonlySet<string> = new Set();

export interface ResourceActionMenuModel {
  readonly status: "Loading" | "Ready" | "Error";
  readonly descriptors: readonly ActionDescriptor[];
  readonly triggerDisabled: boolean;
  readonly triggerDisabledReason?: string;
  /** Refresh a media subject when its menu opens. */
  readonly refresh: () => void;
}
export function ResourceActionRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(
    null,
  );
  const [cache] = useState(() =>
    createResourceActionSnapshotCache({
      resolve: resolveActionSnapshots,
      schedule: (flush) =>
        queueMicrotask(() => {
          try {
            const pending = flush();
            if (pending !== undefined)
              void pending.catch((error) => setDefect({ error }));
          } catch (error) {
            setDefect({ error });
          }
        }),
    }),
  );
  const [busy] = useState(createBusyStore);
  const [metadataIntents] = useState(() => new Map<string, {
    readonly intent: MutationIntent;
    readonly expectedJobId: Schema<"MetadataRetryAllowed">["expected_job_id"];
    submitting: boolean;
  }>());
  const [pendingMetadataRequests, setPendingMetadataRequests] = useState<ReadonlySet<CanonicalResourceRef>>(new Set());
  const workspace = useWorkspaceStore();
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const {
    linkComposer,
    openAuthorsEditor,
    openMediaMetadata,
    openLibrarySettings,
    openPodcastSettings,
    openSubscribe,
  } = useResourceOverlaysController();
  const lectern = useLectern();
  const playerCommands = usePlayerCommands();
  const playerSession = usePlayerSession();
  const feedback = useFeedback();
  const submitMetadata = useCallback(async function submit(
    mediaId: string,
    expectedJobId: Schema<"MetadataRetryAllowed">["expected_job_id"] | null,
    detail: ActionSelectDetail,
  ): Promise<void> {
    let pending = metadataIntents.get(mediaId);
    if (!pending) {
      if (expectedJobId === null) {
        // justify-defect: fresh research needs the exact offered expectation.
        throw new TypeError("Metadata admission lost its inspected expectation");
      }
      pending = { intent: createMutationIntent(), expectedJobId, submitting: false };
      metadataIntents.set(mediaId, pending);
      setPendingMetadataRequests(new Set([...metadataIntents.keys()].map((id) => canonicalResourceRef({ scheme: "media", id }))));
    }
    if (pending.submitting) return;
    pending.submitting = true;
    const paneId = detail.triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId
      ?? workspaceRef.current.state.activePrimaryPaneId;
    const showMetadata = () => openMediaMetadata(mediaId, detail.triggerEl, () =>
      document.querySelector<HTMLElement>(`[data-pane-chrome-for="${paneId}"]`));
    try {
      await submitMetadataEnrichment(mediaId, {
        client_mutation_id: pending.intent.clientMutationId(JSON.stringify(pending.expectedJobId)),
        expected_job_id: pending.expectedJobId,
      });
      pending.intent.discard();
      metadataIntents.delete(mediaId);
      setPendingMetadataRequests(new Set([...metadataIntents.keys()].map((id) => canonicalResourceRef({ scheme: "media", id }))));
      feedback.publish({
        kind: "Hud",
        key: `metadata-request:${mediaId}`,
        content: { tone: "Neutral", title: "metadata research request confirmed" },
        actions: [{ label: "metadata…", onClick: showMetadata }],
      });
    } catch (error) {
      if (isApiError(error) && error.status >= 400 && error.status < 500) {
        pending.intent.discard();
        metadataIntents.delete(mediaId);
        feedback.resolve(`metadata-request:${mediaId}`);
        setPendingMetadataRequests(new Set([...metadataIntents.keys()].map((id) => canonicalResourceRef({ scheme: "media", id }))));
        throw error;
      }
      // No receipt was received. New snapshots must not rotate this frozen body.
      feedback.publish({
        kind: "Hud",
        key: `metadata-request:${mediaId}`,
        content: { tone: "Danger", title: "metadata request unconfirmed", message: "confirm this request to safely check whether it was queued" },
        actions: [
          { label: "confirm request", onClick: () => { void submit(mediaId, null, detail).catch((error) => {
            if (handleUnauthenticatedApiError(error)) return;
            if (isApiError(error) && !isSameSystemApiDefect(error)) {
              feedback.publish({ kind: "Hud", content: { tone: "Danger", title: "metadata request was not accepted", message: error.message } });
              void cache.reconcile({ kind: "Subjects", refs: [canonicalResourceRef({ scheme: "media", id: mediaId })] }).catch((error) => setDefect({ error }));
            } else setDefect({ error });
          }); } },
          { label: "metadata…", onClick: showMetadata },
        ],
      });
    } finally {
      pending.submitting = false;
    }
  }, [metadataIntents, feedback, openMediaMetadata, cache]);
  useEffect(() => subscribeMetadataOperationChanges((mediaId) => {
    void cache.reconcile({ kind: "Subjects", refs: [canonicalResourceRef({ scheme: "media", id: mediaId })] }).catch((error) => setDefect({ error }));
  }), [cache]);
  const reconcileMedia = useCallback(
    (mediaId: string) =>
      void cache
        .reconcile({ kind: "Subjects", refs: [canonicalResourceRef({ scheme: "media", id: mediaId })] })
        .catch((error) => setDefect({ error })),
    [cache],
  );
  const offerCompletionUndo = useCompletionUndo(reconcileMedia);
  // Lectern membership is part of every media's actions: reconcile the media whose rows came or went.
  const lecternMembers = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (lectern.resource.status !== "ready") return;
    const current = new Set(lectern.resource.data.items.map((item) => item.mediaSummary.mediaId));
    const previous = lecternMembers.current;
    lecternMembers.current = current;
    if (previous === null) return;
    const changed = [
      ...[...previous].filter((id) => !current.has(id)),
      ...[...current].filter((id) => !previous.has(id)),
    ];
    if (changed.length === 0) return;
    void cache.reconcile({
      kind: "Subjects",
      refs: changed.map((id) => canonicalResourceRef({ scheme: "media", id })),
    }).catch((error) => setDefect({ error }));
  }, [cache, lectern.resource]);
  const createOverlayMutationBoundary = useCallback(
    (ref: CanonicalResourceRef, actionId: ResourceActionId) => {
      const key = `${ref}|${actionId}`;
      return createResourceActionMutationBoundary({
        isGloballyBusy: () => busy.has(key),
        markGloballyBusy: () => busy.add(key),
        clearGloballyBusy: () => busy.delete(key),
        reconcile: cache.reconcile,
      });
    },
    [busy, cache],
  );
  const settleDeletedResource = useCallback(
    (ref: CanonicalResourceRef, fallbackHref: string) => {
      settleDeletedResourcePanes({
        deletedRef: ref,
        fallbackHref,
        workspace: workspaceRef.current,
      });
    },
    [],
  );
  const settleDeletedMessageConversation = useCallback<
    ResourceActionPorts["settleDeletedMessageConversation"]
  >(
    (input) => {
      if (input.conversationDeleted)
        settleDeletedResource(input.conversationRef, "/conversations");
    },
    [settleDeletedResource],
  );
  const ports: ResourceActionPorts = {
    submitMetadata,
    workspace,
    activePaneId: workspace.state.activePrimaryPaneId,
    openShare,
    openLibraryPlacement,
    linkComposer,
    openAuthorsEditor,
    openMediaMetadata,
    openLibrarySettings,
    openPodcastSettings,
    openSubscribe,
    createOverlayMutationBoundary,
    settleDeletedResource,
    settleDeletedMessageConversation,
    reconcile: cache.reconcile,
    lectern,
    playerCommands,
    playerSession,
    feedback,
    offerCompletionUndo,
  };
  const portsRef = useRef(ports);
  useEffect(() => {
    portsRef.current = ports;
  });

  const invoke = useCallback(
    (command: ResourceActionCommand) => {
      void (async () => {
        const current = portsRef.current;
        const key = `${command.ref}|${command.id}`;
        if (!command.openOnly) {
          if (busy.has(key)) return;
          if (command.confirmation) {
            if (typeof window === "undefined") return;
            const { title, body } = command.confirmation;
            if (
              !window.confirm(
                `${title}\n\n${body.replaceAll("{title}", "this resource")}`,
              )
            )
              return;
          }
          busy.add(key);
        }
        try {
          await command.execute(current, command.detail);
          if (!command.openOnly) await cache.reconcile(command.reconcile);
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && !isSameSystemApiDefect(error)) {
            if (command.id === "ResourceOperation.Media.RetryMetadata") {
              void cache.reconcile(command.reconcile).catch((error) => setDefect({ error }));
            }
            const importRecovery =
              command.id === "ResourceOperation.Media.RetryProcessing" ||
              command.id === "ResourceOperation.Media.RepairSource" ||
              command.id === "ResourceOperation.Media.RepairSearch";
            current.feedback.publish({
              kind: "Hud",
              content:
                importRecovery && error.code === "E_RESOURCE_CONFLICT"
                  ? { ...IMPORTS_CONFLICT_NOTICE, requestId: error.requestId }
                  : {
                      tone: "Danger",
                      title: `Could not ${command.label.replace(/…$/, "")}`,
                      message: error.message,
                      requestId: error.requestId,
                    },
            });
          } else {
            setDefect({ error });
          }
        } finally {
          if (!command.openOnly) busy.delete(key);
        }
      })();
    },
    [busy, cache],
  );
  const runtime = useMemo<ResourceActionRuntime>(
    () => ({
      cache,
      busy,
      invoke,
      raiseDefect: (error) => setDefect({ error }),
      offerCompletionUndo,
    }),
    [cache, busy, invoke, offerCompletionUndo],
  );

  const connectivity = useConnectivity();
  const offlineSnapshot = useOfflineSnapshot();
  const offlineByRef = useMemo(
    () =>
      new Map(
        (offlineSnapshot?.items ?? []).map((item) => [
          canonicalResourceRef({ scheme: "media", id: item.mediaId }),
          item,
        ]),
      ),
    [offlineSnapshot],
  );
  const playbackByRef = useMemo(() => {
    const byRef = new Map<CanonicalResourceRef, "Idle" | "Paused" | "Ended">();
    const state = playerSession.state;
    if (state.kind !== "Loaded" || state.source.kind !== "Episode") return byRef;
    const ref = canonicalResourceRef({ scheme: "media", id: state.source.descriptor.mediaId });
    if (state.phase === "Ended" || state.phase === "Paused") byRef.set(ref, state.phase);
    return byRef;
  }, [playerSession.state]);
  const environment = useMemo<ResourceActionEnvironment>(
    () => ({
      connectivity,
      offline: !offlineAvailable
        ? { kind: "Unavailable" }
        : offlineSnapshot === null
          ? { kind: "Loading" }
          : { kind: "Ready", byRef: offlineByRef },
      lectern:
        lectern.resource.status === "ready"
          ? {
              kind: "Ready",
              atCapacity:
                lectern.resource.data.items.length >= LECTERN_MAX_ITEMS,
              mutation: lectern.busy ? "Busy" : "Idle",
            }
          : { kind: lectern.resource.status === "error" ? "Error" : "Loading" },
      playbackByRef,
      pendingMetadataRequests,
    }),
    [
      connectivity,
      lectern.busy,
      lectern.resource,
      offlineSnapshot,
      offlineByRef,
      playbackByRef,
      pendingMetadataRequests,
    ],
  );
  if (defect) throw defect.error;
  return (
    <RuntimeContext.Provider value={runtime}>
      <EnvironmentContext.Provider value={environment}>
        {children}
      </EnvironmentContext.Provider>
    </RuntimeContext.Provider>
  );
}

export function useResourceActionCompletionUndo(): (
  input: CompletionUndoInput,
) => void {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("ResourceActionRuntimeProvider is missing");
  return runtime.offerCompletionUndo;
}

export function useOptionalResourceActionMenuModel(
  target: ResourceActionSubject | undefined,
): ResourceActionMenuModel | null {
  const runtime = useContext(RuntimeContext);
  const environment = useContext(EnvironmentContext);
  const cache = target ? runtime?.cache : undefined;
  const busy = target ? runtime?.busy : undefined;
  const ref = target?.ref;
  useEffect(() => {
    if (ref !== undefined && cache) return cache.retain(ref);
  }, [ref, cache]);
  const subscribeSnapshot = useCallback(
    (listener: () => void) => (cache ? cache.subscribe(listener) : () => {}),
    [cache],
  );
  const getSnapshot = useCallback(
    () => (ref === undefined ? undefined : cache?.peek(ref)),
    [cache, ref],
  );
  const entry = useSyncExternalStore(
    subscribeSnapshot,
    getSnapshot,
    getSnapshot,
  );
  const subscribeBusy = useCallback(
    (listener: () => void) => (busy ? busy.subscribe(listener) : () => {}),
    [busy],
  );
  const getBusyKeys = useCallback(
    () => busy?.getKeys() ?? EMPTY_BUSY_KEYS,
    [busy],
  );
  const busyKeys = useSyncExternalStore(
    subscribeBusy,
    getBusyKeys,
    getBusyKeys,
  );
  const refresh = useCallback(() => {
    if (!runtime || !cache || ref === undefined) return;
    if (parseResourceRef(ref)?.scheme !== "media") return;
    void cache.reconcile({ kind: "Subjects", refs: [ref] }).catch(runtime.raiseDefect);
  }, [cache, ref, runtime]);
  return useMemo<ResourceActionMenuModel | null>(() => {
    if (!target) return null;
    if (!runtime || !environment || !cache)
      throw new Error("ResourceActionRuntimeProvider is missing");
    if (!entry || entry.status === "Loading")
      return { status: "Loading", descriptors: [], triggerDisabled: true,
        triggerDisabledReason: "Actions are still loading.", refresh };
    const snapshot =
      entry.status === "Error" ? entry.lastGoodSnapshot : entry.snapshot;
    const retry: ActionDescriptor = {
      kind: "command",
      id: "ResourceActionSnapshot.Retry",
      label: "Retry actions",
      icon: createElement(RefreshCw, { size: 16, "aria-hidden": true }),
      disabled: entry.status === "Error" && entry.retrying === true,
      disabledReason:
        entry.status === "Error" && entry.retrying === true
          ? "Actions are refreshing."
          : undefined,
      onSelect: () => {
        void cache.retry(target.ref).catch(runtime.raiseDefect);
      },
    };
    if (!snapshot)
      return { status: "Error", descriptors: [retry], triggerDisabled: false, refresh };
    const busyIds = new Set<ResourceActionId>();
    for (const key of busyKeys) {
      const prefix = `${target.ref}|`;
      if (key.startsWith(prefix))
        busyIds.add(key.slice(prefix.length) as ResourceActionId);
    }
    const descriptors = resourceActionDescriptors({
      snapshot,
      environment,
      busyIds,
      invoke: runtime.invoke,
      forceBlockedReason:
        entry.status === "Error"
          ? "Refresh actions before trying this command again."
          : entry.status === "Reconciling"
            ? "Actions are refreshing."
            : undefined,
    });
    if (entry.status === "Error")
      return {
        status: "Error",
        descriptors: [
          ...descriptors,
          { ...retry, separatorBefore: descriptors.length > 0 || undefined },
        ],
        triggerDisabled: false,
        refresh,
      };
    return {
      status: "Ready",
      descriptors,
      triggerDisabled: descriptors.length === 0,
      refresh,
      ...(descriptors.length === 0
        ? { triggerDisabledReason: "No actions are available." }
        : {}),
    };
  }, [busyKeys, cache, entry, environment, refresh, runtime, target]);
}

export function useResourceActionMenuModel(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  const model = useOptionalResourceActionMenuModel(target);
  if (!model)
    throw new Error("A canonical resource action subject is required.");
  return model;
}
