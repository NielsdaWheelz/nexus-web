import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import LecternPaneBody from "@/app/(authenticated)/lectern/LecternPaneBody";
import LecternMutationNotice from "@/components/LecternMutationNotice";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";

const MEDIA_A = "11111111-0000-4000-8000-000000000001";
const MEDIA_B = "22222222-0000-4000-8000-000000000002";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";

interface WireItem {
  itemId: string;
  mediaId: string;
  kind: "web_article";
  title: string;
  subtitle: { kind: "Absent" };
  href: string;
  consumption: { state: "Unread"; progress: { kind: "Absent" } };
  activation: { kind: "Readable" };
}

function wireItem(itemId: string, mediaId: string, title: string): WireItem {
  return {
    itemId,
    mediaId,
    kind: "web_article",
    title,
    subtitle: { kind: "Absent" },
    href: `/media/${mediaId}`,
    consumption: { state: "Unread", progress: { kind: "Absent" } },
    activation: { kind: "Readable" },
  };
}

function wireSlateItem(mediaId: string, title: string) {
  return {
    target: {
      kind: "Media",
      ref: `media:${mediaId}`,
      mediaKind: "web_article",
      title,
      subtitle: { kind: "Present", value: "A deterministic suggestion" },
      imageUrl: { kind: "Absent" },
      href: `/media/${mediaId}`,
    },
    reason: {
      kind: "Connected",
      anchor: { ref: `media:${MEDIA_A}`, label: "Queued article" },
      edgeOrigin: "citation",
    },
  };
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch({
  slateReads,
  unknownFirstPlacement = false,
  holdLecternInitial = false,
}: {
  slateReads: unknown[][];
  unknownFirstPlacement?: boolean;
  holdLecternInitial?: boolean;
}) {
  let queue = [wireItem(ITEM_A, MEDIA_A, "Queued article")];
  let slateRead = 0;
  let placementCount = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/lectern" && method === "GET") {
      if (holdLecternInitial) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return jsonResponse({ data: { items: queue } });
    }
    if (path === "/api/lectern/slate" && method === "GET") {
      const items = slateReads[Math.min(slateRead, slateReads.length - 1)] ?? [];
      slateRead += 1;
      return jsonResponse({ data: { items } });
    }
    if (path === "/api/lectern/commands" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.kind !== "PlaceItems") {
        throw new Error(`Unexpected Lectern command ${body.kind}`);
      }
      placementCount += 1;
      if (unknownFirstPlacement && placementCount === 1) {
        return jsonResponse(
          { error: { code: "E_UPSTREAM", message: "Unknown outcome" } },
          503,
        );
      }
      const placedId = "bbbbbbbb-0000-4000-8000-000000000002";
      queue = [...queue, wireItem(placedId, MEDIA_B, "Suggested article")];
      return jsonResponse({
        data: {
          outcome: { kind: "Placed", itemIds: [placedId] },
          lectern: { items: queue },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, placementCount: () => placementCount };
}

function withProviders(node: ReactNode) {
  const href = "/lectern";
  return withRenderEnvironment(
    <FeedbackProvider>
      <LecternProvider>
        <GlobalPlayerProvider>
          <PaneRuntimeProvider
            paneId="pane-1"
            isActive
            href={href}
            routeId="lectern"
            routeKey={resolvePaneRouteIdentity(href).routeKey}
            canGoBack={false}
            canGoForward={false}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onOpenInNewPane={vi.fn()}
            onSetPaneLabel={vi.fn()}
          >
            <LecternMutationNotice />
            {node}
          </PaneRuntimeProvider>
        </GlobalPlayerProvider>
      </LecternProvider>
    </FeedbackProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LecternPaneBody Slate host", () => {
  it("normalizes Add while the canonical Lectern snapshot is still loading", async () => {
    const suggested = wireSlateItem(MEDIA_B, "Suggested article");
    const { fetchMock } = installFetch({
      slateReads: [[suggested]],
      holdLecternInitial: true,
    });
    const user = userEvent.setup();
    render(withProviders(<LecternPaneBody />));

    const add = await screen.findByRole("button", {
      name: "Add Suggested article to Lectern",
    });
    await user.click(add);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Lectern is still loading.",
    );
    expect(add).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          pathOf(input as RequestInfo | URL) === "/api/lectern/commands",
      ),
    ).toHaveLength(0);
  });

  it("renders the queue and accepts a Slate row through the canonical provider", async () => {
    const suggested = wireSlateItem(MEDIA_B, "Suggested article");
    const { fetchMock } = installFetch({ slateReads: [[suggested], []] });
    const user = userEvent.setup();
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Queued article")).toBeVisible();
    expect(await screen.findByText("Suggested article")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Add Suggested article to Lectern",
      }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "On the lectern" })).getByText(
          "Suggested article",
        ),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "At hand suggestions" }),
      ).toBeNull(),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          pathOf(input as RequestInfo | URL) === "/api/lectern/commands" &&
          (init?.method ?? "GET") === "POST",
      ),
    ).toHaveLength(1);
  });

  it("keeps the sole assertive unknown recovery in LecternMutationNotice", async () => {
    const suggested = wireSlateItem(MEDIA_B, "Suggested article");
    const host = installFetch({
      slateReads: [[suggested], []],
      unknownFirstPlacement: true,
    });
    const user = userEvent.setup();
    render(withProviders(<LecternPaneBody />));

    await user.click(
      await screen.findByRole("button", {
        name: "Add Suggested article to Lectern",
      }),
    );
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/Couldn't update the Lectern/);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    const slate = screen.getByRole("region", { name: "At hand suggestions" });
    expect(within(slate).getByText("Couldn’t confirm Add.")).toBeVisible();
    expect(within(slate).queryByRole("status")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(host.placementCount()).toBe(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("keeps the fixed Slate list and controls inside a 320px pane", async () => {
    const suggested = wireSlateItem(
      MEDIA_B,
      "A deliberately long deterministic suggestion title",
    );
    installFetch({ slateReads: [[suggested]] });
    render(
      withProviders(
        <div
          data-testid="narrow-lectern-host"
          style={{ width: "320px", maxWidth: "320px" }}
        >
          <LecternPaneBody />
        </div>,
      ),
    );
    const add = await screen.findByRole("button", {
      name: /Add A deliberately long deterministic suggestion title to Lectern/,
    });
    const host = screen.getByTestId("narrow-lectern-host");

    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
    expect(add).toBeVisible();
    expect(
      screen.getByText("A deterministic suggestion · Connected with Queued article")
    ).toBeVisible();
    expect(screen.getByRole("list", { name: "At hand suggestions" })).toBeVisible();
  });
});
