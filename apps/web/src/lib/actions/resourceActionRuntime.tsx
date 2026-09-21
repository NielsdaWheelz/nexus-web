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
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import {
  resourceActionDescriptors,
  type ResourceActionCommand,
  type ResourceActionPorts,
} from "@/lib/actions/resourceActionMenu";
import {
  offlineMediaByRefFromInventory,
  type ResourceActionEnvironment,
  type ResourceActionOfflineReadingAvailability,
} from "@/lib/actions/resourceActionEnvironment";
import type { ResourceActionId } from "@/lib/actions/resourceActions";
import {
  decodeResourceActionSnapshotResolveResponse,
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
import { useOfflineMediaCapability } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { OfflineMediaInventoryItem } from "@/lib/offlineMedia/clientStore";
import { useOfflineReadingCapability } from "@/lib/offlineReading/OfflineReadingProvider";
import { IMPORTS_CONFLICT_NOTICE } from "@/lib/status/imports";
import { useShareController } from "@/lib/sharing/controller";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import {
  canonicalSessionOfGlobalState,
  usePlayerCommands,
  usePlayerSession,
} from "@/lib/player/globalPlayer";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { assertNever } from "@/lib/assertNever";

async function resolveActionSnapshots(
  refs: readonly CanonicalResourceRef[],
): Promise<readonly ResourceActionSnapshot[]> {
  const requests: Promise<readonly ResourceActionSnapshot[]>[] = [];
  for (let offset = 0; offset < refs.length; offset += 100) {
    requests.push(
      apiFetch<{ data: unknown }>(
        "/api/resource-items/action-snapshots/resolve",
        {
          method: "POST",
          body: JSON.stringify({ refs: refs.slice(offset, offset + 100) }),
        },
      ).then((response) =>
        decodeResourceActionSnapshotResolveResponse(response.data),
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
const EMPTY_INVENTORY: readonly OfflineMediaInventoryItem[] = [];

export interface ResourceActionMenuModel {
  readonly status: "Loading" | "Ready" | "Error";
  readonly descriptors: readonly ActionDescriptor[];
  readonly triggerDisabled: boolean;
  readonly triggerDisabledReason?: string;
}
const LOADING_MODEL: ResourceActionMenuModel = {
  status: "Loading",
  descriptors: [],
  triggerDisabled: true,
  triggerDisabledReason: "Actions are still loading.",
};

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
  const workspace = useWorkspaceStore();
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const {
    openAuthorsEditor,
    openLibrarySettings,
    openPodcastSettings,
    openSubscribe,
  } = useResourceOverlaysController();
  const lectern = useLectern();
  const playerCommands = usePlayerCommands();
  const playerSession = usePlayerSession();
  const offlineCapability = useOfflineMediaCapability();
  const offlineReadingCapability = useOfflineReadingCapability();
  const feedback = useFeedback();
  const offerCompletionUndo = useCompletionUndo(cache.reconcile);
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
    workspace,
    activePaneId: workspace.state.activePrimaryPaneId,
    openShare,
    openLibraryPlacement,
    openAuthorsEditor,
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
    offlineCapability,
    offlineReadingCapability,
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
          await command.execute(current);
          if (!command.openOnly) await cache.reconcile(command.reconcile);
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && !isSameSystemApiDefect(error)) {
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
  const androidShell = useAndroidShell();
  const store =
    offlineCapability.kind === "Ready" ? offlineCapability.store : null;
  const subscribeInventory = useCallback(
    (listener: () => void) =>
      store ? store.subscribeInventory(listener) : () => {},
    [store],
  );
  const getInventory = useCallback(
    () => (store ? store.getInventory() : EMPTY_INVENTORY),
    [store],
  );
  const inventory = useSyncExternalStore(
    subscribeInventory,
    getInventory,
    () => EMPTY_INVENTORY,
  );
  const readingController =
    offlineReadingCapability.kind === "Ready"
      ? offlineReadingCapability.controller
      : null;
  const readingSnapshot = useSyncExternalStore(
    readingController?.subscribe ?? (() => () => undefined),
    readingController?.getSnapshot ?? (() => null),
    () => null,
  );
  const readingByRef = useMemo(() => {
    const byRef = new Map<
      CanonicalResourceRef,
      ResourceActionOfflineReadingAvailability
    >();
    for (const item of readingSnapshot?.items ?? []) {
      const state = item.availability;
      let projected: ResourceActionOfflineReadingAvailability;
      switch (state.kind) {
        case "Preparing":
        case "Authorizing":
        case "Verifying":
          projected = { kind: "Resolving" };
          break;
        case "Ready":
          projected = {
            kind: "Ready",
            hasDevicePosition: state.progress.kind !== "Canonical",
          };
          break;
        case "Queued":
        case "Downloading":
        case "Restarting":
        case "Failed":
        case "Removing":
          projected = { kind: state.kind };
          break;
        default:
          return assertNever(state, "offline reading availability");
      }
      byRef.set(`media:${item.mediaId}` as CanonicalResourceRef, projected);
    }
    return byRef;
  }, [readingSnapshot]);
  const playbackByRef = useMemo(() => {
    const byRef = new Map<CanonicalResourceRef, "Idle" | "Paused" | "Ended">();
    const session = canonicalSessionOfGlobalState(playerSession.state);
    if (!session) return byRef;
    const ref = `media:${session.descriptor.mediaId}` as CanonicalResourceRef;
    switch (playerSession.state.kind) {
      case "PausedAtEnd":
      case "Completing":
      case "CompletionFailed":
        byRef.set(ref, "Ended");
        break;
      case "Active":
        if (playerSession.state.phase === "Paused") byRef.set(ref, "Paused");
        break;
      case "Absent":
      case "UpdateRequired":
      case "RuntimeFailed":
      case "PlaybackFailed":
      case "PreviewAudio":
      case "PreviewAudioFailed":
      case "PreviewAudioAtEnd":
        break;
      default:
        assertNever(playerSession.state, "global player state");
    }
    return byRef;
  }, [playerSession.state]);
  const environment = useMemo<ResourceActionEnvironment>(
    () => ({
      platform: androidShell ? "Android" : "Web",
      connectivity,
      offline:
        offlineCapability.kind === "Ready"
          ? { kind: "Ready", byRef: offlineMediaByRefFromInventory(inventory) }
          : {
              kind:
                offlineCapability.kind === "Connecting"
                  ? "Loading"
                  : "Unavailable",
            },
      offlineReading:
        offlineReadingCapability.kind === "Ready"
          ? { kind: "Ready", byRef: readingByRef }
          : {
              kind:
                offlineReadingCapability.kind === "Connecting"
                  ? "Loading"
                  : "Unavailable",
            },
      lectern:
        lectern.resource.status === "ready"
          ? {
              kind: "Ready",
              atCapacity:
                lectern.resource.data.items.length >= LECTERN_MAX_ITEMS,
              mutation: lectern.mutation.kind === "Idle" ? "Idle" : "Busy",
            }
          : { kind: lectern.resource.status === "error" ? "Error" : "Loading" },
      playbackByRef,
    }),
    [
      androidShell,
      connectivity,
      inventory,
      lectern.mutation.kind,
      lectern.resource,
      offlineCapability.kind,
      offlineReadingCapability.kind,
      readingByRef,
      playbackByRef,
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
  return useMemo<ResourceActionMenuModel | null>(() => {
    if (!target) return null;
    if (!runtime || !environment || !cache)
      throw new Error("ResourceActionRuntimeProvider is missing");
    if (!entry || entry.status === "Loading") return LOADING_MODEL;
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
      return { status: "Error", descriptors: [retry], triggerDisabled: false };
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
      };
    return {
      status: "Ready",
      descriptors,
      triggerDisabled: descriptors.length === 0,
      ...(descriptors.length === 0
        ? { triggerDisabledReason: "No actions are available." }
        : {}),
    };
  }, [busyKeys, cache, entry, environment, runtime, target]);
}

export function useResourceActionMenuModel(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  const model = useOptionalResourceActionMenuModel(target);
  if (!model)
    throw new Error("A canonical resource action subject is required.");
  return model;
}
