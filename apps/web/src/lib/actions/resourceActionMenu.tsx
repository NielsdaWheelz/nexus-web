import { createElement } from "react";
import type { LucideIcon } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { present } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import type { FeedbackContextValue } from "@/components/feedback/Feedback";
import {
  RESOURCE_ACTION_CATALOG,
  type ResourceActionId,
  type ResourceActionConfirmation,
} from "@/lib/actions/resourceActions";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
} from "@/lib/actions/resourceActionSnapshot";
import type {
  ResourceActionReconciliationScope,
  ResourceActionSnapshotCache,
} from "@/lib/actions/resourceActionSnapshotCache";
import type { ResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import type { MountedActionRequest } from "@/lib/actions/mountedActionHandoff";
import {
  executeResourceChat,
  executeResourceLibraryPlacement,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import {
  assumeMediaId,
  assumeLecternItemId,
  LECTERN_MAX_ITEMS,
} from "@/lib/lectern/contract";
import type { LecternCapability } from "@/lib/lectern/LecternProvider";
import type { CompletionUndoInput } from "@/lib/lectern/useCompletionUndo";
import { offlineCall } from "@/lib/offline/bridge";
import type { useShareController } from "@/lib/sharing/controller";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { useLibraryPlacementController } from "@/lib/libraries/placementController";
import { deleteMemberLibrary } from "@/lib/libraries/client";
import type { useWorkspaceStore } from "@/lib/workspace/store";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import {
  publishImportsInvalidation,
  repairSearchImport,
  repairSourceImport,
  retrySourceImport,
} from "@/lib/imports/importsClient";
import {
  refreshMediaSource,
} from "@/lib/media/ingestionClient";
import { METADATA_RETRY_BLOCKED_COPY } from "@/lib/media/mediaMetadataOperations";
import { deleteMedia } from "@/lib/media/mediaLibraries";
import { deleteConversation } from "@/lib/chat/conversationIndex";
import {
  retryPodcastSubscriptionBackfill,
  unsubscribeFromPodcast,
} from "@/app/(authenticated)/podcasts/podcastSubscriptions";
import {
  playingEpisode,
  type usePlayerCommands,
  type usePlayerSession,
} from "@/lib/player/playerRuntime";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import {
  artifactPaneHref,
  createDossierBuild,
  learnDossier,
} from "@/lib/dossiers/dossierApi";
import { requestHighlightActionIntent } from "@/lib/highlights/actionIntent";
import {
  requestMessageActionIntent,
  type SettleDeletedMessageConversation,
} from "@/lib/chat/messageActionIntent";
import {
  requestNoteBlockActionIntent,
  requestPageActionIntent,
} from "@/lib/notes/actionIntents";
import { requestPodcastActionIntent } from "@/lib/podcasts/actionIntent";

export interface ResourceActionPorts {
  readonly submitMetadata: (
    mediaId: string,
    expectedJobId: Schema<"MetadataRetryAllowed">["expected_job_id"] | null,
    detail: ActionSelectDetail,
  ) => Promise<void>;
  readonly workspace: ReturnType<typeof useWorkspaceStore>;
  readonly activePaneId: string;
  readonly openShare: ReturnType<typeof useShareController>["openShare"];
  readonly openLibraryPlacement: ReturnType<
    typeof useLibraryPlacementController
  >["openLibraryPlacement"];
  readonly openAuthorsEditor: ReturnType<
    typeof useResourceOverlaysController
  >["openAuthorsEditor"];
  readonly openMediaMetadata: ReturnType<
    typeof useResourceOverlaysController
  >["openMediaMetadata"];
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
    id: ResourceActionId,
  ) => ResourceActionMutationBoundary;
  readonly settleDeletedResource: (
    ref: CanonicalResourceRef,
    fallbackHref: string,
  ) => void;
  readonly settleDeletedMessageConversation: SettleDeletedMessageConversation;
  readonly reconcile: ResourceActionSnapshotCache["reconcile"];
  readonly lectern: LecternCapability;
  readonly playerCommands: ReturnType<typeof usePlayerCommands>;
  readonly playerSession: ReturnType<typeof usePlayerSession>;
  readonly feedback: FeedbackContextValue;
  readonly offerCompletionUndo: (input: CompletionUndoInput) => void;
}

export interface ResourceActionCommand {
  readonly ref: CanonicalResourceRef;
  readonly id: ResourceActionId;
  readonly label: string;
  readonly confirmation?: ResourceActionConfirmation;
  readonly openOnly: boolean;
  readonly reconcile: ResourceActionReconciliationScope;
  readonly execute: (ports: ResourceActionPorts, detail: ActionSelectDetail) => void | Promise<void>;
  readonly detail: ActionSelectDetail;
}

export const RESOURCE_ACTION_BLOCKED_REASON_COPY = {
  PermissionDenied: "You don’t have permission to do this.",
  Locked: "This item is locked.",
  Processing: "Available when processing finishes.",
  TemporarilyUnavailable: "Temporarily unavailable. Try again.",
  Loading: "Actions are still loading.",
  CapacityReached: "Lectern is full. Remove an item to add this one.",
  RequiresOnline: "Connect to the internet to use this action.",
  UnsupportedOnDevice: "Not supported on this device.",
  Busy: "This action is in progress.",
};
type BlockedReason = keyof typeof RESOURCE_ACTION_BLOCKED_REASON_COPY;

function activate(
  activation: ResourceActivation,
  ports: ResourceActionPorts,
  disposition: "Follow" | "Fork" = "Follow",
) {
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

function lecternReady(
  ports: ResourceActionPorts,
  capacityMatters: boolean,
): boolean {
  let title: string | undefined;
  if (ports.lectern.resource.status !== "ready")
    title = "Lectern is still loading";
  else if (ports.lectern.busy)
    title = "Another Lectern change is still finishing";
  else if (
    capacityMatters &&
    ports.lectern.resource.data.items.length >= LECTERN_MAX_ITEMS
  )
    title = "Lectern is full";
  if (!title) return true;
  ports.feedback.publish({ kind: "Hud", content: { tone: "Neutral", title } });
  return false;
}

async function deliverMountedAction(
  request: MountedActionRequest,
  activation: ResourceActivation,
  ports: ResourceActionPorts,
  abort?: () => void,
): Promise<boolean> {
  try {
    activate(activation, ports);
  } catch (error) {
    if (request.cancel("ActivationFailed")) abort?.();
    throw error;
  }
  const outcome = await request.outcome;
  if (outcome.kind === "Accepted") return true;
  abort?.();
  if (outcome.kind === "OwnerDefect") throw outcome.error;
  ports.feedback.publish({
    kind: "Hud",
    content: {
      tone: "Danger",
      title: "Resource action couldn’t be opened",
      message: "The resource did not become ready for this action. Try again.",
    },
  });
  return false;
}

// An accepted editor retains settlement ownership even after its pane unmounts.
async function mountedMutation(
  snapshot: ResourceActionSnapshot,
  ports: ResourceActionPorts,
  request: (completion: {
    onCommitted: () => Promise<void>;
    onAborted: () => void;
  }) => MountedActionRequest,
  scope: ResourceActionReconciliationScope = {
    kind: "Subjects",
    refs: [snapshot.ref],
  },
): Promise<void> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const finish = () => {
    if (settled)
      throw new Error(`Mounted resource action settled twice: ${snapshot.ref}`);
    settled = true;
  };
  const callbacks = {
    async onCommitted() {
      finish();
      try {
        await ports.reconcile(scope);
        resolve();
      } catch (error) {
        // The awaiting invocation owns this failure, not the editor callback.
        reject(error);
      }
    },
    onAborted() {
      finish();
      resolve();
    },
  };
  if (
    await deliverMountedAction(
      request(callbacks),
      snapshot.activation,
      ports,
      callbacks.onAborted,
    )
  ) {
    await completion;
  }
}

interface CommandOptions {
  readonly label?: string;
  readonly icon?: LucideIcon;
  readonly checked?: boolean;
  readonly blocked?: BlockedReason;
  readonly disabledReason?: string;
  readonly confirmation?: ResourceActionConfirmation;
  readonly openOnly?: boolean;
  readonly restoreFocusOnClose?: boolean;
  readonly reconcile?: ResourceActionReconciliationScope;
}

// Render straight from server capabilities and current client facts. Executable
// callbacks and their reconciliation policy are declared beside the menu item.
export function resourceActionDescriptors({
  snapshot,
  environment,
  busyIds,
  invoke,
  forceBlockedReason,
}: {
  snapshot: ResourceActionSnapshot;
  environment: ResourceActionEnvironment;
  busyIds: ReadonlySet<ResourceActionId>;
  invoke: (command: ResourceActionCommand) => void;
  forceBlockedReason?: string;
}): readonly ActionDescriptor[] {
  if (snapshot.missing) return [];
  const { ref, activation } = snapshot;
  const subject = { ref };
  const id = () => {
    const parsed = parseResourceRef(ref);
    if (!parsed) throw new Error(`Invalid resource action ref: ${ref}`);
    return parsed.id;
  };
  const subjectScope = { kind: "Subjects", refs: [ref] } as const;
  const allScope = { kind: "AllRetained" } as const;
  const noneScope = { kind: "None" } as const;
  const mounted = { ref, activation };
  const lecternBlocked = (
    capacityMatters: boolean,
  ): BlockedReason | undefined => {
    const state = environment.lectern;
    if (state.kind === "Loading") return "Loading";
    if (state.kind === "Error") return "TemporarilyUnavailable";
    if (state.mutation === "Busy") return "Busy";
    if (capacityMatters && state.atCapacity) return "CapacityReached";
  };
  const make = (
    capability: ResourceActionCapability,
    actionId: ResourceActionId,
    execute: ResourceActionCommand["execute"],
    options: CommandOptions = {},
  ): ActionDescriptor => {
    const entry = RESOURCE_ACTION_CATALOG[actionId];
    const label = options.label ?? entry.label;
    let reason = options.blocked;
    if (capability.availability.kind === "Blocked")
      reason = capability.availability.reason;
    if (busyIds.has(actionId)) reason = "Busy";
    const disabledReason =
      forceBlockedReason ??
      (busyIds.has(actionId) ? RESOURCE_ACTION_BLOCKED_REASON_COPY.Busy : undefined) ??
      options.disabledReason ??
      (reason ? RESOURCE_ACTION_BLOCKED_REASON_COPY[reason] : undefined);
    return {
      kind: "command",
      id: actionId,
      label,
      icon: createElement(options.icon ?? entry.icon, {
        size: 16,
        "aria-hidden": true,
      }),
      tone: entry.group === "Danger" ? "danger" : "default",
      disabled: disabledReason !== undefined || undefined,
      disabledReason,
      restoreFocusOnClose: options.restoreFocusOnClose,
      state:
        options.checked === undefined
          ? undefined
          : { kind: "toggle", pressed: options.checked },
      onSelect: (detail) =>
        invoke({
          ref,
          id: actionId,
          label,
          execute,
          detail,
          confirmation:
            options.confirmation ??
            ("confirmation" in entry ? entry.confirmation : undefined),
          openOnly: options.openOnly ?? false,
          reconcile: options.reconcile ?? noneScope,
        }),
    };
  };

  const download = (
    capability: Extract<ResourceActionCapability, { kind: "Download" }>,
  ): ActionDescriptor => {
    const actionId = "ResourceOperation.Media.Offline";
    const states = RESOURCE_ACTION_CATALOG[actionId].states;
    // Android answers on the bridge; a refusal is a hud, never a workspace defect.
    const call =
      (op: string, args: Record<string, unknown> = {}) =>
      async (ports: ResourceActionPorts) => {
        try {
          await offlineCall(op, { mediaId: id(), ...args });
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          ports.feedback.publish({
            kind: "Hud",
            content: {
              tone: "Danger",
              title:
                code === "Storage"
                  ? "Not enough device storage for this download."
                  : code === "Unsupported"
                    ? "This episode’s audio can’t be downloaded."
                    : "The download couldn’t be changed. Try again.",
            },
          });
        }
      };
    const enqueue = call("enqueue", {
      kind: capability.mediaKind,
      title: capability.title,
      url: capability.audioUrl,
    });
    const state = environment.offline;
    if (state.kind !== "Ready")
      return make(capability, actionId, enqueue, {
        checked: false,
        blocked: state.kind === "Loading" ? "Loading" : "UnsupportedOnDevice",
      });
    const requiresOnline =
      environment.connectivity === "Offline" ? "RequiresOnline" : undefined;
    const item = state.byRef.get(ref);
    switch (item?.state) {
      case undefined:
        return make(capability, actionId, enqueue, {
          checked: false,
          blocked: requiresOnline,
          confirmation:
            capability.mediaKind === "web_article"
              ? {
                  title: "Download text-only copy?",
                  body: "Downloaded web articles include readable text but not images.",
                }
              : undefined,
        });
      case "Queued":
      case "Downloading":
        return make(capability, actionId, call("cancel"), {
          ...states.Downloading,
          checked: false,
        });
      case "Ready":
        return make(capability, actionId, call("remove"), {
          ...states.Ready,
          checked: true,
          confirmation:
            item.progress !== null && item.progress.kind !== "Canonical"
              ? {
                  title: "Remove downloaded copy?",
                  body: "Remove this copy and its position saved on this device. That position has not reached Nexus.",
                }
              : undefined,
        });
      case "Failed":
        return make(capability, actionId, call("retry"), {
          ...states.Failed,
          checked: false,
          blocked: requiresOnline,
        });
      case "Removing":
        return make(capability, actionId, call("remove"), {
          ...states.Ready,
          checked: true,
          blocked: "Busy",
        });
    }
  };

  const project = (
    capability: ResourceActionCapability,
  ): ActionDescriptor | null => {
    switch (capability.kind) {
      case "Open":
        return make(capability, "ResourceAction.Open", (ports) =>
          activate(activation, ports),
        );
      case "OpenInNewPane":
        return make(capability, "ResourceAction.OpenInNewPane", (ports) =>
          activate(activation, ports, "Fork"),
        );
      case "OpenSource": {
        const descriptor = make(
          capability,
          "ResourceOperation.OpenSource",
          () => {},
        );
        return {
          kind: "link",
          id: descriptor.id,
          label: descriptor.label,
          icon: descriptor.icon,
          tone: descriptor.tone,
          disabled: descriptor.disabled,
          disabledReason: descriptor.disabledReason,
          href: capability.href,
        };
      }
      case "MediaMetadata":
        return make(
          capability,
          "ResourceAction.Media.Metadata",
          (ports, detail) => {
            const paneId = detail.triggerEl?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId
              ?? detail.triggerEl?.closest<HTMLElement>("[data-pane-chrome-for]")?.dataset.paneChromeFor
              ?? ports.activePaneId;
            ports.openMediaMetadata(id(), detail.triggerEl, () =>
              findPaneChromeFocusTarget(paneId),
            );
          },
          { openOnly: true, restoreFocusOnClose: false },
        );
      case "Playback": {
        const playback = environment.playbackByRef.get(ref) ?? "Idle";
        return make(
          capability,
          "ResourceOperation.Media.Playback",
          // playAudio resumes the loaded episode, or starts it from the server's resume point.
          (ports) => ports.playerCommands.playAudio(capability.playerDescriptor),
          {
            ...RESOURCE_ACTION_CATALOG["ResourceOperation.Media.Playback"]
              .states[playback],
            blocked: lecternBlocked(false),
          },
        );
      }
      case "PlayNext":
        return make(
          capability,
          "ResourceOperation.Media.PlayNext",
          async (ports) => {
            if (!lecternReady(ports, true)) return;
            // After the playing episode's row when it has one (and is not this media), else first.
            const playing = playingEpisode(ports.playerSession.state);
            const row = ports.lectern
              .getCanonicalSnapshot()
              ?.items.find(
                (item) =>
                  item.mediaSummary.mediaId === playing?.mediaId &&
                  item.mediaSummary.mediaId !== id(),
              );
            await ports.lectern.placeItems({
              mediaIds: [assumeMediaId(id())],
              placement: row
                ? { kind: "After", itemId: row.itemId }
                : { kind: "First" },
            });
          },
          { blocked: lecternBlocked(true), reconcile: subjectScope },
        );
      case "Consumption":
      case "EpisodeConsumption": {
        const finished =
          capability.state === "Finished" || capability.state === "Played";
        const states =
          RESOURCE_ACTION_CATALOG["ResourceOperation.Media.Consumption"].states;
        const presentation =
          capability.kind === "Consumption"
            ? states[finished ? "DocumentFinished" : "DocumentIncomplete"]
            : states[finished ? "EpisodePlayed" : "EpisodeUnplayed"];
        return make(
          capability,
          "ResourceOperation.Media.Consumption",
          async (ports) => {
            if (!lecternReady(ports, false)) return;
            const mediaId = assumeMediaId(id());
            if (finished) {
              await ports.lectern.setUnread(mediaId);
              return;
            }
            const before = ports.lectern.getCanonicalSnapshot() ?? { items: [] };
            const result = await ports.lectern.ensureMediaFinished(mediaId);
            ports.offerCompletionUndo({
              mediaId,
              before,
              finishId: result.finishId,
              done: false,
            });
          },
          {
            ...presentation,
            checked: finished,
            blocked: lecternBlocked(false),
            reconcile: subjectScope,
          },
        );
      }
      case "ResetProgress":
        return make(
          capability,
          "ResourceOperation.Media.ResetProgress",
          async (ports) => {
            if (lecternReady(ports, false))
              await ports.lectern.resetProgress(assumeMediaId(id()));
          },
          { blocked: lecternBlocked(false), reconcile: subjectScope },
        );
      case "Transcript": {
        const state = capability.state;
        const open =
          state === "Ready" ||
          state === "Partial" ||
          state === "Queued" ||
          state === "Running";
        let blocked: BlockedReason | undefined;
        if (state === "Queued" || state === "Running") blocked = "Processing";
        else if (state === "Unavailable") blocked = "TemporarilyUnavailable";
        return make(
          capability,
          "ResourceOperation.Media.Transcript",
          async (ports) => {
            if (open) {
              activate(activation, ports);
              return;
            }
            await apiFetch(`/api/media/${id()}/transcript/request`, {
              method: "POST",
              body: JSON.stringify({ reason: "episode_open" }),
            });
          },
          {
            ...RESOURCE_ACTION_CATALOG["ResourceOperation.Media.Transcript"]
              .states[state],
            blocked,
            reconcile: open ? noneScope : subjectScope,
          },
        );
      }
      case "Download":
        return download(capability);
      case "LibraryPlacement":
        return make(
          capability,
          "RelationshipAction.LibraryPlacement",
          (ports) => {
            const anchor =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            executeResourceLibraryPlacement({
              subject,
              openLibraryPlacement: ports.openLibraryPlacement,
              options: {
                anchor: () => anchor,
                returnFocusFallback: present(() =>
                  findPaneLandmarkFocusTarget(ports.activePaneId),
                ),
                reconcileActions: () => ports.reconcile(subjectScope),
              },
            });
          },
          { openOnly: true },
        );
      case "LecternMembership": {
        const included = capability.state === "Present";
        return make(
          capability,
          "RelationshipAction.LecternMembership",
          async (ports) => {
            if (!lecternReady(ports, !included)) return;
            if (capability.state === "Present")
              await ports.lectern.removeItem(
                assumeLecternItemId(capability.lecternItemId),
              );
            else
              await ports.lectern.placeItems({
                mediaIds: [assumeMediaId(id())],
                placement: { kind: "Last" },
              });
          },
          {
            ...RESOURCE_ACTION_CATALOG["RelationshipAction.LecternMembership"]
              .states[capability.state],
            checked: included,
            blocked: lecternBlocked(!included),
            reconcile: subjectScope,
          },
        );
      }
      case "PodcastSubscription": {
        const subscribed = capability.state === "Subscribed";
        return make(
          capability,
          "RelationshipAction.PodcastSubscription",
          async (ports) => {
            if (subscribed) await unsubscribeFromPodcast(id());
            else
              ports.openSubscribe(
                id(),
                ports.createOverlayMutationBoundary(
                  ref,
                  "RelationshipAction.PodcastSubscription",
                ),
              );
          },
          {
            ...RESOURCE_ACTION_CATALOG["RelationshipAction.PodcastSubscription"]
              .states[capability.state],
            checked: subscribed,
            openOnly: !subscribed,
            reconcile: subscribed ? allScope : noneScope,
          },
        );
      }
      case "Chat":
        return make(capability, "ResourceAction.Chat", async (ports) => {
          await executeResourceChat({
            ref,
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
        });
      case "Share":
        return make(capability, "ResourceAction.Share", (ports) => {
          const anchor =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          executeResourceShare({
            subject,
            openShare: ports.openShare,
            options: {
              returnFocusTo: () => anchor,
              returnFocusFallback: present(() =>
                findPaneLandmarkFocusTarget(ports.activePaneId),
              ),
            },
          });
        });
      case "DownloadOriginal":
        return make(
          capability,
          "ResourceOperation.Media.DownloadOriginal",
          async () => {
            const response = await apiFetch<
              ApiJson<"/media/{media_id}/file", "get">
            >(`/api/media/${id()}/file`, { cache: "no-store" });
            window.location.assign(response.data.url);
          },
        );
      case "Recovery": {
        const offer = capability.offer;
        switch (offer.kind) {
          case "RetrySource":
            return make(
              capability,
              "ResourceOperation.Media.RetryProcessing",
              async () => {
                await retrySourceImport({
                  mediaId: id(),
                  expectedAttemptId: offer.expectedAttemptId,
                  clientMutationId: crypto.randomUUID(),
                });
                publishImportsInvalidation();
              },
              { reconcile: subjectScope },
            );
          case "RepairSource":
            return make(
              capability,
              "ResourceOperation.Media.RepairSource",
              async () => {
                await repairSourceImport({
                  mediaId: id(),
                  expectedAttemptId: offer.expectedAttemptId,
                  expectedJobId: offer.expectedJobId,
                  clientMutationId: crypto.randomUUID(),
                });
                publishImportsInvalidation();
              },
              { reconcile: subjectScope },
            );
          case "RepairSearch":
            return make(
              capability,
              "ResourceOperation.Media.RepairSearch",
              async () => {
                await repairSearchImport({
                  mediaId: id(),
                  expectedRevision: offer.expectedRevision,
                  expectedJobId: offer.expectedJobId,
                  clientMutationId: crypto.randomUUID(),
                });
                publishImportsInvalidation();
              },
              { reconcile: subjectScope },
            );
          default:
            return assertNever(offer, "media recovery offer");
        }
      }
      case "RefreshSource":
        return make(
          capability,
          "ResourceOperation.Media.RefreshSource",
          async () => {
            await refreshMediaSource(id());
          },
          { reconcile: subjectScope },
        );
      case "RetryMetadata": {
        const confirming = environment.pendingMetadataRequests.has(ref);
        const canConfirm = confirming && (capability.retry.status !== "blocked"
          || capability.retry.reason !== "not_creator");
        return make(
          canConfirm ? { ...capability, availability: { kind: "Available" } } : capability,
          "ResourceOperation.Media.RetryMetadata",
          async (ports, detail) => {
            await ports.submitMetadata(id(), capability.retry.status === "allowed"
              ? capability.retry.expected_job_id : null, detail);
          },
          {
            label: canConfirm ? "confirm metadata request" : undefined,
            disabledReason: !canConfirm && capability.retry.status === "blocked"
              ? METADATA_RETRY_BLOCKED_COPY[capability.retry.reason] : undefined,
            blocked: environment.connectivity === "Offline" ? "RequiresOnline" : undefined,
            reconcile: subjectScope,
          },
        );
      }
      case "EditAuthors":
        return make(
          capability,
          "ResourceOperation.Media.EditAuthors",
          (ports) => {
            ports.openAuthorsEditor(
              id(),
              ports.createOverlayMutationBoundary(
                ref,
                "ResourceOperation.Media.EditAuthors",
              ),
            );
          },
          { openOnly: true },
        );
      case "LibrarySettings":
        return make(
          capability,
          "ResourceOperation.Library.Settings",
          (ports) => {
            ports.openLibrarySettings(
              id(),
              ports.createOverlayMutationBoundary(
                ref,
                "ResourceOperation.Library.Settings",
              ),
            );
          },
          { openOnly: true },
        );
      case "PodcastSettings":
        return make(
          capability,
          "ResourceOperation.Podcast.Settings",
          (ports) => {
            ports.openPodcastSettings(
              id(),
              ports.createOverlayMutationBoundary(
                ref,
                "ResourceOperation.Podcast.Settings",
              ),
            );
          },
          { openOnly: true },
        );
      case "RetryPodcastBackfill":
        return make(
          capability,
          "ResourceOperation.Podcast.RetryBackfill",
          async () => {
            await retryPodcastSubscriptionBackfill(id());
          },
          { reconcile: subjectScope },
        );
      case "RemoveMedia":
        return make(
          capability,
          "ResourceOperation.Media.Remove",
          async (ports) => {
            await deleteMedia(id());
            ports.settleDeletedResource(ref, "/libraries");
          },
          { reconcile: allScope },
        );
      case "DeleteLibrary":
        return make(
          capability,
          "ResourceOperation.Library.Delete",
          async (ports) => {
            await deleteMemberLibrary(id());
            ports.settleDeletedResource(ref, "/libraries");
          },
          { reconcile: allScope },
        );
      case "DeleteConversation":
        return make(
          capability,
          "ResourceOperation.Conversation.Delete",
          async (ports) => {
            await deleteConversation(id());
            ports.settleDeletedResource(ref, "/conversations");
          },
          { reconcile: allScope },
        );
      case "RefreshPodcast":
        return make(
          capability,
          "ResourceOperation.Podcast.Refresh",
          (ports) =>
            mountedMutation(snapshot, ports, (completion) =>
              requestPodcastActionIntent({
                kind: "RefreshPodcast",
                ...mounted,
                ...completion,
              }),
            ),
          { reconcile: subjectScope },
        );
      case "LearnHighlight":
        return make(
          capability,
          "ResourceOperation.Highlight.Learn",
          async (ports) => {
            const outcome = await learnDossier(ref, crypto.randomUUID());
            ports.workspace.activateWorkspaceTarget({
              originPaneId: ports.activePaneId,
              target: {
                href: artifactPaneHref(outcome.artifact_ref),
                labelHint: "Dossier",
              },
              disposition: { kind: "Follow" },
              modality: "Programmatic",
            });
          },
        );
      case "RegenerateArtifact":
        return make(
          capability,
          "ResourceOperation.Artifact.Regenerate",
          async () => {
            await createDossierBuild(
              { kind: "Artifact", artifactRef: ref },
              null,
              crypto.randomUUID(),
            );
          },
          { reconcile: subjectScope },
        );
      case "HighlightNote":
        return make(
          capability,
          "ResourceOperation.Highlight.Note",
          (ports) =>
            mountedMutation(snapshot, ports, (completion) =>
              requestHighlightActionIntent(
                capability.state === "Present"
                  ? {
                      kind: "EditHighlightNote",
                      noteBlockId: capability.noteBlockId,
                      ...mounted,
                      ...completion,
                    }
                  : { kind: "AddHighlightNote", ...mounted, ...completion },
              ),
            ),
          RESOURCE_ACTION_CATALOG["ResourceOperation.Highlight.Note"].states[
            capability.state
          ],
        );
      case "EditHighlight":
      case "LinkHighlight":
      case "EditHighlightBounds":
      case "DeleteHighlight": {
        const kind = capability.kind;
        const actionIds = {
          EditHighlight: "ResourceOperation.Highlight.Edit",
          LinkHighlight: "ResourceOperation.Highlight.Link",
          EditHighlightBounds: "ResourceOperation.Highlight.EditBounds",
          DeleteHighlight: "ResourceOperation.Highlight.Delete",
        } as const;
        return make(capability, actionIds[capability.kind], (ports) =>
          mountedMutation(
            snapshot,
            ports,
            (completion) =>
              requestHighlightActionIntent({ kind, ...mounted, ...completion }),
            capability.kind === "DeleteHighlight" ? allScope : subjectScope,
          ),
        );
      }
      case "ForkMessage":
      case "WalkMessageSources": {
        const kind = capability.kind;
        return make(
          capability,
          capability.kind === "ForkMessage"
            ? "ResourceOperation.Message.Fork"
            : "ResourceOperation.Message.WalkSources",
          async (ports) => {
            await deliverMountedAction(
              requestMessageActionIntent({ kind, ...mounted }),
              activation,
              ports,
            );
          },
        );
      }
      case "RerunMessage":
      case "RegenerateMessage":
      case "DeleteMessage": {
        const kind = capability.kind;
        const actionIds = {
          RerunMessage: "ResourceOperation.Message.Rerun",
          RegenerateMessage: "ResourceOperation.Message.Regenerate",
          DeleteMessage: "ResourceOperation.Message.Delete",
        } as const;
        return make(capability, actionIds[capability.kind], (ports) =>
          mountedMutation(
            snapshot,
            ports,
            (completion) =>
              requestMessageActionIntent(
                kind === "DeleteMessage"
                  ? {
                      kind: "DeleteMessage",
                      settleDeletedConversation:
                        ports.settleDeletedMessageConversation,
                      ...mounted,
                      ...completion,
                    }
                  : { kind, ...mounted, ...completion },
              ),
            capability.kind === "DeleteMessage" ? allScope : subjectScope,
          ),
        );
      }
      case "EditPageTitle":
      case "DeletePage": {
        const kind = capability.kind;
        return make(
          capability,
          capability.kind === "EditPageTitle"
            ? "ResourceOperation.Page.EditTitle"
            : "ResourceOperation.Page.Delete",
          (ports) =>
            mountedMutation(
              snapshot,
              ports,
              (completion) =>
                requestPageActionIntent({ kind, ...mounted, ...completion }),
              capability.kind === "DeletePage" ? allScope : subjectScope,
            ),
        );
      }
      case "EditNoteBody":
        return make(
          capability,
          "ResourceOperation.NoteBlock.EditBody",
          (ports) =>
            mountedMutation(snapshot, ports, (completion) =>
              requestNoteBlockActionIntent({
                kind: "EditNoteBody",
                ...mounted,
                ...completion,
              }),
            ),
        );
      default:
        return assertNever(capability, "resource action capability");
    }
  };

  const seenKinds = new Set<ResourceActionCapability["kind"]>();
  const descriptors = new Map<string, ActionDescriptor>();
  for (const capability of snapshot.capabilities) {
    if (seenKinds.has(capability.kind))
      throw new Error(
        `Duplicate resource action capability kind: ${capability.kind}`,
      );
    seenKinds.add(capability.kind);
    const descriptor = project(capability);
    if (!descriptor) continue;
    if (descriptors.has(descriptor.id))
      throw new Error(`Duplicate resource action id: ${descriptor.id}`);
    descriptors.set(descriptor.id, descriptor);
  }
  const result: ActionDescriptor[] = [];
  let previousGroup: string | undefined;
  for (const [actionId, entry] of Object.entries(RESOURCE_ACTION_CATALOG)) {
    const descriptor = descriptors.get(actionId);
    if (!descriptor) continue;
    result.push({
      ...descriptor,
      separatorBefore:
        (previousGroup !== undefined && previousGroup !== entry.group) ||
        undefined,
    });
    previousGroup = entry.group;
  }
  return result;
}
