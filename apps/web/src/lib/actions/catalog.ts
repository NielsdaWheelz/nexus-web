import {
  ArrowUpRight,
  BookOpenText,
  Captions,
  CircleCheck,
  CircleX,
  Download,
  ExternalLink,
  FileDown,
  FilePenLine,
  GitFork,
  Highlighter,
  Info,
  Library,
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
  Search,
  Settings,
  Share2,
  Sparkles,
  SquareDashedText,
  Trash2,
  Undo2,
  Upload,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { apiTransportFeedback, outcomeUnknown, type ApiError } from "@/lib/api/client";
import { CONFLICT_NOTICE } from "@/lib/imports/copy";

type Group =
  | "Navigate"
  | "Consume"
  | "Organize"
  | "CreateTransform"
  | "ShareExport"
  | "Manage"
  | "Danger";

/** `{title}` is replaced by the resource's label. */
export interface Confirmation {
  readonly title: string;
  readonly body: string;
}

interface Entry {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: Group;
  readonly confirmation?: Confirmation;
  readonly states?: Readonly<
    Record<string, { readonly label: string; readonly icon: LucideIcon }>
  >;
}

/**
 * Every verb's copy, keyed by the server's action kind (a recovery offer by its
 * offer kind). Insertion order is menu order; groups are separated.
 */
export const ACTION_CATALOG = {
  Open: { label: "Open", icon: ArrowUpRight, group: "Navigate" },
  OpenInNewPane: {
    label: "Open in new pane",
    icon: PanelsTopLeft,
    group: "Navigate",
  },
  OpenSource: { label: "Open source", icon: ExternalLink, group: "Navigate" },
  MediaMetadata: { label: "metadata…", icon: Info, group: "Navigate" },
  Playback: {
    label: "Play",
    icon: Play,
    group: "Consume",
    states: {
      Idle: { label: "Play", icon: Play },
      Paused: { label: "Resume", icon: Play },
      Ended: { label: "Replay", icon: RotateCcw },
    },
  },
  PlayNext: { label: "Play next", icon: ListStart, group: "Consume" },
  Consumption: {
    label: "Mark as finished",
    icon: CircleCheck,
    group: "Consume",
    states: {
      DocumentIncomplete: { label: "Mark as finished", icon: CircleCheck },
      DocumentFinished: { label: "Mark as unread", icon: Undo2 },
      EpisodeUnplayed: { label: "Mark as played", icon: CircleCheck },
      EpisodePlayed: { label: "Mark as unplayed", icon: Undo2 },
    },
  },
  ResetProgress: { label: "Reset progress", icon: RotateCcw, group: "Consume" },
  Transcript: {
    label: "Request transcript…",
    icon: Captions,
    group: "Consume",
    states: {
      not_requested: { label: "Request transcript…", icon: Captions },
      queued: { label: "Transcript queued", icon: Captions },
      running: { label: "Transcript processing", icon: Captions },
      ready: { label: "Open transcript", icon: Captions },
      partial: { label: "Open transcript", icon: Captions },
      unavailable: { label: "Transcript unavailable", icon: Captions },
      failed_provider: { label: "Retry transcript", icon: RotateCcw },
    },
  },
  Download: {
    label: "Download for offline",
    icon: Download,
    group: "Consume",
    states: {
      Downloading: { label: "Cancel download", icon: CircleX },
      Failed: { label: "Retry download", icon: RotateCcw },
      Ready: { label: "Remove download", icon: Trash2 },
    },
  },
  LibraryPlacement: { label: "Libraries…", icon: Library, group: "Organize" },
  LecternMembership: {
    label: "add to lectern",
    icon: ListPlus,
    group: "Organize",
    states: {
      Absent: { label: "add to lectern", icon: ListPlus },
      Present: { label: "Remove from Lectern", icon: ListMinus },
    },
  },
  PodcastSubscription: {
    label: "Subscribe",
    icon: Rss,
    group: "Organize",
    states: {
      Unsubscribed: { label: "Subscribe", icon: Rss },
      Subscribed: { label: "Unsubscribe", icon: Rss },
    },
  },
  Chat: {
    label: "Chat about this…",
    icon: MessageCircle,
    group: "CreateTransform",
  },
  EditHighlight: {
    label: "Edit highlight…",
    icon: Highlighter,
    group: "CreateTransform",
  },
  HighlightNote: {
    label: "Add note…",
    icon: NotebookPen,
    group: "CreateTransform",
    states: {
      Absent: { label: "Add note…", icon: NotebookPen },
      Present: { label: "Edit note…", icon: NotebookPen },
    },
  },
  LearnHighlight: {
    label: "Learn from this",
    icon: BookOpenText,
    group: "CreateTransform",
  },
  EditHighlightBounds: {
    label: "Edit bounds",
    icon: SquareDashedText,
    group: "CreateTransform",
  },
  ForkMessage: {
    label: "Fork from here",
    icon: GitFork,
    group: "CreateTransform",
  },
  RerunMessage: { label: "Rerun", icon: RefreshCw, group: "CreateTransform" },
  RegenerateMessage: {
    label: "Regenerate",
    icon: Sparkles,
    group: "CreateTransform",
  },
  EditPageTitle: {
    label: "Edit title…",
    icon: Pencil,
    group: "CreateTransform",
  },
  EditNoteBody: {
    label: "Edit note",
    icon: FilePenLine,
    group: "CreateTransform",
  },
  RegenerateArtifact: {
    label: "Regenerate",
    icon: Sparkles,
    group: "CreateTransform",
  },
  Share: { label: "Share…", icon: Share2, group: "ShareExport" },
  DownloadOriginal: {
    label: "Download original",
    icon: FileDown,
    group: "ShareExport",
  },
  RetrySource: {
    label: "Retry source processing",
    icon: RotateCcw,
    group: "Manage",
  },
  RepairSource: {
    label: "Retry stopped processing",
    icon: Wrench,
    group: "Manage",
  },
  RepairSearch: {
    label: "Rebuild search index",
    icon: Search,
    group: "Manage",
  },
  RefreshSource: { label: "refresh source", icon: RefreshCw, group: "Manage" },
  // Imports runs the two upload commands on this runtime; no resource menu offers them.
  RetryUpload: { label: "Retry upload", icon: Upload, group: "Manage" },
  RetryMetadata: {
    label: "research metadata",
    icon: Sparkles,
    group: "Manage",
  },
  ReviewMetadataResult: {
    label: "mark reviewed",
    icon: CircleCheck,
    group: "Manage",
  },
  EditAuthors: { label: "Edit authors…", icon: Users, group: "Manage" },
  LibrarySettings: {
    label: "Library settings…",
    icon: Settings,
    group: "Manage",
  },
  PodcastSettings: {
    label: "playback options…",
    icon: Settings,
    group: "Manage",
  },
  RefreshPodcast: {
    label: "Check for new episodes",
    icon: RefreshCw,
    group: "Manage",
  },
  RetryPodcastBackfill: {
    label: "retry episode history",
    icon: RotateCcw,
    group: "Manage",
  },
  RemoveUpload: { label: "Remove import", icon: Trash2, group: "Danger" },
  RemoveMedia: {
    label: "Remove from Nexus",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Remove from Nexus?",
      body: "Remove “{title}” from Nexus, every Library, and the Lectern? This can’t be undone.",
    },
  },
  DeleteLibrary: {
    label: "Delete Library",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete Library?",
      body: "Delete “{title}”? Its items stay in Nexus. This can’t be undone.",
    },
  },
  DeleteConversation: {
    label: "Delete chat",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "delete chat?",
      body: "deletes “{title}” and all its messages, replies and forks. this cannot be undone.",
    },
  },
  DeleteMessage: {
    label: "delete message and replies",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "delete message and replies?",
      body: "deletes this message and all descendant replies and forks. if no messages remain, the chat is deleted. this cannot be undone.",
    },
  },
  DeleteHighlight: {
    label: "Delete highlight",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete highlight?",
      body: "Delete this highlight? Its note is kept. This can’t be undone.",
    },
  },
  DeletePage: {
    label: "Delete page",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete page?",
      body: "Delete “{title}”? Its notes are kept.",
    },
  },
} as const satisfies Record<string, Entry>;

export type ActionId = keyof typeof ACTION_CATALOG;

export const BLOCKED_COPY = {
  PermissionDenied: "You don’t have permission to do this.",
  Locked: "This item is locked.",
  Processing: "Available when processing finishes.",
  TemporarilyUnavailable: "Temporarily unavailable. Try again.",
  Loading: "Still loading. Try again in a moment.",
  CapacityReached: "Lectern is full. Remove an item to add this one.",
  RequiresOnline: "Connect to the internet to use this action.",
  UnsupportedOnDevice: "Not supported on this device.",
  Busy: "This action is in progress.",
} as const;

export type BlockedReason = keyof typeof BLOCKED_COPY;

/** A verb's modeled failure; a recovery that met newer work is the imports conflict. */
export function actionFailure(
  id: ActionId,
  label: string,
  error: ApiError,
): FeedbackContent {
  const recovery =
    id === "RetrySource" || id === "RepairSource" || id === "RepairSearch";
  if (
    (id === "LecternMembership" || id === "PlayNext") &&
    error.code === "E_RESOURCE_CONFLICT"
  )
    return {
      tone: "Warning",
      title: "lectern changed",
      message: "review its current state before trying again.",
      requestId: error.requestId,
    };
  if (recovery && error.code === "E_RESOURCE_CONFLICT")
    return { ...CONFLICT_NOTICE, requestId: error.requestId };
  const unconfirmed = outcomeUnknown(error);
  const title = unconfirmed
    ? `couldn't confirm: ${label.replace(/…$/, "")}`
    : id === "LecternMembership" && label === "add to lectern"
      ? "couldn't add to lectern"
      : `couldn't ${label.replace(/…$/, "")}`;
  const transport = apiTransportFeedback(error, title);
  if (transport !== null) return unconfirmed ? {
    ...transport,
    tone: "Warning",
    message: "check the item's current state before trying again.",
  } : transport;
  return {
    tone: "Danger",
    title,
    message: error.code === "E_FORBIDDEN" || error.code === "E_OWNER_REQUIRED"
      ? "this account doesn't have permission for that change."
      : error.code === "E_NOT_FOUND" || error.code === "E_MEDIA_NOT_FOUND"
        ? "this item is no longer available."
        : error.code === "E_LIMIT"
          ? "the destination is full. make room before trying again."
          : undefined,
    requestId: error.requestId,
  };
}
