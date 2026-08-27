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
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { MediaActivityProvider } from "@/lib/media/MediaActivityProvider";
import { writeDailyDraft } from "@/lib/notes/dailyDraftStore";
import { resolveDailyLocalDate } from "@/lib/notes/openDailyPage";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
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
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALENDAR_TIME_ZONE = "UTC";

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
      if (url.pathname === "/api/media/activity") {
        return jsonResponse({
          data: {
            needs_attention_count: 0,
            active_count: 0,
            has_more: false,
            items: [],
          },
        });
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
          accountId: ACCOUNT_ID,
          calendarTimeZone: CALENDAR_TIME_ZONE,
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
                    <OfflineMediaProvider
                      accountId={ACCOUNT_ID}
                      transport={null}
                    >
                      <GlobalPlayerProvider>
                        <ShareControllerProvider>
                          <MediaActivityProvider>
                            <WorkspaceProbe />
                            <Nexus />
                          </MediaActivityProvider>
                        </ShareControllerProvider>
                      </GlobalPlayerProvider>
                    </OfflineMediaProvider>
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

function writeAtomicTodayDraft() {
  writeDailyDraft({
    version: 1,
    accountId: ACCOUNT_ID,
    localDate: resolveDailyLocalDate(
      { kind: "Today" },
      CALENDAR_TIME_ZONE,
    ),
    noteId: "11111111-1111-4111-8111-111111111111",
    clientMutationId: "nexus-browser-atomic-draft",
    bodyPmJson: {
      type: "object_embed",
      attrs: {
        objectType: "media",
        objectId: "11111111-1111-4111-8111-111111111111",
        label: "Attachment",
        relationType: "embeds",
        displayMode: "compact",
      },
    },
    bodyText: "",
    handoff: { kind: "None" },
  });
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

const MOBILE_ROOT_SECTIONS = [
  ["Open", ["Libraries"]],
  [
    "Quick Actions",
    ["Quick Note", "Today", "New Chat", "New Page", "New Library", "Import"],
  ],
  ["Places", ["Lectern", "Libraries", "Browse", "Podcasts", "Chats", "Notes"]],
] as const;

const MOBILE_ROOT_GEOMETRIES = [
  ["390px portrait", 390, 800, "16px"],
  ["320px portrait", 320, 800, "16px"],
  ["short landscape", 640, 360, "16px"],
  ["200% text", 390, 800, "32px"],
] as const;

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
    document.documentElement.style.removeProperty("font-size");
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
    const open = within(dialog).getByRole("region", { name: "Open" });
    const currentRow = within(open).getByRole("listitem");
    expect(
      within(currentRow).getByRole("button", {
        name: "Libraries Tab · Current",
      }),
    ).toBeVisible();
    const more = within(currentRow).getByRole("button", {
      name: "Actions for Libraries",
    });
    await userEvent.click(more);
    expect(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Close tab",
      }),
      "One tap on a mobile row's More control did not expose that row's canonical action",
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(more).toHaveFocus());

    const quickActions = within(dialog).getByRole("region", {
      name: "Quick Actions",
    });
    expect(
      within(quickActions).getByRole("button", {
        name: /^Quick Note Create · \/n(?:\s|$)/,
      }),
    ).toBeVisible();
    expect(
      within(quickActions).getByRole("button", { name: "Today Place" }),
    ).toBeVisible();

    const places = within(dialog).getByRole("region", { name: "Places" });
    const placeButtons = within(places).getAllByRole("button");
    expect(placeButtons).toEqual([
      within(places).getByRole("button", { name: "Lectern" }),
      within(places).getByRole("button", { name: "Libraries" }),
      within(places).getByRole("button", { name: "Browse" }),
      within(places).getByRole("button", { name: "Podcasts" }),
      within(places).getByRole("button", { name: "Chats" }),
      within(places).getByRole("button", { name: "Notes" }),
    ]);
    expect(
      within(places).queryByRole("button", { name: "Stats" }),
    ).toBeNull();
    expect(
      within(places).queryByRole("button", { name: "Atlas" }),
    ).toBeNull();
    expect(
      within(places).queryByRole("button", { name: "Oracle" }),
    ).toBeNull();

    await userEvent.click(
      within(places).getByRole("button", { name: "Notes" }),
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

  it.each(MOBILE_ROOT_GEOMETRIES)(
    "renders blank mobile Root as one reachable full-width vertical stream at %s",
    async (name, width, height, rootFontSize) => {
      await page.viewport(width, height);
      document.documentElement.style.fontSize = rootFontSize;
      renderNexus("mobile");

      await userEvent.click(
        await screen.findByRole("button", { name: "Open Nexus, 1 tab" }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Nexus" });
      const search = within(dialog).getByRole("searchbox", {
        name: "Find anything…",
      });
      await waitFor(() => expect(search).toHaveFocus());

      const sections = MOBILE_ROOT_SECTIONS.map(([label]) =>
        within(dialog).getByRole("region", { name: label }),
      );
      expect(
        within(dialog)
          .getAllByRole("heading", { level: 3 })
          .map((heading) => heading.textContent?.trim()),
        `${name}: blank Root lost its labeled semantic section order`,
      ).toEqual(MOBILE_ROOT_SECTIONS.map(([label]) => label));

      const scrollOwners = [
        dialog,
        // justify-eslint-override: a content scroller intentionally has no ARIA
        // role; inspecting every descendant's browser overflow behavior avoids
        // coupling this geometry proof to a class name or test id.
        // eslint-disable-next-line testing-library/no-node-access
        ...Array.from(dialog.querySelectorAll<HTMLElement>("*")),
      ].filter((element) => {
        const style = window.getComputedStyle(element);
        return [style.overflowX, style.overflowY].some(
          (overflow) => overflow === "auto" || overflow === "scroll",
        );
      });
      expect(
        scrollOwners,
        `${name}: Root must expose one content scroller, not nested or sideways scroll surfaces`,
      ).toHaveLength(1);
      const [scrollOwner] = scrollOwners;
      expect(
        scrollOwner,
        `${name}: Root has no observable content scroller`,
      ).toBeDefined();
      expect(
        scrollOwner!.contains(
          within(dialog).getByRole("heading", { level: 2, name: "Nexus" }),
        ),
        `${name}: the fixed Nexus header moved inside the content scroller`,
      ).toBe(false);
      expect(
        scrollOwner!.contains(search),
        `${name}: the fixed search input moved inside the content scroller`,
      ).toBe(false);

      const rowGeometry = MOBILE_ROOT_SECTIONS.flatMap(
        ([sectionLabel, rowLabels], sectionIndex) => {
          const section = sections[sectionIndex]!;
          const list = within(section).getByRole("list");
          const rows = within(list).getAllByRole("listitem");
          expect(
            rows,
            `${name}: ${sectionLabel} lost a canonical row`,
          ).toHaveLength(rowLabels.length);
          return rows.map((row, rowIndex) => {
            const rowLabel = rowLabels[rowIndex]!;
            const [primary] = within(row).getAllByRole("button");
            expect(primary).toHaveAccessibleName(
              new RegExp(`^${rowLabel}(?:\\b|$)`),
            );
            expect(primary!.textContent?.trim().startsWith(rowLabel)).toBe(true);
            return {
              list,
              row,
              primary: primary!,
              controls: within(row).getAllByRole("button"),
            };
          });
        },
      );
      const boxes = rowGeometry.map(({ row }) => row.getBoundingClientRect());
      expect(
        rowGeometry.every(
          ({ list }, index) =>
            Math.abs(boxes[index]!.width - list.clientWidth) <= 1,
        ),
        `${name}: every canonical row must occupy its section's full width`,
      ).toBe(true);
      expect(
        boxes.every(
          (box, index) => index === 0 || box.top >= boxes[index - 1]!.bottom - 1,
        ),
        `${name}: rows must form one vertical stream instead of sharing horizontal tracks`,
      ).toBe(true);
      expect(
        rowGeometry.every(({ controls }) =>
          controls.every((control) => {
            const box = control.getBoundingClientRect();
            return box.width >= 48 && box.height >= 48;
          }),
        ),
        `${name}: every primary and More control must retain a 48px touch target`,
      ).toBe(true);
      expect(
        rowGeometry.every(
          ({ primary }) => primary.scrollWidth <= primary.clientWidth + 1,
        ),
        `${name}: a row label clips instead of growing or wrapping at ${rootFontSize} root text`,
      ).toBe(true);

      for (const [
        sectionIndex,
        [sectionLabel],
      ] of MOBILE_ROOT_SECTIONS.entries()) {
        const list = within(sections[sectionIndex]!).getByRole("list");
        expect(
          list.scrollWidth,
          `${name}: ${sectionLabel} remains horizontally scrollable`,
        ).toBeLessThanOrEqual(list.clientWidth + 1);
        list.scrollLeft = 24;
        expect(list.scrollLeft).toBe(0);
      }

      const finalRow = rowGeometry.at(-1)!.row;
      finalRow.scrollIntoView({ block: "nearest" });
      await waitFor(() => {
        const rowBox = finalRow.getBoundingClientRect();
        const ownerBox = scrollOwner!.getBoundingClientRect();
        expect(
          rowBox.top >= ownerBox.top - 1 && rowBox.bottom <= ownerBox.bottom + 1,
          `${name}: the final Places row is not reachable in the sole content scroller`,
        ).toBe(true);
      });

      expect(
        dialog.scrollWidth,
        `${name}: Nexus Root overflows horizontally`,
      ).toBeLessThanOrEqual(dialog.clientWidth + 1);
    },
  );

  it("puts typed Results before Do with query and restores the exact query-owned row through the Back sequence", async () => {
    const trimmedQuery = "LiBrArIeS";
    const query = `  ${trimmedQuery}  `;
    const unavailableReason = "Open Today to finish the current embedded draft";
    await page.viewport(320, 800);
    document.documentElement.style.fontSize = "32px";
    writeAtomicTodayDraft();
    renderNexus("mobile");

    const opener = await screen.findByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await userEvent.click(opener);
    let dialog = await screen.findByRole("dialog", { name: "Nexus" });
    let search = within(dialog).getByRole("searchbox", {
      name: "Find anything…",
    });
    await userEvent.type(search, query);

    await waitFor(() =>
      expect(within(dialog).getAllByRole("heading", { level: 3 })).toHaveLength(
        2,
      ),
    );
    const typedSectionOrder = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent?.trim());
    const queryActions = within(dialog).getByRole("region", {
      name: "Do with query",
    });
    const results = within(dialog).getByRole("region", { name: "Results" });
    const resultRows = within(results).getAllByRole("listitem");
    const status = within(dialog).getByRole("status", { name: "Nexus status" });
    const ask = within(queryActions).getByRole("button", {
      name: `Ask Nexus about “${trimmedQuery}” Chat`,
    });
    expect(ask).toBeVisible();
    const addToToday = within(queryActions).getByRole("button", {
      name: `Add “${trimmedQuery}” to Today. Unavailable. ${unavailableReason}`,
    });
    expect(
      within(addToToday).getByText("Append note"),
      "The unavailable query action lost its useful nonrepeating metadata",
    ).toBeVisible();
    expect(within(addToToday).getByText(unavailableReason)).toBeVisible();
    expect(
      within(queryActions).getByRole("button", {
        name: `Browse for “${trimmedQuery}”… Choose a kind`,
      }),
    ).toBeVisible();
    const create = within(queryActions).getByRole("button", {
      name: `Create “${trimmedQuery}”… Choose a type`,
    });
    expect(
      within(queryActions).getByRole("button", {
        name: `See all results for “${trimmedQuery}” Search`,
      }),
    ).toBeVisible();
    expect(create.textContent?.split(trimmedQuery)).toHaveLength(2);

    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(dialog).toBeVisible();
    expect(selectionRequests()).toHaveLength(0);
    fireEvent.compositionEnd(search);

    for (let index = 0; index < resultRows.length; index += 1) {
      await userEvent.keyboard("{ArrowDown}");
    }
    await waitFor(() =>
      expect(status).toHaveTextContent(
        `Ask Nexus about “${trimmedQuery}”. ${resultRows.length + 1} of ${resultRows.length + 5}.`,
      ),
    );
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() =>
      expect(status).toHaveTextContent(
        `${resultRows.length} of ${resultRows.length + 5}.`,
      ),
    );
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(status).toHaveTextContent(unavailableReason));

    const unavailableCopy = within(addToToday).getByText(unavailableReason);
    expect(
      unavailableCopy.scrollWidth,
      "The owned unavailable reason is visually clipped at 320px and 200% text",
    ).toBeLessThanOrEqual(unavailableCopy.clientWidth + 1);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: `Create “${trimmedQuery}”`,
      }),
      "Keyboard Enter on a query action did not enter its owned workflow",
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    dialog = await screen.findByRole("dialog", { name: "Nexus" });
    search = within(dialog).getByRole("searchbox", { name: "Find anything…" });
    await waitFor(() => expect(search).toHaveValue(query));
    await waitFor(() => expect(search).toHaveFocus());
    expect(
      within(dialog).getByRole("status", { name: "Nexus status" }),
      "Returning from a query-owned workflow did not restore its exact active row",
    ).toHaveTextContent(`Create “${trimmedQuery}”…`);

    const unmatchedQuery = "xylophonic semaphore";
    fireEvent.change(search, { target: { value: unmatchedQuery } });
    expect(
      await within(dialog).findByText(`No results for “${unmatchedQuery}”`),
    ).toBeVisible();
    const unmatchedActions = within(dialog).getByRole("region", {
      name: "Do with query",
    });
    expect(within(unmatchedActions).getAllByRole("listitem")).toHaveLength(5);
    expect(within(unmatchedActions).getAllByRole("button")).toHaveLength(5);
    expect(
      within(dialog).getByRole("status", { name: "Nexus status" }),
    ).toHaveTextContent("0 results");
    expect(
      within(dialog).queryByRole("region", { name: "Results" }),
    ).toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(search).toHaveValue(""));
    expect(search).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull(),
    );
    expect(opener).toHaveFocus();
    expect(
      typedSectionOrder,
      "A typed mobile query must present owned Results before its verb-first actions",
    ).toEqual(["Results", "Do with query"]);
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
      within(dialog).getByRole("button", { name: "Notes" }),
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
