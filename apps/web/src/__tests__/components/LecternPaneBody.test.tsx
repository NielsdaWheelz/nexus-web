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
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const MEDIA_A = "11111111-0000-4000-8000-000000000001";
const MEDIA_B = "22222222-0000-4000-8000-000000000002";
const MEDIA_C = "33333333-0000-4000-8000-000000000003";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ITEM_C = "cccccccc-0000-4000-8000-000000000003";
const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

interface WireItem {
  itemId: string;
  mediaId: string;
  kind: "web_article";
  title: string;
  subtitle: { kind: "Absent" };
  href: string;
  consumption: {
    state: "Unread";
    progress: { kind: "Absent" };
    progressResettable: false;
  };
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
    consumption: {
      state: "Unread",
      progress: { kind: "Absent" },
      progressResettable: false,
    },
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
  failLecternInitial = false,
  failSlateReads = false,
  initialQueue = [wireItem(ITEM_A, MEDIA_A, "Queued article")],
}: {
  slateReads: unknown[][];
  unknownFirstPlacement?: boolean;
  holdLecternInitial?: boolean;
  failLecternInitial?: boolean;
  failSlateReads?: boolean;
  initialQueue?: WireItem[];
}) {
  let queue = initialQueue;
  let lecternRead = 0;
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
      lecternRead += 1;
      if (failLecternInitial && lecternRead === 1) {
        return jsonResponse(
          { error: { code: "E_UPSTREAM", message: "Lectern unavailable" } },
          503,
        );
      }
      return jsonResponse({ data: { items: queue } });
    }
    if (path === "/api/lectern/slate" && method === "GET") {
      if (failSlateReads) {
        slateRead += 1;
        return jsonResponse(
          { error: { code: "E_UPSTREAM", message: "Slate unavailable" } },
          503,
        );
      }
      const items = slateReads[Math.min(slateRead, slateReads.length - 1)] ?? [];
      slateRead += 1;
      return jsonResponse({ data: { items } });
    }
    if (path === "/api/lectern/commands" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.kind === "RemoveItem") {
        queue = queue.filter((item) => item.itemId !== body.itemId);
        return jsonResponse({
          data: {
            outcome: { kind: "Removed", itemId: body.itemId },
            lectern: { items: queue },
          },
        });
      }
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
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <LibraryPlacementControllerProvider>
          <ShareControllerProvider>
            <LecternProvider>
              <GlobalPlayerProvider>
                <PaneRuntimeProvider
                paneId="pane-1"
                visitId={TEST_VISIT_ID}
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
                onActivateWorkspaceTarget={vi.fn(() => ({ kind: "ActivatedExisting" as const, paneId: "pane" }))}
                onSetPaneLabel={vi.fn()}
                >
                  <LecternMutationNotice />
                  {node}
                </PaneRuntimeProvider>
              </GlobalPlayerProvider>
            </LecternProvider>
          </ShareControllerProvider>
        </LibraryPlacementControllerProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LecternPaneBody orientation", () => {
  it("places one Lectern opener before the sovereign queue and subordinate Slate", async () => {
    const suggested = wireSlateItem(MEDIA_B, "Suggested article");
    installFetch({ slateReads: [[suggested]] });
    render(withProviders(<LecternPaneBody />));

    const queue = await screen.findByRole("region", {
      name: "On the lectern",
    });
    const slate = await screen.findByRole("region", {
      name: "At hand suggestions",
    });
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Lectern",
    });

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(heading).toBeVisible();
    expect(
      await within(queue).findByRole("list", { name: "On the lectern" }),
    ).toBeVisible();
    expect(within(queue).queryByRole("heading", { level: 2 })).toBeNull();
    expect(queue).toHaveAttribute("tabindex", "-1");
    expect(
      heading.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(queue).not.toContainElement(slate);
    expect(slate).not.toContainElement(queue);
    expect(
      queue.compareDocumentPosition(slate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("LecternPaneBody states", () => {
  it("recovers a queue read failure to the flat empty state with no Slate", async () => {
    installFetch({
      slateReads: [[]],
      failLecternInitial: true,
      initialQueue: [],
    });
    const user = userEvent.setup();
    render(withProviders(<LecternPaneBody />));

    const queue = screen.getByRole("region", { name: "On the lectern" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Lectern" }),
    ).toBeVisible();
    expect(await within(queue).findByRole("alert")).toHaveTextContent(
      "Failed to load the Lectern",
    );

    await user.click(within(queue).getByRole("button", { name: "Retry" }));

    expect(
      await within(queue).findByText("Nothing on the lectern yet."),
    ).toBeVisible();
    expect(within(queue).queryByRole("heading", { level: 2 })).toBeNull();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "At hand suggestions" }),
      ).toBeNull(),
    );
  });

  it("keeps the ready queue intact when the Slate initial read fails", async () => {
    installFetch({ slateReads: [[]], failSlateReads: true });
    render(withProviders(<LecternPaneBody />));

    const queue = screen.getByRole("region", { name: "On the lectern" });
    expect(
      await within(queue).findByRole("link", { name: "Queued article" }),
    ).toBeVisible();
    const slate = await screen.findByRole("region", {
      name: "At hand suggestions",
    });
    expect(
      await within(slate).findByText("Couldn’t load suggestions."),
    ).toBeVisible();
    expect(within(slate).getByRole("button", { name: "Retry" })).toBeVisible();
    expect(queue).not.toContainElement(slate);
  });
});

describe("LecternPaneBody removal focus", () => {
  it("moves focus to the next row, previous row, then queue as rows disappear", async () => {
    installFetch({
      slateReads: [[]],
      initialQueue: [
        wireItem(ITEM_A, MEDIA_A, "Alpha"),
        wireItem(ITEM_B, MEDIA_B, "Bravo"),
        wireItem(ITEM_C, MEDIA_C, "Charlie"),
      ],
    });
    const user = userEvent.setup();
    render(withProviders(<LecternPaneBody />));

    const queue = screen.getByRole("region", { name: "On the lectern" });
    await within(queue).findByRole("link", { name: "Charlie" });

    async function remove(title: string) {
      await user.click(
        within(queue).getByRole("button", {
          name: `More actions for ${title}`,
        }),
      );
      await user.click(
        screen.getByRole("menuitem", { name: "Remove from Lectern" }),
      );
    }

    await remove("Bravo");
    await waitFor(() =>
      expect(within(queue).getByRole("link", { name: "Charlie" })).toHaveFocus(),
    );

    await remove("Charlie");
    await waitFor(() =>
      expect(within(queue).getByRole("link", { name: "Alpha" })).toHaveFocus(),
    );

    await remove("Alpha");
    expect(
      await within(queue).findByText("Nothing on the lectern yet."),
    ).toBeVisible();
    expect(queue).toHaveFocus();
  });
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

    const queue = screen.getByRole("region", { name: "On the lectern" });
    expect(
      screen.getByRole("heading", { level: 1, name: "Lectern" }),
    ).toBeVisible();
    expect(within(queue).getByRole("status")).toHaveTextContent(
      "Loading On the lectern",
    );
    expect(within(queue).queryByRole("heading", { level: 2 })).toBeNull();

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

    expect(
      await screen.findByRole("link", { name: "Queued article" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Suggested article" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Add Suggested article to Lectern",
      }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "On the lectern" })).getByRole(
          "link",
          { name: "Suggested article" },
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
