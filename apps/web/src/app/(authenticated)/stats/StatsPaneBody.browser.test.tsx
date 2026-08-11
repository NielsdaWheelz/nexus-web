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
const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

const DEVICE_HANDLE = "ncd1.AAAAAAAAAAAAAAAAAAAAAA";
const ADJUSTMENT_HANDLE =
  "nca1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

function stats(
  activeMs: number,
  correction: "None" | "Observed" | "Excluded" = "None",
  continuesBeyondRange = false,
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
          observedActiveMs: activeMs,
          manualActiveMs: 0,
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
                  {
                    source: "Observed",
                    mediaRef: "media:00000000-0000-4000-8000-000000000002",
                    title: "A Book",
                    modality: "Reading",
                    device: {
                      kind: "Present",
                      value: { deviceHandle: DEVICE_HANDLE, label: "Desktop" },
                    },
                    adjustmentHandle: { kind: "Absent" },
                    startedAt: "2026-08-10T16:00:00.000Z",
                    endedAt: "2026-08-10T16:01:00.000Z",
                    activeMs: 60_000,
                    forwardWordPosition: 120,
                    forwardMediaPositionMs: 0,
                    firstProgress: { kind: "Present", value: 0.1 },
                    lastProgress: { kind: "Present", value: 0.2 },
                    continuesBeforeRange: continuesBeyondRange,
                    continuesAfterRange: false,
                  },
                ]
              : [],
          nextCursor: { kind: "Absent" },
        },
        longestSession: { kind: "Absent" },
        activeExclusions:
          correction === "Excluded"
            ? [
                {
                  adjustmentHandle: ADJUSTMENT_HANDLE,
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

function response(activeMs: number): Response {
  return new Response(JSON.stringify(stats(activeMs)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function StatsPane() {
  return (
    <FeedbackProvider>
      <PaneReturnMementoProvider>
        <PaneRuntimeProvider
        paneId="stats-pane"
        visitId={VISIT_ID}
        isActive
        href={HREF}
        routeId="stats"
        routeKey={resolvePaneRouteIdentity(HREF).routeKey}
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
  it("revalidates a mounted pane after local acceptance and foreground recovery", async () => {
    let read = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response([0, 60_000, 120_000][read++] ?? 120_000))),
    );
    render(<StatsPane />);

    expect(
      await screen.findByRole("heading", { name: "No observed activity yet" }),
    ).toBeVisible();

    act(() => publishConsumptionProjectionChange());
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Activity summary" })).toHaveTextContent(
        "1 min",
      ),
    );

    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Activity summary" })).toHaveTextContent(
        "2 min",
      ),
    );
  });

  it("excludes an observed session and restores that exact correction", async () => {
    let currentProjection = stats(60_000, "Observed");
    const posted: unknown[] = [];
    vi.stubGlobal("confirm", vi.fn(() => true));
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
          return new Response(
            JSON.stringify({
              data: {
                outcome: posted.length === 1 ? "Excluded" : "Retracted",
                adjustmentHandle: {
                  kind: "Present",
                  value: ADJUSTMENT_HANDLE,
                },
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

    await user.click(
      await screen.findByRole("button", { name: "Don’t count this" }),
    );
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(
      await screen.findByRole("heading", { name: "Excluded activity" }),
    ).toBeVisible();
    expect(posted[0]).toMatchObject({
      kind: "Exclude",
      modality: "Reading",
      deviceHandle: DEVICE_HANDLE,
      startedAt: "2026-08-10T16:00:00.000Z",
      endedAt: "2026-08-10T16:01:00.000Z",
    });

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(
      await screen.findByRole("button", { name: "Don’t count this" }),
    ).toBeVisible();
    expect(posted[1]).toMatchObject({
      kind: "Retract",
      adjustmentHandle: ADJUSTMENT_HANDLE,
    });
  });

  it("does not offer an inexact correction for a range-clipped session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(
        new Response(JSON.stringify(stats(60_000, "Observed", true)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )),
    );
    render(<StatsPane />);

    expect(
      await screen.findByText("Open all time to correct"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Don’t count this" }),
    ).not.toBeInTheDocument();
  });

  it("models a concurrent correction conflict and refreshes history", async () => {
    let reads = 0;
    vi.stubGlobal("confirm", vi.fn(() => true));
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
                message: "already retracted",
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
      await screen.findByRole("button", { name: "Don’t count this" }),
    );
    expect(
      await screen.findByText("Activity changed before this correction"),
    ).toBeVisible();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
