import { describe, expect, it } from "vitest";
import {
  conversationResourceOptions,
  episodeResourceOptions,
  libraryResourceOptions,
  mediaResourceOptions,
  podcastResourceOptions,
} from "@/lib/actions/resourceActions";

describe("mediaResourceOptions", () => {
  const media = {
    id: "media-1",
    title: "Designing Data-Intensive Applications",
    canonical_source_url: "https://example.com/source",
    capabilities: { can_delete: true, can_retry: true },
  };

  it("keeps the same resource menu for header and list item consumers", () => {
    const headerMenu = mediaResourceOptions({
      media,
      canManageLibraries: true,
      onOpenChat: () => {},
      onManageLibraries: () => {},
      onRetry: () => {},
      onDelete: () => {},
    });

    const rowMenu = mediaResourceOptions({
      media,
      canManageLibraries: true,
      onOpenChat: () => {},
      onManageLibraries: () => {},
      onRetry: () => {},
      onDelete: () => {},
    });

    expect(
      headerMenu.map((option) => ({
        id: option.id,
        label: option.label,
        href: option.href,
        disabled: option.disabled,
        tone: option.tone,
        restoreFocusOnClose: option.restoreFocusOnClose,
        separatorBefore: option.separatorBefore,
      }))
    ).toEqual(
      rowMenu.map((option) => ({
        id: option.id,
        label: option.label,
        href: option.href,
        disabled: option.disabled,
        tone: option.tone,
        restoreFocusOnClose: option.restoreFocusOnClose,
        separatorBefore: option.separatorBefore,
      }))
    );
    expect(headerMenu.map((option) => option.id)).toEqual([
      "open-source",
      "retry-processing",
      "chat-about-media",
      "manage-media-libraries",
      "delete-media",
    ]);
    expect(headerMenu.at(-1)).toMatchObject({
      id: "delete-media",
      label: "Delete document",
      tone: "danger",
      separatorBefore: true,
    });
  });

  it("only exposes actions the surface can actually execute", () => {
    const options = mediaResourceOptions({
      media,
      canManageLibraries: false,
      retryBusy: true,
      deleteBusy: true,
      onRetry: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "open-source",
      "retry-processing",
      "delete-media",
    ]);
    expect(options[1]).toMatchObject({
      id: "retry-processing",
      label: "Retrying...",
      disabled: true,
    });
    expect(options[2]).toMatchObject({
      id: "delete-media",
      disabled: true,
      separatorBefore: true,
    });
  });

  it("shows source refresh only when supported and wired by the surface", () => {
    const options = mediaResourceOptions({
      media: {
        ...media,
        capabilities: { can_refresh_source: true },
      },
      canManageLibraries: false,
      refreshBusy: true,
      onRefreshSource: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "open-source",
      "refresh-source",
    ]);
    expect(options[1]).toMatchObject({
      id: "refresh-source",
      label: "Refreshing...",
      disabled: true,
    });
  });
});

describe("libraryResourceOptions", () => {
  it("orders canonical library actions with destructive work last", () => {
    const options = libraryResourceOptions({
      library: { is_default: false, role: "admin" },
      onOpenChat: () => {},
      onViewIntelligence: () => {},
      onEdit: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "chat-about-library",
      "view-library-intelligence",
      "edit-library",
      "delete-library",
    ]);
    expect(options.at(-1)).toMatchObject({
      id: "delete-library",
      tone: "danger",
      separatorBefore: true,
    });
  });

  it("does not offer edit or delete on the default library", () => {
    const options = libraryResourceOptions({
      library: { is_default: true, role: "admin" },
      onOpenChat: () => {},
      onViewIntelligence: () => {},
      onEdit: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "chat-about-library",
      "view-library-intelligence",
    ]);
  });
});

describe("podcastResourceOptions", () => {
  it("omits podcast management actions when there is no subscription", () => {
    expect(
      podcastResourceOptions({
        canUsePodcastActions: false,
        onManageLibraries: () => {},
        onOpenSettings: () => {},
        onRefreshSync: () => {},
        onUnsubscribe: () => {},
      })
    ).toEqual([]);
  });

  it("keeps subscribed podcast management consistent across surfaces", () => {
    const options = podcastResourceOptions({
      canUsePodcastActions: true,
      refreshBusy: true,
      onManageLibraries: () => {},
      onOpenSettings: () => {},
      onRefreshSync: () => {},
      onUnsubscribe: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "manage-podcast-libraries",
      "open-podcast-settings",
      "refresh-podcast-sync",
      "unsubscribe-podcast",
    ]);
    expect(options[2]).toMatchObject({
      id: "refresh-podcast-sync",
      label: "Refreshing...",
      disabled: true,
    });
    expect(options.at(-1)).toMatchObject({
      id: "unsubscribe-podcast",
      tone: "danger",
      separatorBefore: true,
    });
  });
});

describe("episodeResourceOptions", () => {
  it("uses media actions plus the episode playback state action", () => {
    const options = episodeResourceOptions({
      media: {
        id: "episode-1",
        title: "Episode 1",
        canonical_source_url: "https://example.com/episode",
        capabilities: { can_delete: true, can_retry: true },
      },
      busy: true,
      retryBusy: true,
      deleteBusy: true,
      played: false,
      markingBusy: true,
      onManageLibraries: () => {},
      onOpenChat: () => {},
      onRetry: () => {},
      onDelete: () => {},
      onTogglePlayed: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "open-source",
      "retry-processing",
      "chat-about-media",
      "manage-media-libraries",
      "toggle-episode-played",
      "delete-media",
    ]);
    expect(options[1]).toMatchObject({
      id: "retry-processing",
      disabled: true,
    });
    expect(options[3]).toMatchObject({
      id: "manage-media-libraries",
      disabled: true,
    });
    expect(options[4]).toMatchObject({
      id: "toggle-episode-played",
      label: "Mark as played",
      disabled: true,
    });
    expect(options[5]).toMatchObject({
      id: "delete-media",
      disabled: true,
      tone: "danger",
      separatorBefore: true,
    });
  });
});

describe("conversationResourceOptions", () => {
  it("uses one destructive conversation action everywhere", () => {
    expect(
      conversationResourceOptions({
        deleting: true,
        onDelete: () => {},
      })
    ).toEqual([
      expect.objectContaining({
        id: "delete-conversation",
        label: "Deleting...",
        tone: "danger",
        disabled: true,
      }),
    ]);
  });
});
