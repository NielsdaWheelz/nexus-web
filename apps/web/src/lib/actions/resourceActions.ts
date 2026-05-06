import type { ActionMenuOption } from "@/components/ui/ActionMenu";

type MenuSelectDetail = { triggerEl: HTMLButtonElement | null };

interface MediaActionSubject {
  id: string;
  title: string;
  canonical_source_url: string | null;
  capabilities?: object | null;
}

export function mediaResourceOptions(input: {
  media: MediaActionSubject | null | undefined;
  canManageLibraries: boolean;
  retryBusy?: boolean;
  refreshBusy?: boolean;
  deleteBusy?: boolean;
  onOpenChat?: () => void;
  onManageLibraries?: (detail: MenuSelectDetail) => void;
  onRetry?: () => void;
  onRefreshSource?: () => void;
  onDelete?: () => void;
}): ActionMenuOption[] {
  const media = input.media;
  if (!media) return [];

  const capabilities = media.capabilities as {
    can_delete?: unknown;
    can_retry?: unknown;
    can_refresh_source?: unknown;
  } | null | undefined;
  const options: ActionMenuOption[] = [];

  if (media.canonical_source_url) {
    options.push({
      id: "open-source",
      label: "Open source",
      href: media.canonical_source_url,
    });
  }

  if (capabilities?.can_retry === true && input.onRetry) {
    options.push({
      id: "retry-processing",
      label: input.retryBusy ? "Retrying..." : "Retry processing",
      disabled: input.retryBusy,
      onSelect: input.onRetry,
    });
  }

  if (capabilities?.can_refresh_source === true && input.onRefreshSource) {
    options.push({
      id: "refresh-source",
      label: input.refreshBusy ? "Refreshing..." : "Refresh source",
      disabled: input.refreshBusy,
      onSelect: input.onRefreshSource,
    });
  }

  if (input.onOpenChat) {
    options.push({
      id: "chat-about-media",
      label: "Chat about this document",
      onSelect: input.onOpenChat,
    });
  }

  if (input.canManageLibraries && input.onManageLibraries) {
    options.push({
      id: "manage-media-libraries",
      label: "Libraries...",
      restoreFocusOnClose: false,
      onSelect: input.onManageLibraries,
    });
  }

  if (capabilities?.can_delete === true && input.onDelete) {
    options.push({
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

export function libraryResourceOptions(input: {
  library: { is_default: boolean; role: string } | null | undefined;
  onOpenChat?: () => void;
  onViewIntelligence?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}): ActionMenuOption[] {
  const library = input.library;
  if (!library) return [];

  const options: ActionMenuOption[] = [];

  if (input.onOpenChat) {
    options.push({
      id: "chat-about-library",
      label: "Chat about this library",
      onSelect: input.onOpenChat,
    });
  }

  if (input.onViewIntelligence) {
    options.push({
      id: "view-library-intelligence",
      label: "Intelligence",
      onSelect: input.onViewIntelligence,
    });
  }

  if (!library.is_default && input.onEdit) {
    options.push({
      id: "edit-library",
      label: "Edit library",
      onSelect: input.onEdit,
    });
  }

  if (!library.is_default && library.role === "admin" && input.onDelete) {
    options.push({
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
  onManageLibraries?: (detail: MenuSelectDetail) => void;
  onOpenSettings?: () => void;
  onRefreshSync?: () => void;
  onUnsubscribe?: () => void;
}): ActionMenuOption[] {
  if (!input.canUsePodcastActions) return [];

  const options: ActionMenuOption[] = [];

  if (input.onManageLibraries) {
    options.push({
      id: "manage-podcast-libraries",
      label: "Libraries...",
      restoreFocusOnClose: false,
      disabled: input.busy || input.unsubscribeBusy,
      onSelect: input.onManageLibraries,
    });
  }

  if (input.onOpenSettings) {
    options.push({
      id: "open-podcast-settings",
      label: "Settings",
      disabled: input.busy || input.unsubscribeBusy,
      onSelect: input.onOpenSettings,
    });
  }

  if (input.onRefreshSync) {
    options.push({
      id: "refresh-podcast-sync",
      label: input.refreshBusy ? "Refreshing..." : "Refresh sync",
      disabled: input.busy || input.refreshBusy || input.unsubscribeBusy,
      onSelect: input.onRefreshSync,
    });
  }

  if (input.onUnsubscribe) {
    options.push({
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
  played: boolean;
  markingBusy?: boolean;
  onManageLibraries: (detail: MenuSelectDetail) => void;
  onOpenChat?: () => void;
  onRetry?: () => void;
  onRefreshSource?: () => void;
  onDelete?: () => void;
  onTogglePlayed: () => void;
}): ActionMenuOption[] {
  const options = mediaResourceOptions({
    media: input.media,
    canManageLibraries: true,
    retryBusy: input.retryBusy,
    refreshBusy: input.refreshBusy,
    deleteBusy: input.deleteBusy,
    onOpenChat: input.onOpenChat,
    onManageLibraries: input.onManageLibraries,
    onRetry: input.onRetry,
    onRefreshSource: input.onRefreshSource,
    onDelete: input.onDelete,
  }).map((option) =>
    option.id === "manage-media-libraries"
      ? { ...option, disabled: input.busy }
      : option
  );
  const playbackOption: ActionMenuOption = {
    id: "toggle-episode-played",
    label: input.played ? "Mark as unplayed" : "Mark as played",
    disabled: input.markingBusy,
    onSelect: input.onTogglePlayed,
  };
  const dangerIndex = options.findIndex((option) => option.tone === "danger");
  if (dangerIndex === -1) {
    options.push(playbackOption);
  } else {
    options.splice(dangerIndex, 0, playbackOption);
  }
  return options;
}

export function conversationResourceOptions(input: {
  deleting?: boolean;
  onDelete: () => void;
}): ActionMenuOption[] {
  return [
    {
      id: "delete-conversation",
      label: input.deleting ? "Deleting..." : "Delete conversation",
      tone: "danger",
      disabled: input.deleting,
      onSelect: input.onDelete,
    },
  ];
}
