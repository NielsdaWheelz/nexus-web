import { createElement, type ComponentType } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  ExternalLink,
  Library,
  ListMinus,
  ListPlus,
  MessageCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  Rss,
  Settings,
  Share2,
  Sparkles,
  Trash2,
  Undo2,
  XCircle,
} from "lucide-react";
import { assumeLecternItemId, type LecternItemId } from "@/lib/lectern/contract";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
  ServerActionAvailability,
} from "@/lib/actions/resourceActionSnapshot";
import type {
  ActionControlState,
  ActionDescriptor,
  ActionSelectDetail,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";

type ActionIcon = ComponentType<{
  size?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

interface ResourceActionCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly busyLabel?: string;
  readonly icon: ActionIcon;
  readonly tone?: "default" | "danger";
  readonly restoreFocusOnClose?: boolean;
}

/**
 * The one owner of cross-surface resource-action identity and presentation
 * metadata. Callers choose applicability and provide execution; they do not
 * restate ids, copy, icons, ordering tone, or focus policy.
 */
export const RESOURCE_ACTION_CATALOG = {
  Open: {
    id: "ResourceAction.Open",
    label: "Open",
    icon: ArrowUpRight,
  },
  ExternalOpen: {
    id: "ExternalAction.Open",
    label: "Open",
    icon: ArrowUpRight,
  },
  Share: {
    id: "ResourceAction.Share",
    label: "Share…",
    icon: Share2,
    restoreFocusOnClose: false,
  },
  Chat: {
    id: "ResourceAction.Chat",
    label: "Chat about this resource",
    busyLabel: "Starting chat...",
    icon: MessageCircle,
  },
  OpenSource: {
    id: "ResourceOperation.OpenSource",
    label: "Open source",
    icon: ExternalLink,
  },
  RetryProcessing: {
    id: "ResourceOperation.Media.RetryProcessing",
    label: "Retry processing",
    busyLabel: "Retrying...",
    icon: RotateCcw,
  },
  DownloadOffline: {
    id: "ResourceOperation.Media.DownloadOffline",
    label: "Download for offline",
    icon: Download,
  },
  CancelOfflineDownload: {
    id: "ResourceOperation.Media.CancelOfflineDownload",
    label: "Cancel download",
    icon: XCircle,
  },
  RetryOfflineDownload: {
    id: "ResourceOperation.Media.RetryOfflineDownload",
    label: "Retry download",
    icon: RotateCcw,
  },
  RemoveOfflineDownload: {
    id: "ResourceOperation.Media.RemoveOfflineDownload",
    label: "Remove download",
    busyLabel: "Removing download…",
    icon: Trash2,
  },
  RefreshSource: {
    id: "ResourceOperation.Media.RefreshSource",
    label: "Refresh source",
    busyLabel: "Refreshing...",
    icon: RefreshCw,
  },
  RetryMetadata: {
    id: "ResourceOperation.Media.RetryMetadata",
    label: "Re-enrich metadata",
    busyLabel: "Re-enriching...",
    icon: Sparkles,
  },
  EditAuthors: {
    id: "ResourceOperation.Media.EditAuthors",
    label: "Edit authors…",
    icon: Pencil,
  },
  MarkFinished: {
    id: "ResourceOperation.Media.MarkFinished",
    label: "Mark as finished",
    busyLabel: "Marking...",
    icon: CheckCircle2,
  },
  MarkUnread: {
    id: "ResourceOperation.Media.MarkUnread",
    label: "Mark as unread",
    busyLabel: "Marking...",
    icon: Undo2,
  },
  ResetProgress: {
    id: "ResourceOperation.Media.ResetProgress",
    label: "Reset progress",
    busyLabel: "Resetting...",
    icon: RotateCcw,
  },
  RemoveMedia: {
    id: "ResourceOperation.Media.Remove",
    label: "Remove media",
    busyLabel: "Removing...",
    icon: Trash2,
    tone: "danger",
    restoreFocusOnClose: false,
  },
  LibrarySettings: {
    id: "ResourceOperation.Library.Settings",
    label: "Settings",
    icon: Settings,
  },
  DeleteLibrary: {
    id: "ResourceOperation.Library.Delete",
    label: "Delete library",
    busyLabel: "Deleting...",
    icon: Trash2,
    tone: "danger",
    restoreFocusOnClose: false,
  },
  PodcastSettings: {
    id: "ResourceOperation.Podcast.Settings",
    label: "Settings",
    busyLabel: "Loading settings...",
    icon: Settings,
  },
  RefreshPodcast: {
    id: "ResourceOperation.Podcast.Refresh",
    label: "Check for new episodes",
    busyLabel: "Checking...",
    icon: RefreshCw,
  },
  MarkPlayed: {
    id: "ResourceOperation.Episode.MarkPlayed",
    label: "Mark as played",
    busyLabel: "Marking...",
    icon: CheckCircle2,
  },
  MarkUnplayed: {
    id: "ResourceOperation.Episode.MarkUnplayed",
    label: "Mark as unplayed",
    busyLabel: "Marking...",
    icon: Undo2,
  },
  DeleteConversation: {
    id: "ResourceOperation.Conversation.Delete",
    label: "Delete conversation",
    busyLabel: "Deleting...",
    icon: Trash2,
    tone: "danger",
    restoreFocusOnClose: false,
  },
  EditLibraryPlacement: {
    id: "RelationshipAction.LibraryPlacement.Edit",
    label: "Libraries…",
    icon: Library,
    restoreFocusOnClose: false,
  },
  AddToLectern: {
    id: "RelationshipAction.Lectern.Add",
    label: "Add to Lectern",
    busyLabel: "Adding...",
    icon: ListPlus,
  },
  RemoveFromLectern: {
    id: "RelationshipAction.Lectern.Remove",
    label: "Remove from Lectern",
    busyLabel: "Removing...",
    icon: ListMinus,
    restoreFocusOnClose: false,
  },
  Subscribe: {
    id: "RelationshipAction.Podcast.Subscribe",
    label: "Subscribe",
    busyLabel: "Subscribing…",
    icon: Rss,
    restoreFocusOnClose: false,
  },
  UnsubscribePodcast: {
    id: "RelationshipAction.Podcast.Unsubscribe",
    label: "Unsubscribe",
    busyLabel: "Unsubscribing...",
    icon: Library,
    tone: "danger",
    restoreFocusOnClose: false,
  },
} as const satisfies Record<string, ResourceActionCatalogEntry>;

export type ResourceActionCatalogKey = keyof typeof RESOURCE_ACTION_CATALOG;
export type ResourceActionId =
  (typeof RESOURCE_ACTION_CATALOG)[ResourceActionCatalogKey]["id"];

interface SemanticResourceActionBase {
  readonly catalogKey: ResourceActionCatalogKey;
  readonly busy?: boolean;
  readonly disabledReason?: string;
}

export type SemanticResourceAction =
  | (SemanticResourceActionBase & {
      readonly kind: "command";
      readonly onSelect: (detail: ActionSelectDetail) => void;
      readonly state?: ActionControlState;
    })
  | (SemanticResourceActionBase & {
      readonly kind: "link";
      readonly href: string;
      readonly onSelect?: (detail: ActionSelectDetail) => void;
    });

function catalogEntry(
  key: ResourceActionCatalogKey,
): ResourceActionCatalogEntry {
  return RESOURCE_ACTION_CATALOG[key];
}

function actionIcon(entry: ResourceActionCatalogEntry) {
  return createElement(entry.icon, { size: 14, "aria-hidden": true });
}

/** Project one catalog-owned semantic action into an overflow-menu descriptor. */
export function projectResourceActionToMenu(
  action: SemanticResourceAction,
): ActionDescriptor {
  const entry = catalogEntry(action.catalogKey);
  if (
    action.busy === true &&
    entry.busyLabel === undefined &&
    action.disabledReason === undefined
  ) {
    // justify-defect: an unavailable action whose label does not explain the
    // state must publish an accessible reason.
    throw new Error(
      `Busy resource action requires disabledReason: ${entry.id}`,
    );
  }
  const common = {
    id: entry.id,
    label:
      action.busy && entry.busyLabel !== undefined
        ? entry.busyLabel
        : entry.label,
    icon: actionIcon(entry),
    disabled: action.busy || undefined,
    disabledReason: action.busy ? action.disabledReason : undefined,
    tone: entry.tone,
  } as const;
  if (action.kind === "link") {
    return {
      ...common,
      kind: "link",
      href: action.href,
      onSelect: action.onSelect,
      restoreFocusOnClose: entry.restoreFocusOnClose,
    };
  }
  return {
    ...common,
    kind: "command",
    onSelect: action.onSelect,
    state: action.state,
    restoreFocusOnClose: entry.restoreFocusOnClose,
  };
}

/**
 * Header/action-bar projection of the same semantic action. Metadata and
 * behavior are intentionally shared with the menu projection; only the target
 * descriptor type requires an icon.
 */
export function projectResourceActionToHeader(
  action: SemanticResourceAction,
): PaneHeaderAction {
  const descriptor = projectResourceActionToMenu(action);
  if (descriptor.icon === undefined) {
    // justify-defect: every catalog entry owns an icon, so a missing icon means
    // the catalog-to-header projection no longer satisfies PaneHeaderAction.
    throw new Error(
      `Resource header action is missing its icon: ${descriptor.id}`,
    );
  }
  return { ...descriptor, icon: descriptor.icon };
}

// ---------------------------------------------------------------------------
// Pure resource-action planner
//
// `resolveResourceActionPlan` is the single owner of resource-action membership,
// grouping, current verb, blocked/busy state, and order. It is TOTAL, PURE, and
// dispatch-free: it reads the server snapshot, the client-wide environment, and
// the global keyed busy set, and returns immutable plan data. The runtime later
// attaches an executor per `intent`; the planner never holds a closure.
// ---------------------------------------------------------------------------

/**
 * Every reason a planned resource action can be blocked while still visible and
 * keyboard-discoverable. `Locked`/`Processing`/`TemporarilyUnavailable` are the
 * server availability reasons; `RequiresOnline` is the one client-only reason the
 * planner derives (an offline device cannot start a download). Device-unsupported
 * actions are omitted, not blocked, and in-flight state is the `busy` field.
 */
export type ResourceActionBlockedReason =
  | "Locked"
  | "Processing"
  | "TemporarilyUnavailable"
  | "RequiresOnline";

/**
 * The closed union of WHAT a resource action does. It carries only the typed
 * data an executor needs (no closures, no URLs beyond `OpenSource`), so the plan
 * stays immutable, comparable, and dispatch-free.
 */
export type ResourceActionIntent =
  | { readonly kind: "Open" }
  | { readonly kind: "Share" }
  | { readonly kind: "Chat" }
  | { readonly kind: "OpenSource"; readonly href: string }
  | { readonly kind: "RetryProcessing" }
  | { readonly kind: "RefreshSource" }
  | { readonly kind: "RetryMetadata" }
  | { readonly kind: "EditAuthors" }
  | { readonly kind: "ResetProgress" }
  | { readonly kind: "LibrarySettings" }
  | { readonly kind: "DeleteLibrary" }
  | { readonly kind: "PodcastSettings" }
  | { readonly kind: "RefreshPodcast" }
  | { readonly kind: "DeleteConversation" }
  | { readonly kind: "RemoveMedia" }
  | { readonly kind: "LibraryPlacement" }
  | { readonly kind: "MarkFinished" }
  | { readonly kind: "MarkUnread" }
  | { readonly kind: "MarkPlayed" }
  | { readonly kind: "MarkUnplayed" }
  | { readonly kind: "Subscribe" }
  | { readonly kind: "Unsubscribe" }
  | { readonly kind: "AddToLectern" }
  | { readonly kind: "RemoveFromLectern"; readonly lecternItemId: LecternItemId }
  | { readonly kind: "OfflineDownload" }
  | { readonly kind: "OfflineCancel" }
  | { readonly kind: "OfflineRetry" }
  | { readonly kind: "OfflineRemove" };

export interface PlannedResourceAction {
  readonly catalogKey: ResourceActionCatalogKey;
  readonly intent: ResourceActionIntent;
  readonly busy: boolean;
  readonly blockedReason?: ResourceActionBlockedReason;
}

export interface ResourceActionPlan {
  readonly core: readonly PlannedResourceAction[];
  readonly operations: readonly PlannedResourceAction[];
  readonly relationships: readonly PlannedResourceAction[];
}

type ResourceActionGroup = "core" | "operations" | "relationships";

interface GroupedPlannedAction {
  readonly group: ResourceActionGroup;
  readonly action: PlannedResourceAction;
}

/** Catalog insertion order — the sole authority for within-group ordering. */
const RESOURCE_ACTION_CATALOG_INDEX: ReadonlyMap<
  ResourceActionCatalogKey,
  number
> = new Map(
  (Object.keys(RESOURCE_ACTION_CATALOG) as ResourceActionCatalogKey[]).map(
    (key, index) => [key, index],
  ),
);

function catalogInsertionIndex(key: ResourceActionCatalogKey): number {
  const index = RESOURCE_ACTION_CATALOG_INDEX.get(key);
  if (index === undefined) {
    // justify-defect: the index map is built from the catalog itself, so a miss
    // means the catalog key type and the runtime catalog disagree.
    throw new Error(`Unknown resource action catalog key: ${key}`);
  }
  return index;
}

function isDangerCatalogKey(key: ResourceActionCatalogKey): boolean {
  return catalogEntry(key).tone === "danger";
}

function isBusyId(
  busyIds: ReadonlySet<ResourceActionId>,
  catalogKey: ResourceActionCatalogKey,
): boolean {
  return busyIds.has(RESOURCE_ACTION_CATALOG[catalogKey].id);
}

function plannedFromServer(
  group: ResourceActionGroup,
  catalogKey: ResourceActionCatalogKey,
  intent: ResourceActionIntent,
  availability: ServerActionAvailability,
  busyIds: ReadonlySet<ResourceActionId>,
): GroupedPlannedAction {
  const busy = isBusyId(busyIds, catalogKey);
  const action: PlannedResourceAction =
    availability.kind === "Blocked"
      ? { catalogKey, intent, busy, blockedReason: availability.reason }
      : { catalogKey, intent, busy };
  return { group, action };
}

/**
 * Derive the concrete offline actions from the one client-wide environment. The
 * server only asserts eligibility (`OfflineAudio`); the concrete Download /
 * Cancel / Retry / Remove verb and the `RequiresOnline` reason live entirely on
 * the client. Web omits offline entirely.
 */
function deriveOfflineAudioActions(
  environment: ResourceActionEnvironment,
  ref: CanonicalResourceRef,
  busyIds: ReadonlySet<ResourceActionId>,
): readonly PlannedResourceAction[] {
  if (environment.platform !== "Android") return [];

  const offlineAction = (
    catalogKey: ResourceActionCatalogKey,
    intent: ResourceActionIntent,
  ): PlannedResourceAction => ({
    catalogKey,
    intent,
    busy: isBusyId(busyIds, catalogKey),
  });

  const availability = environment.offlineMediaByRef.get(ref);
  if (availability === undefined) {
    const busy = isBusyId(busyIds, "DownloadOffline");
    return environment.connectivity === "Offline"
      ? [
          {
            catalogKey: "DownloadOffline",
            intent: { kind: "OfflineDownload" },
            busy,
            blockedReason: "RequiresOnline",
          },
        ]
      : [{ catalogKey: "DownloadOffline", intent: { kind: "OfflineDownload" }, busy }];
  }

  switch (availability.kind) {
    case "Resolving":
    case "Queued":
    case "Downloading":
    case "Restarting":
      return [offlineAction("CancelOfflineDownload", { kind: "OfflineCancel" })];
    case "Ready":
      return [offlineAction("RemoveOfflineDownload", { kind: "OfflineRemove" })];
    case "Failed":
      return [
        offlineAction("RetryOfflineDownload", { kind: "OfflineRetry" }),
        offlineAction("RemoveOfflineDownload", { kind: "OfflineRemove" }),
      ];
    case "Removing":
      return [
        {
          catalogKey: "RemoveOfflineDownload",
          intent: { kind: "OfflineRemove" },
          busy: true,
        },
      ];
    default: {
      const exhaustive: never = availability;
      // justify-defect: LocalAvailability is a closed union; an unknown state
      // has no safe offline verb.
      throw new Error(
        `Unsupported offline availability: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Map one decoded capability to its planned action(s). State machines emit
 * exactly one current verb; `OfflineAudio` derives 0..2 device-local actions;
 * every other capability emits exactly one action.
 */
function planCapability(
  capability: ResourceActionCapability,
  environment: ResourceActionEnvironment,
  ref: CanonicalResourceRef,
  busyIds: ReadonlySet<ResourceActionId>,
): readonly GroupedPlannedAction[] {
  const availability = capability.availability;
  switch (capability.kind) {
    case "Open":
      return [plannedFromServer("core", "Open", { kind: "Open" }, availability, busyIds)];
    case "Share":
      return [plannedFromServer("core", "Share", { kind: "Share" }, availability, busyIds)];
    case "Chat":
      return [plannedFromServer("core", "Chat", { kind: "Chat" }, availability, busyIds)];
    case "OpenSource":
      return [
        plannedFromServer(
          "operations",
          "OpenSource",
          { kind: "OpenSource", href: capability.href },
          availability,
          busyIds,
        ),
      ];
    case "RetryProcessing":
      return [plannedFromServer("operations", "RetryProcessing", { kind: "RetryProcessing" }, availability, busyIds)];
    case "RefreshSource":
      return [plannedFromServer("operations", "RefreshSource", { kind: "RefreshSource" }, availability, busyIds)];
    case "RetryMetadata":
      return [plannedFromServer("operations", "RetryMetadata", { kind: "RetryMetadata" }, availability, busyIds)];
    case "EditAuthors":
      return [plannedFromServer("operations", "EditAuthors", { kind: "EditAuthors" }, availability, busyIds)];
    case "ResetProgress":
      return [plannedFromServer("operations", "ResetProgress", { kind: "ResetProgress" }, availability, busyIds)];
    case "LibrarySettings":
      return [plannedFromServer("operations", "LibrarySettings", { kind: "LibrarySettings" }, availability, busyIds)];
    case "DeleteLibrary":
      return [plannedFromServer("operations", "DeleteLibrary", { kind: "DeleteLibrary" }, availability, busyIds)];
    case "PodcastSettings":
      return [plannedFromServer("operations", "PodcastSettings", { kind: "PodcastSettings" }, availability, busyIds)];
    case "RefreshPodcast":
      return [plannedFromServer("operations", "RefreshPodcast", { kind: "RefreshPodcast" }, availability, busyIds)];
    case "DeleteConversation":
      return [plannedFromServer("operations", "DeleteConversation", { kind: "DeleteConversation" }, availability, busyIds)];
    case "RemoveMedia":
      return [plannedFromServer("operations", "RemoveMedia", { kind: "RemoveMedia" }, availability, busyIds)];
    case "LibraryPlacement":
      return [plannedFromServer("relationships", "EditLibraryPlacement", { kind: "LibraryPlacement" }, availability, busyIds)];
    case "OfflineAudio":
      return deriveOfflineAudioActions(environment, ref, busyIds).map((action) => ({
        group: "operations",
        action,
      }));
    case "Consumption":
      return capability.state === "Finished"
        ? [plannedFromServer("operations", "MarkUnread", { kind: "MarkUnread" }, availability, busyIds)]
        : [plannedFromServer("operations", "MarkFinished", { kind: "MarkFinished" }, availability, busyIds)];
    case "EpisodeConsumption":
      return capability.state === "Played"
        ? [plannedFromServer("operations", "MarkUnplayed", { kind: "MarkUnplayed" }, availability, busyIds)]
        : [plannedFromServer("operations", "MarkPlayed", { kind: "MarkPlayed" }, availability, busyIds)];
    case "PodcastSubscription":
      return capability.state === "Subscribed"
        ? [plannedFromServer("relationships", "UnsubscribePodcast", { kind: "Unsubscribe" }, availability, busyIds)]
        : [plannedFromServer("relationships", "Subscribe", { kind: "Subscribe" }, availability, busyIds)];
    case "LecternMembership":
      if (capability.state === "Present") {
        if (capability.lecternItemId === undefined) {
          // justify-defect: a Present Lectern membership must carry the item id
          // its Remove verb executes against; without it no command is safe.
          throw new Error(
            `LecternMembership Present is missing lecternItemId for ${ref}`,
          );
        }
        return [
          plannedFromServer(
            "relationships",
            "RemoveFromLectern",
            {
              kind: "RemoveFromLectern",
              lecternItemId: assumeLecternItemId(capability.lecternItemId),
            },
            availability,
            busyIds,
          ),
        ];
      }
      return [plannedFromServer("relationships", "AddToLectern", { kind: "AddToLectern" }, availability, busyIds)];
    default: {
      const exhaustive: never = capability;
      // justify-defect: the capability union is closed and same-system; an
      // unknown kind cannot be mapped to a safe action.
      throw new Error(
        `Unsupported resource action capability: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Order a group by catalog insertion index. The planner owns order; callers
 * cannot influence it. Danger placement is NOT decided here — the composer
 * hoists all danger actions into one final group across the whole plan.
 */
function sortByCatalogOrder(
  actions: readonly PlannedResourceAction[],
): readonly PlannedResourceAction[] {
  return [...actions].sort(
    (left, right) =>
      catalogInsertionIndex(left.catalogKey) -
      catalogInsertionIndex(right.catalogKey),
  );
}

/**
 * The one owner of resource-action membership, grouping, current verb, and
 * order. Total, pure, and dispatch-free.
 */
export function resolveResourceActionPlan(
  snapshot: ResourceActionSnapshot,
  environment: ResourceActionEnvironment,
  busyIds: ReadonlySet<ResourceActionId>,
): ResourceActionPlan {
  if (snapshot.missing) {
    return { core: [], operations: [], relationships: [] };
  }

  const seenKinds = new Set<ResourceActionCapability["kind"]>();
  for (const capability of snapshot.capabilities) {
    if (seenKinds.has(capability.kind)) {
      // justify-defect: a snapshot with two facts for one capability kind is a
      // contradiction; the plan's action identity would be ambiguous.
      throw new Error(
        `Duplicate resource action capability kind: ${capability.kind}`,
      );
    }
    seenKinds.add(capability.kind);
  }

  const core: PlannedResourceAction[] = [];
  const operations: PlannedResourceAction[] = [];
  const relationships: PlannedResourceAction[] = [];
  for (const capability of snapshot.capabilities) {
    for (const grouped of planCapability(
      capability,
      environment,
      snapshot.ref,
      busyIds,
    )) {
      switch (grouped.group) {
        case "core":
          core.push(grouped.action);
          break;
        case "operations":
          operations.push(grouped.action);
          break;
        case "relationships":
          relationships.push(grouped.action);
          break;
        default: {
          const exhaustive: never = grouped.group;
          // justify-defect: the group tag is a closed union produced above.
          throw new Error(`Unknown resource action group: ${exhaustive}`);
        }
      }
    }
  }

  return {
    core: sortByCatalogOrder(core),
    operations: sortByCatalogOrder(operations),
    relationships: sortByCatalogOrder(relationships),
  };
}

/** A planned action placed in the final flat menu, with its group-boundary rule. */
export interface ComposedResourceAction extends PlannedResourceAction {
  /** True on the first action of each non-first visual group (separator above). */
  readonly separatorBefore: boolean;
}

/**
 * The one flatten policy for a resolved plan: emit the non-danger groups core →
 * operations → relationships (each already in catalog order), then move every
 * danger action into one final terminal group (catalog order within it), and
 * mark a separator at each group boundary. Defects on a duplicate catalog id so
 * no command's identity is ambiguous. This is the composer the spec assigns the
 * danger-last + separators contract to; the planner owns membership/verb/order.
 */
export function composeResourceActionPlan(
  plan: ResourceActionPlan,
): readonly ComposedResourceAction[] {
  const seen = new Set<ResourceActionId>();
  for (const action of [...plan.core, ...plan.operations, ...plan.relationships]) {
    const id = RESOURCE_ACTION_CATALOG[action.catalogKey].id;
    if (seen.has(id)) {
      // justify-defect: duplicate ids make focus, execution, and busy identity
      // ambiguous, so no command can be selected safely.
      throw new Error(`Duplicate resource action id: ${id}`);
    }
    seen.add(id);
  }
  const notDanger = (action: PlannedResourceAction) =>
    !isDangerCatalogKey(action.catalogKey);
  const danger = sortByCatalogOrder(
    [...plan.core, ...plan.operations, ...plan.relationships].filter(
      (action) => isDangerCatalogKey(action.catalogKey),
    ),
  );
  const groups = [
    plan.core.filter(notDanger),
    plan.operations.filter(notDanger),
    plan.relationships.filter(notDanger),
    danger,
  ].filter((group) => group.length > 0);

  const result: ComposedResourceAction[] = [];
  groups.forEach((group, groupIndex) => {
    group.forEach((action, index) => {
      result.push({
        ...action,
        separatorBefore: groupIndex > 0 && index === 0,
      });
    });
  });
  return result;
}
