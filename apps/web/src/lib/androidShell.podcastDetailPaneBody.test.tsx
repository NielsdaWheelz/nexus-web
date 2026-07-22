import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRuntime: () => ({ openInNewPane: vi.fn() }),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneLabel: () => {},
}));

vi.mock("@/components/workspace/PanePrimaryChrome", () => ({
  usePanePrimaryChrome: () => {},
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => ({
    account: {
      billing_enabled: true,
      billing_plan_tier: "plus",
      billing_status: "active",
      subscription_current_period_start: "2026-03-01T00:00:00Z",
      subscription_current_period_end: "2026-04-01T00:00:00Z",
      cancel_at_period_end: false,
      can_manage_billing: true,
      entitlement_plan_tier: "plus",
      entitlement_source: "subscription",
      entitlement_expires_at: null,
      can_share: true,
      can_use_platform_llm: false,
      can_transcribe: false,
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 0,
        remaining: 0,
        period_start: "2026-03-01T00:00:00Z",
        period_end: "2026-04-01T00:00:00Z",
      },
    },
  }),
}));

import PodcastDetailPaneBody from "@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";

// The pane reads useLectern()/useGlobalPlayer(); mount the real providers and
// answer their initial GET /api/lectern at the fetch boundary below.
function Wrapped() {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <PodcastDetailPaneBody />
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PodcastDetailPaneBody transcript billing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps transcript requests unavailable when transcription is locked", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/podcast-1") {
        return jsonResponse({
          data: {
            podcast: {
              id: "podcast-1",
              provider: "podcast_index",
              provider_podcast_id: "provider-1",
              title: "Systems Podcast",
              author: "Systems Team",
              feed_url: "https://feeds.example.com/systems.xml",
              website_url: null,
              image_url: null,
              description: "Systems thinking show",
              created_at: "2026-03-06T00:00:00Z",
              updated_at: "2026-03-06T00:00:00Z",
            },
            subscription: null,
          },
        });
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({
          data: [
            {
              id: "media-0",
              kind: "podcast_episode",
              title: "Episode 0",
              canonical_source_url: "https://feeds.example.com/systems.xml",
              processing_status: "ready_for_reading",
              transcript_state: "not_requested",
              transcript_coverage: "none",
              listening_state: null,
              subscription_default_playback_speed: null,
              episode_state: "unplayed",
              failure_stage: null,
              last_error_code: null,
              playback_source: null,
              playerDescriptor: { kind: "Absent" },
              capabilities: {
                can_read: true,
                can_highlight: true,
                can_quote: true,
                can_search: true,
                can_play: true,
                can_download_file: false,
              },
              contributors: [],
              published_date: null,
              publisher: null,
              language: null,
              description: null,
              description_html: null,
              description_text: null,
              created_at: "2026-03-06T00:00:00Z",
              updated_at: "2026-03-06T00:00:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    await screen.findByRole("link", { name: "Episode 0" });
    await user.click(
      screen.getByRole("button", { name: "More actions for Episode 0" })
    );
    expect(
      screen.queryByRole("menuitem", { name: "Request transcript..." })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Transcription requests require AI Plus or AI Pro. Plan changes are not available in this Android app."
      )
    ).not.toBeInTheDocument();
  });
});
