import * as Icon from "@/lib/ui/icons";
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
  Open: { label: "Open", icon: null, group: "Navigate" },
  OpenInNewPane: {
    label: "Open in new pane",
    icon: null,
    group: "Navigate",
  },
  OpenSource: { label: "Open source", icon: null, group: "Navigate" },
  BrowserCapture: { label: "Open source in new tab", icon: null, group: "Navigate" },
  OpenPodcastFeed: { label: "Open feed", icon: null, group: "Navigate" },
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
  RemoveEpisodeFromAll: { label: "Remove from All…", icon: Icon.Remove, group: "Danger" },
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
  PodcastLibraries: { label: "Add to library…", icon: Icon.Library, group: "Organize" },
  SubscribePodcast: { label: "Subscribe", icon: null, group: "Organize" },
  UnsubscribePodcast: { label: "Unsubscribe", icon: null, group: "Organize" },
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
    label: "Research metadata",
    icon: Icon.Search,
    group: "Manage",
  },
  ReviewMetadataResult: {
    label: "Mark reviewed",
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
  RefreshPodcast: {
    label: "Check for new episodes",
    icon: Icon.Again,
    group: "Manage",
  },
  RemovePodcastEpisodes: { label: "Remove episodes from libraries…", icon: Icon.Remove, group: "Danger" },
  RemoveUpload: { label: "Remove import", icon: null, group: "Danger" },
  RemoveMedia: {
    label: "Remove from Nexus",
    icon: null,
    group: "Danger",
    confirmation: {
      title: "remove from nexus",
      body: "remove “{title}” from your nexus and lectern? this removes its individual entries in libraries you manage and revokes sharing you created. your highlights and passage attachments are deleted; note text remains. progress may be lost. other readers may lose access. this cannot be undone.",
    },
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

export const BLOCKED_COPY = {
  PodcastSubscription: "included by this podcast subscription",
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
  if (id === "Playback" && error.code === "E_AUDIO_UNAVAILABLE")
    return { tone: "Warning", title: "audio unavailable", requestId: error.requestId };
  if (id === "Playback" && (error.code === "E_PLAYBACK_REFUSED" || error.code === "E_PLAYBACK_STALE"))
    return { tone: "Warning", title: `couldn’t complete “${label.replace(/…$/, "")}”`, message: error.message };
  if (id === "Playback" && error.code === "E_PLAYBACK_UNCONFIRMED")
    return { tone: "Warning", title: "playback request not confirmed",
      message: "check the player’s current state before trying again." };
  const recovery =
    id === "RetrySource" || id === "RepairSource" || id === "RepairSearch";
  if (
    id === "LecternMembership" &&
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
    : `couldn't complete “${label.replace(/…$/, "")}”`;
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
