import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import {
  ResourceCacheProvider,
  type DehydratedResources,
} from "@/lib/api/resourceCache";
import type { ResourceItem } from "@/lib/notes/api";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import {
  PaneRuntimeProvider,
  type PaneResourceStatus,
} from "@/lib/panes/paneRuntime";
import DailyNotePaneBody from "./DailyNotePaneBody";

type OpenInNewPane = (
  href: string,
  titleHint?: string,
  secondarySurfaceId?: WorkspaceSecondarySurfaceId,
) => void;

const testState = vi.hoisted(() => ({
  pagePaneProps: [] as Array<{
    pageIdOverride?: string;
    initialPage?: { id: string; title: string };
  }>,
  usePaneChromeOverride: vi.fn(),
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: testState.usePaneChromeOverride,
}));

vi.mock("../pages/[pageId]/PagePaneBody", () => ({
  default: (props: {
    pageIdOverride?: string;
    initialPage?: { id: string; title: string };
  }) => {
    testState.pagePaneProps.push(props);
    return (
      <div
        data-testid="page-pane"
        data-page-id={props.pageIdOverride ?? ""}
        data-initial-page-id={props.initialPage?.id ?? ""}
      >
        Page {props.pageIdOverride}
      </div>
    );
  },
}));

describe("DailyNotePaneBody", () => {
  beforeEach(() => {
    testState.pagePaneProps = [];
    testState.usePaneChromeOverride.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the render-environment current date and explicit timezone", async () => {
    const fetchCalls = stubDailyFetch({
      "2026-06-03": dailyPage("page-today", "Today"),
    });

    renderDailyPane("/daily");

    const pagePane = await screen.findByTestId("page-pane");
    expect(pagePane).toHaveAttribute("data-page-id", "page-today");
    expect(pagePane).toHaveAttribute("data-initial-page-id", "page-today");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.pathname).toBe("/api/notes/daily/2026-06-03");
    expect(fetchCalls[0]?.searchParams.get("time_zone")).toBe("UTC");
  });

  it("uses an explicit route date and delegates the resolved page", async () => {
    const fetchCalls = stubDailyFetch({
      "2026-05-06": dailyPage("page-explicit", "May 6, 2026"),
    });

    renderDailyPane("/daily/2026-05-06");

    const pagePane = await screen.findByTestId("page-pane");
    expect(pagePane).toHaveAttribute("data-page-id", "page-explicit");
    expect(pagePane).toHaveAttribute("data-initial-page-id", "page-explicit");
    expect(testState.pagePaneProps.at(-1)?.initialPage).toMatchObject({
      id: "page-explicit",
      title: "May 6, 2026",
    });
    expect(fetchCalls.map((url) => url.pathname)).toEqual([
      "/api/notes/daily/2026-05-06",
    ]);
  });

  it("uses the daily page hydration cache key without refetching", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("unexpected daily note fetch on hydration hit");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDailyPane("/daily/2026-05-06", {
      resources: {
        "daily-note-page:2026-05-06:UTC": {
          localDate: "2026-05-06",
          timeZone: "UTC",
          page: dailyPage("page-seeded", "Seeded daily page"),
        },
      },
    });

    const pagePane = await screen.findByTestId("page-pane");
    expect(pagePane).toHaveAttribute("data-page-id", "page-seeded");
    expect(pagePane).toHaveAttribute("data-initial-page-id", "page-seeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid local dates before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("invalid daily date should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDailyPane("/daily/2026-02-29");

    expect(
      await screen.findByText("Daily note date must use YYYY-MM-DD."),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("page-pane")).not.toBeInTheDocument();
  });

  it("publishes an open-yesterday chrome option", async () => {
    stubDailyFetch({
      "2026-06-03": dailyPage("page-today", "Today"),
    });
    const onOpenInNewPane = vi.fn();

    renderDailyPane("/daily", { onOpenInNewPane });

    const option = await chromeOption("daily-open-yesterday");
    option.onSelect?.({ triggerEl: null });

    expect(onOpenInNewPane).toHaveBeenCalledWith(
      "/daily/2026-06-02",
      "Yesterday",
      undefined,
    );
  });

  it("uses a shell-provided canonical page resource without constructing a local ref", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("shell-resolved daily page should not refetch by date");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDailyPane("/daily/2026-05-06", {
      resourceItem: pageResourceItem("11111111-1111-4111-8111-111111111111"),
    });

    const pagePane = await screen.findByTestId("page-pane");
    expect(pagePane).toHaveAttribute(
      "data-page-id",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(pagePane).toHaveAttribute("data-initial-page-id", "");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for a pending shell resource before fetching by date", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("pending shell resource should not refetch by date");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDailyPane("/daily/2026-05-06", { resourceStatus: "pending" });

    expect(await screen.findByRole("status")).toBeVisible();
    expect(screen.queryByTestId("page-pane")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function renderDailyPane(
  href: string,
  options: {
    resources?: DehydratedResources;
    resourceItem?: ResourceItem | null;
    resourceStatus?: PaneResourceStatus;
    onOpenInNewPane?: OpenInNewPane;
  } = {},
) {
  const identity = resolvePaneRouteIdentity(href);
  const route = resolvePaneRouteModel(href);
  const onOpenInNewPane = options.onOpenInNewPane ?? vi.fn<OpenInNewPane>();
  const view = render(
    <FeedbackProvider>
      <ResourceCacheProvider value={options.resources ?? {}}>
        <PaneRuntimeProvider
          paneId="pane-daily"
          href={href}
          routeId={identity.routeId}
          routeKey={identity.routeKey}
          resourceItem={options.resourceItem ?? null}
          resourceStatus={options.resourceStatus ?? "none"}
          pathParams={route.params}
          canGoBack={false}
          canGoForward={false}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onOpenInNewPane={onOpenInNewPane}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
        >
          <DailyNotePaneBody />
        </PaneRuntimeProvider>
      </ResourceCacheProvider>
    </FeedbackProvider>,
  );
  return { ...view, onOpenInNewPane };
}

async function chromeOption(id: string): Promise<ActionMenuOption> {
  let option: ActionMenuOption | undefined;
  await waitFor(() => {
    option = testState.usePaneChromeOverride.mock.calls
      .at(-1)?.[0]
      ?.options?.find((candidate: ActionMenuOption) => candidate.id === id);
    expect(option).toBeDefined();
  });
  return option as ActionMenuOption;
}

function stubDailyFetch(pagesByDate: Record<string, Record<string, unknown>>): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request
          ? new URL(input.url)
          : new URL(String(input), "https://nexus.test");
      calls.push(url);
      const date = url.pathname.match(/^\/api\/notes\/daily\/([^/]+)$/)?.[1];
      const page = date ? pagesByDate[date] : null;
      if (!page) {
        throw new Error(`Unexpected fetch path: ${url.pathname}`);
      }
      return jsonResponse({ data: { page } });
    }),
  );
  return calls;
}

function dailyPage(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    surface: null,
    blocks: [],
  };
}

function pageResourceItem(id: string): ResourceItem {
  const ref = `page:${id}`;
  return {
    ref,
    scheme: "page",
    id,
    label: "Daily note",
    summary: "",
    route: `/pages/${id}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/pages/${id}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      linkable: true,
      attachable: true,
      chatSubject: "readable",
      readable: "body",
      inspectable: "none",
      citableResultType: "page",
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: true,
      promptRender: "inline_body",
      expansionPolicy: "page_note_blocks",
      expandable: true,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
