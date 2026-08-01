import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { getWorkspacePrimaryPanes } from "@/lib/workspace/schema";
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
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

let requests: RecordedRequest[] = [];

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
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      requests.push({ pathname: url.pathname, method, body });

      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/me/nexus-history") {
        return jsonResponse({
          data: { recent: [], frecency_by_href: {} },
        });
      }
      if (
        url.pathname === "/api/me/nexus-selections" &&
        method === "POST"
      ) {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/resource-items/openables/search") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/search") {
        return jsonResponse({
          results: [],
          page: { has_more: false, next_cursor: null },
        });
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

describe("Nexus product composition", () => {
  beforeEach(() => {
    requests = [];
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

    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Notes Place$/ }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Workspace active location" }),
      ).toHaveTextContent("/notes"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    await waitFor(() => expect(selectionRequests()).toHaveLength(1));
    expect(selectionRequests()[0]?.body).toMatchObject({
      target_href: "/notes",
      label_snapshot: "Notes",
      source: "Static",
    });
  });
});
