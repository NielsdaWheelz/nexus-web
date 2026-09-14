import {
  ArrowUpRight,
  BookOpenText,
  Captions,
  CircleCheck,
  Download,
  ExternalLink,
  FileDown,
  FilePenLine,
  GitFork,
  Highlighter,
  History,
  Library,
  Link2,
  ListMinus,
  ListPlus,
  ListStart,
  MessageCircle,
  NotebookPen,
  PanelsTopLeft,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Rss,
  Settings,
  Share2,
  Sparkles,
  TextSelect,
  Trash2,
  Undo2,
  Users,
  Waypoints,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { ResourceActionEnvironment } from "@/lib/actions/resourceActionEnvironment";
import type {
  ResourceActionCapability,
  ResourceActionSnapshot,
  ServerActionAvailability,
} from "@/lib/actions/resourceActionSnapshot";
import {
  assumeLecternItemId,
  type LecternItemId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ResourceActivation } from "@/lib/resources/activation";

export type ResourceActionGroup =
  | "Navigate"
  | "Consume"
  | "Organize"
  | "CreateTransform"
  | "ShareExport"
  | "Manage"
  | "Danger";

export type ResourceActionTone = "default" | "danger";

export type ResourceActionBlockedReason =
  | "PermissionDenied"
  | "Locked"
  | "Processing"
  | "TemporarilyUnavailable"
  | "Loading"
  | "CapacityReached"
  | "RequiresOnline"
  | "UnsupportedOnDevice"
  | "Busy";

export type ResourceActionAvailability =
  | { readonly kind: "Available" }
  | {
      readonly kind: "Blocked";
      readonly reason: ResourceActionBlockedReason;
    };

export type ResourceActionControlState =
  | { readonly kind: "Command" }
  | { readonly kind: "Toggle"; readonly checked: boolean };

export type ResourceActionConfirmation =
  | { readonly kind: "None" }
  | {
      readonly kind: "Required";
      readonly title: string;
      readonly body: string;
      readonly confirmLabel: string;
    };

export interface ResourceActionPresentation {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: ResourceActionGroup;
  readonly tone: ResourceActionTone;
}

interface ResourceActionCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: ResourceActionGroup;
  readonly order: number;
  readonly tone: ResourceActionTone;
  readonly confirmation: ResourceActionConfirmation;
}

const NONE = Object.freeze({ kind: "None" } as const);

function requiredConfirmation(
  title: string,
  body: string,
  confirmLabel: string,
): ResourceActionConfirmation {
  return Object.freeze({
    kind: "Required" as const,
    title,
    body,
    confirmLabel,
  });
}

function catalogEntry<const Entry extends ResourceActionCatalogEntry>(
  entry: Entry,
): Readonly<Entry> {
  return Object.freeze(entry);
}

function statePresentation(label: string, icon: LucideIcon) {
  return Object.freeze({ label, icon });
}

/**
 * The only owner of resource-action identity, default copy, iconography,
 * semantic grouping, order, tone, and confirmation policy. Keys are the stable
 * action IDs themselves so callers cannot translate through a second identity.
 */
export const RESOURCE_ACTION_CATALOG = Object.freeze({
  "ResourceAction.Open": catalogEntry({
    id: "ResourceAction.Open",
    label: "Open",
    icon: ArrowUpRight,
    group: "Navigate",
    order: 10,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceAction.OpenInNewPane": catalogEntry({
    id: "ResourceAction.OpenInNewPane",
    label: "Open in new pane",
    icon: PanelsTopLeft,
    group: "Navigate",
    order: 20,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.OpenSource": catalogEntry({
    id: "ResourceOperation.OpenSource",
    label: "Open source",
    icon: ExternalLink,
    group: "Navigate",
    order: 30,
    tone: "default",
    confirmation: NONE,
  }),

  "ResourceOperation.Media.Playback": catalogEntry({
    id: "ResourceOperation.Media.Playback",
    label: "Play",
    icon: Play,
    group: "Consume",
    order: 10,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      Idle: statePresentation("Play", Play),
      Paused: statePresentation("Resume", Play),
      Ended: statePresentation("Replay", RotateCcw),
    }),
  }),
  "ResourceOperation.Media.PlayNext": catalogEntry({
    id: "ResourceOperation.Media.PlayNext",
    label: "Play next",
    icon: ListStart,
    group: "Consume",
    order: 20,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Media.Consumption": catalogEntry({
    id: "ResourceOperation.Media.Consumption",
    label: "Mark as finished",
    icon: CircleCheck,
    group: "Consume",
    order: 30,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      DocumentIncomplete: statePresentation("Mark as finished", CircleCheck),
      DocumentFinished: statePresentation("Mark as unread", Undo2),
      EpisodeUnplayed: statePresentation("Mark as played", CircleCheck),
      EpisodePlayed: statePresentation("Mark as unplayed", Undo2),
    }),
  }),
  "ResourceOperation.Media.ResetProgress": catalogEntry({
    id: "ResourceOperation.Media.ResetProgress",
    label: "Reset progress",
    icon: RotateCcw,
    group: "Consume",
    order: 40,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Media.Transcript": catalogEntry({
    id: "ResourceOperation.Media.Transcript",
    label: "Request transcript…",
    icon: Captions,
    group: "Consume",
    order: 50,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      NotRequested: statePresentation("Request transcript…", Captions),
      Queued: statePresentation("Transcript queued", Captions),
      Running: statePresentation("Transcript processing", Captions),
      Ready: statePresentation("Open transcript", Captions),
      Partial: statePresentation("Open transcript", Captions),
      Unavailable: statePresentation("Transcript unavailable", Captions),
      FailedQuota: statePresentation("Retry transcript", RotateCcw),
      FailedProvider: statePresentation("Retry transcript", RotateCcw),
    }),
  }),
  "ResourceOperation.Media.Offline": catalogEntry({
    id: "ResourceOperation.Media.Offline",
    label: "Download for offline",
    icon: Download,
    group: "Consume",
    order: 60,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      Absent: statePresentation("Download for offline", Download),
      Downloading: statePresentation("Cancel download", XCircle),
      Failed: statePresentation("Retry download", RotateCcw),
      Ready: statePresentation("Remove download", Trash2),
    }),
  }),

  "RelationshipAction.LibraryPlacement": catalogEntry({
    id: "RelationshipAction.LibraryPlacement",
    label: "Libraries…",
    icon: Library,
    group: "Organize",
    order: 10,
    tone: "default",
    confirmation: NONE,
  }),
  "RelationshipAction.LecternMembership": catalogEntry({
    id: "RelationshipAction.LecternMembership",
    label: "Add to Lectern",
    icon: ListPlus,
    group: "Organize",
    order: 20,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      Absent: statePresentation("Add to Lectern", ListPlus),
      Present: statePresentation("Remove from Lectern", ListMinus),
    }),
  }),
  "RelationshipAction.PodcastSubscription": catalogEntry({
    id: "RelationshipAction.PodcastSubscription",
    label: "Subscribe",
    icon: Rss,
    group: "Organize",
    order: 30,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      Unsubscribed: statePresentation("Subscribe", Rss),
      Subscribed: statePresentation("Unsubscribe", Rss),
    }),
  }),

  "ResourceAction.Chat": catalogEntry({
    id: "ResourceAction.Chat",
    label: "Chat about this…",
    icon: MessageCircle,
    group: "CreateTransform",
    order: 10,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Highlight.Edit": catalogEntry({
    id: "ResourceOperation.Highlight.Edit",
    label: "Edit highlight…",
    icon: Highlighter,
    group: "CreateTransform",
    order: 20,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Highlight.Note": catalogEntry({
    id: "ResourceOperation.Highlight.Note",
    label: "Add note…",
    icon: NotebookPen,
    group: "CreateTransform",
    order: 30,
    tone: "default",
    confirmation: NONE,
    states: Object.freeze({
      Absent: statePresentation("Add note…", NotebookPen),
      Present: statePresentation("Edit note…", NotebookPen),
    }),
  }),
  "ResourceOperation.Highlight.Link": catalogEntry({
    id: "ResourceOperation.Highlight.Link",
    label: "Link…",
    icon: Link2,
    group: "CreateTransform",
    order: 40,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Highlight.Learn": catalogEntry({
    id: "ResourceOperation.Highlight.Learn",
    label: "Learn from this",
    icon: BookOpenText,
    group: "CreateTransform",
    order: 50,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Highlight.EditBounds": catalogEntry({
    id: "ResourceOperation.Highlight.EditBounds",
    label: "Edit bounds",
    icon: TextSelect,
    group: "CreateTransform",
    order: 60,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Message.Fork": catalogEntry({
    id: "ResourceOperation.Message.Fork",
    label: "Fork from here",
    icon: GitFork,
    group: "CreateTransform",
    order: 70,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Message.WalkSources": catalogEntry({
    id: "ResourceOperation.Message.WalkSources",
    label: "Walk through sources",
    icon: Waypoints,
    group: "CreateTransform",
    order: 80,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Message.Rerun": catalogEntry({
    id: "ResourceOperation.Message.Rerun",
    label: "Rerun",
    icon: RefreshCw,
    group: "CreateTransform",
    order: 90,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Message.Regenerate": catalogEntry({
    id: "ResourceOperation.Message.Regenerate",
    label: "Regenerate",
    icon: Sparkles,
    group: "CreateTransform",
    order: 100,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Page.EditTitle": catalogEntry({
    id: "ResourceOperation.Page.EditTitle",
    label: "Edit title…",
    icon: Pencil,
    group: "CreateTransform",
    order: 110,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.NoteBlock.EditBody": catalogEntry({
    id: "ResourceOperation.NoteBlock.EditBody",
    label: "Edit note",
    icon: FilePenLine,
    group: "CreateTransform",
    order: 120,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Contributor.Rename": catalogEntry({
    id: "ResourceOperation.Contributor.Rename",
    label: "Edit name…",
    icon: Pencil,
    group: "CreateTransform",
    order: 130,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Artifact.Regenerate": catalogEntry({
    id: "ResourceOperation.Artifact.Regenerate",
    label: "Regenerate",
    icon: Sparkles,
    group: "CreateTransform",
    order: 140,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.ArtifactRevision.MakeCurrent": catalogEntry({
    id: "ResourceOperation.ArtifactRevision.MakeCurrent",
    label: "Make current",
    icon: History,
    group: "CreateTransform",
    order: 150,
    tone: "default",
    confirmation: NONE,
  }),

  "ResourceAction.Share": catalogEntry({
    id: "ResourceAction.Share",
    label: "Share…",
    icon: Share2,
    group: "ShareExport",
    order: 10,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Media.DownloadOriginal": catalogEntry({
    id: "ResourceOperation.Media.DownloadOriginal",
    label: "Download original",
    icon: FileDown,
    group: "ShareExport",
    order: 20,
    tone: "default",
    confirmation: NONE,
  }),

  "ResourceOperation.Media.RetryProcessing": catalogEntry({
    id: "ResourceOperation.Media.RetryProcessing",
    label: "Retry processing",
    icon: RotateCcw,
    group: "Manage",
    order: 10,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Media.RefreshSource": catalogEntry({
    id: "ResourceOperation.Media.RefreshSource",
    label: "Refresh source",
    icon: RefreshCw,
    group: "Manage",
    order: 20,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Media.RetryMetadata": catalogEntry({
    id: "ResourceOperation.Media.RetryMetadata",
    label: "Re-enrich metadata",
    icon: Sparkles,
    group: "Manage",
    order: 30,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Media.EditAuthors": catalogEntry({
    id: "ResourceOperation.Media.EditAuthors",
    label: "Edit authors…",
    icon: Users,
    group: "Manage",
    order: 40,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Library.Settings": catalogEntry({
    id: "ResourceOperation.Library.Settings",
    label: "Library settings…",
    icon: Settings,
    group: "Manage",
    order: 50,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Podcast.Settings": catalogEntry({
    id: "ResourceOperation.Podcast.Settings",
    label: "Podcast settings…",
    icon: Settings,
    group: "Manage",
    order: 60,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Podcast.Refresh": catalogEntry({
    id: "ResourceOperation.Podcast.Refresh",
    label: "Check for new episodes",
    icon: RefreshCw,
    group: "Manage",
    order: 70,
    tone: "default",
    confirmation: NONE,
  }),
  "ResourceOperation.Podcast.RetryBackfill": catalogEntry({
    id: "ResourceOperation.Podcast.RetryBackfill",
    label: "Retry backlog",
    icon: RotateCcw,
    group: "Manage",
    order: 80,
    tone: "default",
    confirmation: NONE,
  }),

  "ResourceOperation.Media.Remove": catalogEntry({
    id: "ResourceOperation.Media.Remove",
    label: "Remove from Nexus",
    icon: Trash2,
    group: "Danger",
    order: 10,
    tone: "danger",
    confirmation: requiredConfirmation(
      "Remove from Nexus?",
      "Remove “{title}” from Nexus, every Library, and the Lectern? This can’t be undone.",
      "Remove from Nexus",
    ),
  }),
  "ResourceOperation.Library.Delete": catalogEntry({
    id: "ResourceOperation.Library.Delete",
    label: "Delete Library",
    icon: Trash2,
    group: "Danger",
    order: 20,
    tone: "danger",
    confirmation: requiredConfirmation(
      "Delete Library?",
      "Delete “{title}”? Its items stay in Nexus. This can’t be undone.",
      "Delete Library",
    ),
  }),
  "ResourceOperation.Conversation.Delete": catalogEntry({
    id: "ResourceOperation.Conversation.Delete",
    label: "Delete chat",
    icon: Trash2,
    group: "Danger",
    order: 30,
    tone: "danger",
    confirmation: requiredConfirmation(
      "Delete chat?",
      "Delete “{title}” and its messages? This can’t be undone.",
      "Delete chat",
    ),
  }),
  "ResourceOperation.Message.Delete": catalogEntry({
    id: "ResourceOperation.Message.Delete",
    label: "Delete message",
    icon: Trash2,
    group: "Danger",
    order: 40,
    tone: "danger",
    confirmation: requiredConfirmation(
      "Delete message?",
      "Delete this message? This can’t be undone.",
      "Delete message",
    ),
  }),
  "ResourceOperation.Highlight.Delete": catalogEntry({
    id: "ResourceOperation.Highlight.Delete",
    label: "Delete highlight",
    icon: Trash2,
    group: "Danger",
    order: 50,
    tone: "danger",
    confirmation: requiredConfirmation(
      "Delete highlight?",
      "Delete this highlight and its note? This can’t be undone.",
      "Delete highlight",
    ),
  }),
  "ResourceOperation.Page.Delete": catalogEntry({
    id: "ResourceOperation.Page.Delete",
    label: "Delete page",
    icon: Trash2,
    group: "Danger",
    order: 60,
    tone: "danger",
    confirmation: requiredConfirmation(
      "Delete page?",
      "Delete “{title}” and its note blocks? This can’t be undone.",
      "Delete page",
    ),
  }),
} as const satisfies Record<string, ResourceActionCatalogEntry>);

export type ResourceActionId = keyof typeof RESOURCE_ACTION_CATALOG;

export type ResourceActionIntent =
  | { readonly kind: "Open"; readonly activation: ResourceActivation }
  | { readonly kind: "OpenInNewPane"; readonly activation: ResourceActivation }
  | { readonly kind: "OpenSource"; readonly href: string }
  | { readonly kind: "Play"; readonly playerDescriptor: PlayerDescriptor }
  | {
      readonly kind: "ResumePlayback";
      readonly playerDescriptor: PlayerDescriptor;
    }
  | { readonly kind: "Replay"; readonly playerDescriptor: PlayerDescriptor }
  | { readonly kind: "PlayNext" }
  | { readonly kind: "MarkFinished" }
  | { readonly kind: "MarkUnread" }
  | { readonly kind: "MarkPlayed" }
  | { readonly kind: "MarkUnplayed" }
  | { readonly kind: "ResetProgress" }
  | {
      readonly kind: "RequestTranscript";
      readonly resourceRef: CanonicalResourceRef;
    }
  | {
      readonly kind: "OpenTranscript";
      readonly resourceRef: CanonicalResourceRef;
    }
  | {
      readonly kind: "RetryTranscript";
      readonly resourceRef: CanonicalResourceRef;
    }
  | { readonly kind: "OfflineDownload" }
  | { readonly kind: "OfflineCancel" }
  | { readonly kind: "OfflineRetry" }
  | { readonly kind: "OfflineRemove" }
  | { readonly kind: "LibraryPlacement" }
  | { readonly kind: "AddToLectern" }
  | { readonly kind: "RemoveFromLectern"; readonly lecternItemId: LecternItemId }
  | { readonly kind: "Subscribe" }
  | { readonly kind: "Unsubscribe" }
  | { readonly kind: "Chat" }
  | { readonly kind: "EditHighlight" }
  | { readonly kind: "AddHighlightNote" }
  | { readonly kind: "EditHighlightNote"; readonly noteBlockId: string }
  | { readonly kind: "LinkHighlight" }
  | { readonly kind: "LearnHighlight" }
  | { readonly kind: "EditHighlightBounds" }
  | { readonly kind: "ForkMessage" }
  | { readonly kind: "WalkMessageSources" }
  | { readonly kind: "RerunMessage" }
  | { readonly kind: "RegenerateMessage" }
  | { readonly kind: "EditPageTitle" }
  | { readonly kind: "EditNoteBody" }
  | { readonly kind: "RenameContributor" }
  | { readonly kind: "RegenerateArtifact" }
  | { readonly kind: "MakeArtifactRevisionCurrent" }
  | { readonly kind: "Share" }
  | { readonly kind: "DownloadOriginal" }
  | { readonly kind: "RetryProcessing" }
  | { readonly kind: "RefreshSource" }
  | { readonly kind: "RetryMetadata" }
  | { readonly kind: "EditAuthors" }
  | { readonly kind: "LibrarySettings" }
  | { readonly kind: "PodcastSettings" }
  | { readonly kind: "RefreshPodcast" }
  | { readonly kind: "RetryPodcastBackfill" }
  | { readonly kind: "RemoveMedia" }
  | { readonly kind: "DeleteLibrary" }
  | { readonly kind: "DeleteConversation" }
  | { readonly kind: "DeleteMessage" }
  | { readonly kind: "DeleteHighlight" }
  | { readonly kind: "DeletePage" };

export interface PlannedResourceAction {
  readonly id: ResourceActionId;
  readonly presentation: ResourceActionPresentation;
  readonly control: ResourceActionControlState;
  readonly availability: ResourceActionAvailability;
  readonly confirmation: ResourceActionConfirmation;
  readonly intent: ResourceActionIntent;
}

const COMMAND = Object.freeze({ kind: "Command" } as const);
const AVAILABLE = Object.freeze({ kind: "Available" } as const);

const GROUP_INDEX: Readonly<Record<ResourceActionGroup, number>> = Object.freeze({
  Navigate: 0,
  Consume: 1,
  Organize: 2,
  CreateTransform: 3,
  ShareExport: 4,
  Manage: 5,
  Danger: 6,
});

function blocked(reason: ResourceActionBlockedReason): ResourceActionAvailability {
  return Object.freeze({ kind: "Blocked" as const, reason });
}

function finalAvailability(
  id: ResourceActionId,
  server: ServerActionAvailability,
  busyIds: ReadonlySet<ResourceActionId>,
  clientReason?: ResourceActionBlockedReason,
): ResourceActionAvailability {
  if (busyIds.has(id)) return blocked("Busy");
  if (server.kind === "Blocked") return blocked(server.reason);
  return clientReason === undefined ? AVAILABLE : blocked(clientReason);
}

function planned(
  id: ResourceActionId,
  server: ServerActionAvailability,
  busyIds: ReadonlySet<ResourceActionId>,
  intent: ResourceActionIntent,
  options: {
    readonly label?: string;
    readonly icon?: LucideIcon;
    readonly control?: ResourceActionControlState;
    readonly clientBlockedReason?: ResourceActionBlockedReason;
  } = {},
): PlannedResourceAction {
  const entry = RESOURCE_ACTION_CATALOG[id];
  const presentation = Object.freeze({
    label: options.label ?? entry.label,
    icon: options.icon ?? entry.icon,
    group: entry.group,
    tone: entry.tone,
  });
  const control = options.control ?? COMMAND;
  if (!Object.isFrozen(control)) Object.freeze(control);
  const frozenIntent = immutableCopy(intent);
  return Object.freeze({
    id,
    presentation,
    control,
    availability: finalAvailability(
      id,
      server,
      busyIds,
      options.clientBlockedReason,
    ),
    confirmation: entry.confirmation,
    intent: frozenIntent,
  });
}

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]),
    );
    return Object.freeze(copy) as T;
  }
  return value;
}

function toggle(checked: boolean): ResourceActionControlState {
  return Object.freeze({ kind: "Toggle" as const, checked });
}

function lecternBlockedReason(
  environment: ResourceActionEnvironment,
  capacityMatters: boolean,
): ResourceActionBlockedReason | undefined {
  switch (environment.lectern.kind) {
    case "Loading":
      return "Loading";
    case "Error":
      return "TemporarilyUnavailable";
    case "Ready":
      if (environment.lectern.mutation === "Busy") return "Busy";
      if (capacityMatters && environment.lectern.atCapacity) {
        return "CapacityReached";
      }
      return undefined;
    default: {
      const exhaustive: never = environment.lectern;
      throw new Error(
        `Unsupported Lectern environment: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function deriveOfflineAction(
  availability: ServerActionAvailability,
  environment: ResourceActionEnvironment,
  ref: CanonicalResourceRef,
  busyIds: ReadonlySet<ResourceActionId>,
): PlannedResourceAction {
  const id = "ResourceOperation.Media.Offline";
  const states = RESOURCE_ACTION_CATALOG[id].states;
  if (environment.platform === "Web") {
    return planned(id, availability, busyIds, { kind: "OfflineDownload" }, {
      ...states.Absent,
      control: toggle(false),
      clientBlockedReason: "UnsupportedOnDevice",
    });
  }

  if (environment.offline.kind === "Loading") {
    return planned(id, availability, busyIds, { kind: "OfflineDownload" }, {
      ...states.Absent,
      control: toggle(false),
      clientBlockedReason: "Loading",
    });
  }
  if (environment.offline.kind === "Unavailable") {
    return planned(id, availability, busyIds, { kind: "OfflineDownload" }, {
      ...states.Absent,
      control: toggle(false),
      clientBlockedReason: "UnsupportedOnDevice",
    });
  }

  const local = environment.offline.byRef.get(ref);
  if (local === undefined) {
    return planned(id, availability, busyIds, { kind: "OfflineDownload" }, {
      control: toggle(false),
      clientBlockedReason:
        environment.connectivity === "Offline" ? "RequiresOnline" : undefined,
    });
  }

  switch (local.kind) {
    case "Resolving":
    case "Queued":
    case "Downloading":
    case "Restarting":
      return planned(id, availability, busyIds, { kind: "OfflineCancel" }, {
        ...states.Downloading,
        control: toggle(false),
      });
    case "Ready":
      return planned(id, availability, busyIds, { kind: "OfflineRemove" }, {
        ...states.Ready,
        control: toggle(true),
      });
    case "Failed":
      return planned(id, availability, busyIds, { kind: "OfflineRetry" }, {
        ...states.Failed,
        control: toggle(false),
        clientBlockedReason:
          environment.connectivity === "Offline" ? "RequiresOnline" : undefined,
      });
    case "Removing":
      return planned(id, availability, busyIds, { kind: "OfflineRemove" }, {
        ...states.Ready,
        control: toggle(true),
        clientBlockedReason: "Busy",
      });
    default: {
      const exhaustive: never = local;
      throw new Error(
        `Unsupported offline availability: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function planTranscript(
  capability: Extract<ResourceActionCapability, { readonly kind: "Transcript" }>,
  ref: CanonicalResourceRef,
  busyIds: ReadonlySet<ResourceActionId>,
): PlannedResourceAction {
  const id = "ResourceOperation.Media.Transcript";
  const states = RESOURCE_ACTION_CATALOG[id].states;
  switch (capability.state) {
    case "NotRequested":
      return planned(id, capability.availability, busyIds, {
        kind: "RequestTranscript",
        resourceRef: ref,
      }, states.NotRequested);
    case "Queued":
      return planned(id, capability.availability, busyIds, {
        kind: "OpenTranscript",
        resourceRef: ref,
      }, { ...states.Queued, clientBlockedReason: "Processing" });
    case "Running":
      return planned(id, capability.availability, busyIds, {
        kind: "OpenTranscript",
        resourceRef: ref,
      }, { ...states.Running, clientBlockedReason: "Processing" });
    case "Ready":
    case "Partial":
      return planned(id, capability.availability, busyIds, {
        kind: "OpenTranscript",
        resourceRef: ref,
      }, states[capability.state]);
    case "Unavailable":
      return planned(id, capability.availability, busyIds, {
        kind: "RequestTranscript",
        resourceRef: ref,
      }, {
        ...states.Unavailable,
        clientBlockedReason: "TemporarilyUnavailable",
      });
    case "FailedQuota":
    case "FailedProvider":
      return planned(id, capability.availability, busyIds, {
        kind: "RetryTranscript",
        resourceRef: ref,
      }, states[capability.state]);
    default: {
      const exhaustive: never = capability.state;
      throw new Error(`Unsupported transcript state: ${exhaustive}`);
    }
  }
}

function planCapability(
  capability: ResourceActionCapability,
  environment: ResourceActionEnvironment,
  ref: CanonicalResourceRef,
  activation: ResourceActivation,
  busyIds: ReadonlySet<ResourceActionId>,
): PlannedResourceAction {
  const availability = capability.availability;
  switch (capability.kind) {
    case "Open":
      return planned("ResourceAction.Open", availability, busyIds, {
        kind: "Open",
        activation,
      });
    case "OpenInNewPane":
      return planned("ResourceAction.OpenInNewPane", availability, busyIds, {
        kind: "OpenInNewPane",
        activation,
      });
    case "OpenSource":
      return planned("ResourceOperation.OpenSource", availability, busyIds, {
        kind: "OpenSource",
        href: capability.href,
      });
    case "Playback": {
      const states =
        RESOURCE_ACTION_CATALOG["ResourceOperation.Media.Playback"].states;
      const playback = environment.playbackByRef.get(ref) ?? "Idle";
      if (playback === "Paused") {
        return planned(
          "ResourceOperation.Media.Playback",
          availability,
          busyIds,
          {
            kind: "ResumePlayback",
            playerDescriptor: capability.playerDescriptor,
          },
          {
            ...states.Paused,
            clientBlockedReason: lecternBlockedReason(environment, false),
          },
        );
      }
      if (playback === "Ended") {
        return planned(
          "ResourceOperation.Media.Playback",
          availability,
          busyIds,
          { kind: "Replay", playerDescriptor: capability.playerDescriptor },
          {
            ...states.Ended,
            clientBlockedReason: lecternBlockedReason(environment, false),
          },
        );
      }
      return planned(
        "ResourceOperation.Media.Playback",
        availability,
        busyIds,
        { kind: "Play", playerDescriptor: capability.playerDescriptor },
        {
          ...states.Idle,
          clientBlockedReason: lecternBlockedReason(environment, false),
        },
      );
    }
    case "PlayNext":
      return planned(
        "ResourceOperation.Media.PlayNext",
        availability,
        busyIds,
        { kind: "PlayNext" },
        {
          clientBlockedReason: lecternBlockedReason(environment, true),
        },
      );
    case "Consumption": {
      const finished = capability.state === "Finished";
      const state = RESOURCE_ACTION_CATALOG[
        "ResourceOperation.Media.Consumption"
      ].states[finished ? "DocumentFinished" : "DocumentIncomplete"];
      return planned(
        "ResourceOperation.Media.Consumption",
        availability,
        busyIds,
        { kind: finished ? "MarkUnread" : "MarkFinished" },
        {
          ...state,
          control: toggle(finished),
          clientBlockedReason: lecternBlockedReason(environment, false),
        },
      );
    }
    case "EpisodeConsumption": {
      const played = capability.state === "Played";
      const state = RESOURCE_ACTION_CATALOG[
        "ResourceOperation.Media.Consumption"
      ].states[played ? "EpisodePlayed" : "EpisodeUnplayed"];
      return planned(
        "ResourceOperation.Media.Consumption",
        availability,
        busyIds,
        { kind: played ? "MarkUnplayed" : "MarkPlayed" },
        {
          ...state,
          control: toggle(played),
          clientBlockedReason: lecternBlockedReason(environment, false),
        },
      );
    }
    case "ResetProgress":
      return planned(
        "ResourceOperation.Media.ResetProgress",
        availability,
        busyIds,
        { kind: "ResetProgress" },
        {
          clientBlockedReason: lecternBlockedReason(environment, false),
        },
      );
    case "Transcript":
      return planTranscript(capability, ref, busyIds);
    case "OfflineAudio":
      return deriveOfflineAction(availability, environment, ref, busyIds);
    case "LibraryPlacement":
      return planned("RelationshipAction.LibraryPlacement", availability, busyIds, {
        kind: "LibraryPlacement",
      });
    case "LecternMembership": {
      const states = RESOURCE_ACTION_CATALOG[
        "RelationshipAction.LecternMembership"
      ].states;
      if (capability.state === "Present") {
        return planned(
          "RelationshipAction.LecternMembership",
          availability,
          busyIds,
          {
            kind: "RemoveFromLectern",
            lecternItemId: assumeLecternItemId(capability.lecternItemId),
          },
          {
            ...states.Present,
            control: toggle(true),
            clientBlockedReason: lecternBlockedReason(environment, false),
          },
        );
      }
      return planned(
        "RelationshipAction.LecternMembership",
        availability,
        busyIds,
        { kind: "AddToLectern" },
        {
          ...states.Absent,
          control: toggle(false),
          clientBlockedReason: lecternBlockedReason(environment, true),
        },
      );
    }
    case "PodcastSubscription": {
      const subscribed = capability.state === "Subscribed";
      const state = RESOURCE_ACTION_CATALOG[
        "RelationshipAction.PodcastSubscription"
      ].states[subscribed ? "Subscribed" : "Unsubscribed"];
      return planned(
        "RelationshipAction.PodcastSubscription",
        availability,
        busyIds,
        { kind: subscribed ? "Unsubscribe" : "Subscribe" },
        {
          ...state,
          control: toggle(subscribed),
        },
      );
    }
    case "Chat":
      return planned("ResourceAction.Chat", availability, busyIds, { kind: "Chat" });
    case "EditHighlight":
      return planned("ResourceOperation.Highlight.Edit", availability, busyIds, {
        kind: "EditHighlight",
      });
    case "HighlightNote": {
      const present = capability.state === "Present";
      const state = RESOURCE_ACTION_CATALOG[
        "ResourceOperation.Highlight.Note"
      ].states[present ? "Present" : "Absent"];
      return planned(
        "ResourceOperation.Highlight.Note",
        availability,
        busyIds,
        present
          ? { kind: "EditHighlightNote", noteBlockId: capability.noteBlockId }
          : { kind: "AddHighlightNote" },
        state,
      );
    }
    case "LinkHighlight":
      return planned("ResourceOperation.Highlight.Link", availability, busyIds, {
        kind: "LinkHighlight",
      });
    case "LearnHighlight":
      return planned("ResourceOperation.Highlight.Learn", availability, busyIds, {
        kind: "LearnHighlight",
      });
    case "EditHighlightBounds":
      return planned(
        "ResourceOperation.Highlight.EditBounds",
        availability,
        busyIds,
        { kind: "EditHighlightBounds" },
      );
    case "ForkMessage":
      return planned("ResourceOperation.Message.Fork", availability, busyIds, {
        kind: "ForkMessage",
      });
    case "WalkMessageSources":
      return planned(
        "ResourceOperation.Message.WalkSources",
        availability,
        busyIds,
        { kind: "WalkMessageSources" },
      );
    case "RerunMessage":
      return planned("ResourceOperation.Message.Rerun", availability, busyIds, {
        kind: "RerunMessage",
      });
    case "RegenerateMessage":
      return planned(
        "ResourceOperation.Message.Regenerate",
        availability,
        busyIds,
        { kind: "RegenerateMessage" },
      );
    case "EditPageTitle":
      return planned("ResourceOperation.Page.EditTitle", availability, busyIds, {
        kind: "EditPageTitle",
      });
    case "EditNoteBody":
      return planned("ResourceOperation.NoteBlock.EditBody", availability, busyIds, {
        kind: "EditNoteBody",
      });
    case "RenameContributor":
      return planned(
        "ResourceOperation.Contributor.Rename",
        availability,
        busyIds,
        { kind: "RenameContributor" },
      );
    case "RegenerateArtifact":
      return planned(
        "ResourceOperation.Artifact.Regenerate",
        availability,
        busyIds,
        { kind: "RegenerateArtifact" },
      );
    case "MakeArtifactRevisionCurrent":
      return planned(
        "ResourceOperation.ArtifactRevision.MakeCurrent",
        availability,
        busyIds,
        { kind: "MakeArtifactRevisionCurrent" },
      );
    case "Share":
      return planned("ResourceAction.Share", availability, busyIds, { kind: "Share" });
    case "DownloadOriginal":
      return planned(
        "ResourceOperation.Media.DownloadOriginal",
        availability,
        busyIds,
        { kind: "DownloadOriginal" },
      );
    case "RetryProcessing":
      return planned(
        "ResourceOperation.Media.RetryProcessing",
        availability,
        busyIds,
        { kind: "RetryProcessing" },
      );
    case "RefreshSource":
      return planned(
        "ResourceOperation.Media.RefreshSource",
        availability,
        busyIds,
        { kind: "RefreshSource" },
      );
    case "RetryMetadata":
      return planned(
        "ResourceOperation.Media.RetryMetadata",
        availability,
        busyIds,
        { kind: "RetryMetadata" },
      );
    case "EditAuthors":
      return planned(
        "ResourceOperation.Media.EditAuthors",
        availability,
        busyIds,
        { kind: "EditAuthors" },
      );
    case "LibrarySettings":
      return planned("ResourceOperation.Library.Settings", availability, busyIds, {
        kind: "LibrarySettings",
      });
    case "PodcastSettings":
      return planned("ResourceOperation.Podcast.Settings", availability, busyIds, {
        kind: "PodcastSettings",
      });
    case "RefreshPodcast":
      return planned("ResourceOperation.Podcast.Refresh", availability, busyIds, {
        kind: "RefreshPodcast",
      });
    case "RetryPodcastBackfill":
      return planned(
        "ResourceOperation.Podcast.RetryBackfill",
        availability,
        busyIds,
        { kind: "RetryPodcastBackfill" },
      );
    case "RemoveMedia":
      return planned("ResourceOperation.Media.Remove", availability, busyIds, {
        kind: "RemoveMedia",
      });
    case "DeleteLibrary":
      return planned("ResourceOperation.Library.Delete", availability, busyIds, {
        kind: "DeleteLibrary",
      });
    case "DeleteConversation":
      return planned(
        "ResourceOperation.Conversation.Delete",
        availability,
        busyIds,
        { kind: "DeleteConversation" },
      );
    case "DeleteMessage":
      return planned("ResourceOperation.Message.Delete", availability, busyIds, {
        kind: "DeleteMessage",
      });
    case "DeleteHighlight":
      return planned("ResourceOperation.Highlight.Delete", availability, busyIds, {
        kind: "DeleteHighlight",
      });
    case "DeletePage":
      return planned("ResourceOperation.Page.Delete", availability, busyIds, {
        kind: "DeletePage",
      });
    default: {
      const exhaustive: never = capability;
      throw new Error(
        `Unsupported resource action capability: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function compareCatalogOrder(
  left: PlannedResourceAction,
  right: PlannedResourceAction,
): number {
  const leftEntry = RESOURCE_ACTION_CATALOG[left.id];
  const rightEntry = RESOURCE_ACTION_CATALOG[right.id];
  return (
    GROUP_INDEX[leftEntry.group] - GROUP_INDEX[rightEntry.group] ||
    leftEntry.order - rightEntry.order
  );
}

/**
 * Resolve one authoritative, final, deeply immutable action plan. Capability
 * input order cannot affect output order; stable IDs are also the global busy
 * identity. Renderers and surfaces may only project this result, never amend it.
 */
export function resolveResourceActionPlan(
  snapshot: ResourceActionSnapshot,
  environment: ResourceActionEnvironment,
  busyIds: ReadonlySet<ResourceActionId>,
): readonly PlannedResourceAction[] {
  if (snapshot.missing) return Object.freeze([]);

  const seenKinds = new Set<ResourceActionCapability["kind"]>();
  const seenIds = new Set<ResourceActionId>();
  const actions: PlannedResourceAction[] = [];
  for (const capability of snapshot.capabilities) {
    if (seenKinds.has(capability.kind)) {
      throw new Error(
        `Duplicate resource action capability kind: ${capability.kind}`,
      );
    }
    seenKinds.add(capability.kind);

    const action = planCapability(
      capability,
      environment,
      snapshot.ref,
      snapshot.activation,
      busyIds,
    );
    if (seenIds.has(action.id)) {
      throw new Error(`Duplicate resource action id: ${action.id}`);
    }
    seenIds.add(action.id);
    actions.push(action);
  }

  actions.sort(compareCatalogOrder);
  return Object.freeze(actions);
}
