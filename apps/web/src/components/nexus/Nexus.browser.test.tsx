import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import Nexus from "./Nexus";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

interface RecordedRequest {
  readonly pathname: string;
  readonly search: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
  readonly keepalive: boolean;
  readonly signal: AbortSignal | null;
  readonly activeWorkspaceLocation: string | null;
}

let requests: RecordedRequest[] = [];
let activeWorkspaceLocation: string | null = null;
let respondToOpenables: (init: RequestInit | undefined) => Promise<Response>;
let respondToSearch: (init: RequestInit | undefined) => Promise<Response>;
let respondToSelection: (init: RequestInit | undefined) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function installBff() {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      requests.push({
        pathname: url.pathname,
        search: url.search,
        method,
        body,
        keepalive: init?.keepalive ?? request?.keepalive ?? false,
        signal: init?.signal ?? request?.signal ?? null,
        activeWorkspaceLocation,
      });

      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/me/nexus-history") {
        return jsonResponse({
          data: { recent: [], frecency_by_href: {} },
        });
      }
      if (url.pathname === "/api/me/nexus-selections" && method === "POST") {
        return respondToSelection(init);
      }
      if (url.pathname === "/api/me/workspace-session" && method === "PUT") {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/resource-items/openables/search") {
        return respondToOpenables(init);
      }
      if (url.pathname === "/api/search") {
        return respondToSearch(init);
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`Unexpected BFF request: ${method} ${url.pathname}`);
    },
  );
}

function WorkspaceProbe() {
  const { state } = useWorkspaceStore();
  const panes = getWorkspacePrimaryPanes(state);
  const active = panes.find((pane) => pane.id === state.activePrimaryPaneId);
  const activeHref = active?.currentVisit.href ?? null;
  useLayoutEffect(() => {
    activeWorkspaceLocation = activeHref;
  }, [activeHref]);
  return (
    <>
      <output aria-label="Workspace pane count">{panes.length}</output>
      <output aria-label="Workspace active location">
        {active?.currentVisit.href ?? ""}
      </output>
    </>
  );
}

function renderNexus(initialViewport: "desktop" | "mobile") {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          calendarTimeZone: "UTC",
        }}
      >
        <MobileChromeProvider>
          <KeybindingsProvider>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  initialState={createDefaultWorkspaceState(
                    "/libraries",
                    workspacePrimaryMetrics,
                  )}
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                >
                  <LecternProvider>
                    <GlobalPlayerProvider>
                      <ShareControllerProvider>
                        <WorkspaceProbe />
                        <Nexus />
                      </ShareControllerProvider>
                    </GlobalPlayerProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
      { initialViewport },
    ),
  );
}

function selectionRequests() {
  return requests.filter(
    (request) =>
      request.pathname === "/api/me/nexus-selections" &&
      request.method === "POST",
  );
}

function openablesRequests(query?: string) {
  return requests.filter(
    (request) =>
      request.pathname === "/api/resource-items/openables/search" &&
      request.method === "POST" &&
      (query === undefined || request.body?.q === query),
  );
}

function queryHistoryRequests() {
  return requests.filter(
    (request) =>
      request.pathname === "/api/me/nexus-history" &&
      new URLSearchParams(request.search).has("query"),
  );
}

async function passAnimationFrames(count: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let remaining = count;
    const advance = () => {
      remaining -= 1;
      if (remaining === 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(advance);
    };
    window.requestAnimationFrame(advance);
  });
}

describe("Nexus product composition", () => {
  beforeEach(() => {
    requests = [];
    activeWorkspaceLocation = null;
    respondToOpenables = async () => jsonResponse({ data: { items: [] } });
    respondToSearch = async () =>
      jsonResponse({
        results: [],
        page: { has_more: false, next_cursor: null },
      });
    respondToSelection = async () => jsonResponse({ data: null });
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    installBff();
  });

  it("opens the desktop command surface and forks its active place into a real workspace pane", async () => {
    await page.viewport(1_280, 900);
    renderNexus("desktop");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
      name: "Find anything…",
    });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Workspace pane count" })
          .textContent,
        "Desktop Nexus Shift+Enter lost its Fork disposition at the workspace boundary",
      ).toBe("2"),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    expect(selectionRequests()[0]?.body).toMatchObject({
      target_href: "/libraries",
      source: "Workspace",
    });
  });

  it("opens the mobile task, focuses search, and follows a place through the same workspace owner", async () => {
    await page.viewport(390, 800);
    renderNexus("mobile");

    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const search = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    await waitFor(() => expect(search).toHaveFocus());
    const places = within(dialog).getByRole("region", { name: "Places" });
    const placeButtons = within(places).getAllByRole("button");
    expect(placeButtons).toEqual([
      within(places).getByRole("button", { name: /^Lectern Place$/ }),
      within(places).getByRole("button", { name: /^Libraries Place$/ }),
      within(places).getByRole("button", { name: /^Browse Place$/ }),
      within(places).getByRole("button", { name: /^Podcasts Place$/ }),
      within(places).getByRole("button", { name: /^Chats Place$/ }),
      within(places).getByRole("button", { name: /^Notes Place$/ }),
    ]);
    expect(
      within(places).queryByRole("button", { name: /^Stats Place$/ }),
    ).toBeNull();
    expect(
      within(places).queryByRole("button", { name: /^Atlas Place$/ }),
    ).toBeNull();
    expect(
      within(places).queryByRole("button", { name: /^Oracle Place$/ }),
    ).toBeNull();

    fireEvent.click(
      within(places).getByRole("button", { name: /^Notes Place$/ }),
    );
    expect(
      selectionRequests(),
      "Nexus history was written before the accepted destination could paint",
    ).toHaveLength(0);

    fireEvent(window, new Event("pagehide"));

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Workspace active location" }),
      ).toHaveTextContent("/notes"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    const selection = selectionRequests()[0];
    expect(selection?.activeWorkspaceLocation).toBe("/notes");
    expect(selection?.keepalive).toBe(true);
    expect(selection?.body).toMatchObject({
      target_href: "/notes",
      label_snapshot: "Notes",
      source: "Static",
    });

    await passAnimationFrames(3);
    expect(
      selectionRequests(),
      "Frames scheduled before pagehide duplicated the flushed Nexus history write",
    ).toHaveLength(1);
  });

  it("replays one mutation after foreground work preempts selection persistence", async () => {
    let attempt = 0;
    respondToSelection = async (init) => {
      attempt += 1;
      if (attempt > 1) return jsonResponse({ data: null });
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Selection persistence requires an abort signal");
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };
    await page.viewport(390, 800);
    renderNexus("mobile");
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Notes Place$/ }),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    const first = selectionRequests()[0];
    const mutationId = first?.body?.client_mutation_id;
    expect(mutationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first?.signal).toBeInstanceOf(AbortSignal);

    await userEvent.click(
      screen.getByRole("button", { name: "Open Nexus, 1 tab" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Nexus" });
    await waitFor(() => expect(first?.signal?.aborted).toBe(true));
    expect(
      selectionRequests(),
      "Foreground Nexus work duplicated an interrupted selection mutation",
    ).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(selectionRequests()).toHaveLength(2));
    expect(selectionRequests()[1]?.body?.client_mutation_id).toBe(mutationId);
  });

  it("starts query-aware history only after the foreground provider chain settles", async () => {
    let resolveOpenables!: (response: Response) => void;
    let resolveSearch!: (response: Response) => void;
    const openablesStarted = new Promise<void>((resolve) => {
      respondToOpenables = async () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveOpenables = resolveResponse;
        });
      };
    });
    const searchStarted = new Promise<void>((resolve) => {
      respondToSearch = async () => {
        resolve();
        return new Promise<Response>((resolveResponse) => {
          resolveSearch = resolveResponse;
        });
      };
    });
    await page.viewport(1_280, 900);
    renderNexus("desktop");
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
      name: "Find anything…",
    });

    fireEvent.change(input, { target: { value: "alpha" } });
    await openablesStarted;
    expect(queryHistoryRequests()).toHaveLength(0);

    resolveOpenables(jsonResponse({ data: { items: [] } }));
    await searchStarted;
    expect(queryHistoryRequests()).toHaveLength(0);

    resolveSearch(
      jsonResponse({
        results: [],
        page: { has_more: false, next_cursor: null },
      }),
    );
    await waitFor(() => expect(queryHistoryRequests()).toHaveLength(1));
    expect(
      new URLSearchParams(queryHistoryRequests()[0]?.search).get("query"),
    ).toBe("alpha");
  });

  it("bounds Openables to the 32 most-recent session queries and releases them on dismissal", async () => {
    await page.viewport(1_280, 900);
    renderNexus("desktop");

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Nexus" });
    const input = within(dialog).getByRole("combobox", {
      name: "Find anything…",
    });
    const distinctQueries = [..."abcdefghijklmnopqrstuvwxyz", ..."0123456"];

    for (const query of distinctQueries) {
      fireEvent.change(input, { target: { value: query } });
      await waitFor(() =>
        expect(
          openablesRequests(query),
          `Openables did not settle query ${query}`,
        ).toHaveLength(1),
      );
    }

    const leastRecentlyUsed = distinctQueries[0]!;
    fireEvent.change(input, { target: { value: leastRecentlyUsed } });
    await waitFor(() =>
      expect(
        openablesRequests(leastRecentlyUsed),
        "The 33rd distinct Openables query did not evict the least-recently-used query",
      ).toHaveLength(2),
    );

    const backdrop = screen.getByRole("presentation", { hidden: true });
    fireEvent.click(backdrop);
    await waitFor(() => expect(input).toHaveValue(""));
    fireEvent.click(backdrop);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const reopened = await screen.findByRole("dialog", { name: "Nexus" });
    fireEvent.change(
      within(reopened).getByRole("combobox", { name: "Find anything…" }),
      { target: { value: leastRecentlyUsed } },
    );
    await waitFor(() =>
      expect(
        openablesRequests(leastRecentlyUsed),
        "Dismissing Nexus retained an Openables result from the prior session",
      ).toHaveLength(3),
    );
  });
});
