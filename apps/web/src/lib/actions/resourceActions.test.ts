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
      onOpenChat: () => {},
      onShare: () => {},
      onRetry: () => {},
      onDelete: () => {},
    });

    const rowMenu = mediaResourceOptions({
      media,
      onOpenChat: () => {},
      onShare: () => {},
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
      "share",
      "open-source",
      "retry-processing",
      "chat-about-media",
      "delete-media",
    ]);
    expect(headerMenu[1]).toMatchObject({
      kind: "link",
      id: "open-source",
      href: "https://example.com/source",
    });
    expect(
      headerMenu
        .filter((option) => option.id !== "open-source")
        .every((option) => option.kind === "command"),
    ).toBe(true);
    expect(headerMenu.at(-1)).toMatchObject({
      kind: "command",
      id: "delete-media",
      label: "Remove media",
      tone: "danger",
      separatorBefore: true,
    });
  });

  it("exposes Add to Lectern only when onAddToLectern is wired", () => {
    const withoutHandler = mediaResourceOptions({ media });
    expect(withoutHandler.some((option) => option.id === "add-to-lectern")).toBe(false);

    const withHandler = mediaResourceOptions({
      media,
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
        isDefault: false,
        role: "admin",
        canRename: true,
        canDelete: true,
        canEditEntries: true,
      },
      onOpenSettings: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "library-settings",
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
        isDefault: true,
        role: "admin",
        canRename: false,
        canDelete: false,
        canEditEntries: true,
      },
      onOpenSettings: () => {},
      onDelete: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([]);
  });

  it("offers no mutation actions on a system-protected library", () => {
    // A system library (e.g. the Oracle Corpus) reports every can_* flag false,
    // so no edit/delete action is offered even to an admin owner.
    const options = libraryResourceOptions({
      library: {
        isDefault: false,
        role: "admin",
        canRename: false,
        canDelete: false,
        canEditEntries: false,
      },
      onOpenSettings: () => {},
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
        onShare: () => {},
        onOpenSettings: () => {},
        onRefreshSync: () => {},
        onUnsubscribe: () => {},
      })
    ).toEqual([
      expect.objectContaining({ id: "share", label: "Share…" }),
    ]);
  });

  it("keeps subscribed podcast management consistent across surfaces", () => {
    const options = podcastResourceOptions({
      canUsePodcastActions: true,
      refreshBusy: true,
      onShare: () => {},
      onOpenSettings: () => {},
      onRefreshSync: () => {},
      onUnsubscribe: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "share",
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
      episodePanelId: "episode-panel-episode-1",
      onShare: () => {},
      onOpenChat: () => {},
      onRetry: () => {},
      onDelete: () => {},
      onTogglePlayed: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "share",
      "open-source",
      "retry-processing",
      "chat-about-media",
      "toggle-episode-played",
      "delete-media",
    ]);
    expect(options[2]).toMatchObject({
      id: "retry-processing",
      disabled: true,
    });
    expect(options[0]).toMatchObject({
      id: "share",
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
      episodePanelId: "episode-panel-episode-2",
      onShare: () => {},
      onTogglePlayed: () => {},
      onAddToLectern: () => {},
    });
    expect(options.map((option) => option.id)).toContain("add-to-lectern");
  });

  it("keeps episode notes, queue, and transcript commands in the row menu", () => {
    const options = episodeResourceOptions({
      media: {
        id: "episode-3",
        title: "Episode 3",
        canonical_source_url: null,
        capabilities: {},
      },
      played: false,
      episodePanelId: "episode-panel-episode-3",
      showNotesExpanded: true,
      transcriptPanelExpanded: true,
      onShare: () => {},
      onTogglePlayed: () => {},
      onToggleShowNotes: () => {},
      onPlayNext: () => {},
      onRequestTranscript: () => {},
    });

    expect(options.map((option) => option.id)).toEqual([
      "share",
      "toggle-episode-notes",
      "play-episode-next",
      "request-episode-transcript",
      "toggle-episode-played",
    ]);
    expect(options[1]).toMatchObject({
      state: {
        kind: "disclosure",
        expanded: true,
        controls: "episode-panel-episode-3",
      },
    });
    expect(options[3]).toMatchObject({
      state: {
        kind: "disclosure",
        expanded: true,
        controls: "episode-panel-episode-3",
      },
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
