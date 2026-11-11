import * as Icon from "@/lib/ui/icons";

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
  readonly icon: Icon.Glyph | null;
  readonly group: Group;
  readonly confirmation?: Confirmation;
  readonly states?: Readonly<
    Record<string, { readonly label: string; readonly icon: Icon.Glyph | null }>
  >;
}

/**
 * Every verb's copy, keyed by the server's action kind (a recovery offer by its
 * offer kind). Insertion order is menu order; groups are separated. A `null` icon
 * is a word: its row keeps a blank slot. `as const` keeps the `null` literal, so a
 * direct read of a wordless entry does not compile where a glyph is required.
 */
export const ACTION_CATALOG = {
  MakeTask: {label:"make task",icon:null,group:"CreateTransform"},
  CompleteTask: {label:"complete",icon:null,group:"Consume"},
  ReopenTask: {label:"reopen",icon:null,group:"Consume"},
  TaskCompletionDate: {label:"change completion date",icon:null,group:"Consume"},
  StopTask: {label:"stop tracking task",icon:null,group:"Organize"},
  ResumeTask: {label:"track task again",icon:null,group:"Organize"},
  RepeatDaily: {label:"repeat daily",icon:null,group:"Organize"},
  StopDaily: {label:"stop repeating daily",icon:null,group:"Organize"},
  HabitHistory: {label:"habit history",icon:null,group:"Navigate"},
  Open: { label: "Open", icon: null, group: "Navigate" },
  OpenInNewPane: {
    label: "Open in new pane",
    icon: null,
    group: "Navigate",
  },
  OpenSource: { label: "Open source", icon: null, group: "Navigate" },
  OpenFeed: { label: "Open feed", icon: null, group: "Navigate" },
  Metadata: { label: "Metadata…", icon: null, group: "Navigate" },
  Playback: {
    label: "Play",
    icon: Icon.Play,
    group: "Consume",
    states: {
      Idle: { label: "Play", icon: Icon.Play },
      Playing: { label: "Pause", icon: Icon.Pause },
      Buffering: { label: "Pause", icon: Icon.Pause },
      Paused: { label: "Resume", icon: Icon.Play },
      Ended: { label: "Replay", icon: Icon.Play },
    },
  },
  PlayFromHere: { label: "Play from here", icon: Icon.Play, group: "Consume" },
  AddToQueue: { label: "Add to queue", icon: null, group: "Consume" },
  PlayNext: { label: "Play next", icon: null, group: "Consume" },
  Consumption: {
    label: "Mark as finished",
    icon: null,
    group: "Consume",
    states: {
      DocumentIncomplete: { label: "Mark as finished", icon: null },
      DocumentFinished: { label: "Mark as unread", icon: null },
      EpisodeUnplayed: { label: "Mark as played", icon: null },
      EpisodePlayed: { label: "Mark as unplayed", icon: null },
    },
  },
  MarkCollectionFinished: { label: "Mark all finished…", icon: null, group: "Consume" },
  MarkCollectionUnread: { label: "Mark all unread…", icon: null, group: "Consume" },
  ResetProgress: { label: "Reset progress", icon: null, group: "Consume" },
  Transcript: {
    label: "Request transcript…",
    icon: null,
    group: "Consume",
    states: {
      not_requested: { label: "Request transcript…", icon: null },
      queued: { label: "Transcript queued", icon: null },
      running: { label: "Transcript processing", icon: null },
      ready: { label: "Open transcript", icon: null },
      partial: { label: "Open transcript", icon: null },
      unavailable: { label: "Transcript unavailable", icon: null },
      failed_provider: { label: "Retry transcript", icon: Icon.Again },
    },
  },
  TranscribePodcastEpisodes: { label: "Transcribe all episodes…", icon: null, group: "Consume" },
  Download: {
    label: "Download for offline",
    icon: Icon.Download,
    group: "Consume",
    states: {
      Downloading: { label: "Cancel download", icon: Icon.Dismiss },
      Failed: { label: "Retry download", icon: Icon.Again },
      Ready: { label: "Remove download", icon: null },
    },
  },
  AddEpisodeToAll: { label: "Add to All", icon: Icon.Add, group: "Organize" },
  RemoveFeedEntry: { label: "Remove from All…", icon: Icon.Remove, group: "Danger" },
  LibraryPlacement: { label: "Libraries…", icon: Icon.Library, group: "Organize" },
  LecternMembership: {
    label: "Add to Lectern",
    icon: Icon.AddToLectern,
    group: "Organize",
    states: {
      Absent: { label: "Add to Lectern", icon: Icon.AddToLectern },
      Present: { label: "Remove from Lectern", icon: Icon.RemoveFromLectern },
    },
  },
  AddUnfinishedToLectern: { label: "Add unfinished contents to Lectern…", icon: Icon.AddToLectern, group: "Organize" },
  FeedLibraries: { label: "Add to library…", icon: Icon.Library, group: "Organize" },
  SubscribeFeed: { label: "Subscribe", icon: null, group: "Organize" },
  UnsubscribeFeed: { label: "Unsubscribe", icon: null, group: "Organize" },
  Chat: {
    label: "Chat about this…",
    icon: Icon.NewChat,
    group: "CreateTransform",
  },
  EditHighlight: {
    label: "Edit highlight…",
    icon: Icon.Highlight,
    group: "CreateTransform",
  },
  EditHighlightAnnotation: {
    label: "Annotate",
    icon: Icon.Note,
    group: "CreateTransform",
  },
  EditHighlightBounds: {
    label: "Edit bounds",
    icon: null,
    group: "CreateTransform",
  },
  ForkMessage: {
    label: "Fork from here",
    icon: Icon.Forks,
    group: "CreateTransform",
  },
  RerunMessage: { label: "Rerun", icon: Icon.Again, group: "CreateTransform" },
  RegenerateMessage: {
    label: "Regenerate",
    icon: Icon.Again,
    group: "CreateTransform",
  },
  EditPageTitle: {
    label: "Edit title…",
    icon: null,
    group: "CreateTransform",
  },
  EditNoteBody: {
    label: "Edit note",
    icon: null,
    group: "CreateTransform",
  },
  Share: { label: "Share…", icon: Icon.Share, group: "ShareExport" },
  DownloadOriginal: {
    label: "Download original",
    icon: Icon.Download,
    group: "ShareExport",
  },
  RetrySource: {
    label: "Retry source processing",
    icon: Icon.Again,
    group: "Manage",
  },
  RepairSource: {
    label: "Retry stopped processing",
    icon: Icon.Again,
    group: "Manage",
  },
  RepairSearch: {
    label: "Rebuild search index",
    icon: Icon.Again,
    group: "Manage",
  },
  RefreshSource: { label: "Refresh source", icon: Icon.Again, group: "Manage" },
  // Imports runs the two upload commands on this runtime; no resource menu offers them.
  RetryUpload: { label: "Retry upload", icon: Icon.Again, group: "Manage" },
  RetryMetadata: {
    label: "update metadata",
    icon: null,
    group: "Manage",
  },
  LeaveLibrary: { label: "Leave library…", icon: null, group: "Manage", confirmation: {
    title: "leave library?", body: "leave “{title}”? its contents remain in the library. you may lose access to items held only here.",
  } },
  LibrarySettings: {
    label: "Library settings…",
    icon: Icon.Settings,
    group: "Manage",
  },
  PodcastSettings: {
    label: "Playback defaults…",
    icon: Icon.Settings,
    group: "Manage",
  },
  RefreshFeed: {
    label: "Check for new episodes",
    icon: Icon.Again,
    group: "Manage",
  },
  RemoveFeedItems: { label: "Remove episodes from libraries…", icon: Icon.Remove, group: "Danger" },
  RemoveUpload: { label: "Remove import", icon: null, group: "Danger" },
  RemoveMedia: {
    label: "remove from nexus…",
    icon: null,
    group: "Danger",
  },
  DeleteLibrary: {
    label: "Delete library",
    icon: null,
    group: "Danger",
    confirmation: {
      title: "Delete Library?",
      body: "Delete “{title}”? Its items stay in Nexus. This can’t be undone.",
    },
  },
  DeleteConversation: {
    label: "Delete chat",
    icon: null,
    group: "Danger",
    confirmation: {
      title: "delete chat?",
      body: "deletes “{title}” and all its messages, replies and forks. this cannot be undone.",
    },
  },
  DeleteMessage: {
    label: "Delete message and replies",
    icon: null,
    group: "Danger",
    confirmation: {
      title: "delete message and replies?",
      body: "deletes this message and all descendant replies and forks. if no messages remain, the chat is deleted. this cannot be undone.",
    },
  },
  DeleteHighlight: {
    label: "Delete highlight",
    icon: null,
    group: "Danger",
    confirmation: {
      title: "Delete highlight?",
      body: "Delete this highlight? Its annotation is deleted too. This can’t be undone.",
    },
  },
  DeletePage: {
    label: "Delete page",
    icon: null,
    group: "Danger",
    confirmation: {
      title: "Delete page?",
      body: "Delete “{title}”? Its notes are kept.",
    },
  },
  DeleteNote: {
    label: "Delete note",
    icon: null,
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
  FeedSubscription: "included by a subscription.",
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

export function actionOutcome(id: ActionId, feedbackLabel: string, error: ApiError, rawWrite: boolean): ActionOutcome {
  const named = `“${feedbackLabel.replace(/…$/, "")}”`;
  const fact = `couldn’t complete ${named}.`;
  const domain = (line: Line, retry = false): ActionOutcome => ({ kind: "Domain", line, retry });
  if (id === "LecternMembership" && error.code === "E_RESOURCE_CONFLICT")
    return domain({ fact: "couldn’t change the lectern." });
  if ((id === "RetrySource" || id === "RepairSource" || id === "RepairSearch") && error.code === "E_RESOURCE_CONFLICT")
    return domain({ fact });
  if (rawWrite && outcomeUnknown(error)) return { kind: "Unknown", line: { fact: `not sure ${named} worked.` } };
  switch (error.code) {
    case "E_ACTION_FACTS_STALE": return domain({ fact, reason: "the menu is outdated. reopen it." });
    case "E_FORBIDDEN":
    case "E_OWNER_REQUIRED": return domain({ fact, reason: "you don’t have permission." });
    case "E_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND": return domain({ fact, reason: "this item is gone." });
    case "E_LIMIT": return domain({ fact, reason: "the destination is full." });
  }
  return { kind: "Transport", fact, retry: id === "Playback" };
}
