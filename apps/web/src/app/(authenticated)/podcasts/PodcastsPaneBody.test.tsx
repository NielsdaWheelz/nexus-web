/**
 * PodcastsPaneBody — focused browser tests for the Browse launcher integration (spec §14).
 * Renders the full pane body with stubbed fetch and asserts that the Browse toolbar button
 * dispatches OPEN_LAUNCHER_EVENT with lane:'browse'.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { OPEN_LAUNCHER_EVENT } from "@/lib/launcher/launcherEvents";
import type { OpenLauncherDetail } from "@/lib/launcher/launcherEvents";
import PodcastsPaneBody from "./PodcastsPaneBody";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/subscriptions") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      // connection summaries (not fired with empty rows, but guard for safety)
      if (url.pathname.startsWith("/api/resource-graph/connections")) {
        return jsonResponse({ data: {} });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    }),
  );
}

function renderPodcastsPane() {
  return renderHydratedPane({
    href: "/podcasts",
    resources: {},
    children: <PodcastsPaneBody />,
  });
}

describe("PodcastsPaneBody — Browse launcher integration", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/podcasts");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Browse toolbar button dispatches OPEN_LAUNCHER_EVENT with lane:'browse'", async () => {
    const dispatched: OpenLauncherDetail[] = [];
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<OpenLauncherDetail>).detail);
    };
    window.addEventListener(OPEN_LAUNCHER_EVENT, handler);

    try {
      renderPodcastsPane();

      const browseBtn = await screen.findByRole("button", { name: "Browse" });
      fireEvent.click(browseBtn);

      await waitFor(() => {
        expect(dispatched).toHaveLength(1);
      });
      expect(dispatched[0]).toMatchObject({ lane: "browse" });
    } finally {
      window.removeEventListener(OPEN_LAUNCHER_EVENT, handler);
    }
  });
});
