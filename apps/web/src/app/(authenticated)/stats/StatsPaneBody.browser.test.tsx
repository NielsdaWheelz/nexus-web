import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { publishConsumptionProjectionChange } from "@/lib/consumption/projectionRevision";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import StatsPaneBody from "./StatsPaneBody";

const HREF = "/stats?view=stats&period=day&anchor=2026-08-10";
const NEXT_HREF = "/stats?view=stats&period=day&anchor=2026-08-11";
const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

const DEVICE_HANDLE = "ncd1.AAAAAAAAAAAAAAAAAAAAAA";
const EXCLUSION_HANDLE = "nce1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

function observedSession(
  title: string,
  day: "10" | "11",
  continuesBeyondRange = false,
  mediaId = "00000000-0000-4000-8000-000000000002",
): unknown {
  return {
    mediaRef: `media:${mediaId}`,
    title,
    modality: "Reading",
    device: { deviceHandle: DEVICE_HANDLE, label: "Desktop" },
    startedAt: `2026-08-${day}T16:00:00.000Z`,
    endedAt: `2026-08-${day}T16:01:00.000Z`,
    activeMs: 60_000,
    forwardWordPosition: 120,
    forwardMediaPositionMs: 0,
    firstProgress: { kind: "Present", value: 0.1 },
    lastProgress: { kind: "Present", value: 0.2 },
    continuesBeforeRange: continuesBeyondRange,
    continuesAfterRange: false,
  };
}

interface StatsFixtureOptions {
  readonly title?: string;
  readonly day?: "10" | "11";
  readonly nextCursor?: string;
}

function stats(
  activeMs: number,
  correction: "None" | "Observed" | "Excluded" = "None",
  continuesBeyondRange = false,
  options: StatsFixtureOptions = {},
): unknown {
  const recordedActiveMs = correction === "Excluded" ? 60_000 : activeMs;
  return {
    data: {
      activity: {
        appliedFilters: ["time"],
        inapplicableFilters: [],
        totals: {
          activeMs,
          recordedActiveMs,
          excludedActiveMs: correction === "Excluded" ? 60_000 : 0,
          forwardWordPosition: 0,
          forwardMediaPositionMs: 0,
          activeDays: activeMs === 0 ? 0 : 1,
          streak: activeMs === 0 ? 0 : 1,
          longestStreak: activeMs === 0 ? 0 : 1,
          sessionCount: activeMs === 0 ? 0 : 1,
        },
        timeline: [],
        localDays: [],
        localHours: [],
        media: { rows: [], otherActiveMs: 0 },
        contributors: { rows: [], otherActiveMs: 0, nonAdditive: true },
        devices: [],
        sessions: {
          rows:
            correction === "Observed"
              ? [
                  observedSession(
                    options.title ?? "A Book",
                    options.day ?? "10",
                    continuesBeyondRange,
                  ),
                ]
              : [],
          nextCursor: options.nextCursor
            ? { kind: "Present", value: options.nextCursor }
            : { kind: "Absent" },
        },
        longestSession: { kind: "Absent" },
        activeExclusions:
          correction === "Excluded"
            ? [
                {
                  exclusionHandle: EXCLUSION_HANDLE,
                  mediaRef: "media:00000000-0000-4000-8000-000000000002",
                  title: "A Book",
                  modality: "Reading",
                  device: { deviceHandle: DEVICE_HANDLE, label: "Desktop" },
                  startedAt: "2026-08-10T16:00:00.000Z",
                  endedAt: "2026-08-10T16:01:00.000Z",
                  excludedActiveMs: 60_000,
                },
              ]
            : [],
      },
      completion: {
        appliedFilters: ["time"],
        inapplicableFilters: [],
        total: 0,
        dates: [],
        timeline: [],
        media: [],
        contributors: [],
        byModality: { Reading: 0, Listening: 0, Viewing: 0 },
      },
      retainedArtifacts: {
        appliedFilters: ["time"],
        inapplicableFilters: [],
        periodWide: true,
        highlights: 0,
        noteBlocks: 0,
        neutralLinks: 0,
      },
    },
  };
}

function sessionPage(title: string, day: "10" | "11" = "10"): Response {
  return Response.json({
    data: {
      sessions: [
        observedSession(
          title,
          day,
          false,
          "00000000-0000-4000-8000-000000000003",
        ),
      ],
      nextCursor: { kind: "Absent" },
    },
  });
}

function response(activeMs: number): Response {
  return new Response(JSON.stringify(stats(activeMs)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function StatsPane({ href = HREF }: { href?: string }) {
  return (
    <FeedbackProvider>
      <PaneReturnMementoProvider>
        <PaneRuntimeProvider
          paneId="stats-pane"
          visitId={VISIT_ID}
          isActive
          href={href}
          routeId="stats"
          routeKey={resolvePaneRouteIdentity(href).routeKey}
          canGoBack={false}
          canGoForward={false}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onActivateWorkspaceTarget={() => ({
            kind: "Unchanged",
            paneId: "stats-pane",
          })}
          onSetPaneLabel={vi.fn()}
        >
          <StatsPaneBody />
        </PaneRuntimeProvider>
      </PaneReturnMementoProvider>
    </FeedbackProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Stats activity freshness", () => {
  it("discards a pending session page when a different Stats view commits", async () => {
    let resolveOldPage: (response: Response) => void = () => {
      throw new Error("Old session page did not start");
    };
    let oldPageSettled = false;
    const oldPage = new Promise<Response>((resolve) => {
      resolveOldPage = resolve;
    }).then((response) => {
      oldPageSettled = true;
      return response;
    });
    let statsReads = 0;
    let oldPageStarted = false;
    const oldPageRequest: { signal: AbortSignal | null } = { signal: null };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/api/consumption/sessions?")) {
          oldPageStarted = true;
          oldPageRequest.signal = init?.signal ?? null;
          return oldPage;
        }
        statsReads += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              stats(60_000, "Observed", false, {
                title:
                  statsReads === 1
                    ? "Old current session"
                    : "New current session",
                day: statsReads === 1 ? "10" : "11",
                nextCursor: statsReads === 1 ? "old-page" : undefined,
              }),
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const view = render(<StatsPane />);

    const loadMore = await screen.findByRole("button", {
      name: "Load more sessions",
    });
    act(() => loadMore.click());
    await waitFor(() => expect(oldPageStarted).toBe(true));

    view.rerender(<StatsPane href={NEXT_HREF} />);
    expect(await screen.findByText("New current session")).toBeVisible();
    expect(screen.queryByText("Old current session")).not.toBeInTheDocument();
    expect(oldPageRequest.signal?.aborted).toBe(true);

    resolveOldPage(sessionPage("Stale continuation"));
    await waitFor(() => expect(oldPageSettled).toBe(true));
    await act(async () => undefined);

    expect(screen.queryByText("Stale continuation")).not.toBeInTheDocument();
  });

  it("preserves session rows and offers Retry when pagination fails", async () => {
    let sessionReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.includes("/api/consumption/sessions?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                stats(60_000, "Observed", false, {
                  nextCursor: "next-page",
                }),
              ),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        sessionReads += 1;
        return Promise.resolve(
          sessionReads === 1
            ? Response.json(
                {
                  error: {
                    code: "E_UPSTREAM",
                    message: "temporarily unavailable",
                  },
                },
                { status: 503 },
              )
            : sessionPage("Recovered session"),
        );
      }),
    );
    render(<StatsPane />);

    const loadMore = await screen.findByRole("button", {
      name: "Load more sessions",
    });
    act(() => loadMore.click());

    expect(await screen.findByText("Sessions couldn’t load")).toBeVisible();
    expect(screen.getByText("A Book")).toBeVisible();
    const retry = screen.getByRole("button", {
      name: "Retry loading sessions",
    });
    act(() => retry.click());

    expect(await screen.findByText("Recovered session")).toBeVisible();
    expect(
      screen.queryByText("Sessions couldn’t load"),
    ).not.toBeInTheDocument();
  });

  it("revalidates a mounted pane after local acceptance and foreground recovery", async () => {
    let read = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(response([0, 60_000, 120_000][read++] ?? 120_000)),
      ),
    );
    render(<StatsPane />);

    expect(
      await screen.findByRole("heading", { name: "No observed activity yet" }),
    ).toBeVisible();

    act(() => publishConsumptionProjectionChange());
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Activity summary" }),
      ).toHaveTextContent("1 min"),
    );

    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Activity summary" }),
      ).toHaveTextContent("2 min"),
    );
    expect(
      screen.getByRole("region", { name: "Activity summary" }),
    ).toHaveTextContent("Observed time");
    expect(screen.queryByText(/added/i)).not.toBeInTheDocument();
  });

  it("excludes an observed session and restores that exact correction", async () => {
    let currentProjection = stats(60_000, "Observed");
    const posted: unknown[] = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    let releaseExclude: () => void = () => {
      throw new Error("Exclude request did not start");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const method = init?.method ?? request?.method ?? "GET";
        if (method === "POST") {
          posted.push(
            request
              ? await request.clone().json()
              : JSON.parse(String(init?.body)),
          );
          currentProjection =
            posted.length === 1
              ? stats(0, "Excluded")
              : stats(60_000, "Observed");
          if (posted.length === 1) {
            await new Promise<void>((resolve) => {
              releaseExclude = resolve;
            });
          }
          return new Response(
            JSON.stringify({
              data: {
                outcome: posted.length === 1 ? "Excluded" : "Restored",
                exclusionHandle: EXCLUSION_HANDLE,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(currentProjection), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const user = userEvent.setup();
    render(<StatsPane />);

    const sessionActions = await screen.findByRole("button", {
      name: /Actions for A Book, Reading/,
    });
    sessionActions.focus();
    await user.keyboard("{Enter}");
    const exclude = await screen.findByRole("menuitem", {
      name: "Don’t count this session",
    });
    await waitFor(() => expect(exclude).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toHaveLength(1));
    await waitFor(() => expect(sessionActions).toHaveFocus());
    releaseExclude();
    expect(
      await screen.findByRole("heading", { name: "Excluded activity" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "No observed activity yet" }),
    ).not.toBeInTheDocument();
    expect(posted[0]).toMatchObject({
      kind: "Exclude",
      modality: "Reading",
      deviceHandle: DEVICE_HANDLE,
      startedAt: "2026-08-10T16:00:00.000Z",
      endedAt: "2026-08-10T16:01:00.000Z",
    });

    await user.click(
      screen.getByRole("button", {
        name: /Restore A Book session from/,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /Actions for A Book, Reading/,
      }),
    ).toBeVisible();
    expect(posted[1]).toMatchObject({
      kind: "Restore",
      exclusionHandle: EXCLUSION_HANDLE,
    });
  });

  it("does not offer an inexact correction for a range-clipped session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(stats(60_000, "Observed", true)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    render(<StatsPane />);

    expect(await screen.findByText(/continues beyond range/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Actions for A Book, Reading/ }),
    ).not.toBeInTheDocument();
  });

  it("models a concurrent correction conflict and refreshes history", async () => {
    let reads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const method = init?.method ?? request?.method ?? "GET";
        if (method === "POST") {
          return Response.json(
            {
              error: {
                code: "E_RESOURCE_CONFLICT",
                message: "already restored",
              },
            },
            { status: 409 },
          );
        }
        reads += 1;
        return new Response(JSON.stringify(stats(60_000, "Observed")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const user = userEvent.setup();
    render(<StatsPane />);

    await user.click(
      await screen.findByRole("button", {
        name: /Actions for A Book, Reading/,
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Don’t count this session" }),
    );
    expect(
      await screen.findByText("Activity changed before this correction"),
    ).toBeVisible();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
