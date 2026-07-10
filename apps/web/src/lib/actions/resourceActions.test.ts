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

  it("exposes Add to Lectern only when onAddToLectern is wired", () => {
    const withoutHandler = mediaResourceOptions({ media, canManageLibraries: false });
    expect(withoutHandler.some((option) => option.id === "add-to-lectern")).toBe(false);

    const withHandler = mediaResourceOptions({
      media,
      canManageLibraries: false,
      onAddToLectern: () => {},
    });
    expect(withHandler.map((option) => option.id)).toContain("add-to-lectern");
    expect(withHandler.find((option) => option.id === "add-to-lectern")).toMatchObject({
      label: "Add to Lectern",
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

  it("shows metadata re-enrichment between source refresh and chat when supported", () => {
    const options = mediaResourceOptions({
      media: {
        ...media,
        capabilities: { can_refresh_source: true, can_retry_metadata: true },
      },
      canManageLibraries: false,
      refreshBusy: false,
      retryMetadataBusy: true,
      onRefreshSource: () => {},
      onRetryMetadata: () => {},
      onOpenChat: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "open-source",
      "refresh-source",
      "re-enrich-metadata",
      "chat-about-media",
    ]);
    expect(options[2]).toMatchObject({
      id: "re-enrich-metadata",
      label: "Re-enriching...",
      disabled: true,
    });
  });

  it("ignores non-boolean capability values", () => {
    const options = mediaResourceOptions({
      media: {
        ...media,
        capabilities: {
          can_delete: "true",
          can_retry: 1,
          can_refresh_source: true,
        },
      },
      canManageLibraries: false,
      onDelete: () => {},
      onRetry: () => {},
      onRefreshSource: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "open-source",
      "refresh-source",
    ]);
  });
});

describe("libraryResourceOptions", () => {
  it("orders canonical library actions with destructive work last", () => {
    const options = libraryResourceOptions({
      library: {
        is_default: false,
        role: "admin",
        can_rename: true,
        can_delete: true,
        can_edit_entries: true,
      },
      onEdit: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "edit-library",
      "delete-library",
    ]);
    expect(options.at(-1)).toMatchObject({
      id: "delete-library",
      tone: "danger",
      separatorBefore: true,
    });
  });

  it("offers no menu actions on the default library", () => {
    // The default library cannot be renamed or deleted (its media entries are
    // still editable); the dossier is now inline, not a menu action.
    const options = libraryResourceOptions({
      library: {
        is_default: true,
        role: "admin",
        can_rename: false,
        can_delete: false,
        can_edit_entries: true,
      },
      onEdit: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([]);
  });

  it("offers no mutation actions on a system-protected library", () => {
    // A system library (e.g. the Oracle Corpus) reports every can_* flag false,
    // so no edit/delete action is offered even to an admin owner.
    const options = libraryResourceOptions({
      library: {
        is_default: false,
        role: "admin",
        can_rename: false,
        can_delete: false,
        can_edit_entries: false,
      },
      onEdit: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([]);
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

  it("exposes Add to Lectern when onAddToLectern is wired (AC-13)", () => {
    const options = episodeResourceOptions({
      media: {
        id: "episode-2",
        title: "Episode 2",
        canonical_source_url: "https://example.com/episode-2",
        capabilities: {},
      },
      played: false,
      onManageLibraries: () => {},
      onTogglePlayed: () => {},
      onAddToLectern: () => {},
    });
    expect(options.map((option) => option.id)).toContain("add-to-lectern");
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

  it("adds the distill action when onDistill is provided", () => {
    const options = conversationResourceOptions({
      onDistill: () => {},
      distilling: false,
      onDelete: () => {},
    });
    expect(options[0]).toMatchObject({
      id: "distill-conversation",
      label: "Distill",
      disabled: false,
    });
    expect(options[1]).toMatchObject({ id: "delete-conversation" });
  });

  it("shows the distilling label and disables the action while distilling", () => {
    const [distill] = conversationResourceOptions({
      onDistill: () => {},
      distilling: true,
      onDelete: () => {},
    });
    expect(distill).toMatchObject({
      id: "distill-conversation",
      label: "Distilling...",
      disabled: true,
    });
  });
});
