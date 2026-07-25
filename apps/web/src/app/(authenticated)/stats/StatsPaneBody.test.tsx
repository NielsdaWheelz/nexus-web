import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import StatsPaneBody from "./StatsPaneBody";

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const MEDIA_ID = "00000000-0000-4000-8000-000000000010";

function response(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(status >= 200 && status < 300 ? { data: body } : body),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function stats(
  activeMs = 3_600_000,
  appliedFilters: string[] = ["time"],
): unknown {
  const session = {
    mediaRef: `media:${MEDIA_ID}`,
    title: "The Left Hand of Darkness",
    modality: "Reading",
    device: {
      deviceHandle: "ncd1.AAAAAAAAAAAAAAAAAAAAAA",
      label: "This device",
    },
    startedAt: "2026-07-24T16:00:00.000Z",
    endedAt: "2026-07-24T17:00:00.000Z",
    activeMs,
    forwardWordPosition: 1200,
    forwardMediaPositionMs: 0,
    firstProgress: { kind: "Present", value: 0.1 },
    lastProgress: { kind: "Present", value: 0.2 },
    continuesBeforeRange: false,
    continuesAfterRange: false,
  };
  return {
    activity: {
      appliedFilters,
      inapplicableFilters: [],
      totals: {
        activeMs,
        activeDays: activeMs ? 1 : 0,
        streak: activeMs ? 1 : 0,
        longestStreak: activeMs ? 2 : 0,
        sessionCount: activeMs ? 1 : 0,
        forwardWordPosition: activeMs ? 1200 : 0,
        forwardMediaPositionMs: 0,
      },
      timeline: [
        {
          start: "2026-07-24T07:00:00.000Z",
          end: "2026-07-25T07:00:00.000Z",
          localLabel: "Jul 24",
          utcOffsetMinutes: -420,
          readingActiveMs: activeMs,
          listeningActiveMs: 0,
          viewingActiveMs: 0,
          activeMs,
          forwardWordPosition: activeMs ? 1200 : 0,
          forwardMediaPositionMs: 0,
        },
      ],
      localDays: [{ date: "2026-07-24", activeMs }],
      localHours: [{ hour: 9, activeMs }],
      media: {
        rows: activeMs
          ? [
              {
                mediaRef: `media:${MEDIA_ID}`,
                title: "The Left Hand of Darkness",
                activeMs,
                forwardWordPosition: 1200,
                forwardMediaPositionMs: 0,
              },
            ]
          : [],
        otherActiveMs: 0,
      },
      contributors: {
        rows: activeMs
          ? [
              {
                contributorHandle: "ursula-le-guin",
                displayName: "Ursula K. Le Guin",
                roles: ["Author"],
                activeMs,
                forwardWordPosition: 1200,
                forwardMediaPositionMs: 0,
              },
            ]
          : [],
        otherActiveMs: 0,
        nonAdditive: true,
      },
      devices: activeMs
        ? [
            {
              deviceHandle: "ncd1.AAAAAAAAAAAAAAAAAAAAAA",
              label: "This device",
              firstObservedAt: "2026-01-01T00:00:00.000Z",
              lastObservedAt: "2026-07-24T17:00:00.000Z",
              deviceClasses: ["Desktop"],
              isCurrent: true,
              activeMs,
            },
          ]
        : [],
      sessions: {
        rows: activeMs ? [session] : [],
        nextCursor: activeMs
          ? { kind: "Present", value: "next-page" }
          : { kind: "Absent" },
      },
      longestSession: activeMs
        ? { kind: "Present", value: session }
        : { kind: "Absent" },
    },
    completion: {
      appliedFilters,
      inapplicableFilters: ["device"],
      total: activeMs ? 1 : 0,
      dates: activeMs ? [{ date: "2026-07-24", total: 1 }] : [],
      timeline: activeMs
        ? [
            {
              start: "2026-07-24T07:00:00.000Z",
              end: "2026-07-25T07:00:00.000Z",
              localLabel: "Jul 24",
              total: 1,
            },
          ]
        : [],
      media: activeMs
        ? [
            {
              mediaRef: `media:${MEDIA_ID}`,
              title: "The Left Hand of Darkness",
              total: 1,
            },
          ]
        : [],
      contributors: activeMs
        ? [
            {
              contributorHandle: "ursula-le-guin",
              displayName: "Ursula K. Le Guin",
              roles: ["Author"],
              total: 1,
            },
          ]
        : [],
      byModality: { Reading: activeMs ? 1 : 0, Listening: 0, Viewing: 0 },
    },
    retainedArtifacts: {
      appliedFilters: ["time"],
      inapplicableFilters: ["modality", "media", "contributor", "device"],
      periodWide: true,
      highlights: activeMs ? 2 : 0,
      noteBlocks: activeMs ? 1 : 0,
      neutralLinks: activeMs ? 3 : 0,
    },
  };
}

function StatefulStats({
  href = "/stats?view=stats&period=day&anchor=2026-07-24",
}: {
  href?: string;
}) {
  const [currentHref, setCurrentHref] = useState(href);
  return (
    <>
      <span hidden data-testid="current-stats-href">
        {currentHref}
      </span>
      <PaneReturnMementoProvider>
        <PaneRuntimeProvider
          paneId="stats-pane"
          visitId={VISIT_ID}
          isActive
          href={currentHref}
          routeId="stats"
          routeKey={resolvePaneRouteIdentity(currentHref).routeKey}
          canGoBack={false}
          canGoForward={false}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
          onNavigatePane={vi.fn()}
          onReplacePane={(_id, next) => setCurrentHref(next)}
          onOpenInNewPane={vi.fn()}
          onSetPaneLabel={vi.fn()}
        >
          <StatsPaneBody />
        </PaneRuntimeProvider>
      </PaneReturnMementoProvider>
    </>
  );
}

function installFetch(handler: (url: URL) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(handler(new URL(String(input), "http://localhost"))),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("StatsPaneBody", () => {
  it("canonicalizes invalid URL state before issuing the local-time query", async () => {
    const fetch = vi.fn(() => Promise.resolve(response(stats())));
    vi.stubGlobal("fetch", fetch);
    render(<StatefulStats href="/stats?view=wat&noise=1" />);
    await waitFor(() =>
      expect(screen.getByTestId("current-stats-href")).toHaveTextContent(
        /^\/stats\?view=stats&period=day&anchor=\d{4}-\d{2}-\d{2}$/,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Activity over time" }),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps deterministic chrome while hydration resolves and then renders an aria-hidden stacked chart with source tables", async () => {
    installFetch((url) => {
      expect(url.pathname).toBe("/api/consumption/stats");
      return response(stats());
    });
    render(<StatefulStats />);
    expect(screen.getByLabelText("Loading statistics")).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "Activity over time" }),
    ).toBeVisible();
    const section = screen.getByRole("region", { name: "Activity over time" });
    expect(within(section).getByRole("table")).toBeVisible();
    expect(screen.getByTestId("activity-timeline-chart")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(within(section).getByText("(UTC-07:00)")).toBeVisible();
    expect(screen.getByText("Current streak")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Ending streak")).toBeVisible();
    expect(screen.getAllByText("The Left Hand of Darkness")[0]).toBeVisible();
  });

  it("keeps the prior result and its labels together while a new range loads", async () => {
    let calls = 0;
    let resolveNext: ((value: Response) => void) | undefined;
    installFetch(() => {
      calls += 1;
      if (calls === 1) return response(stats());
      return new Promise<Response>((resolve) => {
        resolveNext = resolve;
      });
    });
    render(<StatefulStats />);
    await screen.findByRole("heading", { name: "Activity over time" });
    await userEvent.selectOptions(screen.getByLabelText("Period"), "week");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Updating Week. Showing the prior Day result until it arrives.",
    );
    resolveNext?.(response(stats()));
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
  });

  it("moves calendar periods without overflowing short months", async () => {
    installFetch(() => response(stats()));
    render(
      <StatefulStats href="/stats?view=stats&period=month&anchor=2026-01-31" />,
    );
    await screen.findByRole("heading", { name: "Activity over time" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(screen.getByTestId("current-stats-href")).toHaveTextContent(
        "anchor=2026-02-01",
      ),
    );
  });

  it("distinguishes ordinary empty from filter-empty", async () => {
    installFetch((url) =>
      response(
        stats(
          0,
          url.searchParams.has("mediaRef") ? ["time", "media"] : ["time"],
        ),
        200,
      ),
    );
    const { unmount } = render(<StatefulStats />);
    expect(
      await screen.findByRole("heading", { name: "No observed activity yet" }),
    ).toBeVisible();
    unmount();
    render(
      <StatefulStats
        href={`/stats?view=stats&period=day&anchor=2026-07-24&media=media%3A${MEDIA_ID}`}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        name: "No activity matches this view",
      }),
    ).toBeVisible();
  });

  it("keeps completion and retained facts visible when activity alone is empty", async () => {
    const payload = stats(0) as {
      completion: {
        total: number;
        media: unknown[];
        contributors: unknown[];
        dates: unknown[];
        timeline: unknown[];
        byModality: { Reading: number };
      };
      retainedArtifacts: {
        highlights: number;
        noteBlocks: number;
        neutralLinks: number;
      };
    };
    payload.completion.total = 1;
    payload.completion.media = [
      {
        mediaRef: `media:${MEDIA_ID}`,
        title: "The Left Hand of Darkness",
        total: 1,
      },
    ];
    payload.completion.contributors = [
      {
        contributorHandle: "ursula-le-guin",
        displayName: "Ursula K. Le Guin",
        roles: ["Author"],
        total: 1,
      },
    ];
    payload.completion.dates = [{ date: "2026-07-24", total: 1 }];
    payload.completion.timeline = [
      {
        start: "2026-07-24T07:00:00.000Z",
        end: "2026-07-25T07:00:00.000Z",
        localLabel: "Jul 24",
        total: 1,
      },
    ];
    payload.completion.byModality.Reading = 1;
    payload.retainedArtifacts.highlights = 2;
    installFetch(() => response(payload));
    render(<StatefulStats />);
    expect(
      await screen.findByRole("heading", { name: "No observed activity yet" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Completions" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Created and kept" }),
    ).toBeVisible();
  });

  it("renders any selected annual year from the deterministic Stats contract", async () => {
    const queries: URL[] = [];
    installFetch((url) => {
      queries.push(url);
      return response(stats());
    });
    render(<StatefulStats href="/stats?view=year&year=2026" />);

    expect(
      await screen.findByRole("heading", { name: "2026" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Year")).toHaveValue(2026);
    expect(
      screen.getByRole("region", { name: "Modality composition" }),
    ).toContainElement(
      screen.getByRole("row", { name: /Reading 1h/ }),
    );
    expect(
      screen.getByRole("region", { name: "Longest session" }),
    ).toHaveTextContent("The Left Hand of Darkness");
    expect(
      screen.getByRole("region", { name: "Top works" }),
    ).toHaveTextContent("The Left Hand of Darkness");
    expect(
      screen.getByRole("region", { name: "Contributors" }),
    ).toHaveTextContent("Ursula K. Le Guin");
    expect(
      screen.getByRole("region", { name: "Created and kept" }),
    ).toHaveTextContent("Highlights");
    expect(
      queries.some(
        (url) =>
          url.searchParams.get("bucket") === "Month" &&
          url.searchParams.get("start")?.startsWith("2026-01-01") === true &&
          url.searchParams.get("end")?.startsWith("2027-01-01") === true,
      ),
    ).toBe(true);
  });

  it("renders an empty selected annual year as the ordinary loaded-empty state", async () => {
    installFetch(() => response(stats(0)));
    render(<StatefulStats href="/stats?view=year&year=1970" />);

    expect(
      await screen.findByRole("heading", { name: "No observed activity yet" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Year")).toHaveValue(1970);
    expect(
      screen.getByRole("heading", { name: "Year in Reading" }),
    ).toBeVisible();
  });

  it("shows a recoverable error and retries the same pane query", async () => {
    let calls = 0;
    installFetch(() => {
      calls += 1;
      return calls < 4
        ? response({ error: { code: "E_TEST", message: "temporary" } }, 500)
        : response(stats());
    });
    render(<StatefulStats />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      (await screen.findAllByText("The Left Hand of Darkness"))[0],
    ).toBeVisible();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("filters from safe breakdown rows without rendering raw handles and appends the next session page", async () => {
    const statsQueries: URL[] = [];
    installFetch((url) => {
      if (url.pathname === "/api/consumption/sessions")
        return response({
          sessions: [
            {
              ...((stats() as { activity: { sessions: { rows: unknown[] } } })
                .activity.sessions.rows[0] as object),
              startedAt: "2026-07-24T18:00:00.000Z",
            },
          ],
          nextCursor: { kind: "Absent" },
        });
      statsQueries.push(url);
      return response(stats());
    });
    render(<StatefulStats />);
    await screen.findAllByText("The Left Hand of Darkness");
    expect(
      screen.queryByDisplayValue(`media:${MEDIA_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("ncd1.AAAAAAAAAAAAAAAAAAAAAA"),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Filter work: The Left Hand of Darkness",
      }),
    );
    await waitFor(() =>
      expect(
        statsQueries.some(
          (url) => url.searchParams.get("mediaRef") === `media:${MEDIA_ID}`,
        ),
      ).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Clear media filter" }),
    ).toBeVisible();
    await userEvent.click(
      await screen.findByRole("button", { name: "Load more sessions" }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "The Left Hand of Darkness" }),
      ).toHaveLength(4),
    );
  });
});
