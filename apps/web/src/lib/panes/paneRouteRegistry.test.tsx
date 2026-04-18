import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(authenticated)/libraries/LibrariesPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/libraries/[id]/LibraryPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/media/[id]/MediaPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/conversations/ConversationsPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/conversations/[id]/ConversationPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/conversations/new/ConversationNewPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/discover/DiscoverPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/documents/DocumentsPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/podcasts/PodcastsPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/videos/VideosPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/search/SearchPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/SettingsPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/billing/SettingsBillingPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/reader/SettingsReaderPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/keys/SettingsKeysPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/settings/keybindings/KeybindingsPaneBody", () => ({
  default: () => null,
}));

import { resolvePaneRoute } from "./paneRouteRegistry";

describe("pane route registry", () => {
  it("resolves typed route params", () => {
    const route = resolvePaneRoute("/media/abc-123");
    expect(route.id).toBe("media");
    expect(route.params.id).toBe("abc-123");
    expect(route.render).toBeTypeOf("function");
    expect(route.staticTitle).toBe("Media");
    expect(route.resourceRef).toBe("media:abc-123");
  });

  it("resolves /conversations/new before :id capture", () => {
    const route = resolvePaneRoute("/conversations/new");
    expect(route.id).toBe("conversationNew");
    expect(route.render).toBeTypeOf("function");
  });

  it("still resolves /conversations/:id for real IDs", () => {
    const route = resolvePaneRoute("/conversations/abc-123");
    expect(route.id).toBe("conversation");
    expect(route.params.id).toBe("abc-123");
    expect(route.staticTitle).toBe("Chat");
    expect(route.resourceRef).toBe("conversation:abc-123");
  });

  it("keeps chat-detail route as a single pane surface", () => {
    const route = resolvePaneRoute("/conversations/abc-123");
    expect(route.id).toBe("conversation");
    expect(route.definition?.bodyMode).toBe("standard");
    expect(route.definition?.defaultWidthPx).toBe(560);
    expect(route.definition?.getChrome).toBeTypeOf("function");
  });

  it("keeps podcast-detail route as a wide document surface", () => {
    const route = resolvePaneRoute("/podcasts/pod-123");
    expect(route.id).toBe("podcastDetail");
    expect(route.params.podcastId).toBe("pod-123");
    expect(route.staticTitle).toBe("Podcast");
    expect(route.resourceRef).toBe("podcast:pod-123");
    expect(route.definition?.bodyMode).toBe("document");
    expect(route.definition?.defaultWidthPx).toBe(960);
    expect(route.definition?.minWidthPx).toBe(760);
    expect(route.definition?.maxWidthPx).toBe(1400);
    expect(route.definition?.getChrome).toBeTypeOf("function");
  });

  it("rejects the removed discover podcasts surface", () => {
    const route = resolvePaneRoute("/discover/podcasts");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
    expect(route.staticTitle).toBe("Tab");
    expect(route.resourceRef).toBeNull();
  });

  it("resolves /conversations/new with query params", () => {
    const route = resolvePaneRoute("/conversations/new?attach_type=highlight&attach_id=abc");
    expect(route.id).toBe("conversationNew");
  });

  it("returns unsupported when route is not registered", () => {
    const route = resolvePaneRoute("/not-supported");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
    expect(route.staticTitle).toBe("Tab");
    expect(route.resourceRef).toBeNull();
  });

  it("rejects the removed /podcasts/subscriptions route", () => {
    const route = resolvePaneRoute("/podcasts/subscriptions");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
    expect(route.staticTitle).toBe("Tab");
    expect(route.resourceRef).toBeNull();
  });

  it("treats malformed encoded params as unsupported", () => {
    const route = resolvePaneRoute("/media/%E0%A4%A");
    expect(route.id).toBe("unsupported");
    expect(route.render).toBeNull();
    expect(route.staticTitle).toBe("Tab");
  });

  it("resolves expanded authenticated static routes", () => {
    expect(resolvePaneRoute("/libraries").id).toBe("libraries");
    expect(resolvePaneRoute("/discover").id).toBe("discover");
    expect(resolvePaneRoute("/discover/podcasts").id).toBe("unsupported");
    expect(resolvePaneRoute("/documents").id).toBe("documents");
    expect(resolvePaneRoute("/podcasts").id).toBe("podcasts");
    expect(resolvePaneRoute("/videos").id).toBe("videos");
    expect(resolvePaneRoute("/search").id).toBe("search");
    expect(resolvePaneRoute("/settings").id).toBe("settings");
    expect(resolvePaneRoute("/settings/billing").id).toBe("settingsBilling");
    expect(resolvePaneRoute("/settings/reader").id).toBe("settingsReader");
    expect(resolvePaneRoute("/settings/keys").id).toBe("settingsKeys");
    expect(resolvePaneRoute("/settings/local-vault").id).toBe(
      "settingsLocalVault"
    );
    expect(resolvePaneRoute("/settings/identities").id).toBe(
      "settingsIdentities"
    );
  });

  it("describes podcasts as the followed-show management surface", () => {
    const route = resolvePaneRoute("/podcasts");
    expect(route.definition?.getChrome?.({ href: "/podcasts", params: {} })).toMatchObject({
      title: "Podcasts",
      subtitle: "Followed shows, show status, and library membership.",
    });
  });

});
