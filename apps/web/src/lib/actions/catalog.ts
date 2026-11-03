import {
  ArrowUpRight,
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
  Pause,
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
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Line } from "@/components/feedback/stage";
import { outcomeUnknown, type ApiError } from "@/lib/api/client";
import { admissionReason as currentAdmissionReason } from "@/lib/api/failure";

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
  BrowserCapture: { label: "Open source in new tab", icon: ExternalLink, group: "Navigate" },
  OpenPodcastFeed: { label: "Open feed", icon: Rss, group: "Navigate" },
  Metadata: { label: "Metadata…", icon: Info, group: "Navigate" },
  Playback: {
    label: "Play",
    icon: Play,
    group: "Consume",
    states: {
      Idle: { label: "Play", icon: Play },
      Playing: { label: "Pause", icon: Pause },
      Buffering: { label: "Pause", icon: Pause },
      Paused: { label: "Resume", icon: Play },
      Ended: { label: "Replay", icon: RotateCcw },
    },
  },
  PlayFromHere: { label: "Play from here", icon: Play, group: "Consume" },
  AddToQueue: { label: "Add to queue", icon: ListPlus, group: "Consume" },
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
  MarkCollectionFinished: { label: "Mark all finished…", icon: CircleCheck, group: "Consume" },
  MarkCollectionUnread: { label: "Mark all unread…", icon: Undo2, group: "Consume" },
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
  TranscribePodcastEpisodes: { label: "Transcribe all episodes…", icon: Captions, group: "Consume" },
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
  AddEpisodeToAll: { label: "Add to All", icon: ListPlus, group: "Organize" },
  RemoveEpisodeFromAll: { label: "Remove from All…", icon: ListMinus, group: "Danger" },
  LibraryPlacement: { label: "Libraries…", icon: Library, group: "Organize" },
  LecternMembership: {
    label: "Add to Lectern",
    icon: ListPlus,
    group: "Organize",
    states: {
      Absent: { label: "Add to Lectern", icon: ListPlus },
      Present: { label: "Remove from Lectern", icon: ListMinus },
    },
  },
  AddUnfinishedToLectern: { label: "Add unfinished contents to Lectern…", icon: ListPlus, group: "Organize" },
  PodcastLibraries: { label: "Add to library…", icon: Library, group: "Organize" },
  SubscribePodcast: { label: "Subscribe", icon: Rss, group: "Organize" },
  UnsubscribePodcast: { label: "Unsubscribe", icon: Rss, group: "Organize" },
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
  EditHighlightAnnotation: {
    label: "Annotate",
    icon: NotebookPen,
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
  RefreshSource: { label: "Refresh source", icon: RefreshCw, group: "Manage" },
  // Imports runs the two upload commands on this runtime; no resource menu offers them.
  RetryUpload: { label: "Retry upload", icon: Upload, group: "Manage" },
  RetryMetadata: {
    label: "Research metadata",
    icon: Sparkles,
    group: "Manage",
  },
  ReviewMetadataResult: {
    label: "Mark reviewed",
    icon: CircleCheck,
    group: "Manage",
  },
  LeaveLibrary: { label: "Leave library…", icon: ListMinus, group: "Manage", confirmation: {
    title: "leave library?", body: "leave “{title}”? its contents remain in the library. you may lose access to items held only here.",
  } },
  LibrarySettings: {
    label: "Library settings…",
    icon: Settings,
    group: "Manage",
  },
  PodcastSettings: {
    label: "Playback defaults…",
    icon: Settings,
    group: "Manage",
  },
  RefreshPodcast: {
    label: "Check for new episodes",
    icon: RefreshCw,
    group: "Manage",
  },
  RemovePodcastEpisodes: { label: "Remove episodes from libraries…", icon: Trash2, group: "Danger" },
  RemoveUpload: { label: "Remove import", icon: Trash2, group: "Danger" },
  RemoveMedia: {
    label: "Remove from Nexus",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "remove from nexus",
      body: "remove “{title}” from your nexus and lectern? this removes its individual entries in libraries you manage and revokes sharing you created. your highlights and passage attachments are deleted; note text remains. progress may be lost. other readers may lose access. this cannot be undone.",
    },
  },
  DeleteLibrary: {
    label: "Delete library",
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
    label: "Delete message and replies",
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
      body: "Delete this highlight? Its annotation is deleted too. This can’t be undone.",
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
  DeleteNote: {
    label: "Delete note",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete note?",
      body: "Delete “{title}”? Pages and notes linked to it are kept.",
    },
  },
} as const satisfies Record<string, Entry>;

export type ActionId = keyof typeof ACTION_CATALOG;

/** The server's `blocked` reasons. `Loading` and `Busy` describe waits, so their sites keep them
 * off screen, for a screen reader alone. */
export const BLOCKED_COPY = {
  PodcastSubscription: "included by this podcast subscription.",
  PermissionDenied: "you don’t have permission.",
  Locked: "this item is locked.",
  Processing: "available once processing finishes.",
  TemporarilyUnavailable: "unavailable right now.",
  Loading: "still loading.",
  CapacityReached: "lectern is full. remove an item first.",
  RequiresOnline: "needs a connection.",
  UnsupportedOnDevice: "not available on this device.",
  Busy: "in progress.",
} as const;

export type BlockedReason = keyof typeof BLOCKED_COPY;

/** Why a remote verb is unavailable, from admission. A browser offline while admitted lacks a
 * connection too. A durable reason, shown. */
export function admissionReason(): string {
  return currentAdmissionReason() ?? BLOCKED_COPY.RequiresOnline;
}

/** What a failed verb tells. `Domain` is the verb's own line, translated from a domain code ahead
 * of the transport; `Transport` leaves the reason and verb to the transport; `Unknown` is a write
 * that may have gone through, held until the verb runs again. `retry` resends the same verb. */
export type ActionOutcome =
  | { readonly kind: "Domain"; readonly line: Line; readonly retry: boolean }
  | { readonly kind: "Transport"; readonly fact: string; readonly retry: boolean }
  | { readonly kind: "Unknown"; readonly line: Line };

export function actionOutcome(id: ActionId, label: string, title: string, error: ApiError): ActionOutcome {
  const named = `“${label.replace(/…$/, "")}”`;
  const fact = `couldn’t complete ${named}.`;
  const domain = (line: Line, retry = false): ActionOutcome => ({ kind: "Domain", line, retry });
  if (id === "Playback") switch (error.code) {
    case "E_AUDIO_UNAVAILABLE": return domain({ fact: `couldn’t play “${title}”.`, reason: "it has no audio link." });
  }
  if (id === "LecternMembership" && error.code === "E_RESOURCE_CONFLICT")
    return domain({ fact: "couldn’t change the lectern." });
  if ((id === "RetrySource" || id === "RepairSource" || id === "RepairSearch") && error.code === "E_RESOURCE_CONFLICT")
    return domain({ fact });
  if (outcomeUnknown(error)) return { kind: "Unknown", line: { fact: `not sure ${named} went through.` } };
  switch (error.code) {
    case "E_ACTION_FACTS_STALE": return domain({ fact, reason: "the menu was out of date. reopen it." });
    case "E_FORBIDDEN":
    case "E_OWNER_REQUIRED": return domain({ fact, reason: "you don’t have permission." });
    case "E_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND": return domain({ fact, reason: "this item is gone." });
    case "E_LIMIT": return domain({ fact, reason: "the destination is full." });
  }
  return { kind: "Transport", fact, retry: id === "Playback" };
}
