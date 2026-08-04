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
import type { Presence } from "@/lib/api/presence";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
  ServerActionAvailability,
} from "@/lib/actions/resourceActionSnapshot";
import { resourceCapabilityForScheme } from "@/lib/resources/resourceCapabilities";
import type {
  ResourceActionSubject,
  StandingActionTarget,
} from "@/lib/resources/resourceActionTarget";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
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
  RemoveFromContext: {
    id: "RelationshipAction.Context.Remove",
    label: "Remove from conversation context",
    busyLabel: "Removing...",
    icon: ListMinus,
    restoreFocusOnClose: false,
  },
  UnlinkConnection: {
    id: "RelationshipAction.Connection.Unlink",
    label: "Unlink connection",
    busyLabel: "Unlinking...",
    icon: ListMinus,
    restoreFocusOnClose: false,
  },
  DismissConnection: {
    id: "RelationshipAction.Connection.Dismiss",
    label: "Dismiss connection",
    busyLabel: "Dismissing...",
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

export interface ResourceMenuGroups {
  readonly core: readonly ActionDescriptor[];
  readonly operations: readonly ActionDescriptor[];
  readonly relationships: readonly ActionDescriptor[];
  readonly view: readonly ActionDescriptor[];
}

export type ActionPublication =
  | {
      readonly kind: "ResourceMenu";
      readonly target: StandingActionTarget;
      readonly groups: ResourceMenuGroups;
    }
  | { readonly kind: "FlatMenu"; readonly actions: readonly ActionDescriptor[] };

export interface RichResourceActionGroups {
  readonly operations: readonly ActionDescriptor[];
  readonly relationships: readonly ActionDescriptor[];
}

export function emptyResourceMenuGroups(): ResourceMenuGroups {
  return { core: [], operations: [], relationships: [], view: [] };
}

function withoutCallerSeparator(
  action: ActionDescriptor,
  separatorBefore: boolean,
): ActionDescriptor {
  const { separatorBefore: _discarded, ...descriptor } = action;
  return separatorBefore
    ? ({ ...descriptor, separatorBefore: true } as ActionDescriptor)
    : (descriptor as ActionDescriptor);
}

/**
 * The only flattening policy for a resource menu. It validates ids before
 * projection, owns all separators, keeps semantic group order, and moves every
 * consequential action to one stable final group.
 */
export function composeResourceMenu(
  groups: ResourceMenuGroups,
): ActionDescriptor[] {
  const semanticGroups = [
    groups.core,
    groups.operations,
    groups.relationships,
    groups.view,
  ] as const;
  const seen = new Set<string>();
  for (const action of semanticGroups.flat()) {
    if (seen.has(action.id)) {
      // justify-defect: duplicate ids make focus, analytics, and execution
      // identity ambiguous, so no command can be selected safely.
      throw new Error(`Duplicate resource action id: ${action.id}`);
    }
    seen.add(action.id);
  }

  const ordinaryGroups = semanticGroups
    .map((group) => group.filter((action) => action.tone !== "danger"))
    .filter((group) => group.length > 0);
  const dangerGroup = semanticGroups
    .flat()
    .filter((action) => action.tone === "danger");
  const finalGroups =
    dangerGroup.length > 0
      ? [...ordinaryGroups, dangerGroup]
      : ordinaryGroups;

  const result: ActionDescriptor[] = [];
  for (const group of finalGroups) {
    group.forEach((action, index) => {
      result.push(
        withoutCallerSeparator(action, result.length > 0 && index === 0),
      );
    });
  }
  return result;
}

export type ResourceActionProjection = "Representation" | "CurrentPane";
export type ResourceCoreCatalogKey = "Open" | "Share" | "Chat";

export type SynchronousResourceActionExecutor<Target> = (
  target: Target,
  detail: ActionSelectDetail,
) => void;

export type ResourceChatExecutor = (
  target: ResourceActionSubject,
  detail: ActionSelectDetail,
) => void | Promise<void>;

function invokeSynchronous<Target>(
  executor: SynchronousResourceActionExecutor<Target>,
  target: Target,
): (detail: ActionSelectDetail) => void {
  return (detail) => executor(target, detail);
}

function invokeChat(
  executor: ResourceChatExecutor,
  target: ResourceActionSubject,
): (detail: ActionSelectDetail) => void {
  return (detail) => {
    void executor(target, detail);
  };
}

type ExternalStandingActionTarget = Extract<
  StandingActionTarget,
  { kind: "External" }
>;

export interface ExternalRepresentationCoreInput {
  readonly target: ExternalStandingActionTarget;
  readonly projection: "Representation";
}

export interface ResourceRepresentationCoreInput {
  readonly target: ResourceActionSubject;
  readonly projection: "Representation";
  readonly busyIds: ReadonlySet<ResourceActionId>;
  readonly executors: {
    readonly open: SynchronousResourceActionExecutor<ResourceActionSubject>;
    readonly share: SynchronousResourceActionExecutor<ResourceActionSubject>;
    readonly chat: ResourceChatExecutor;
  };
}

export interface ResourceCurrentPaneCoreInput {
  readonly target: ResourceActionSubject;
  readonly projection: "CurrentPane";
  readonly busyIds: ReadonlySet<ResourceActionId>;
  readonly executors: {
    readonly share: SynchronousResourceActionExecutor<ResourceActionSubject>;
    readonly chat: ResourceChatExecutor;
  };
}

export type ResourceCoreResolverInput =
  | ExternalRepresentationCoreInput
  | ResourceRepresentationCoreInput
  | ResourceCurrentPaneCoreInput;

function isExternalRepresentationInput(
  input: ResourceCoreResolverInput,
): input is ExternalRepresentationCoreInput {
  return input.target.kind === "External";
}

function validatedResourceActionRef(target: ResourceActionSubject) {
  const parsedRef = parseResourceRef(target.ref);
  if (!parsedRef || target.activation.resourceRef !== target.ref) {
    // justify-defect: the strict target decoder guarantees one canonical
    // identity; contradictory refs could execute against the wrong resource.
    throw new Error(
      `Invalid resource action target: ${JSON.stringify({
        ref: target.ref,
        activationRef: target.activation.resourceRef,
      })}`,
    );
  }
  return parsedRef;
}

/**
 * The projection-independent policy for resource core membership and order.
 * Menu and Nexus projections consume these catalog keys instead of
 * independently re-deriving visibility from scheme capabilities.
 */
export function resolveResourceCoreCatalogKeys(
  target: ResourceActionSubject,
  projection: ResourceActionProjection,
): readonly ResourceCoreCatalogKey[] {
  const parsedRef = validatedResourceActionRef(target);
  if (target.missing) return [];

  const capabilities = resourceCapabilityForScheme(parsedRef.scheme);
  const routeable =
    target.activation.kind !== "none" && target.activation.href !== null;
  const keys: ResourceCoreCatalogKey[] = [];
  if (projection === "Representation" && routeable) keys.push("Open");
  if (routeable && capabilities.sharing !== "None") keys.push("Share");
  if (capabilities.chatSubject !== "none") keys.push("Chat");
  return keys;
}

/**
 * Pure universal-core policy. Static scheme capabilities establish whether
 * Share and Chat are meaningful; the shared executors are required ports rather
 * than optional callbacks that accidentally redefine policy.
 */
export function resolveResourceCoreActions(
  input: ResourceCoreResolverInput,
): ResourceMenuGroups {
  if (isExternalRepresentationInput(input)) {
    return {
      ...emptyResourceMenuGroups(),
      core: [
        projectResourceActionToMenu({
          kind: "link",
          catalogKey: "ExternalOpen",
          href: input.target.href,
        }),
      ],
    };
  }

  const target = input.target;
  const catalogKeys = resolveResourceCoreCatalogKeys(target, input.projection);
  const core: ActionDescriptor[] = [];
  for (const catalogKey of catalogKeys) {
    switch (catalogKey) {
      case "Open":
        if (input.projection === "Representation") {
          core.push(
            projectResourceActionToMenu({
              kind: "command",
              catalogKey,
              onSelect: invokeSynchronous(input.executors.open, target),
            }),
          );
        }
        break;
      case "Share":
        core.push(
          projectResourceActionToMenu({
            kind: "command",
            catalogKey,
            onSelect: invokeSynchronous(input.executors.share, target),
          }),
        );
        break;
      case "Chat":
        core.push(
          projectResourceActionToMenu({
            kind: "command",
            catalogKey,
            busy: input.busyIds.has(RESOURCE_ACTION_CATALOG.Chat.id),
            onSelect: invokeChat(input.executors.chat, target),
          }),
        );
        break;
    }
  }
  return { ...emptyResourceMenuGroups(), core };
}

export interface ResourceRelationshipResolverInput {
  readonly target: ResourceActionSubject;
  readonly executors: {
    readonly libraryPlacement: SynchronousResourceActionExecutor<ResourceActionSubject>;
  };
}

/**
 * Universal relationship policy for standing resource menus. Static scheme
 * capability decides whether placement is meaningful; row permissions remain
 * owned by the placement list response.
 */
export function resolveUniversalResourceRelationshipActions(
  input: ResourceRelationshipResolverInput,
): ResourceMenuGroups {
  const parsedRef = validatedResourceActionRef(input.target);
  if (input.target.missing) return emptyResourceMenuGroups();

  const mode =
    resourceCapabilityForScheme(parsedRef.scheme).libraryPlacement;
  switch (mode) {
    case "None":
      return emptyResourceMenuGroups();
    case "ManageEntries":
      if (parsedRef.scheme !== "media" && parsedRef.scheme !== "podcast") {
        // justify-defect: ManageEntries is a closed capability whose executor
        // can narrow only the two supported placement targets.
        throw new Error(
          `Unsupported library placement scheme: ${parsedRef.scheme}`,
        );
      }
      return {
        ...emptyResourceMenuGroups(),
        relationships: [
          projectResourceActionToMenu({
            kind: "command",
            catalogKey: "EditLibraryPlacement",
            onSelect: invokeSynchronous(
              input.executors.libraryPlacement,
              input.target,
            ),
          }),
        ],
      };
    default: {
      const exhaustive: never = mode;
      throw new Error(
        `Unsupported library placement mode: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

export type RichActionExecutor = (
  detail: ActionSelectDetail,
) => void | Promise<void>;

export type ExecutableResourceAction =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Available"; readonly execute: RichActionExecutor };

export type LecternMembershipAction =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Add"; readonly execute: RichActionExecutor }
  | {
      readonly kind: "Remove";
      readonly itemId: LecternItemId;
      readonly execute: RichActionExecutor;
    };

export type MediaReadStateAction =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "MarkFinished"; readonly execute: RichActionExecutor }
  | { readonly kind: "MarkUnread"; readonly execute: RichActionExecutor };

export type EpisodePlayedStateAction =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "MarkPlayed"; readonly execute: RichActionExecutor }
  | { readonly kind: "MarkUnplayed"; readonly execute: RichActionExecutor };

export type EpisodeOfflineDownloadAction =
  | { readonly kind: "Unavailable" }
  | {
      readonly kind: "Available";
      readonly availability: Presence<LocalAvailability>;
      readonly execute: {
        readonly download: RichActionExecutor;
        readonly cancel: RichActionExecutor;
        readonly retry: RichActionExecutor;
        readonly remove: RichActionExecutor;
      };
    };

export type PodcastSubscriptionAction =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Subscribed"; readonly execute: RichActionExecutor };

export interface MediaActionSubject {
  readonly id: string;
  readonly title: string;
  readonly canonical_source_url: string | null;
}

interface MediaOperationCapabilities {
  readonly retryProcessing: ExecutableResourceAction;
  readonly refreshSource: ExecutableResourceAction;
  readonly retryMetadata: ExecutableResourceAction;
  readonly editAuthors: ExecutableResourceAction;
  readonly progressReset: ExecutableResourceAction;
  readonly lecternMembership: LecternMembershipAction;
  readonly removeMedia: ExecutableResourceAction;
}

export interface MediaResourceActionsInput
  extends MediaOperationCapabilities {
  readonly media: MediaActionSubject;
  readonly readState: MediaReadStateAction;
  readonly busyIds: ReadonlySet<ResourceActionId>;
}

function isBusy(
  busyIds: ReadonlySet<ResourceActionId>,
  catalogKey: ResourceActionCatalogKey,
): boolean {
  return busyIds.has(RESOURCE_ACTION_CATALOG[catalogKey].id);
}

function commandDescriptor(
  catalogKey: ResourceActionCatalogKey,
  execute: RichActionExecutor,
  busyIds: ReadonlySet<ResourceActionId>,
): ActionDescriptor {
  return projectResourceActionToMenu({
    kind: "command",
    catalogKey,
    busy: isBusy(busyIds, catalogKey),
    onSelect: (detail) => {
      void execute(detail);
    },
  });
}

const NO_BUSY_RESOURCE_ACTIONS: ReadonlySet<ResourceActionId> = new Set();

export function episodeOfflineDownloadOptions(
  offline: EpisodeOfflineDownloadAction,
): readonly ActionDescriptor[] {
  if (offline.kind === "Unavailable") return [];
  if (offline.availability.kind === "Absent") {
    return [
      commandDescriptor(
        "DownloadOffline",
        offline.execute.download,
        NO_BUSY_RESOURCE_ACTIONS,
      ),
    ];
  }
  switch (offline.availability.value.kind) {
    case "Resolving":
    case "Queued":
    case "Downloading":
    case "Restarting":
      return [
        commandDescriptor(
          "CancelOfflineDownload",
          offline.execute.cancel,
          NO_BUSY_RESOURCE_ACTIONS,
        ),
      ];
    case "Ready":
      return [
        commandDescriptor(
          "RemoveOfflineDownload",
          offline.execute.remove,
          NO_BUSY_RESOURCE_ACTIONS,
        ),
      ];
    case "Failed":
      return [
        commandDescriptor(
          "RetryOfflineDownload",
          offline.execute.retry,
          NO_BUSY_RESOURCE_ACTIONS,
        ),
        commandDescriptor(
          "RemoveOfflineDownload",
          offline.execute.remove,
          NO_BUSY_RESOURCE_ACTIONS,
        ),
      ];
    case "Removing":
      return [
        projectResourceActionToMenu({
          kind: "command",
          catalogKey: "RemoveOfflineDownload",
          busy: true,
          onSelect: offline.execute.remove,
        }),
      ];
  }
}

function executableDescriptor(
  catalogKey: ResourceActionCatalogKey,
  capability: ExecutableResourceAction,
  busyIds: ReadonlySet<ResourceActionId>,
): ActionDescriptor | null {
  return capability.kind === "Available"
    ? commandDescriptor(catalogKey, capability.execute, busyIds)
    : null;
}

function mediaOperationGroups(
  input: MediaOperationCapabilities & {
    readonly media: MediaActionSubject;
    readonly consumptionAction:
      | MediaReadStateAction
      | EpisodePlayedStateAction;
    readonly busyIds: ReadonlySet<ResourceActionId>;
    readonly offlineDownload?: EpisodeOfflineDownloadAction;
  },
): RichResourceActionGroups {
  const operations: ActionDescriptor[] = [];
  if (input.media.canonical_source_url) {
    operations.push(
      projectResourceActionToMenu({
        kind: "link",
        catalogKey: "OpenSource",
        href: input.media.canonical_source_url,
      }),
    );
  }
  if (input.offlineDownload?.kind === "Available") {
    operations.push(...episodeOfflineDownloadOptions(input.offlineDownload));
  }
  const retry = executableDescriptor(
    "RetryProcessing",
    input.retryProcessing,
    input.busyIds,
  );
  if (retry) operations.push(retry);
  const refresh = executableDescriptor(
    "RefreshSource",
    input.refreshSource,
    input.busyIds,
  );
  if (refresh) operations.push(refresh);
  const metadata = executableDescriptor(
    "RetryMetadata",
    input.retryMetadata,
    input.busyIds,
  );
  if (metadata) operations.push(metadata);
  const editAuthors = executableDescriptor(
    "EditAuthors",
    input.editAuthors,
    input.busyIds,
  );
  if (editAuthors) operations.push(editAuthors);

  switch (input.consumptionAction.kind) {
    case "Unavailable":
      break;
    case "MarkFinished":
      operations.push(
        commandDescriptor(
          "MarkFinished",
          input.consumptionAction.execute,
          input.busyIds,
        ),
      );
      break;
    case "MarkUnread":
      operations.push(
        commandDescriptor(
          "MarkUnread",
          input.consumptionAction.execute,
          input.busyIds,
        ),
      );
      break;
    case "MarkPlayed":
      operations.push(
        commandDescriptor(
          "MarkPlayed",
          input.consumptionAction.execute,
          input.busyIds,
        ),
      );
      break;
    case "MarkUnplayed":
      operations.push(
        commandDescriptor(
          "MarkUnplayed",
          input.consumptionAction.execute,
          input.busyIds,
        ),
      );
      break;
    default: {
      const exhaustive: never = input.consumptionAction;
      // justify-defect: this switch must stay exhaustive as capability variants
      // evolve; an unknown variant has no safe semantic action.
      throw new Error(
        `Unsupported media consumption action: ${JSON.stringify(exhaustive)}`,
      );
    }
  }

  const progressReset = executableDescriptor(
    "ResetProgress",
    input.progressReset,
    input.busyIds,
  );
  if (progressReset) operations.push(progressReset);

  const remove = executableDescriptor(
    "RemoveMedia",
    input.removeMedia,
    input.busyIds,
  );
  if (remove) operations.push(remove);

  const relationships: ActionDescriptor[] = [];
  switch (input.lecternMembership.kind) {
    case "Unavailable":
      break;
    case "Add":
      relationships.push(
        commandDescriptor(
          "AddToLectern",
          input.lecternMembership.execute,
          input.busyIds,
        ),
      );
      break;
    case "Remove":
      relationships.push(
        commandDescriptor(
          "RemoveFromLectern",
          input.lecternMembership.execute,
          input.busyIds,
        ),
      );
      break;
    default: {
      const exhaustive: never = input.lecternMembership;
      // justify-defect: Lectern membership projects exactly one verb; an
      // unknown state cannot safely select a relationship command.
      throw new Error(
        `Unsupported Lectern membership: ${JSON.stringify(exhaustive)}`,
      );
    }
  }

  return {
    operations,
    relationships,
  };
}

export function mediaResourceOptions(
  input: MediaResourceActionsInput,
): RichResourceActionGroups {
  return mediaOperationGroups({
    ...input,
    consumptionAction: input.readState,
  });
}

export interface LibraryResourceActionsInput {
  readonly settings: ExecutableResourceAction;
  readonly deleteLibrary: ExecutableResourceAction;
  readonly busyIds: ReadonlySet<ResourceActionId>;
}

export function libraryResourceOptions(
  input: LibraryResourceActionsInput,
): RichResourceActionGroups {
  const operations: ActionDescriptor[] = [];
  const settings = executableDescriptor(
    "LibrarySettings",
    input.settings,
    input.busyIds,
  );
  if (settings) operations.push(settings);
  const remove = executableDescriptor(
    "DeleteLibrary",
    input.deleteLibrary,
    input.busyIds,
  );
  if (remove) operations.push(remove);
  return {
    operations,
    relationships: [],
  };
}

export interface PodcastResourceActionsInput {
  readonly settings: ExecutableResourceAction;
  readonly checkForNewEpisodes: ExecutableResourceAction;
  readonly subscription: PodcastSubscriptionAction;
  readonly busyIds: ReadonlySet<ResourceActionId>;
}

export function podcastResourceOptions(
  input: PodcastResourceActionsInput,
): RichResourceActionGroups {
  const operations: ActionDescriptor[] = [];
  const settings = executableDescriptor(
    "PodcastSettings",
    input.settings,
    input.busyIds,
  );
  if (settings) operations.push(settings);
  const refresh = executableDescriptor(
    "RefreshPodcast",
    input.checkForNewEpisodes,
    input.busyIds,
  );
  if (refresh) operations.push(refresh);
  const relationships =
    input.subscription.kind === "Subscribed"
      ? [
          commandDescriptor(
            "UnsubscribePodcast",
            input.subscription.execute,
            input.busyIds,
          ),
        ]
      : [];
  return {
    operations,
    relationships,
  };
}

export interface EpisodeResourceActionsInput
  extends MediaOperationCapabilities {
  readonly media: MediaActionSubject;
  readonly playedState: EpisodePlayedStateAction;
  readonly offlineDownload: EpisodeOfflineDownloadAction;
  readonly busyIds: ReadonlySet<ResourceActionId>;
}

export function episodeResourceOptions(
  input: EpisodeResourceActionsInput,
): RichResourceActionGroups {
  return mediaOperationGroups({
    ...input,
    consumptionAction: input.playedState,
  });
}

export interface ConversationResourceActionsInput {
  readonly deleteConversation: ExecutableResourceAction;
  readonly busyIds: ReadonlySet<ResourceActionId>;
}

export function conversationResourceOptions(
  input: ConversationResourceActionsInput,
): RichResourceActionGroups {
  const remove = executableDescriptor(
    "DeleteConversation",
    input.deleteConversation,
    input.busyIds,
  );
  return {
    operations: remove ? [remove] : [],
    relationships: [],
  };
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

/**
 * The one flatten policy for a resolved plan: emit core → operations →
 * relationships, then move every danger action into one final terminal group
 * (preserving catalog order within it). Defects on a duplicate catalog id so no
 * command's identity is ambiguous. This is the composer the spec assigns the
 * danger-last contract to; the planner owns membership/grouping/verb/order.
 */
export function composeResourceActionPlan(
  plan: ResourceActionPlan,
): readonly PlannedResourceAction[] {
  const ordered = [...plan.core, ...plan.operations, ...plan.relationships];
  const seen = new Set<ResourceActionId>();
  for (const action of ordered) {
    const id = RESOURCE_ACTION_CATALOG[action.catalogKey].id;
    if (seen.has(id)) {
      // justify-defect: duplicate ids make focus, execution, and busy identity
      // ambiguous, so no command can be selected safely.
      throw new Error(`Duplicate resource action id: ${id}`);
    }
    seen.add(id);
  }
  const safe = ordered.filter(
    (action) => !isDangerCatalogKey(action.catalogKey),
  );
  const danger = sortByCatalogOrder(
    ordered.filter((action) => isDangerCatalogKey(action.catalogKey)),
  );
  return [...safe, ...danger];
}
