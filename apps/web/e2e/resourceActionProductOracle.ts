/**
 * Product-owned oracle for the canonical resource-action hard cut.
 *
 * This file deliberately imports no production catalog, planner, snapshot, or
 * presenter. Journey tests compare the running product with these reviewed
 * literals so one shared implementation cannot make every surface agree on the
 * same wrong menu.
 */

export const RESOURCE_SCHEMES = [
  "media",
  "library",
  "evidence_span",
  "content_chunk",
  "highlight",
  "page",
  "note_block",
  "fragment",
  "conversation",
  "message",
  "oracle_reading",
  "oracle_passage_anchor",
  "artifact",
  "artifact_revision",
  "external_snapshot",
  "contributor",
  "podcast",
  "reader_apparatus_item",
  "passage_anchor",
] as const;

export type OracleResourceScheme = (typeof RESOURCE_SCHEMES)[number];

export const MEDIA_SUBTYPES = [
  "web_article",
  "epub",
  "pdf",
  "video",
  "podcast_episode",
] as const;

export const ACTION_GROUPS = [
  "Navigate",
  "Consume",
  "Organize",
  "CreateTransform",
  "ShareExport",
  "Manage",
  "Danger",
] as const;

type OracleActionGroup = (typeof ACTION_GROUPS)[number];
type OracleTone = "default" | "danger";

interface OracleConfirmation {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
}

export interface OracleActionDefinition {
  readonly id: string;
  readonly group: OracleActionGroup;
  readonly order: number;
  readonly label: string;
  readonly icon: string;
  readonly tone: OracleTone;
  readonly confirmation: OracleConfirmation | null;
  readonly appliesWhen: string;
}

const action = (definition: OracleActionDefinition): OracleActionDefinition =>
  definition;

/** Stable IDs name capabilities. State changes the verb, never the ID. */
export const RESOURCE_ACTION_LEDGER = [
  action({
    id: "ResourceAction.Open",
    group: "Navigate",
    order: 10,
    label: "Open",
    icon: "ArrowUpRight",
    tone: "default",
    confirmation: null,
    appliesWhen: "Canonical activation is routeable or external.",
  }),
  action({
    id: "ResourceAction.OpenInNewPane",
    group: "Navigate",
    order: 20,
    label: "Open in new pane",
    icon: "PanelsTopLeft",
    tone: "default",
    confirmation: null,
    appliesWhen: "Canonical activation can be hosted by a Nexus pane.",
  }),
  action({
    id: "ResourceOperation.OpenSource",
    group: "Navigate",
    order: 30,
    label: "Open source",
    icon: "ExternalLink",
    tone: "default",
    confirmation: null,
    appliesWhen: "The resource has an authoritative source URL.",
  }),

  action({
    id: "ResourceOperation.Media.Playback",
    group: "Consume",
    order: 10,
    label: "Play",
    icon: "Play",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media has a FooterAudio player descriptor.",
  }),
  action({
    id: "ResourceOperation.Media.PlayNext",
    group: "Consume",
    order: 20,
    label: "Play next",
    icon: "ListStart",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media has a FooterAudio player descriptor.",
  }),
  action({
    id: "ResourceOperation.Media.Consumption",
    group: "Consume",
    order: 30,
    label: "Mark as finished",
    icon: "CircleCheck",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "Visible Media; current verb follows media subtype and consumption state.",
  }),
  action({
    id: "ResourceOperation.Media.ResetProgress",
    group: "Consume",
    order: 40,
    label: "Reset progress",
    icon: "RotateCcw",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media has persisted progress that can be reset.",
  }),
  action({
    id: "ResourceOperation.Media.Transcript",
    group: "Consume",
    order: 50,
    label: "Request transcript…",
    icon: "Captions",
    tone: "default",
    confirmation: null,
    appliesWhen: "Video or podcast episode supports transcript provisioning.",
  }),
  action({
    id: "ResourceOperation.Media.Offline",
    group: "Consume",
    order: 60,
    label: "Download for offline",
    icon: "Download",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "Podcast episode has an eligible enclosure; client facts may block but never omit it.",
  }),

  action({
    id: "RelationshipAction.LibraryPlacement",
    group: "Organize",
    order: 10,
    label: "Libraries…",
    icon: "Library",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media or Podcast supports named-Library placement.",
  }),
  action({
    id: "RelationshipAction.LecternMembership",
    group: "Organize",
    order: 20,
    label: "Add to Lectern",
    icon: "ListPlus",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media is eligible for the Lectern.",
  }),
  action({
    id: "RelationshipAction.PodcastSubscription",
    group: "Organize",
    order: 30,
    label: "Subscribe",
    icon: "Rss",
    tone: "default",
    confirmation: null,
    appliesWhen: "Visible Podcast; current verb follows subscription state.",
  }),

  action({
    id: "ResourceAction.Chat",
    group: "CreateTransform",
    order: 10,
    label: "Chat about this…",
    icon: "MessageCircle",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "Static scheme policy permits a chat subject; chooser owns new versus existing chat.",
  }),
  action({
    id: "ResourceOperation.Highlight.Edit",
    group: "CreateTransform",
    order: 20,
    label: "Edit highlight…",
    icon: "Highlighter",
    tone: "default",
    confirmation: null,
    appliesWhen: "Existing Highlight; non-owner remains blocked and visible.",
  }),
  action({
    id: "ResourceOperation.Highlight.Note",
    group: "CreateTransform",
    order: 30,
    label: "Add note…",
    icon: "NotebookPen",
    tone: "default",
    confirmation: null,
    appliesWhen: "Existing Highlight; current verb follows note presence.",
  }),
  action({
    id: "ResourceOperation.Highlight.Link",
    group: "CreateTransform",
    order: 40,
    label: "Link…",
    icon: "Link2",
    tone: "default",
    confirmation: null,
    appliesWhen: "Existing Highlight can own a durable edge.",
  }),
  action({
    id: "ResourceOperation.Highlight.Learn",
    group: "CreateTransform",
    order: 50,
    label: "Learn from this",
    icon: "BookOpenText",
    tone: "default",
    confirmation: null,
    appliesWhen: "Existing Highlight has quote text and a dossier subject.",
  }),
  action({
    id: "ResourceOperation.Highlight.EditBounds",
    group: "CreateTransform",
    order: 60,
    label: "Edit bounds",
    icon: "TextSelect",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "Existing Highlight; unsupported clients block instead of omitting.",
  }),
  action({
    id: "ResourceOperation.Message.Fork",
    group: "CreateTransform",
    order: 70,
    label: "Fork from here",
    icon: "GitFork",
    tone: "default",
    confirmation: null,
    appliesWhen: "Message can start a conversation fork.",
  }),
  action({
    id: "ResourceOperation.Message.WalkSources",
    group: "CreateTransform",
    order: 80,
    label: "Walk through sources",
    icon: "Waypoints",
    tone: "default",
    confirmation: null,
    appliesWhen: "Completed assistant Message has at least two citations.",
  }),
  action({
    id: "ResourceOperation.Message.Rerun",
    group: "CreateTransform",
    order: 90,
    label: "Rerun",
    icon: "RefreshCw",
    tone: "default",
    confirmation: null,
    appliesWhen: "Failed or cancelled assistant Message can rerun.",
  }),
  action({
    id: "ResourceOperation.Message.Regenerate",
    group: "CreateTransform",
    order: 100,
    label: "Regenerate",
    icon: "Sparkles",
    tone: "default",
    confirmation: null,
    appliesWhen: "Completed eligible assistant Message can regenerate.",
  }),
  action({
    id: "ResourceOperation.Page.EditTitle",
    group: "CreateTransform",
    order: 110,
    label: "Edit title…",
    icon: "Pencil",
    tone: "default",
    confirmation: null,
    appliesWhen: "Page title is editable by the viewer.",
  }),
  action({
    id: "ResourceOperation.NoteBlock.EditBody",
    group: "CreateTransform",
    order: 120,
    label: "Edit note",
    icon: "FilePenLine",
    tone: "default",
    confirmation: null,
    appliesWhen: "NoteBlock body is editable by the viewer.",
  }),
  action({
    id: "ResourceOperation.Contributor.Rename",
    group: "CreateTransform",
    order: 130,
    label: "Edit name…",
    icon: "Pencil",
    tone: "default",
    confirmation: null,
    appliesWhen: "Contributor may be curated by the viewer.",
  }),
  action({
    id: "ResourceOperation.Artifact.Regenerate",
    group: "CreateTransform",
    order: 140,
    label: "Regenerate",
    icon: "Sparkles",
    tone: "default",
    confirmation: null,
    appliesWhen: "Artifact has no active build and viewer may regenerate it.",
  }),
  action({
    id: "ResourceOperation.ArtifactRevision.MakeCurrent",
    group: "CreateTransform",
    order: 150,
    label: "Make current",
    icon: "History",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "ArtifactRevision is not current and viewer may update its Artifact head.",
  }),

  action({
    id: "ResourceAction.Share",
    group: "ShareExport",
    order: 10,
    label: "Share…",
    icon: "Share2",
    tone: "default",
    confirmation: null,
    appliesWhen: "Static scheme sharing policy is not None.",
  }),
  action({
    id: "ResourceOperation.Media.DownloadOriginal",
    group: "ShareExport",
    order: 20,
    label: "Download original",
    icon: "FileDown",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media has a persisted original file.",
  }),

  action({
    id: "ResourceOperation.Media.RetryProcessing",
    group: "Manage",
    order: 10,
    label: "Retry processing",
    icon: "RotateCcw",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media processing failed and retry is meaningful.",
  }),
  action({
    id: "ResourceOperation.Media.RefreshSource",
    group: "Manage",
    order: 20,
    label: "Refresh source",
    icon: "RefreshCw",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media has a refreshable source.",
  }),
  action({
    id: "ResourceOperation.Media.RetryMetadata",
    group: "Manage",
    order: 30,
    label: "Re-enrich metadata",
    icon: "Sparkles",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media metadata enrichment can be retried.",
  }),
  action({
    id: "ResourceOperation.Media.EditAuthors",
    group: "Manage",
    order: 40,
    label: "Edit authors…",
    icon: "Users",
    tone: "default",
    confirmation: null,
    appliesWhen: "Media authors are editable by the viewer.",
  }),
  action({
    id: "ResourceOperation.Library.Settings",
    group: "Manage",
    order: 50,
    label: "Library settings…",
    icon: "Settings",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "Library settings are meaningful; insufficient authority blocks rather than omits.",
  }),
  action({
    id: "ResourceOperation.Podcast.Settings",
    group: "Manage",
    order: 60,
    label: "Podcast settings…",
    icon: "Settings",
    tone: "default",
    confirmation: null,
    appliesWhen:
      "Podcast is subscribed; insufficient authority blocks rather than omits.",
  }),
  action({
    id: "ResourceOperation.Podcast.Refresh",
    group: "Manage",
    order: 70,
    label: "Check for new episodes",
    icon: "RefreshCw",
    tone: "default",
    confirmation: null,
    appliesWhen: "Subscribed Podcast has a refreshable feed.",
  }),
  action({
    id: "ResourceOperation.Podcast.RetryBackfill",
    group: "Manage",
    order: 80,
    label: "Retry backlog",
    icon: "RotateCcw",
    tone: "default",
    confirmation: null,
    appliesWhen: "Podcast has a failed episode backlog.",
  }),

  action({
    id: "ResourceOperation.Media.Remove",
    group: "Danger",
    order: 10,
    label: "Remove from Nexus",
    icon: "Trash2",
    tone: "danger",
    confirmation: {
      title: "Remove from Nexus?",
      body: "Remove “{title}” from Nexus, every Library, and the Lectern? This can’t be undone.",
      confirmLabel: "Remove from Nexus",
    },
    appliesWhen: "Media may be deleted by the viewer.",
  }),
  action({
    id: "ResourceOperation.Library.Delete",
    group: "Danger",
    order: 20,
    label: "Delete Library",
    icon: "Trash2",
    tone: "danger",
    confirmation: {
      title: "Delete Library?",
      body: "Delete “{title}”? Its items stay in Nexus. This can’t be undone.",
      confirmLabel: "Delete Library",
    },
    appliesWhen:
      "Non-system Library may be deleted; insufficient authority blocks rather than omits.",
  }),
  action({
    id: "ResourceOperation.Conversation.Delete",
    group: "Danger",
    order: 30,
    label: "Delete chat",
    icon: "Trash2",
    tone: "danger",
    confirmation: {
      title: "Delete chat?",
      body: "Delete “{title}” and its messages? This can’t be undone.",
      confirmLabel: "Delete chat",
    },
    appliesWhen: "Conversation is visible; a non-owner sees PermissionDenied.",
  }),
  action({
    id: "ResourceOperation.Message.Delete",
    group: "Danger",
    order: 40,
    label: "Delete message",
    icon: "Trash2",
    tone: "danger",
    confirmation: {
      title: "Delete message?",
      body: "Delete this message? This can’t be undone.",
      confirmLabel: "Delete message",
    },
    appliesWhen:
      "Message is visible and aggregate deletion is legal; a non-owner sees PermissionDenied.",
  }),
  action({
    id: "ResourceOperation.Highlight.Delete",
    group: "Danger",
    order: 50,
    label: "Delete highlight",
    icon: "Trash2",
    tone: "danger",
    confirmation: {
      title: "Delete highlight?",
      body: "Delete this highlight and its note? This can’t be undone.",
      confirmLabel: "Delete highlight",
    },
    appliesWhen: "Existing Highlight; a non-owner sees PermissionDenied.",
  }),
  action({
    id: "ResourceOperation.Page.Delete",
    group: "Danger",
    order: 60,
    label: "Delete page",
    icon: "Trash2",
    tone: "danger",
    confirmation: {
      title: "Delete page?",
      body: "Delete “{title}” and its note blocks? This can’t be undone.",
      confirmLabel: "Delete page",
    },
    appliesWhen: "Page may be deleted by the viewer.",
  }),
] as const satisfies readonly OracleActionDefinition[];

export type OracleResourceActionId =
  (typeof RESOURCE_ACTION_LEDGER)[number]["id"];

export const ACTIONS_BY_SCHEME = {
  media: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceOperation.OpenSource",
    "ResourceOperation.Media.Playback",
    "ResourceOperation.Media.PlayNext",
    "ResourceOperation.Media.Consumption",
    "ResourceOperation.Media.ResetProgress",
    "ResourceOperation.Media.Transcript",
    "ResourceOperation.Media.Offline",
    "RelationshipAction.LibraryPlacement",
    "RelationshipAction.LecternMembership",
    "ResourceAction.Chat",
    "ResourceAction.Share",
    "ResourceOperation.Media.DownloadOriginal",
    "ResourceOperation.Media.RetryProcessing",
    "ResourceOperation.Media.RefreshSource",
    "ResourceOperation.Media.RetryMetadata",
    "ResourceOperation.Media.EditAuthors",
    "ResourceOperation.Media.Remove",
  ],
  library: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceAction.Share",
    "ResourceOperation.Library.Settings",
    "ResourceOperation.Library.Delete",
  ],
  evidence_span: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
  ],
  content_chunk: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
  ],
  highlight: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.Highlight.Edit",
    "ResourceOperation.Highlight.Note",
    "ResourceOperation.Highlight.Link",
    "ResourceOperation.Highlight.Learn",
    "ResourceOperation.Highlight.EditBounds",
    "ResourceAction.Share",
    "ResourceOperation.Highlight.Delete",
  ],
  page: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.Page.EditTitle",
    "ResourceAction.Share",
    "ResourceOperation.Page.Delete",
  ],
  note_block: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.NoteBlock.EditBody",
    "ResourceAction.Share",
  ],
  fragment: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
  ],
  conversation: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceAction.Share",
    "ResourceOperation.Conversation.Delete",
  ],
  message: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.Message.Fork",
    "ResourceOperation.Message.WalkSources",
    "ResourceOperation.Message.Rerun",
    "ResourceOperation.Message.Regenerate",
    "ResourceOperation.Message.Delete",
  ],
  oracle_reading: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceAction.Share",
  ],
  oracle_passage_anchor: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
  ],
  artifact: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.Artifact.Regenerate",
    "ResourceAction.Share",
  ],
  artifact_revision: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.ArtifactRevision.MakeCurrent",
  ],
  external_snapshot: ["ResourceAction.Open"],
  contributor: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
    "ResourceOperation.Contributor.Rename",
    "ResourceAction.Share",
  ],
  podcast: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "RelationshipAction.LibraryPlacement",
    "RelationshipAction.PodcastSubscription",
    "ResourceAction.Chat",
    "ResourceAction.Share",
    "ResourceOperation.Podcast.Settings",
    "ResourceOperation.Podcast.Refresh",
    "ResourceOperation.Podcast.RetryBackfill",
  ],
  reader_apparatus_item: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
  ],
  passage_anchor: [
    "ResourceAction.Open",
    "ResourceAction.OpenInNewPane",
    "ResourceAction.Chat",
  ],
} as const satisfies Record<
  OracleResourceScheme,
  readonly OracleResourceActionId[]
>;

export const MEDIA_SUBTYPE_POLICY = {
  web_article: {
    playback: false,
    transcript: false,
    offline: false,
    originalFile: "when persisted",
  },
  epub: {
    playback: false,
    transcript: false,
    offline: false,
    originalFile: "when persisted",
  },
  pdf: {
    playback: false,
    transcript: false,
    offline: false,
    originalFile: "when persisted",
  },
  video: {
    playback: false,
    transcript: true,
    offline: false,
    originalFile: "when persisted",
  },
  podcast_episode: {
    playback: "when FooterAudio",
    transcript: true,
    offline: "when enclosure eligible",
    originalFile: "when persisted",
  },
} as const satisfies Record<(typeof MEDIA_SUBTYPES)[number], object>;

export const STATEFUL_ACTION_LABELS = {
  "ResourceOperation.Media.Playback": {
    Idle: "Play",
    Paused: "Resume",
    Ended: "Replay",
  },
  "ResourceOperation.Media.Consumption": {
    Unread: "Mark as finished",
    InProgress: "Mark as finished",
    Finished: "Mark as unread",
    EpisodeUnplayed: "Mark as played",
    EpisodePlayed: "Mark as unplayed",
  },
  "ResourceOperation.Media.Transcript": {
    NotRequested: "Request transcript…",
    Queued: "Transcript queued",
    Running: "Transcript processing",
    Ready: "Open transcript",
    Partial: "Open transcript",
    Unavailable: "Transcript unavailable",
    FailedQuota: "Retry transcript",
    FailedProvider: "Retry transcript",
  },
  "ResourceOperation.Media.Offline": {
    Absent: "Download for offline",
    Resolving: "Cancel download",
    Queued: "Cancel download",
    Downloading: "Cancel download",
    Restarting: "Cancel download",
    Failed: "Retry download",
    Ready: "Remove download",
    Removing: "Remove download",
  },
  "RelationshipAction.LecternMembership": {
    Absent: "Add to Lectern",
    Present: "Remove from Lectern",
  },
  "RelationshipAction.PodcastSubscription": {
    Unsubscribed: "Subscribe",
    Subscribed: "Unsubscribe",
  },
  "ResourceOperation.Highlight.Note": {
    Absent: "Add note…",
    Present: "Edit note…",
  },
} as const;

export const BLOCKED_REASON_COPY = {
  PermissionDenied: "You don’t have permission to do this.",
  Locked: "This item is locked.",
  Processing: "Available when processing finishes.",
  TemporarilyUnavailable: "Temporarily unavailable. Try again.",
  Loading: "Actions are still loading.",
  CapacityReached: "Lectern is full. Remove an item to add this one.",
  RequiresOnline: "Connect to the internet to use this action.",
  UnsupportedOnDevice: "Not supported on this device.",
  Busy: "This action is in progress.",
} as const;

/** Standing representations that must consume only ResourceActionSubject. */
export const REQUIRED_RESOURCE_ACTION_SURFACES = [
  { id: "browse-acquired-row", host: "CollectionRow / browse presenter" },
  { id: "search-result-row", host: "CollectionRow / search presenter" },
  { id: "library-item-row", host: "CollectionRow / media presenter" },
  { id: "libraries-library-row", host: "CollectionRow / library presenter" },
  { id: "lectern-item-row", host: "CollectionRow / lectern presenter" },
  {
    id: "chats-conversation-row",
    host: "CollectionRow / conversation presenter",
  },
  { id: "podcasts-podcast-row", host: "CollectionRow / podcast presenter" },
  { id: "podcast-episode-row", host: "CollectionRow / episode presenter" },
  {
    id: "authors-contributor-row",
    host: "CollectionRow / contributor presenter",
  },
  { id: "author-work-row", host: "CollectionRow / contributor-work presenter" },
  { id: "pages-page-row", host: "CollectionRow / page presenter" },
  { id: "nexus-command-result", host: "Nexus and Switchboard result" },
  { id: "chat-context-card", host: "ConversationContextRefsSurface" },
  { id: "evidence-card", host: "EvidenceItemRow" },
  { id: "connections-card", host: "ConnectionsSurface" },
  {
    id: "resource-surface-note-block",
    host: "ResourceSurfaceBodyEditor note-block occurrence",
  },
  {
    id: "resource-surface-resource-item",
    host: "ResourceSurfaceBodyEditor resource occurrence",
  },
  {
    id: "existing-highlight",
    host: "HighlightResourceActionMenu / existing-highlight popover",
  },
  { id: "assistant-message", host: "AssistantMessage" },
  { id: "user-message", host: "UserMessage" },
  { id: "desktop-listening-shelf", host: "DesktopListeningShelf" },
  { id: "mobile-mini-player", host: "MobileMiniPlayer" },
  { id: "mobile-now-playing", host: "MobileNowPlaying" },
  { id: "desktop-pane-header", host: "SurfaceHeader" },
  { id: "primary-mobile-pane-header", host: "MobilePaneBar" },
  { id: "secondary-mobile-pane-header", host: "MobileSecondaryPaneHost" },
] as const;

/** Commands that remain named controls because their operand is not a Resource. */
export const NON_RESOURCE_COMMANDS = [
  {
    owner: "Browse preview",
    commands: "Acquire/Subscribe before a ResourceRef exists",
  },
  {
    owner: "Nexus non-resource result",
    commands: "Run or open a URL/command result that has no ResourceRef",
  },
  {
    owner: "Search filter",
    commands: "Refine format and kind without acting on a Resource",
  },
  {
    owner: "Account session",
    commands: "Open account destinations and sign out",
  },
  {
    owner: "Collection occurrence",
    commands: "Move earlier/later; remove this exact occurrence",
  },
  {
    owner: "Context edge",
    commands: "Unlink, dismiss, remove from this chat context",
  },
  {
    owner: "Library membership",
    commands: "Remove member, transfer ownership",
  },
  {
    owner: "Reader/pane view",
    commands: "Theme, zoom, PDF colors, find, navigation, Companion visibility",
  },
  {
    owner: "Episode row view",
    commands: "Show/hide notes; show/hide transcript panel",
  },
  {
    owner: "Player session",
    commands: "Capture, volume, speed, previous/next, queue reorder, close",
  },
  {
    owner: "Podcast selection/batch",
    commands: "Mark selected/all played, transcribe selected/all, Export OPML",
  },
  {
    owner: "Fresh text selection",
    commands: "Materialize Highlight, then use its canonical menu",
  },
  {
    owner: "Conversation fork occurrence",
    commands: "Switch, rename, delete this fork",
  },
  {
    owner: "Artifact build handle",
    commands: "Cancel active build; no ArtifactBuild ResourceRef is introduced",
  },
] as const;

/** Exact legacy islands whose survival fails the hard cut. */
export const RETIRED_RESOURCE_ACTION_RESIDUE = [
  "useResourceActionCatalogProjection",
  "publishResourceActionSnapshotInvalidation",
  "resourceActionSnapshotInvalidation",
  "reresolveAll",
  "useDocumentActions",
  "episodeActionBusyKey",
  "ViewAction.Episode.PlayNext",
  "ViewAction.Episode.Transcript",
  "Author.Rename",
  "Player.OpenPreview",
  "Player.PreviewSource",
  "buildHighlightActions",
] as const;

const ARTICLE_ACTION_IDS = [
  "ResourceAction.Open",
  "ResourceAction.OpenInNewPane",
  "ResourceOperation.OpenSource",
  "ResourceOperation.Media.Consumption",
  "ResourceOperation.Media.ResetProgress",
  "RelationshipAction.LibraryPlacement",
  "RelationshipAction.LecternMembership",
  "ResourceAction.Chat",
  "ResourceAction.Share",
  "ResourceOperation.Media.RefreshSource",
  "ResourceOperation.Media.RetryMetadata",
  "ResourceOperation.Media.EditAuthors",
  "ResourceOperation.Media.Remove",
] as const satisfies readonly OracleResourceActionId[];

const actionById = new Map(
  RESOURCE_ACTION_LEDGER.map((definition) => [definition.id, definition]),
);

/** Ready, InProgress captured web article used by the parity journey. */
export const READY_WEB_ARTICLE_PLAN = ARTICLE_ACTION_IDS.map((id) => {
  const definition = actionById.get(id);
  if (definition === undefined) {
    throw new Error(`Product oracle references an unknown action: ${id}`);
  }
  return {
    id,
    label: definition.label,
    icon: definition.icon,
    group: definition.group,
    tone: definition.tone,
  };
});

const ledgerIds = RESOURCE_ACTION_LEDGER.map(({ id }) => id);
if (new Set(ledgerIds).size !== ledgerIds.length) {
  throw new Error("Product oracle contains duplicate resource-action IDs.");
}
if (Object.keys(ACTIONS_BY_SCHEME).length !== RESOURCE_SCHEMES.length) {
  throw new Error(
    "Product oracle does not explicitly cover every ResourceScheme.",
  );
}
for (const scheme of RESOURCE_SCHEMES) {
  for (const id of ACTIONS_BY_SCHEME[scheme]) {
    if (!actionById.has(id)) {
      throw new Error(
        `Product oracle scheme ${scheme} references unknown action ${id}.`,
      );
    }
  }
}
