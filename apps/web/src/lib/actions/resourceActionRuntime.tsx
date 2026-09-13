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
  platformFromAndroidShell,
  type ResourceActionEnvironment,
} from "@/lib/actions/resourceActionEnvironment";
import {
  resolveResourceActionPlan,
  type PlannedResourceAction,
  type ResourceActionBlockedReason,
  type ResourceActionConfirmation,
  type ResourceActionId,
  type ResourceActionIntent,
} from "@/lib/actions/resourceActions";
import {
  decodeResourceActionSnapshotResolveResponse,
  type ResourceActionSnapshot,
} from "@/lib/actions/resourceActionSnapshot";
import {
  createResourceActionSnapshotCache,
  type ResourceActionReconciliationScope,
  type ResourceActionSnapshotCache,
  type SnapshotCacheEntry,
} from "@/lib/actions/resourceActionSnapshotCache";
import {
  createResourceActionMutationBoundary,
  type ResourceActionMutationBoundary,
} from "@/lib/actions/resourceActionMutation";
import {
  isAmbiguousDestructiveActionError,
  observeCanonicalResourceMissing,
  publishObservedDestructiveActionCommit,
  settleDestructiveAction,
  unconfirmedDestructiveActionFeedback,
  type CachedDestructiveActionObservation,
  type DestructiveActionSettlement,
  type DestructiveResourceActionKind,
} from "@/lib/actions/destructiveActionSettlement";
import {
  settleDeletedMessageConversation as settleDeletedMessageConversationLifecycle,
  settleDeletedResourcePanes,
} from "@/lib/actions/resourceDeletionLifecycle";
import type { MountedActionRequest } from "@/lib/actions/mountedActionHandoff";
import {
  executeResourceChat,
  executeResourceLibraryPlacement,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { assumeMediaId, LECTERN_MAX_ITEMS } from "@/lib/lectern/contract";
import {
  useLectern,
  type LecternCapability,
} from "@/lib/lectern/LecternProvider";
import {
  useCompletionUndo,
  type CompletionUndoInput,
} from "@/lib/lectern/useCompletionUndo";
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
import { deleteConversation } from "@/lib/conversations/indexMutation";
import {
  retryPodcastSubscriptionBackfill,
  unsubscribeFromPodcast,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import {
  canonicalSessionOfGlobalState,
  usePlayerCommands,
  usePlayerSession,
} from "@/lib/player/globalPlayer";
import type {
  CanonicalResourceRef,
  ShareOpenOptions,
} from "@/lib/sharing/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  createDossierBuild,
  learnDossierFromHighlight,
  makeDossierRevisionCurrent,
} from "@/lib/dossiers/generationAdapter";
import { requestHighlightActionIntent } from "@/lib/highlights/actionIntent";
import {
  requestMessageActionIntent,
  type SettleDeletedMessageConversation,
} from "@/lib/chat/messageActionIntent";
import { publishConversationIndexChange } from "@/lib/conversations/indexRevision";
import {
  requestNoteBlockActionIntent,
  requestPageActionIntent,
} from "@/lib/notes/actionIntents";
import { requestContributorActionIntent } from "@/lib/contributors/actionIntent";
import { requestPodcastActionIntent } from "@/lib/podcasts/actionIntent";

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

function busyKeyOf(
  ref: CanonicalResourceRef,
  actionId: ResourceActionId,
): string {
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
  readonly openAuthorsEditor: ReturnType<
    typeof useResourceOverlaysController
  >["openAuthorsEditor"];
  readonly openLibrarySettings: ReturnType<
    typeof useResourceOverlaysController
  >["openLibrarySettings"];
  readonly openPodcastSettings: ReturnType<
    typeof useResourceOverlaysController
  >["openPodcastSettings"];
  readonly openSubscribe: ReturnType<
    typeof useResourceOverlaysController
  >["openSubscribe"];
  readonly createOverlayMutationBoundary: (
    ref: CanonicalResourceRef,
    actionId: ResourceActionId,
  ) => ResourceActionMutationBoundary;
  readonly reconcileUnconfirmedDeletionSubject: (
    ref: CanonicalResourceRef,
  ) => Promise<CachedDestructiveActionObservation>;
  readonly settleDeletedMessageConversation: SettleDeletedMessageConversation;
  readonly reconcile: ResourceActionSnapshotCache["reconcile"];
  readonly lectern: LecternCapability;
  readonly playerCommands: ReturnType<typeof usePlayerCommands>;
  readonly playerSession: ReturnType<typeof usePlayerSession>;
  readonly offlineCapability: OfflineMediaCapability;
  readonly feedback: FeedbackContextValue;
  // A user-invoked exact completion (Mark finished / Mark played) offers the
  // canonical 10-second completion Undo HUD.
  readonly offerCompletionUndo: (input: CompletionUndoInput) => void;
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

/**
 * Recheck the shared Lectern precondition at selection time. The planner keeps
 * these actions disabled while the capability is unavailable, but readiness
 * can change between render and click; that race is expected user state, not a
 * provider defect.
 */
function lecternCommandIsReady(
  ports: RuntimePorts,
  capacityMatters: boolean,
): boolean {
  let title: string | null = null;
  if (ports.lectern.resource.status !== "ready") {
    title = "Lectern is still loading";
  } else if (ports.lectern.mutation.kind !== "Idle") {
    title = "Another Lectern change is still finishing";
  } else if (
    capacityMatters &&
    ports.lectern.resource.data.items.length >= LECTERN_MAX_ITEMS
  ) {
    title = "Lectern is full";
  }
  if (title === null) return true;
  ports.feedback.publish({
    kind: "Hud",
    content: { tone: "Neutral", title },
  });
  return false;
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

function placementOptions(
  ports: RuntimePorts,
  mutation: ResourceActionMutationBoundary,
): LibraryPlacementOpenOptions {
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
    mutation,
  };
}

function activateResourceInWorkspace(
  activation: ResourceActivation,
  ports: RuntimePorts,
  disposition: "Follow" | "Fork" = "Follow",
): void {
  executeResourceOpen({
    activation,
    resourceNavigation: {
      disposition: { kind: disposition },
      activateTarget: ({ target, disposition: targetDisposition }) => {
        ports.workspace.activateWorkspaceTarget({
          originPaneId: ports.activePaneId,
          target,
          disposition: targetDisposition,
          modality: "Programmatic",
        });
      },
    },
  });
}

interface ResourceDeletionEffectOutcome {
  readonly kind: "ResourceDeletion";
  readonly actionKind: DestructiveResourceActionKind;
  readonly fallbackHref: string;
  readonly settlement: DestructiveActionSettlement;
}

interface MountedMutationCompletion {
  readonly promise: Promise<void>;
  readonly onCommitted: () => Promise<void>;
  readonly onAborted: () => void;
}

/**
 * Join a mounted editor's lifetime to the global invocation. The
 * editor owns its domain write; the runtime owns reconciliation and keeps the
 * stable action busy until the editor either commits+reconciles or closes.
 */
function createMountedMutationCompletion(
  ref: CanonicalResourceRef,
  ports: RuntimePorts,
  scope: ResourceActionReconciliationScope = {
    kind: "Subjects",
    refs: [ref],
  },
): MountedMutationCompletion {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let terminal = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    async onCommitted() {
      if (terminal) {
        throw new Error(`Mounted resource action settled twice: ${ref}`);
      }
      terminal = true;
      try {
        await ports.reconcile(scope);
        resolvePromise();
      } catch (error) {
        // The invocation promise is the sole error channel. The mounted owner
        // already committed its domain write and may finish its local UI; a
        // second rejection from this callback would be unobserved by event
        // handlers while the invocation reports the same cache defect again.
        rejectPromise(error);
      }
    },
    onAborted() {
      if (terminal) {
        throw new Error(`Mounted resource action settled twice: ${ref}`);
      }
      terminal = true;
      resolvePromise();
    },
  };
}

async function activateAndAwaitMountedAction(input: {
  readonly request: MountedActionRequest;
  readonly activation: ResourceActivation;
  readonly ports: RuntimePorts;
  readonly completion?: MountedMutationCompletion;
}): Promise<boolean> {
  try {
    activateResourceInWorkspace(input.activation, input.ports);
  } catch (error) {
    if (input.request.cancel("ActivationFailed")) {
      input.completion?.onAborted();
    }
    throw error;
  }

  const outcome = await input.request.outcome;
  switch (outcome.kind) {
    case "Accepted":
      return true;
    case "Expired":
    case "Cancelled":
      input.completion?.onAborted();
      input.ports.feedback.publish({
        kind: "Hud",
        content: {
          tone: "Danger",
          title: "Resource action couldn’t be opened",
          message:
            "The resource did not become ready for this action. Try again.",
        },
      });
      return false;
    case "OwnerDefect":
      input.completion?.onAborted();
      throw outcome.error;
  }
}

/** Execute one intent against its existing owning domain client. */
async function runResourceActionEffect(
  intent: ResourceActionIntent,
  target: ResourceActionSubject,
  activation: ResourceActivation,
  actionId: ResourceActionId,
  ports: RuntimePorts,
): Promise<ResourceDeletionEffectOutcome | undefined> {
  switch (intent.kind) {
    case "Open":
      activateResourceInWorkspace(intent.activation, ports);
      return;
    case "OpenInNewPane":
      activateResourceInWorkspace(intent.activation, ports, "Fork");
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
            target: {
              href: `/conversations/${conversationId}`,
              labelHint: "Chat",
            },
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
        options: placementOptions(
          ports,
          ports.createOverlayMutationBoundary(target.ref, actionId),
        ),
      });
      return;
    case "Play": {
      if (!lecternCommandIsReady(ports, false)) return;
      const session = canonicalSessionOfGlobalState(ports.playerSession.state);
      if (
        session?.descriptor.mediaId === intent.playerDescriptor.mediaId &&
        ports.playerSession.state.kind === "Active"
      ) {
        if (ports.playerSession.state.phase === "Paused") {
          ports.playerCommands.resume();
        }
        return;
      }
      ports.playerCommands.playAudio(intent.playerDescriptor);
      return;
    }
    case "Replay":
      if (!lecternCommandIsReady(ports, false)) return;
      ports.playerCommands.playAudio(intent.playerDescriptor);
      return;
    case "ResumePlayback": {
      if (!lecternCommandIsReady(ports, false)) return;
      const session = canonicalSessionOfGlobalState(ports.playerSession.state);
      if (session?.descriptor.mediaId === intent.playerDescriptor.mediaId) {
        ports.playerCommands.resume();
      } else {
        ports.playerCommands.playAudio(intent.playerDescriptor);
      }
      return;
    }
    case "PlayNext": {
      if (!lecternCommandIsReady(ports, true)) return;
      const session = canonicalSessionOfGlobalState(ports.playerSession.state);
      await ports.lectern.placeItems({
        mediaIds: [assumeMediaId(requireRefId(target))],
        placement:
          session?.origin.kind === "Lectern"
            ? { kind: "After", itemId: session.origin.itemId }
            : { kind: "First" },
      });
      return;
    }
    case "RequestTranscript":
    case "RetryTranscript": {
      if (intent.resourceRef !== target.ref) {
        throw new Error("Transcript intent subject mismatch");
      }
      const mediaId = requireRefId(target);
      const forecast = await apiFetch<{
        data: {
          required_minutes: number;
          remaining_minutes: number | null;
          fits_budget: boolean;
        };
      }>(`/api/media/${mediaId}/transcript/request`, {
        method: "POST",
        body: JSON.stringify({ reason: "episode_open", dry_run: true }),
      });
      if (!forecast.data.fits_budget) {
        ports.feedback.publish({
          kind: "Hud",
          content: {
            tone: "Danger",
            title: "Transcript quota is exhausted",
            message:
              forecast.data.remaining_minutes === null
                ? undefined
                : `${forecast.data.remaining_minutes} minutes remain; this transcript needs ${forecast.data.required_minutes}.`,
          },
        });
        return;
      }
      await apiFetch(`/api/media/${mediaId}/transcript/request`, {
        method: "POST",
        body: JSON.stringify({ reason: "episode_open", dry_run: false }),
      });
      return;
    }
    case "OpenTranscript":
      if (intent.resourceRef !== target.ref) {
        throw new Error("Transcript intent subject mismatch");
      }
      activateResourceInWorkspace(activation, ports);
      return;
    case "DownloadOriginal": {
      const response = await apiFetch<{
        data: { url: string; expires_at: string };
      }>(`/api/media/${requireRefId(target)}/file`, { cache: "no-store" });
      window.location.assign(response.data.url);
      return;
    }
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
      if (!lecternCommandIsReady(ports, false)) return;
      await ports.lectern.resetProgress(assumeMediaId(requireRefId(target)));
      return;
    case "MarkFinished":
    case "MarkPlayed": {
      if (!lecternCommandIsReady(ports, false)) return;
      // Offer completion Undo: capture the pre-completion
      // canonical snapshot, finish the media, then offer the 10-second Undo HUD.
      // The snapshot + completed item id let Undo restore the exact Lectern row.
      const mediaId = assumeMediaId(requireRefId(target));
      const preCompletionSnapshot = ports.lectern.getCanonicalSnapshot() ?? {
        items: [],
      };
      const completedItemId =
        preCompletionSnapshot.items.find((item) => item.mediaId === mediaId)
          ?.itemId ?? null;
      const result = await ports.lectern.ensureMediaFinished(mediaId);
      ports.offerCompletionUndo({
        mediaId,
        preCompletionSnapshot,
        completedItemId,
        completionHandle: result.completionHandle,
      });
      return;
    }
    case "MarkUnread":
    case "MarkUnplayed":
      if (!lecternCommandIsReady(ports, false)) return;
      await ports.lectern.setUnread(assumeMediaId(requireRefId(target)));
      return;
    case "AddToLectern":
      if (!lecternCommandIsReady(ports, true)) return;
      await ports.lectern.placeItems({
        mediaIds: [assumeMediaId(requireRefId(target))],
        placement: { kind: "Last" },
      });
      return;
    case "RemoveFromLectern":
      if (!lecternCommandIsReady(ports, false)) return;
      await ports.lectern.removeItem(intent.lecternItemId);
      return;
    case "RemoveMedia": {
      // The shared danger confirm already gated this dispatch, so pass a
      // pre-confirmed removal; the domain command reauthorizes on the server.
      const settlement = await settleDestructiveAction({
        command: async () => {
          const outcome = await confirmAndDeleteMedia({
            mediaId: requireRefId(target),
            mediaTitle: "",
            confirmRemoval: () => true,
          });
          if (outcome.kind === "Cancelled") {
            // justify-defect: this dispatch supplies an unconditional
            // pre-confirmation after the shared confirm has already succeeded.
            throw new Error("Pre-confirmed Media deletion was cancelled");
          }
        },
        observeMissing: () => observeCanonicalResourceMissing(target.ref),
      });
      return {
        kind: "ResourceDeletion",
        actionKind: "RemoveMedia",
        fallbackHref: "/libraries",
        settlement,
      };
    }
    case "DeleteLibrary": {
      const settlement = await settleDestructiveAction({
        command: () => deleteMemberLibrary(requireRefId(target)),
        observeMissing: () => observeCanonicalResourceMissing(target.ref),
      });
      return {
        kind: "ResourceDeletion",
        actionKind: "DeleteLibrary",
        fallbackHref: "/libraries",
        settlement,
      };
    }
    case "DeleteConversation": {
      const settlement = await settleDestructiveAction({
        command: () => deleteConversation(requireRefId(target)),
        observeMissing: () => observeCanonicalResourceMissing(target.ref),
      });
      return {
        kind: "ResourceDeletion",
        actionKind: "DeleteConversation",
        fallbackHref: "/conversations",
        settlement,
      };
    }
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
      // Opening a self-loading overlay is not itself a mutation; the overlay
      // owns its own PUT + typed post-commit reconciliation.
      ports.openAuthorsEditor(
        requireRefId(target),
        ports.createOverlayMutationBoundary(target.ref, actionId),
      );
      return;
    case "LibrarySettings":
      ports.openLibrarySettings(
        requireRefId(target),
        ports.createOverlayMutationBoundary(target.ref, actionId),
        () => ports.reconcileUnconfirmedDeletionSubject(target.ref),
      );
      return;
    case "PodcastSettings":
      ports.openPodcastSettings(
        requireRefId(target),
        ports.createOverlayMutationBoundary(target.ref, actionId),
      );
      return;
    case "Subscribe":
      ports.openSubscribe(
        requireRefId(target),
        ports.createOverlayMutationBoundary(target.ref, actionId),
      );
      return;
    case "RefreshPodcast": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestPodcastActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "RetryPodcastBackfill":
      await retryPodcastSubscriptionBackfill(requireRefId(target));
      return;
    case "RerunMessage":
    case "RegenerateMessage": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestMessageActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "DeleteMessage": {
      const completion = createMountedMutationCompletion(target.ref, ports, {
        kind: "AllRetained",
      });
      const request = requestMessageActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        settleDeletionCommand: (command) =>
          settleMountedDeletionCommand({ command, ref: target.ref, ports }),
        settleDeletedConversation: ports.settleDeletedMessageConversation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "LearnHighlight": {
      const outcome = await learnDossierFromHighlight({
        highlightRef: target.ref,
        idempotencyKey: crypto.randomUUID(),
      });
      ports.workspace.activateWorkspaceTarget({
        originPaneId: ports.activePaneId,
        target: {
          href: `/artifacts/${encodeURIComponent(outcome.artifactRef)}`,
          labelHint: "Dossier",
        },
        disposition: { kind: "Follow" },
        modality: "Programmatic",
      });
      return;
    }
    case "RegenerateArtifact":
      await createDossierBuild({
        target: { kind: "Artifact", artifactRef: target.ref },
        artifactRef: target.ref,
        instruction: null,
        idempotencyKey: crypto.randomUUID(),
      });
      return;
    case "MakeArtifactRevisionCurrent":
      await makeDossierRevisionCurrent(target.ref);
      return;
    case "EditHighlight":
    case "AddHighlightNote":
    case "LinkHighlight":
    case "EditHighlightBounds": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestHighlightActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "DeleteHighlight": {
      const completion = createMountedMutationCompletion(target.ref, ports, {
        kind: "AllRetained",
      });
      const request = requestHighlightActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        settleDeletionCommand: (command) =>
          settleMountedDeletionCommand({ command, ref: target.ref, ports }),
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "EditHighlightNote": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestHighlightActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        noteBlockId: intent.noteBlockId,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "ForkMessage":
    case "WalkMessageSources": {
      const request = requestMessageActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
      });
      await activateAndAwaitMountedAction({ request, activation, ports });
      return;
    }
    case "EditPageTitle": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestPageActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "DeletePage": {
      const completion = createMountedMutationCompletion(target.ref, ports, {
        kind: "AllRetained",
      });
      const request = requestPageActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        settleDeletionCommand: (command) =>
          settleMountedDeletionCommand({ command, ref: target.ref, ports }),
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "EditNoteBody": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestNoteBlockActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
    case "RenameContributor": {
      const completion = createMountedMutationCompletion(target.ref, ports);
      const request = requestContributorActionIntent({
        kind: intent.kind,
        ref: target.ref,
        activation,
        onCommitted: completion.onCommitted,
        onAborted: completion.onAborted,
      });
      if (
        !(await activateAndAwaitMountedAction({
          request,
          activation,
          ports,
          completion,
        }))
      ) {
        return;
      }
      await completion.promise;
      return;
    }
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

/**
 * Intents that merely OPEN a self-loading overlay. Opening is not a mutation:
 * the overlay owns its own mutation + typed post-commit reconciliation, so the runtime must
 * not mark the action busy or reconcile on open (that would show a spurious
 * spinner and fire a wasted full re-resolve, even when the overlay is cancelled).
 */
function isOpenOnlyIntent(intent: ResourceActionIntent): boolean {
  return (
    intent.kind === "LibraryPlacement" ||
    intent.kind === "EditAuthors" ||
    intent.kind === "LibrarySettings" ||
    intent.kind === "PodcastSettings" ||
    intent.kind === "Subscribe"
  );
}

/** The bounded post-effect read scope declared by each closed intent. */
function reconciliationScopeFor(
  intent: ResourceActionIntent,
  ref: CanonicalResourceRef,
): ResourceActionReconciliationScope {
  switch (intent.kind) {
    case "PlayNext":
    case "MarkFinished":
    case "MarkUnread":
    case "MarkPlayed":
    case "MarkUnplayed":
    case "ResetProgress":
    case "RequestTranscript":
    case "RetryTranscript":
    case "AddToLectern":
    case "RemoveFromLectern":
    case "RetryProcessing":
    case "RefreshSource":
    case "RetryMetadata":
    case "RefreshPodcast":
    case "RetryPodcastBackfill":
    case "RegenerateArtifact":
      return { kind: "Subjects", refs: [ref] };
    case "Unsubscribe":
    case "RemoveMedia":
    case "DeleteLibrary":
    case "DeleteConversation":
    case "MakeArtifactRevisionCurrent":
      // These effects change reachability or related-resource facts; the scope
      // is still bounded to subjects retained by live representations.
      return { kind: "AllRetained" };
    case "Open":
    case "OpenInNewPane":
    case "OpenSource":
    case "Play":
    case "ResumePlayback":
    case "Replay":
    case "OpenTranscript":
    case "OfflineDownload":
    case "OfflineCancel":
    case "OfflineRetry":
    case "OfflineRemove":
    case "LibraryPlacement":
    case "Subscribe":
    case "Chat":
    case "EditHighlight":
    case "AddHighlightNote":
    case "EditHighlightNote":
    case "LinkHighlight":
    case "LearnHighlight":
    case "EditHighlightBounds":
    case "DeleteHighlight":
    case "ForkMessage":
    case "WalkMessageSources":
    case "RerunMessage":
    case "RegenerateMessage":
    case "DeleteMessage":
    case "EditPageTitle":
    case "DeletePage":
    case "EditNoteBody":
    case "RenameContributor":
    case "Share":
    case "DownloadOriginal":
    case "EditAuthors":
    case "LibrarySettings":
    case "PodcastSettings":
      return { kind: "None" };
    default: {
      const exhaustive: never = intent;
      throw new Error(
        `Unhandled resource action reconciliation: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Catalog-owned confirmation; no effect or surface may invent another copy. */
function confirmResourceAction(
  confirmation: ResourceActionConfirmation,
): boolean {
  if (confirmation.kind === "None") return true;
  if (typeof window === "undefined") return false;
  const body = confirmation.body.replaceAll("{title}", "this resource");
  return window.confirm(`${confirmation.title}\n\n${body}`);
}

/** The one exhaustive owner mapping an expected dispatch error to HUD copy. */
function dispatchErrorContent(
  actionLabel: string,
  error: unknown,
): FeedbackContent {
  const message =
    isApiError(error) || error instanceof Error ? error.message : undefined;
  const requestId = isApiError(error) ? error.requestId : undefined;
  return {
    tone: "Danger",
    title: `Could not ${actionLabel.replace(/…$/, "")}`,
    message,
    requestId,
  };
}

/**
 * If the independent witness is also unavailable, force the retained subject
 * through the cache barrier. A second transport failure installs Error so a
 * stale inverse Delete cannot re-enable when global Busy clears.
 */
async function reconcileUnconfirmedDeletionSubject(
  cache: ResourceActionSnapshotCache,
  ref: CanonicalResourceRef,
): Promise<CachedDestructiveActionObservation> {
  const release = cache.retain(ref);
  try {
    await cache.reconcile({ kind: "Subjects", refs: [ref] });
    const entry = cache.peek(ref);
    if (entry?.status === "Ready") {
      return entry.snapshot.missing ? "Missing" : "Present";
    }
    if (entry?.status === "Error") {
      if (!isAmbiguousDestructiveActionError(entry.error)) throw entry.error;
      return "Unconfirmed";
    }
    // A concurrent retained-cache read may supersede this exact generation.
    // Its public Loading/Reconciling phase still blocks the stale action.
    return "Unconfirmed";
  } finally {
    release();
  }
}

async function finalizeDestructiveActionSettlement(input: {
  readonly settlement: DestructiveActionSettlement;
  readonly ref: CanonicalResourceRef;
  readonly ports: RuntimePorts;
}): Promise<DestructiveActionSettlement> {
  const settlement = input.settlement;
  if (settlement.kind !== "Unconfirmed") return settlement;

  const cachedObservation =
    await input.ports.reconcileUnconfirmedDeletionSubject(input.ref);
  if (cachedObservation === "Missing") {
    return { kind: "Committed", evidence: "ObservedMissing" };
  }
  if (cachedObservation === "Present") {
    return {
      kind: "NotCommitted",
      commandError: settlement.commandError,
    };
  }
  input.ports.feedback.publish({
    kind: "Hud",
    content: unconfirmedDestructiveActionFeedback(settlement),
  });
  return settlement;
}

async function settleMountedDeletionCommand(input: {
  readonly command: () => Promise<unknown>;
  readonly ref: CanonicalResourceRef;
  readonly ports: RuntimePorts;
}): Promise<DestructiveActionSettlement> {
  return finalizeDestructiveActionSettlement({
    settlement: await settleDestructiveAction({
      command: input.command,
      observeMissing: () => observeCanonicalResourceMissing(input.ref),
    }),
    ref: input.ref,
    ports: input.ports,
  });
}

// ---------------------------------------------------------------------------
// Blocked reason copy + planned action -> descriptor
// ---------------------------------------------------------------------------

/** The exhaustive product copy for every planner-owned blocked reason. */
export const RESOURCE_ACTION_BLOCKED_REASON_COPY: Readonly<
  Record<ResourceActionBlockedReason, string>
> = Object.freeze({
  PermissionDenied: "You don’t have permission to do this.",
  Locked: "This item is locked.",
  Processing: "Available when processing finishes.",
  TemporarilyUnavailable: "Temporarily unavailable. Try again.",
  Loading: "Actions are still loading.",
  CapacityReached: "Lectern is full. Remove an item to add this one.",
  RequiresOnline: "Connect to the internet to use this action.",
  UnsupportedOnDevice: "Not supported on this device.",
  Busy: "This action is in progress.",
});

/**
 * Project one planned action to a renderable descriptor. The catalog projector
 * owns id/label/icon/tone/busy; the runtime layers a blocked reason on top —
 * keeping the normal label (not the busy label) while marking it aria-disabled
 * with catalog-independent reason copy. The onSelect closure only fires on
 * selection, so the descriptor is fully renderable without dispatching.
 */
function plannedActionToDescriptor(
  action: PlannedResourceAction,
  target: ResourceActionSubject,
  activation: ResourceActivation,
  invoke: (input: InvokeInput) => void,
  separatorBefore: boolean,
  forceBlockedReason?: string,
): ActionDescriptor {
  const disabledReason =
    forceBlockedReason ??
    (action.availability.kind === "Blocked"
      ? RESOURCE_ACTION_BLOCKED_REASON_COPY[action.availability.reason]
      : undefined);
  const common = {
    id: action.id,
    label: action.presentation.label,
    icon: createElement(action.presentation.icon, {
      size: 16,
      "aria-hidden": true,
    }),
    tone: action.presentation.tone,
    separatorBefore: separatorBefore || undefined,
    disabled: disabledReason !== undefined || undefined,
    disabledReason,
  } as const;
  if (action.intent.kind === "OpenSource") {
    return { ...common, kind: "link", href: action.intent.href };
  }
  const intent = action.intent;
  return {
    ...common,
    kind: "command",
    state:
      action.control.kind === "Toggle"
        ? { kind: "toggle", pressed: action.control.checked }
        : undefined,
    onSelect: () =>
      invoke({
        ref: target.ref,
        id: action.id,
        label: action.presentation.label,
        confirmation: action.confirmation,
        intent,
        target,
        activation,
      }),
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface InvokeInput {
  readonly ref: CanonicalResourceRef;
  readonly id: ResourceActionId;
  readonly label: string;
  readonly confirmation: ResourceActionConfirmation;
  readonly intent: ResourceActionIntent;
  readonly target: ResourceActionSubject;
  readonly activation: ResourceActivation;
}

interface ResourceActionRuntimeValue {
  readonly cache: ResourceActionSnapshotCache;
  readonly busyStore: BusyStore;
  readonly invoke: (input: InvokeInput) => void;
  readonly raiseDefect: (error: unknown) => void;
  readonly offerCompletionUndo: (input: CompletionUndoInput) => void;
}

const RuntimeContext = createContext<ResourceActionRuntimeValue | null>(null);
const EnvironmentContext = createContext<ResourceActionEnvironment | null>(
  null,
);

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
  const [cache] = useState<ResourceActionSnapshotCache>(() =>
    createResourceActionSnapshotCache({
      resolve: resolveActionSnapshots,
      schedule: (flush) => {
        queueMicrotask(() => {
          try {
            const completion = flush();
            if (completion !== undefined) {
              void completion.catch((error: unknown) => setDefect({ error }));
            }
          } catch (error) {
            setDefect({ error });
          }
        });
      },
    }),
  );
  const [busyStore] = useState<BusyStore>(() => createBusyStore());

  // Compose every dispatch port from the ancestor providers this runtime is
  // mounted inside; keep them in a ref so the imperative `invoke` reads the
  // latest ports without itself being rebuilt on every render.
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
  const feedback = useFeedback();
  const offerCompletionUndo = useCompletionUndo(cache.reconcile);
  const createOverlayMutationBoundary = useCallback(
    (ref: CanonicalResourceRef, actionId: ResourceActionId) => {
      const key = busyKeyOf(ref, actionId);
      return createResourceActionMutationBoundary({
        isGloballyBusy: () => busyStore.has(key),
        markGloballyBusy: () => busyStore.add(key),
        clearGloballyBusy: () => busyStore.delete(key),
        reconcile: cache.reconcile,
      });
    },
    [busyStore, cache],
  );
  const resolveUnconfirmedDeletionSubject = useCallback(
    (ref: CanonicalResourceRef) =>
      reconcileUnconfirmedDeletionSubject(cache, ref),
    [cache],
  );
  const settleDeletedMessageConversation =
    useCallback<SettleDeletedMessageConversation>(
      (input) =>
        settleDeletedMessageConversationLifecycle({
          ...input,
          observeConversationMissing: () =>
            observeCanonicalResourceMissing(input.conversationRef),
          publishConversationIndexChange,
          workspace: workspaceRef.current,
        }),
      [],
    );

  const ports: RuntimePorts = {
    workspace,
    activePaneId: workspace.state.activePrimaryPaneId,
    openShare,
    openLibraryPlacement,
    openAuthorsEditor,
    openLibrarySettings,
    openPodcastSettings,
    openSubscribe,
    createOverlayMutationBoundary,
    reconcileUnconfirmedDeletionSubject: resolveUnconfirmedDeletionSubject,
    settleDeletedMessageConversation,
    reconcile: cache.reconcile,
    lectern,
    playerCommands,
    playerSession,
    offlineCapability,
    feedback,
    offerCompletionUndo,
  };
  const portsRef = useRef<RuntimePorts>(ports);
  useEffect(() => {
    portsRef.current = ports;
  });

  const invoke = useCallback(
    (input: InvokeInput) => {
      void (async () => {
        const currentPorts = portsRef.current;
        // Open-only intents just open a self-loading overlay: no busy, no danger
        // confirm, no reconcile. The overlay owns its mutation + typed completion.
        const openOnly = isOpenOnlyIntent(input.intent);
        const key = busyKeyOf(input.ref, input.id);
        if (!openOnly) {
          if (busyStore.has(key)) return;
          if (!confirmResourceAction(input.confirmation)) return;
          busyStore.add(key);
        }
        try {
          const effectOutcome = await runResourceActionEffect(
            input.intent,
            input.target,
            input.activation,
            input.id,
            currentPorts,
          );
          if (effectOutcome?.kind === "ResourceDeletion") {
            const settlement = await finalizeDestructiveActionSettlement({
              settlement: effectOutcome.settlement,
              ref: input.ref,
              ports: currentPorts,
            });

            if (settlement.kind === "NotCommitted") {
              currentPorts.feedback.publish({
                kind: "Hud",
                content: dispatchErrorContent(
                  input.label,
                  settlement.commandError,
                ),
              });
              return;
            }
            if (settlement.kind === "Unconfirmed") {
              return;
            }
            if (settlement.evidence === "ObservedMissing") {
              publishObservedDestructiveActionCommit(effectOutcome.actionKind);
            }
            // Read the current workspace after the awaited command. The user
            // may have navigated or opened another copy while the request was
            // in flight; every pane that still targets the deleted ref settles.
            settleDeletedResourcePanes({
              deletedRef: input.ref,
              fallbackHref: effectOutcome.fallbackHref,
              workspace: portsRef.current.workspace,
            });
          }
          if (!openOnly) {
            await cache.reconcile(
              reconciliationScopeFor(input.intent, input.ref),
            );
          }
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isApiError(error) && !isSameSystemApiDefect(error)) {
            currentPorts.feedback.publish({
              kind: "Hud",
              content: dispatchErrorContent(input.label, error),
            });
            return;
          }
          // A same-system defect (or any non-ApiError throw) is not
          // user-recoverable; surface it to the nearest error boundary.
          setDefect({ error });
          return;
        } finally {
          if (!openOnly) busyStore.delete(key);
        }
      })();
    },
    [busyStore, cache],
  );

  const runtimeValue = useMemo<ResourceActionRuntimeValue>(
    () => ({
      cache,
      busyStore,
      invoke,
      raiseDefect: (error) => setDefect({ error }),
      offerCompletionUndo,
    }),
    [cache, busyStore, invoke, offerCompletionUndo],
  );

  // The one client-wide environment. Shell identity and service readiness are
  // independent facts: Android never masquerades as Web while native startup
  // is still connecting.
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
  const playbackByRef = useMemo(() => {
    const byRef = new Map<CanonicalResourceRef, "Idle" | "Paused" | "Ended">();
    const session = canonicalSessionOfGlobalState(playerSession.state);
    if (session === null) return byRef;
    const ref = `media:${session.descriptor.mediaId}` as CanonicalResourceRef;
    switch (playerSession.state.kind) {
      case "PausedAtEnd":
      case "Completing":
      case "CompletionFailed":
        byRef.set(ref, "Ended");
        break;
      case "Active":
        if (playerSession.state.phase === "Paused") {
          byRef.set(ref, "Paused");
        }
        break;
      case "Absent":
      case "RuntimeFailed":
      case "PlaybackFailed":
      case "PreviewAudio":
      case "PreviewAudioFailed":
      case "PreviewAudioAtEnd":
        break;
    }
    return byRef;
  }, [playerSession.state]);
  const environment = useMemo<ResourceActionEnvironment>(
    () => ({
      platform: platformFromAndroidShell(androidShell),
      connectivity,
      offline:
        offlineCapability.kind === "Ready"
          ? {
              kind: "Ready",
              byRef: offlineMediaByRefFromInventory(inventory),
            }
          : offlineCapability.kind === "Connecting"
            ? { kind: "Loading" }
            : { kind: "Unavailable" },
      lectern:
        lectern.resource.status === "ready"
          ? {
              kind: "Ready",
              atCapacity:
                lectern.resource.data.items.length >= LECTERN_MAX_ITEMS,
              mutation: lectern.mutation.kind === "Idle" ? "Idle" : "Busy",
            }
          : lectern.resource.status === "error"
            ? { kind: "Error" }
            : { kind: "Loading" },
      playbackByRef,
    }),
    [
      androidShell,
      connectivity,
      inventory,
      lectern.mutation.kind,
      lectern.resource,
      offlineCapability.kind,
      playbackByRef,
    ],
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
 * The shell-owned completion offer survives the pane that created it and owns
 * both canonical unread/Lectern reconciliation barriers.
 */
export function useResourceActionCompletionUndo(): (
  input: CompletionUndoInput,
) => void {
  return useRuntimeContext().offerCompletionUndo;
}

/**
 * Register a ref for deduplicated batch prefetch and read its cache state. The
 * trigger stays unavailable until this returns a Ready entry, so opening a
 * menu performs no request.
 */
export function useResourceActionSnapshot(
  ref: CanonicalResourceRef | null,
): SnapshotCacheEntry | undefined {
  const { cache } = useRuntimeContext();
  useEffect(() => {
    if (ref === null) return;
    return cache.retain(ref);
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

function descriptorsForPlan(
  plan: readonly PlannedResourceAction[],
  target: ResourceActionSubject,
  activation: ResourceActivation,
  invoke: (input: InvokeInput) => void,
  forceBlockedReason?: string,
): readonly ActionDescriptor[] {
  return plan.map((action, index) =>
    plannedActionToDescriptor(
      action,
      target,
      activation,
      invoke,
      index > 0 &&
        plan[index - 1]!.presentation.group !== action.presentation.group,
      forceBlockedReason,
    ),
  );
}

function useCanonicalResourceActionModel(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  const { busyStore, cache, invoke, raiseDefect } = useRuntimeContext();
  const environment = useResourceActionEnvironment();
  const entry = useResourceActionSnapshot(target.ref);
  const busyKeys = useSyncExternalStore(
    busyStore.subscribe,
    busyStore.getKeys,
    busyStore.getKeys,
  );
  return useMemo<ResourceActionMenuModel>(() => {
    if (!entry || entry.status === "Loading") return LOADING_MODEL;
    const snapshot =
      entry.status === "Ready" || entry.status === "Reconciling"
        ? entry.snapshot
        : entry.lastGoodSnapshot;
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
        void cache.retry(target.ref).catch(raiseDefect);
      },
    };
    if (snapshot === undefined) {
      return {
        status: "Error",
        descriptors: [retry],
        triggerDisabled: false,
      };
    }
    const plan = resolveResourceActionPlan(
      snapshot,
      environment,
      busyIdsForRef(busyKeys, target.ref),
    );
    if (entry.status === "Error") {
      return {
        status: "Error",
        descriptors: [
          ...descriptorsForPlan(
            plan,
            target,
            snapshot.activation,
            invoke,
            "Refresh actions before trying this command again.",
          ),
          { ...retry, separatorBefore: plan.length > 0 || undefined },
        ],
        triggerDisabled: false,
      };
    }
    const descriptors = descriptorsForPlan(
      plan,
      target,
      snapshot.activation,
      invoke,
    );
    return {
      status: "Ready",
      descriptors,
      triggerDisabled: descriptors.length === 0,
      ...(descriptors.length === 0
        ? { triggerDisabledReason: "No actions are available." }
        : {}),
    };
  }, [busyKeys, cache, entry, environment, invoke, raiseDefect, target]);
}

/**
 * The dropdown model for `ResourceActionMenu`: the composed, danger-last plan
 * projected to ActionDescriptor[]. Until the ref's snapshot exists, the visible
 * trigger is inert and menu-open performs zero network work.
 */
export function useResourceActionMenuModel(
  target: ResourceActionSubject,
): ResourceActionMenuModel {
  return useCanonicalResourceActionModel(target);
}
