import { afterEach, describe, expect, it, vi } from "vitest";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

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
vi.mock("@/components/chat/Conversation", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/browse/BrowsePaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/podcasts/PodcastsPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/search/SearchPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/authors/[handle]/AuthorPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/notes/NotesPaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/pages/[pageId]/PagePaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/notes/[blockId]/NotePaneBody", () => ({
  default: () => null,
}));
vi.mock("@/app/(authenticated)/daily/DailyNotePaneBody", () => ({
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
vi.mock("@/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody", () => ({
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

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

describe("pane route registry android shell chrome", () => {
  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
  });

  it("keeps billing normal and marks local vault as restricted", () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);

    expect(
      resolvePaneRoute("/settings/billing").definition?.getChrome?.({
        href: "/settings/billing",
        params: {},
      })
    ).toMatchObject({
      title: "Billing",
      subtitle: "Plan, usage, and Stripe subscription management.",
    });
    expect(
      resolvePaneRoute("/settings/local-vault").definition?.getChrome?.({
        href: "/settings/local-vault",
        params: {},
      })
    ).toMatchObject({
      title: "Local Vault",
      subtitle:
        "Not available in the Android app. Use a supported desktop browser for Local Vault.",
    });
  });
});
