import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRuntime: () => ({ openInNewPane: vi.fn() }),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneTitle: () => {},
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: () => {},
  usePaneMobileChromeController: () => null,
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

vi.mock("@/lib/player/globalPlayer", () => ({
  useGlobalPlayer: () => ({
    addToQueue: vi.fn(async () => []),
    queueItems: [],
  }),
}));

import PodcastDetailPaneBody from "@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PodcastDetailPaneBody android shell billing", () => {
  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
    vi.restoreAllMocks();
  });

  it("keeps the transcript upgrade affordance in the android shell", async () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);
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
              transcript_state: "ready",
              transcript_coverage: "full",
              listening_state: null,
              subscription_default_playback_speed: null,
              episode_state: "unplayed",
              failure_stage: null,
              last_error_code: null,
              playback_source: null,
              capabilities: {
                can_read: true,
                can_highlight: true,
                can_quote: true,
                can_search: true,
                can_play: true,
                can_download_file: false,
              },
              authors: [],
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
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastDetailPaneBody />);

    expect(
      await screen.findByText(
        "Transcription is included with AI Plus and AI Pro."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Transcription requests require AI Plus or AI Pro. Plan changes are not available in this Android app."
      )
    ).not.toBeInTheDocument();
  });
});
