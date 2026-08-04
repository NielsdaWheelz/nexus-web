"use client";

import {
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

import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { present } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  useFeedback,
  type FeedbackContent,
  type FeedbackContextValue,
} from "@/components/feedback/Feedback";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import {
  offlineMediaByRefFromInventory,
  type ResourceActionEnvironment,
} from "@/lib/actions/resourceActionEnvironment";
import {
  composeResourceActionPlan,
  projectResourceActionToMenu,
  RESOURCE_ACTION_CATALOG,
  resolveResourceActionPlan,
  type ComposedResourceAction,
  type PlannedResourceAction,
  type ResourceActionBlockedReason,
  type ResourceActionCatalogKey,
  type ResourceActionId,
  type ResourceActionIntent,
  type SemanticResourceAction,
} from "@/lib/actions/resourceActions";
import {
  decodeResourceActionSnapshotResolveResponse,
  type ResourceActionSnapshot,
} from "@/lib/actions/resourceActionSnapshot";
import {
  createResourceActionSnapshotCache,
  type ResourceActionSnapshotCache,
  type SnapshotCacheEntry,
} from "@/lib/actions/resourceActionSnapshotCache";
import {
  executeResourceChat,
  executeResourceLibraryPlacement,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { assumeMediaId } from "@/lib/lectern/contract";
import { useLectern, type LecternCapability } from "@/lib/lectern/LecternProvider";
import {
  useOfflineMediaCapability,
  type OfflineMediaCapability,
} from "@/lib/offlineMedia/OfflineMediaProvider";
import type { OfflineMediaInventoryItem } from "@/lib/offlineMedia/clientStore";
import { useShareController } from "@/lib/sharing/controller";
import {
  useLibraryPlacementController,
  type LibraryPlacementOpenOptions,
} from "@/lib/libraries/placementController";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { runSourceProcessingAction } from "@/lib/media/sourceActions";
import { retryMediaMetadata } from "@/lib/media/ingestionClient";
import { confirmAndDeleteMedia } from "@/lib/media/mediaLibraries";
import { deleteMemberLibrary } from "@/lib/libraries/client";
import { deleteConversation } from "@/lib/conversations/indexApi";
import { unsubscribeFromPodcast } from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import type {
  CanonicalResourceRef,
  ShareOpenOptions,
} from "@/lib/sharing/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

// The app resource-action runtime. One provider mounted in the authenticated
// shell owns: (1) a deduplicated BATCH snapshot cache so opening a menu never
// fetches; (2) the one client-wide ResourceActionEnvironment every surface
// reads; (3) global busy state keyed by (ref, actionId) that updates in every
// simultaneous representation; (4) exhaustive dispatch of each closed
// ResourceActionIntent to its existing owning domain client, with danger
// confirmation, awaited post-mutation reconciliation, expected-error HUD
// feedback, and defect propagation. Menus consume it through hooks that produce
// renderable ActionDescriptor[] whose ports fire only on selection — never at
// render time — so a component test mounts the provider and reads the menu with
// no network on open.

// ---------------------------------------------------------------------------
// Transport (the batch resolve) + scheduling
// ---------------------------------------------------------------------------

const SNAPSHOT_RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const MAX_REFS_PER_REQUEST = 100;
const EMPTY_INVENTORY: readonly OfflineMediaInventoryItem[] = [];

async function fetchSnapshotChunk(
  refs: readonly CanonicalResourceRef[],
): Promise<readonly ResourceActionSnapshot[]> {
  const response = await apiFetch<{ data: unknown }>(SNAPSHOT_RESOLVE_PATH, {
    method: "POST",
    body: JSON.stringify({ refs }),
  });
  return decodeResourceActionSnapshotResolveResponse(response.data);
}

async function resolveActionSnapshots(
  refs: readonly CanonicalResourceRef[],
): Promise<readonly ResourceActionSnapshot[]> {
  if (refs.length <= MAX_REFS_PER_REQUEST) return fetchSnapshotChunk(refs);
  const chunks: (readonly CanonicalResourceRef[])[] = [];
  for (let i = 0; i < refs.length; i += MAX_REFS_PER_REQUEST) {
    chunks.push(refs.slice(i, i + MAX_REFS_PER_REQUEST));
  }
  const results = await Promise.all(chunks.map(fetchSnapshotChunk));
  return results.flat();
}

function scheduleMicrotaskFlush(flush: () => void | Promise<void>): void {
  queueMicrotask(() => {
    void flush();
  });
}

// ---------------------------------------------------------------------------
// Global busy store keyed by `${ref}|${actionId}`
// ---------------------------------------------------------------------------

interface BusyStore {
  readonly getKeys: () => ReadonlySet<string>;
  readonly has: (key: string) => boolean;
  readonly add: (key: string) => void;
  readonly delete: (key: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createBusyStore(): BusyStore {
  let keys: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getKeys: () => keys,
    has: (key) => keys.has(key),
    add: (key) => {
      if (keys.has(key)) return;
      const next = new Set(keys);
      next.add(key);
      keys = next;
      notify();
    },
    delete: (key) => {
      if (!keys.has(key)) return;
      const next = new Set(keys);
      next.delete(key);
      keys = next;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function busyKeyOf(ref: CanonicalResourceRef, actionId: ResourceActionId): string {
  return `${ref}|${actionId}`;
}

/** The busy action ids for one ref, in the shape the planner consumes. */
function busyIdsForRef(
  keys: ReadonlySet<string>,
  ref: CanonicalResourceRef,
): ReadonlySet<ResourceActionId> {
  const prefix = `${ref}|`;
  const ids = new Set<ResourceActionId>();
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      // The suffix was written from a ResourceActionId, so the cast is total.
      ids.add(key.slice(prefix.length) as ResourceActionId);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Dispatch ports + effect table
// ---------------------------------------------------------------------------

interface RuntimePorts {
  readonly workspace: ReturnType<typeof useWorkspaceStore>;
  readonly activePaneId: string;
  readonly openShare: (
    target: Parameters<ReturnType<typeof useShareController>["openShare"]>[0],
    options: ShareOpenOptions,
  ) => void;
  readonly openLibraryPlacement: ReturnType<
    typeof useLibraryPlacementController
  >["openLibraryPlacement"];
  readonly lectern: LecternCapability;
  readonly offlineCapability: OfflineMediaCapability;
  readonly feedback: FeedbackContextValue;
}

function requireRefId(target: ResourceActionSubject): string {
  const parsed = parseResourceRef(target.ref);
  if (!parsed) {
    // justify-defect: the strict target decoder guarantees a canonical ref; a
    // parse failure here means the runtime was handed a corrupted subject.
    throw new Error(`Invalid resource action ref: ${target.ref}`);
  }
  return parsed.id;
}

function requireOfflineController(ports: RuntimePorts) {
  if (ports.offlineCapability.kind !== "Ready") {
    // justify-defect: the planner only emits offline actions on the Android
    // platform, which is exactly OfflineMediaCapability.kind === "Ready", so a
    // dispatched offline intent without a Ready controller is a wiring defect.
    throw new Error("Offline media controller is unavailable");
  }
  return ports.offlineCapability.controller;
}

function shareOptions(ports: RuntimePorts): ShareOpenOptions {
  const returnTarget =
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  return {
    returnFocusTo: () => returnTarget,
    returnFocusFallback: present(() =>
      findPaneLandmarkFocusTarget(ports.activePaneId),
    ),
  };
}

function placementOptions(ports: RuntimePorts): LibraryPlacementOpenOptions {
  const anchorEl =
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  return {
    anchor: () => anchorEl,
    returnFocusFallback: present(() =>
      findPaneLandmarkFocusTarget(ports.activePaneId),
    ),
  };
}

/** Execute one intent against its existing owning domain client. */
async function runResourceActionEffect(
  intent: ResourceActionIntent,
  target: ResourceActionSubject,
  ports: RuntimePorts,
): Promise<void> {
  switch (intent.kind) {
    case "Open":
      executeResourceOpen({
        target,
        resourceNavigation: {
          disposition: { kind: "Follow" },
          activateTarget: ({ target: workspaceTarget, disposition }) => {
            ports.workspace.activateWorkspaceTarget({
              originPaneId: ports.activePaneId,
              target: workspaceTarget,
              disposition,
              modality: "Programmatic",
            });
          },
        },
      });
      return;
    case "OpenSource":
      // justify-defect: OpenSource is a link descriptor; navigation is the
      // anchor href, so it must never enter imperative dispatch.
      throw new Error("OpenSource is a link and is not dispatched");
    case "Share":
      executeResourceShare({
        subject: target,
        openShare: ports.openShare,
        options: shareOptions(ports),
      });
      return;
    case "Chat":
      await executeResourceChat({
        ref: target.ref,
        openConversation: (conversationId) => {
          ports.workspace.activateWorkspaceTarget({
            originPaneId: ports.activePaneId,
            target: { href: `/conversations/${conversationId}`, labelHint: "Chat" },
            disposition: { kind: "Adopt" },
            modality: "Programmatic",
          });
        },
      });
      return;
    case "LibraryPlacement":
      executeResourceLibraryPlacement({
        subject: target,
        openLibraryPlacement: ports.openLibraryPlacement,
        options: placementOptions(ports),
      });
      return;
    case "RetryProcessing":
      await runSourceProcessingAction({
        mediaId: requireRefId(target),
        action: "retry",
        successTitle: "Retrying source processing",
      });
      return;
    case "RefreshSource":
      await runSourceProcessingAction({
        mediaId: requireRefId(target),
        action: "refresh",
        successTitle: "Refreshing source",
      });
      return;
    case "RetryMetadata":
      await retryMediaMetadata(requireRefId(target));
      return;
    case "ResetProgress":
      await ports.lectern.resetProgress(assumeMediaId(requireRefId(target)));
      return;
    case "MarkFinished":
    case "MarkPlayed":
      await ports.lectern.ensureMediaFinished(assumeMediaId(requireRefId(target)));
      return;
    case "MarkUnread":
    case "MarkUnplayed":
      await ports.lectern.setUnread(assumeMediaId(requireRefId(target)));
      return;
    case "AddToLectern":
      await ports.lectern.placeItems({
        mediaIds: [assumeMediaId(requireRefId(target))],
        placement: { kind: "Last" },
      });
      return;
    case "RemoveFromLectern":
      await ports.lectern.removeItem(intent.lecternItemId);
      return;
    case "RemoveMedia":
      // The shared danger confirm already gated this dispatch, so pass a
      // pre-confirmed removal; the domain command reauthorizes on the server.
      await confirmAndDeleteMedia({
        mediaId: requireRefId(target),
        mediaTitle: "",
        confirmRemoval: () => true,
      });
      return;
    case "DeleteLibrary":
      await deleteMemberLibrary(requireRefId(target));
      return;
    case "DeleteConversation":
      await deleteConversation(requireRefId(target));
      return;
    case "Unsubscribe":
      await unsubscribeFromPodcast(requireRefId(target));
      return;
    case "OfflineDownload":
      await requireOfflineController(ports).enqueue(requireRefId(target));
      return;
    case "OfflineCancel":
      await requireOfflineController(ports).cancel(requireRefId(target));
      return;
    case "OfflineRetry":
      await requireOfflineController(ports).retry(requireRefId(target));
      return;
    case "OfflineRemove":
      await requireOfflineController(ports).remove(requireRefId(target));
      return;
    case "EditAuthors":
    case "LibrarySettings":
    case "PodcastSettings":
    case "Subscribe":
    case "RefreshPodcast":
      // justify-defect: these open a pane-local editor / acquisition / refresh
      // flow whose controller and richer inputs (author list, library
      // selection, replacement confirmation, refresh scope + progress) are not
      // yet hoisted to app-runtime scope; the coordinated surface migration
      // wires them. Reaching here before that is a wiring defect, not a
      // user-recoverable error, so it must surface rather than silently no-op.
      throw new Error(
        `Resource action intent '${intent.kind}' is not yet wired at the app runtime`,
      );
    default: {
      const exhaustive: never = intent;
      // justify-defect: the intent union is closed; a new variant must add a
      // dispatch case, not fall through to a silent no-op.
      throw new Error(
        `Unhandled resource action intent: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Confirmation + expected-error copy (single owners)
// ---------------------------------------------------------------------------

function isDangerousIntent(intent: ResourceActionIntent): boolean {
  return (
    intent.kind === "RemoveMedia" ||
    intent.kind === "DeleteLibrary" ||
    intent.kind === "DeleteConversation" ||
    intent.kind === "Unsubscribe"
  );
}

function dangerConfirmMessage(intent: ResourceActionIntent): string {
  switch (intent.kind) {
    case "RemoveMedia":
      return "Remove this media? This cannot be undone.";
    case "DeleteLibrary":
      return "Delete this library? This cannot be undone.";
    case "DeleteConversation":
      return "Delete this conversation? This cannot be undone.";
    case "Unsubscribe":
      return "Unsubscribe from this podcast?";
    default:
      return "Are you sure?";
  }
}

/** The one shared confirm for danger resource actions (replaces ad-hoc confirms). */
function confirmDangerousIntent(intent: ResourceActionIntent): boolean {
  if (typeof window === "undefined") return false;
  return window.confirm(dangerConfirmMessage(intent));
}

/** The one exhaustive owner mapping an expected dispatch error to HUD copy. */
function dispatchErrorContent(
  catalogKey: ResourceActionCatalogKey,
  error: unknown,
): FeedbackContent {
  const label = RESOURCE_ACTION_CATALOG[catalogKey].label;
  const message =
    isApiError(error) || error instanceof Error ? error.message : undefined;
  const requestId = isApiError(error) ? error.requestId : undefined;
  return { tone: "Danger", title: `Could not ${label.replace(/…$/, "")}`, message, requestId };
}

// ---------------------------------------------------------------------------
// Blocked reason copy + planned action -> descriptor
// ---------------------------------------------------------------------------

/** The one exhaustive owner mapping a blocked reason code to accessible copy. */
function blockedReasonCopy(reason: ResourceActionBlockedReason): string {
  switch (reason) {
    case "Locked":
      return "This action is locked.";
    case "Processing":
      return "This resource is still processing.";
    case "TemporarilyUnavailable":
      return "This action is temporarily unavailable.";
    case "RequiresOnline":
      return "You are offline. Reconnect to download.";
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unknown blocked reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function busyDisabledReason(
  catalogKey: ResourceActionCatalogKey,
): string | undefined {
  // The projector shows the catalog busyLabel when present; entries without one
  // still need an accessible reason so a busy action never renders unexplained.
  return "busyLabel" in RESOURCE_ACTION_CATALOG[catalogKey] ? undefined : "Working…";
}

function plannedActionToSemantic(
  action: PlannedResourceAction,
  target: ResourceActionSubject,
  invoke: (input: InvokeInput) => void,
): SemanticResourceAction {
  const busy = action.busy || undefined;
  const disabledReason = action.busy
    ? busyDisabledReason(action.catalogKey)
    : undefined;
  if (action.intent.kind === "OpenSource") {
    return {
      catalogKey: action.catalogKey,
      busy,
      disabledReason,
      kind: "link",
      href: action.intent.href,
    };
  }
  const intent = action.intent;
  return {
    catalogKey: action.catalogKey,
    busy,
    disabledReason,
    kind: "command",
    onSelect: () => {
      invoke({ ref: target.ref, catalogKey: action.catalogKey, intent, target });
    },
  };
}

/**
 * Project one planned action to a renderable descriptor. The catalog projector
 * owns id/label/icon/tone/busy; the runtime layers a blocked reason on top —
 * keeping the normal label (not the busy label) while marking it aria-disabled
 * with catalog-independent reason copy. The onSelect closure only fires on
 * selection, so the descriptor is fully renderable without dispatching.
 */
function plannedActionToDescriptor(
  action: ComposedResourceAction,
  target: ResourceActionSubject,
  invoke: (input: InvokeInput) => void,
): ActionDescriptor {
  const projected = projectResourceActionToMenu(
    plannedActionToSemantic(action, target, invoke),
  );
  // Group-boundary separator (owned by the composer) + client-blocked overlay.
  const descriptor: ActionDescriptor = action.separatorBefore
    ? { ...projected, separatorBefore: true }
    : projected;
  if (!action.busy && action.blockedReason !== undefined) {
    return {
      ...descriptor,
      disabled: true,
      disabledReason: blockedReasonCopy(action.blockedReason),
    };
  }
  return descriptor;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface InvokeInput {
  readonly ref: CanonicalResourceRef;
  readonly catalogKey: ResourceActionCatalogKey;
  readonly intent: ResourceActionIntent;
  readonly target: ResourceActionSubject;
}

interface ResourceActionRuntimeValue {
  readonly cache: ResourceActionSnapshotCache;
  readonly busyStore: BusyStore;
  readonly invoke: (input: InvokeInput) => void;
}

const RuntimeContext = createContext<ResourceActionRuntimeValue | null>(null);
const EnvironmentContext = createContext<ResourceActionEnvironment | null>(null);

function useRuntimeContext(): ResourceActionRuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("ResourceActionRuntimeProvider is missing");
  return value;
}

function useResourceActionEnvironment(): ResourceActionEnvironment {
  const value = useContext(EnvironmentContext);
  if (!value) throw new Error("ResourceActionRuntimeProvider is missing");
  return value;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ResourceActionMenuModel {
  readonly ready: boolean;
  readonly descriptors: readonly ActionDescriptor[];
}

const NOT_READY: ResourceActionMenuModel = { ready: false, descriptors: [] };

export function ResourceActionRuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [cache] = useState<ResourceActionSnapshotCache>(() =>
    createResourceActionSnapshotCache({
      resolve: resolveActionSnapshots,
      schedule: scheduleMicrotaskFlush,
    }),
  );
  const [busyStore] = useState<BusyStore>(() => createBusyStore());
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);

  // Compose every dispatch port from the ancestor providers this runtime is
  // mounted inside; keep them in a ref so the imperative `invoke` reads the
  // latest ports without itself being rebuilt on every render.
  const workspace = useWorkspaceStore();
  const { openShare } = useShareController();
  const { openLibraryPlacement } = useLibraryPlacementController();
  const lectern = useLectern();
  const offlineCapability = useOfflineMediaCapability();
  const feedback = useFeedback();

  const ports: RuntimePorts = {
    workspace,
    activePaneId: workspace.state.activePrimaryPaneId,
    openShare,
    openLibraryPlacement,
    lectern,
    offlineCapability,
    feedback,
  };
  const portsRef = useRef<RuntimePorts>(ports);
  useEffect(() => {
    portsRef.current = ports;
  });

  const invoke = useCallback(
    (input: InvokeInput) => {
      void (async () => {
        const currentPorts = portsRef.current;
        const actionId = RESOURCE_ACTION_CATALOG[input.catalogKey].id;
        const key = busyKeyOf(input.ref, actionId);
        if (busyStore.has(key)) return;
        if (isDangerousIntent(input.intent) && !confirmDangerousIntent(input.intent)) {
          return;
        }
        busyStore.add(key);
        try {
          await runResourceActionEffect(input.intent, input.target, currentPorts);
          // Reconcile: a mutation can change a related resource's facts (Unsubscribe
          // → episode refs, DeleteLibrary → contained media's LibraryPlacement,
          // AddToLectern → the media's own membership). Re-resolve EVERY cached ref
          // in one batch and AWAIT it before busy clears, so every simultaneously
          // mounted representation agrees (AC7) and no stale snapshot outlives the
          // mutation it authorized (AC8).
          await cache.reresolveAll();
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && !isSameSystemApiDefect(error)) {
            currentPorts.feedback.publish({
              kind: "Hud",
              content: dispatchErrorContent(input.catalogKey, error),
            });
            return;
          }
          // A same-system defect (or any non-ApiError throw) is not
          // user-recoverable; surface it to the nearest error boundary.
          setDefect({ error });
          return;
        } finally {
          busyStore.delete(key);
        }
      })();
    },
    [busyStore, cache],
  );

  const runtimeValue = useMemo<ResourceActionRuntimeValue>(
    () => ({ cache, busyStore, invoke }),
    [cache, busyStore, invoke],
  );

  // The one client-wide environment. Platform is "Android" exactly when the
  // native offline service is Ready — this reconciles readiness so Download is
  // never offered before the service can honor it.
  const connectivity = useConnectivity();
  const store = offlineCapability.kind === "Ready" ? offlineCapability.store : null;
  const subscribeInventory = useCallback(
    (listener: () => void) => (store ? store.subscribeInventory(listener) : () => {}),
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
  const environment = useMemo<ResourceActionEnvironment>(
    () => ({
      platform: offlineCapability.kind === "Ready" ? "Android" : "Web",
      connectivity,
      offlineMediaByRef: offlineMediaByRefFromInventory(inventory),
    }),
    [offlineCapability.kind, connectivity, inventory],
  );

  if (defect) throw defect.error;

  return (
    <RuntimeContext.Provider value={runtimeValue}>
      <EnvironmentContext.Provider value={environment}>
        {children}
      </EnvironmentContext.Provider>
    </RuntimeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/**
 * Register a ref for deduplicated batch prefetch and read its cache state. The
 * trigger stays unavailable until this returns a `ready` entry, so opening a
 * menu performs no request.
 */
export function useResourceActionSnapshot(
  ref: CanonicalResourceRef | null,
): SnapshotCacheEntry | undefined {
  const { cache } = useRuntimeContext();
  useEffect(() => {
    if (ref !== null) cache.register(ref);
  }, [ref, cache]);
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(listener),
    [cache],
  );
  const getSnapshot = useCallback(
    () => (ref === null ? undefined : cache.peek(ref)),
    [ref, cache],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useComposedResourceActionModel(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  const { busyStore, invoke } = useRuntimeContext();
  const environment = useResourceActionEnvironment();
  const entry = useResourceActionSnapshot(target.ref);
  const busyKeys = useSyncExternalStore(
    busyStore.subscribe,
    busyStore.getKeys,
    busyStore.getKeys,
  );
  return useMemo<ResourceActionMenuModel>(() => {
    if (!entry || entry.status !== "ready") return NOT_READY;
    const plan = resolveResourceActionPlan(
      entry.snapshot,
      environment,
      busyIdsForRef(busyKeys, target.ref),
    );
    const descriptors = composeResourceActionPlan(plan).map((action) =>
      plannedActionToDescriptor(action, target, invoke),
    );
    return { ready: true, descriptors };
  }, [entry, environment, busyKeys, target, invoke]);
}

/**
 * The dropdown model for `ResourceActionMenu`: the composed, danger-last plan
 * projected to ActionDescriptor[]. `ready` is false until the ref's snapshot
 * exists so the trigger can be withheld (zero network on open).
 */
export function useResourceActionMenuModel(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  return useComposedResourceActionModel(target);
}

/**
 * The catalog projection for Nexus / header surfaces. It returns the SAME
 * composed descriptors as the menu model, so a header or Nexus row renders an
 * identical plan without re-deriving membership.
 */
export function useResourceActionCatalogProjection(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  return useComposedResourceActionModel(target);
}
