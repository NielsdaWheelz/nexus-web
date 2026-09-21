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
  Search,
  Settings,
  Share2,
  Sparkles,
  SquareDashedText,
  Trash2,
  Undo2,
  Users,
  Waypoints,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ResourceActionGroup =
  | "Navigate"
  | "Consume"
  | "Organize"
  | "CreateTransform"
  | "ShareExport"
  | "Manage"
  | "Danger";

export interface ResourceActionConfirmation {
  readonly title: string;
  readonly body: string;
}

interface CatalogEntry {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: ResourceActionGroup;
  readonly confirmation?: ResourceActionConfirmation;
  readonly states?: Readonly<
    Record<string, { readonly label: string; readonly icon: LucideIcon }>
  >;
}

// Insertion order is menu order. Each stable action id owns its copy once.
export const RESOURCE_ACTION_CATALOG = {
  "ResourceAction.Open": {
    label: "Open",
    icon: ArrowUpRight,
    group: "Navigate",
  },
  "ResourceAction.OpenInNewPane": {
    label: "Open in new pane",
    icon: PanelsTopLeft,
    group: "Navigate",
  },
  "ResourceOperation.OpenSource": {
    label: "Open source",
    icon: ExternalLink,
    group: "Navigate",
  },
  "ResourceOperation.Media.Playback": {
    label: "Play",
    icon: Play,
    group: "Consume",
    states: {
      Idle: { label: "Play", icon: Play },
      Paused: { label: "Resume", icon: Play },
      Ended: { label: "Replay", icon: RotateCcw },
    },
  },
  "ResourceOperation.Media.PlayNext": {
    label: "Play next",
    icon: ListStart,
    group: "Consume",
  },
  "ResourceOperation.Media.Consumption": {
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
  "ResourceOperation.Media.ResetProgress": {
    label: "Reset progress",
    icon: RotateCcw,
    group: "Consume",
  },
  "ResourceOperation.Media.Transcript": {
    label: "Request transcript…",
    icon: Captions,
    group: "Consume",
    states: {
      NotRequested: { label: "Request transcript…", icon: Captions },
      Queued: { label: "Transcript queued", icon: Captions },
      Running: { label: "Transcript processing", icon: Captions },
      Ready: { label: "Open transcript", icon: Captions },
      Partial: { label: "Open transcript", icon: Captions },
      Unavailable: { label: "Transcript unavailable", icon: Captions },
      FailedQuota: { label: "Retry transcript", icon: RotateCcw },
      FailedProvider: { label: "Retry transcript", icon: RotateCcw },
    },
  },
  "ResourceOperation.Media.Offline": {
    label: "Download for offline",
    icon: Download,
    group: "Consume",
    states: {
      Absent: { label: "Download for offline", icon: Download },
      Downloading: { label: "Cancel download", icon: CircleX },
      Failed: { label: "Retry download", icon: RotateCcw },
      Ready: { label: "Remove download", icon: Trash2 },
    },
  },
  "RelationshipAction.LibraryPlacement": {
    label: "Libraries…",
    icon: Library,
    group: "Organize",
  },
  "RelationshipAction.LecternMembership": {
    label: "Add to Lectern",
    icon: ListPlus,
    group: "Organize",
    states: {
      Absent: { label: "Add to Lectern", icon: ListPlus },
      Present: { label: "Remove from Lectern", icon: ListMinus },
    },
  },
  "RelationshipAction.PodcastSubscription": {
    label: "Subscribe",
    icon: Rss,
    group: "Organize",
    states: {
      Unsubscribed: { label: "Subscribe", icon: Rss },
      Subscribed: { label: "Unsubscribe", icon: Rss },
    },
  },
  "ResourceAction.Chat": {
    label: "Chat about this…",
    icon: MessageCircle,
    group: "CreateTransform",
  },
  "ResourceOperation.Highlight.Edit": {
    label: "Edit highlight…",
    icon: Highlighter,
    group: "CreateTransform",
  },
  "ResourceOperation.Highlight.Note": {
    label: "Add note…",
    icon: NotebookPen,
    group: "CreateTransform",
    states: {
      Absent: { label: "Add note…", icon: NotebookPen },
      Present: { label: "Edit note…", icon: NotebookPen },
    },
  },
  "ResourceOperation.Highlight.Link": {
    label: "Link…",
    icon: Link2,
    group: "CreateTransform",
  },
  "ResourceOperation.Highlight.Learn": {
    label: "Learn from this",
    icon: BookOpenText,
    group: "CreateTransform",
  },
  "ResourceOperation.Highlight.EditBounds": {
    label: "Edit bounds",
    icon: SquareDashedText,
    group: "CreateTransform",
  },
  "ResourceOperation.Message.Fork": {
    label: "Fork from here",
    icon: GitFork,
    group: "CreateTransform",
  },
  "ResourceOperation.Message.WalkSources": {
    label: "Walk through sources",
    icon: Waypoints,
    group: "CreateTransform",
  },
  "ResourceOperation.Message.Rerun": {
    label: "Rerun",
    icon: RefreshCw,
    group: "CreateTransform",
  },
  "ResourceOperation.Message.Regenerate": {
    label: "Regenerate",
    icon: Sparkles,
    group: "CreateTransform",
  },
  "ResourceOperation.Page.EditTitle": {
    label: "Edit title…",
    icon: Pencil,
    group: "CreateTransform",
  },
  "ResourceOperation.NoteBlock.EditBody": {
    label: "Edit note",
    icon: FilePenLine,
    group: "CreateTransform",
  },
  "ResourceOperation.Contributor.Rename": {
    label: "Edit name…",
    icon: Pencil,
    group: "CreateTransform",
  },
  "ResourceOperation.Artifact.Regenerate": {
    label: "Regenerate",
    icon: Sparkles,
    group: "CreateTransform",
  },
  "ResourceOperation.ArtifactRevision.MakeCurrent": {
    label: "Make current",
    icon: History,
    group: "CreateTransform",
  },
  "ResourceAction.Share": {
    label: "Share…",
    icon: Share2,
    group: "ShareExport",
  },
  "ResourceOperation.Media.DownloadOriginal": {
    label: "Download original",
    icon: FileDown,
    group: "ShareExport",
  },
  "ResourceOperation.Media.RetryProcessing": {
    label: "Retry source processing",
    icon: RotateCcw,
    group: "Manage",
  },
  "ResourceOperation.Media.RepairSource": {
    label: "Retry stopped processing",
    icon: Wrench,
    group: "Manage",
  },
  "ResourceOperation.Media.RepairSearch": {
    label: "Rebuild search index",
    icon: Search,
    group: "Manage",
  },
  "ResourceOperation.Media.RefreshSource": {
    label: "Refresh source",
    icon: RefreshCw,
    group: "Manage",
  },
  "ResourceOperation.Media.RetryMetadata": {
    label: "Re-enrich metadata",
    icon: Sparkles,
    group: "Manage",
  },
  "ResourceOperation.Media.EditAuthors": {
    label: "Edit authors…",
    icon: Users,
    group: "Manage",
  },
  "ResourceOperation.Library.Settings": {
    label: "Library settings…",
    icon: Settings,
    group: "Manage",
  },
  "ResourceOperation.Podcast.Settings": {
    label: "Podcast settings…",
    icon: Settings,
    group: "Manage",
  },
  "ResourceOperation.Podcast.Refresh": {
    label: "Check for new episodes",
    icon: RefreshCw,
    group: "Manage",
  },
  "ResourceOperation.Podcast.RetryBackfill": {
    label: "Retry backlog",
    icon: RotateCcw,
    group: "Manage",
  },
  "ResourceOperation.Media.Remove": {
    label: "Remove from Nexus",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Remove from Nexus?",
      body: "Remove “{title}” from Nexus, every Library, and the Lectern? This can’t be undone.",
    },
  },
  "ResourceOperation.Library.Delete": {
    label: "Delete Library",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete Library?",
      body: "Delete “{title}”? Its items stay in Nexus. This can’t be undone.",
    },
  },
  "ResourceOperation.Conversation.Delete": {
    label: "Delete chat",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete chat?",
      body: "Delete “{title}” and its messages? This can’t be undone.",
    },
  },
  "ResourceOperation.Message.Delete": {
    label: "Delete message",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete message?",
      body: "Delete this message? This can’t be undone.",
    },
  },
  "ResourceOperation.Highlight.Delete": {
    label: "Delete highlight",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete highlight?",
      body: "Delete this highlight and its note? This can’t be undone.",
    },
  },
  "ResourceOperation.Page.Delete": {
    label: "Delete page",
    icon: Trash2,
    group: "Danger",
    confirmation: {
      title: "Delete page?",
      body: "Delete “{title}” and its note blocks? This can’t be undone.",
    },
  },
} as const satisfies Record<string, CatalogEntry>;

export type ResourceActionId = keyof typeof RESOURCE_ACTION_CATALOG;
