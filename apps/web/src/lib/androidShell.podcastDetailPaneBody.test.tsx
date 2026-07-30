import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const PODCAST_ID = "11111111-1111-4111-8111-111111111111";
const EPISODE_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/panes/paneRuntime", () => ({
  definePaneVisitDataKey: (diagnosticName: string) => ({ diagnosticName }),
  usePaneVisitData: () => null,
  useClearAllPaneVisitData: () => () => {},
  usePaneReturnReady: () => {},
  usePaneReturnDescendantReady: () => {},
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRuntime: () => ({ activateTarget: vi.fn() }),
  requirePaneRuntime: (runtime: unknown) => runtime,
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
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";

// The pane reads the Lectern/player providers; mount the real providers and
// answer their initial GET /api/lectern at the fetch boundary below.
function Wrapped() {
  return withRenderEnvironment(
    <FeedbackProvider>
      <ShareControllerProvider>
        <LecternProvider>
          <GlobalPlayerProvider>
            <LibraryPlacementControllerProvider>
              <PodcastDetailPaneBody />
            </LibraryPlacementControllerProvider>
          </GlobalPlayerProvider>
        </LecternProvider>
      </ShareControllerProvider>
    </FeedbackProvider>,
    { androidShell: true },
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
      paramName === "podcastId" ? PODCAST_ID : null
    );

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === `/api/podcasts/${PODCAST_ID}`) {
        return jsonResponse({
          data: {
            podcast: {
              id: PODCAST_ID,
              provider: "podcast_index",
              provider_podcast_id: "provider-1",
              title: "Systems Podcast",
              contributors: [],
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
      if (url.pathname === `/api/podcasts/${PODCAST_ID}/episodes`) {
        return jsonResponse({
          data: {
            items: [{
              id: EPISODE_ID,
              kind: "podcast_episode",
              title: "Episode 0",
              canonical_source_url: {
                kind: "Present",
                value: "https://feeds.example.com/systems.xml",
              },
              offline_download_eligible: true,
              processing_status: "ready_for_reading",
              transcript_state: "not_requested",
              transcript_coverage: "none",
              listening_state: { kind: "Absent" },
              episode_state: "unplayed",
              progress_resettable: false,
              playerDescriptor: { kind: "Absent" },
              capabilities: {
                can_retry: false,
                can_refresh_source: false,
                can_retry_metadata: false,
                can_edit_authors: false,
                can_delete: false,
              },
              contributors: [],
              author_mode: "automatic",
              published_date: { kind: "Absent" },
              duration_seconds: { kind: "Absent" },
              has_show_notes: false,
            }],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
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
