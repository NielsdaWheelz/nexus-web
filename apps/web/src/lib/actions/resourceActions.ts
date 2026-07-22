import type { ReadStatus } from "@/lib/collections/readState";
import type { ActionDescriptor, ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import { isRecord } from "@/lib/validation";

interface MediaActionSubject {
  id: string;
  title: string;
  canonical_source_url: string | null;
  capabilities?: unknown;
}

interface MediaActionCapabilities {
  can_delete: boolean;
  can_retry: boolean;
  can_refresh_source: boolean;
  can_retry_metadata: boolean;
}

function normalizeMediaActionCapabilities(value: unknown): MediaActionCapabilities {
  if (!isRecord(value)) {
    return {
      can_delete: false,
      can_retry: false,
      can_refresh_source: false,
      can_retry_metadata: false,
    };
  }

  return {
    can_delete: value.can_delete === true,
    can_retry: value.can_retry === true,
    can_refresh_source: value.can_refresh_source === true,
    can_retry_metadata: value.can_retry_metadata === true,
  };
}

export function mediaResourceOptions(input: {
  media: MediaActionSubject | null | undefined;
  canManageLibraries: boolean;
  retryBusy?: boolean;
  refreshBusy?: boolean;
  deleteBusy?: boolean;
  retryMetadataBusy?: boolean;
  readState?: ReadStatus;
  onOpenChat?: () => void;
  onManageLibraries?: (detail: ActionSelectDetail) => void;
  onRetry?: () => void;
  onRefreshSource?: () => void;
  onDelete?: () => void;
  onRetryMetadata?: () => void;
  onMarkFinished?: () => void;
  onMarkUnread?: () => void;
  onAddToLectern?: () => void;
}): ActionDescriptor[] {
  const media = input.media;
  if (!media) return [];

  const capabilities = normalizeMediaActionCapabilities(media.capabilities);
  const options: ActionDescriptor[] = [];

  if (media.canonical_source_url) {
    options.push({
      kind: "link",
      id: "open-source",
      label: "Open source",
      href: media.canonical_source_url,
    });
  }

  if (capabilities.can_retry && input.onRetry) {
    options.push({
      kind: "command",
      id: "retry-processing",
      label: input.retryBusy ? "Retrying..." : "Retry processing",
      disabled: input.retryBusy,
      onSelect: input.onRetry,
    });
  }

  if (capabilities.can_refresh_source && input.onRefreshSource) {
    options.push({
      kind: "command",
      id: "refresh-source",
      label: input.refreshBusy ? "Refreshing..." : "Refresh source",
      disabled: input.refreshBusy,
      onSelect: input.onRefreshSource,
    });
  }

  if (capabilities.can_retry_metadata && input.onRetryMetadata) {
    options.push({
      kind: "command",
      id: "re-enrich-metadata",
      label: input.retryMetadataBusy ? "Re-enriching..." : "Re-enrich metadata",
      disabled: input.retryMetadataBusy,
      onSelect: input.onRetryMetadata,
    });
  }

  if (input.onAddToLectern) {
    options.push({
      kind: "command",
      id: "add-to-lectern",
      label: "Add to Lectern",
      onSelect: input.onAddToLectern,
    });
  }

  if (input.onOpenChat) {
    options.push({
      kind: "command",
      id: "chat-about-media",
      label: "Chat about this resource",
      onSelect: input.onOpenChat,
    });
  }

  if (input.canManageLibraries && input.onManageLibraries) {
    options.push({
      kind: "command",
      id: "manage-media-libraries",
      label: "Libraries...",
      restoreFocusOnClose: false,
      onSelect: input.onManageLibraries,
    });
  }

  // Read-state override verb: mark-finished on unread/in-progress; mark-unread on
  // finished. Exactly one is offered, driven by the current derived read-state.
  if (input.readState !== "finished" && input.onMarkFinished) {
    options.push({
      kind: "command",
      id: "mark-finished",
      label: "Mark as finished",
      onSelect: input.onMarkFinished,
    });
  }
  if (input.readState === "finished" && input.onMarkUnread) {
    options.push({
      kind: "command",
      id: "mark-unread",
      label: "Mark as unread",
      onSelect: input.onMarkUnread,
    });
  }

  if (capabilities.can_delete && input.onDelete) {
    options.push({
      kind: "command",
      id: "delete-media",
      label: "Delete document",
      tone: "danger",
      separatorBefore: options.length > 0,
      disabled: input.deleteBusy,
      onSelect: input.onDelete,
    });
  }

  return options;
}

export interface LibraryActionSubject {
  is_default: boolean;
  role: string;
  /**
   * Backend-backed capability flags (LibraryOut). A system-protected library
   * (e.g. the Oracle Corpus, `system_key != null`) reports all of these false,
   * which hides every mutation action below.
   */
  can_rename: boolean;
  can_delete: boolean;
  can_edit_entries: boolean;
}

export function libraryResourceOptions(input: {
  library: LibraryActionSubject | null | undefined;
  onEdit?: () => void;
  onDelete?: () => void;
}): ActionDescriptor[] {
  const library = input.library;
  if (!library) return [];

  const options: ActionDescriptor[] = [];

  // The edit dialog owns rename + sharing/membership (not media-entry
  // editing), so it is gated on can_rename. The default library reports
  // can_rename === false; a system library reports all can_* false.
  if (library.can_rename && input.onEdit) {
    options.push({
      kind: "command",
      id: "edit-library",
      label: "Edit library",
      onSelect: input.onEdit,
    });
  }

  if (library.can_delete && input.onDelete) {
    options.push({
      kind: "command",
      id: "delete-library",
      label: "Delete library",
      tone: "danger",
      separatorBefore: options.length > 0,
      onSelect: input.onDelete,
    });
  }

  return options;
}

export function podcastResourceOptions(input: {
  canUsePodcastActions: boolean;
  busy?: boolean;
  refreshBusy?: boolean;
  unsubscribeBusy?: boolean;
  onManageLibraries?: (detail: ActionSelectDetail) => void;
  onOpenSettings?: () => void;
  onRefreshSync?: () => void;
  onUnsubscribe?: () => void;
}): ActionDescriptor[] {
  if (!input.canUsePodcastActions) return [];

  const options: ActionDescriptor[] = [];

  if (input.onManageLibraries) {
    options.push({
      kind: "command",
      id: "manage-podcast-libraries",
      label: "Libraries...",
      restoreFocusOnClose: false,
      disabled: input.busy || input.unsubscribeBusy,
      onSelect: input.onManageLibraries,
    });
  }

  if (input.onOpenSettings) {
    options.push({
      kind: "command",
      id: "open-podcast-settings",
      label: "Settings",
      disabled: input.busy || input.unsubscribeBusy,
      onSelect: input.onOpenSettings,
    });
  }

  if (input.onRefreshSync) {
    options.push({
      kind: "command",
      id: "refresh-podcast-sync",
      label: input.refreshBusy ? "Refreshing..." : "Refresh sync",
      disabled: input.busy || input.refreshBusy || input.unsubscribeBusy,
      onSelect: input.onRefreshSync,
    });
  }

  if (input.onUnsubscribe) {
    options.push({
      kind: "command",
      id: "unsubscribe-podcast",
      label: input.unsubscribeBusy ? "Unsubscribing..." : "Unsubscribe",
      tone: "danger",
      separatorBefore: options.length > 0,
      disabled: input.busy || input.unsubscribeBusy,
      onSelect: input.onUnsubscribe,
    });
  }

  return options;
}

export function episodeResourceOptions(input: {
  media: MediaActionSubject;
  busy?: boolean;
  retryBusy?: boolean;
  refreshBusy?: boolean;
  deleteBusy?: boolean;
  retryMetadataBusy?: boolean;
  played: boolean;
  markingBusy?: boolean;
  onManageLibraries: (detail: ActionSelectDetail) => void;
  onOpenChat?: () => void;
  onRetry?: () => void;
  onRefreshSource?: () => void;
  onDelete?: () => void;
  onRetryMetadata?: () => void;
  onTogglePlayed: () => void;
  onAddToLectern?: () => void;
  episodePanelId: string;
  showNotesExpanded?: boolean;
  onToggleShowNotes?: () => void;
  playNextDisabled?: boolean;
  onPlayNext?: () => void;
  transcriptPanelExpanded?: boolean;
  onRequestTranscript?: () => void;
}): ActionDescriptor[] {
  const options = mediaResourceOptions({
    media: input.media,
    canManageLibraries: true,
    retryBusy: input.retryBusy,
    refreshBusy: input.refreshBusy,
    deleteBusy: input.deleteBusy,
    retryMetadataBusy: input.retryMetadataBusy,
    onOpenChat: input.onOpenChat,
    onManageLibraries: input.onManageLibraries,
    onRetry: input.onRetry,
    onRefreshSource: input.onRefreshSource,
    onDelete: input.onDelete,
    onRetryMetadata: input.onRetryMetadata,
    onAddToLectern: input.onAddToLectern,
  }).map((option) =>
    option.id === "manage-media-libraries"
      ? { ...option, disabled: input.busy }
      : option
  );
  const playbackOption: ActionDescriptor = {
    kind: "command",
    id: "toggle-episode-played",
    label: input.played ? "Mark as unplayed" : "Mark as played",
    disabled: input.markingBusy,
    onSelect: input.onTogglePlayed,
  };
  const episodeOptions: ActionDescriptor[] = [];
  if (input.onToggleShowNotes) {
    const expanded = input.showNotesExpanded === true;
    episodeOptions.push({
      kind: "command",
      id: "toggle-episode-notes",
      label: expanded ? "Hide notes" : "Show notes",
      state: expanded
        ? {
            kind: "disclosure",
            expanded: true,
            controls: input.episodePanelId,
            menuLabels: { collapsed: "Show notes", expanded: "Hide notes" },
          }
        : {
            kind: "disclosure",
            expanded: false,
            menuLabels: { collapsed: "Show notes", expanded: "Hide notes" },
          },
      onSelect: input.onToggleShowNotes,
    });
  }
  if (input.onPlayNext) {
    episodeOptions.push({
      kind: "command",
      id: "play-episode-next",
      label: "Play next",
      disabled: input.playNextDisabled,
      onSelect: input.onPlayNext,
    });
  }
  if (input.onRequestTranscript) {
    const expanded = input.transcriptPanelExpanded === true;
    episodeOptions.push({
      kind: "command",
      id: "request-episode-transcript",
      label: expanded ? "Hide transcript request" : "Request transcript...",
      state: expanded
        ? {
            kind: "disclosure",
            expanded: true,
            controls: input.episodePanelId,
            menuLabels: {
              collapsed: "Request transcript...",
              expanded: "Hide transcript request",
            },
          }
        : {
            kind: "disclosure",
            expanded: false,
            menuLabels: {
              collapsed: "Request transcript...",
              expanded: "Hide transcript request",
            },
          },
      onSelect: input.onRequestTranscript,
    });
  }
  const dangerIndex = options.findIndex((option) => option.tone === "danger");
  if (dangerIndex === -1) {
    options.push(...episodeOptions, playbackOption);
  } else {
    options.splice(dangerIndex, 0, ...episodeOptions, playbackOption);
  }
  return options;
}

export function conversationResourceOptions(input: {
  deleting?: boolean;
  distilling?: boolean;
  onDistill?: () => void;
  onDelete: () => void;
}): ActionDescriptor[] {
  const options: ActionDescriptor[] = [];
  if (input.onDistill) {
    options.push({
      kind: "command",
      id: "distill-conversation",
      label: input.distilling ? "Distilling..." : "Distill",
      disabled: input.distilling,
      onSelect: input.onDistill,
    });
  }
  options.push({
    kind: "command",
    id: "delete-conversation",
    label: input.deleting ? "Deleting..." : "Delete conversation",
    tone: "danger",
    disabled: input.deleting,
    onSelect: input.onDelete,
  });
  return options;
}
