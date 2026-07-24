import {
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  act,
  render as testingRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCallsForPath,
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { ApiError } from "@/lib/api/client";
import {
  decodeSlateEnvelope,
  type SlateItem,
  type SlateSnapshot,
} from "@/lib/resonance/contract";
import type {
  AcceptResult,
  ReadingSlateAccept,
} from "@/lib/resonance/useReadingSlate";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
  usePaneResolvedBodyReady,
  usePaneReturnMementoCommands,
  usePaneReturnReady,
  usePaneReturnScrollport,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import {
  assumePaneVisitId,
  type PaneVisitId,
} from "@/lib/workspace/schema";
import ReadingSlateSection from "./ReadingSlateSection";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000012",
);
const OTHER_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000013",
);
const TEST_ROUTE_KEY = "/test";

function PaneReturnTestHarness({ children }: { children: ReactNode }) {
  return (
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={TEST_VISIT_ID} routeKey={TEST_ROUTE_KEY}>
        {children}
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>
  );
}

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: PaneReturnTestHarness });
}

const lecternSlateResponse =
  vi.fn<(signal?: AbortSignal) => Promise<SlateSnapshot>>();
const librarySlateResponse =
  vi.fn<(id: string, signal?: AbortSignal) => Promise<SlateSnapshot>>();
let fetchMock: ReturnType<typeof stubFetch>;

async function slateHttpResponse(
  response: Promise<SlateSnapshot>,
): Promise<Response> {
  try {
    return jsonResponse({ data: await response });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 200 &&
      error.status <= 599
    ) {
      return jsonResponse(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    throw error;
  }
}

function installSlateFetch() {
  return stubFetch(async (input, init) => {
    const path = fetchInputPath(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/api/lectern/slate") {
      return slateHttpResponse(lecternSlateResponse(init?.signal ?? undefined));
    }
    const libraryMatch = /^\/api\/libraries\/([^/]+)\/slate$/.exec(path);
    if (method === "GET" && libraryMatch !== null) {
      return slateHttpResponse(
        librarySlateResponse(
          decodeURIComponent(libraryMatch[1]),
          init?.signal ?? undefined,
        ),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function slateItem(index: number): SlateItem {
  const id = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return decodeSlateEnvelope({
    data: {
      items: [
        {
          target: {
            kind: "Media",
            ref: `media:${id}`,
            mediaKind: "pdf",
            title: `Item ${index}`,
            subtitle: { kind: "Present", value: `Subtitle ${index}` },
            imageUrl: { kind: "Absent" },
            href: `/media/${id}`,
          },
          reason: {
            kind: "AddedToNexus",
            addedAt: "2026-07-20T12:00:00Z",
          },
        },
      ],
    },
  }).items[0];
}

function lecternNode(accept: ReadingSlateAccept, isActive = true) {
  return withRenderEnvironment(
    <>
      <div data-pane-id="pane-1">
        <button data-pane-chrome-focus="true">Pane chrome</button>
      </div>
      <ReadingSlateSection
        returnScope="Test.ReadingSlate"
        destination={{ kind: "Lectern" }}
        paneId="pane-1"
        isActive={isActive}
        accept={accept}
      />
    </>,
  );
}

function renderLectern(accept: ReadingSlateAccept) {
  return render(lecternNode(accept));
}

function CommandsProbe({
  publish,
}: {
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  const commands = usePaneReturnMementoCommands();
  useLayoutEffect(() => publish(commands), [commands, publish]);
  return null;
}

function RouteReady({ children }: { children: ReactNode }) {
  usePaneReturnReady(true);
  usePaneResolvedBodyReady();
  return children;
}

function ReadingSlateReturnRoute({
  visitId,
  accept,
}: {
  visitId: PaneVisitId;
  accept: ReadingSlateAccept;
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  usePaneReturnScrollport({
    paneId: "pane-1",
    enabled: true,
    scrollportRef,
  });
  return (
    <section data-pane-shell data-pane-id="pane-1">
      <button data-pane-chrome-focus="true">Pane chrome</button>
      <div ref={scrollportRef} data-testid="slate-return-scrollport">
        <div key={visitId}>
          <RouteReady>
            <h1 data-pane-return-heading tabIndex={-1}>
              Test route
            </h1>
            <ReadingSlateSection
              returnScope="Test.ReadingSlate"
              destination={{ kind: "Lectern" }}
              paneId="pane-1"
              isActive
              accept={accept}
            />
          </RouteReady>
        </div>
      </div>
    </section>
  );
}

function ReadingSlateReturnFixture({
  visitId,
  accept,
  publish,
}: {
  visitId: PaneVisitId;
  accept: ReadingSlateAccept;
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publish} />
      <PaneReturnVisitScope visitId={visitId} routeKey={TEST_ROUTE_KEY}>
        {withRenderEnvironment(
          <ReadingSlateReturnRoute visitId={visitId} accept={accept} />,
        )}
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>
  );
}

function defineSlateGeometry(
  scrollport: HTMLElement,
  rows: readonly HTMLElement[],
): void {
  let scrollTop = 0;
  Object.defineProperties(scrollport, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 400 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  scrollport.getBoundingClientRect = () =>
    ({
      top: 0,
      right: 200,
      bottom: 100,
      left: 0,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => {
      const top = index * 80 - scrollport.scrollTop;
      return {
        top,
        right: 200,
        bottom: top + 40,
        left: 0,
        width: 200,
        height: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });
}

beforeEach(() => {
  lecternSlateResponse.mockReset();
  librarySlateResponse.mockReset();
  fetchMock = installSlateFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("ReadingSlateSection", () => {
  it("holds return restoration until a delayed initial Slate anchor commits", async () => {
    const items = [slateItem(1), slateItem(2), slateItem(3)];
    const delayedReturn = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items })
      .mockResolvedValueOnce({ items: [] })
      .mockImplementationOnce(() => delayedReturn.promise);
    const accept = vi.fn<ReadingSlateAccept>();
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = testingRender(
      <ReadingSlateReturnFixture
        visitId={TEST_VISIT_ID}
        accept={accept}
        publish={publish}
      />,
    );

    const departedLink = await screen.findByRole("link", { name: /Item 2/ });
    const scrollport = screen.getByTestId("slate-return-scrollport");
    defineSlateGeometry(scrollport, screen.getAllByRole("listitem"));
    scrollport.scrollTop = 80;
    departedLink.focus();
    expect(departedLink).toHaveFocus();
    expect(commands).not.toBeNull();
    act(() => {
      commands?.capturePane({
        paneId: "pane-1",
        visitId: TEST_VISIT_ID,
        routeKey: TEST_ROUTE_KEY,
        modality: "Keyboard",
      });
    });

    view.rerender(
      <ReadingSlateReturnFixture
        visitId={OTHER_VISIT_ID}
        accept={accept}
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(
        2,
      ),
    );
    expect(scrollport.scrollTop).toBe(0);

    view.rerender(
      <ReadingSlateReturnFixture
        visitId={TEST_VISIT_ID}
        accept={accept}
        publish={publish}
      />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading At hand suggestions",
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(scrollport.scrollTop).toBe(0);
    expect(screen.getByRole("heading", { name: "Test route" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Pane chrome" })).not.toHaveFocus();

    await act(async () => delayedReturn.resolve({ items }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Item 2/ })).toHaveFocus(),
    );
  });

  it("shows bounded Lectern loading, then a settled initial failure and Retry", async () => {
    const read = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockImplementationOnce(() => read.promise)
      .mockResolvedValueOnce({ items: [] });
    const user = userEvent.setup();
    renderLectern(vi.fn<ReadingSlateAccept>());

    const section = screen.getByRole("region", { name: "At hand suggestions" });
    expect(section).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading At hand suggestions",
    );
    await act(async () =>
      read.reject(new ApiError(400, "E_INVALID_REQUEST", "bad request")),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(section).not.toHaveAttribute("aria-busy");
    await user.click(retry);
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "At hand suggestions" }),
      ).toBeNull(),
    );
  });

  it("keeps survivors stable, appends one replacement, and focuses the next survivor", async () => {
    const initial = [slateItem(1), slateItem(2), slateItem(3)];
    const command = deferred<AcceptResult>();
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: initial })
      .mockImplementationOnce(() => refill.promise);
    const accept = vi.fn<ReadingSlateAccept>(() => command.promise);
    const user = userEvent.setup();
    renderLectern(accept);

    const section = await screen.findByRole("region", {
      name: "At hand suggestions",
    });
    expect(
      await within(section).findByText("Subtitle 2 · Added to Nexus")
    ).toBeVisible();
    expect(within(section).getAllByText(/Added to Nexus/)).toHaveLength(3);
    const addButtons = within(section).getAllByRole("button", {
      name: /Add Item .* to Lectern/,
    });
    const survivingLink = within(section).getByRole("link", { name: /Item 3/ });
    await user.click(addButtons[1]);
    expect(section).toHaveAttribute("aria-busy", "true");
    within(section)
      .getAllByRole("button", { name: /Add Item .* to Lectern/ })
      .forEach((button) => expect(button).toBeDisabled());

    await act(async () => command.resolve({ kind: "Accepted" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Item 3/ })).toHaveFocus(),
    );

    const newcomer = slateItem(4);
    await act(async () =>
      refill.resolve({ items: [initial[0], initial[2], newcomer] }),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Item 4/ })).toBeVisible(),
    );
    const titles = within(section)
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());
    expect(titles).toEqual([
      expect.stringContaining("Item 1"),
      expect.stringContaining("Item 3"),
      expect.stringContaining("Item 4"),
    ]);
    expect(screen.getByRole("link", { name: /Item 3/ })).toBe(survivingLink);
    expect(survivingLink).toHaveFocus();
  });

  it("preserves meaningful focus moved after acceptance but before repair", async () => {
    const initial = [slateItem(1), slateItem(2)];
    const command = deferred<AcceptResult>();
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: initial })
      .mockImplementationOnce(() => refill.promise);
    const user = userEvent.setup();
    renderLectern(() => command.promise);

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    const paneChrome = screen.getByRole("button", { name: "Pane chrome" });
    await act(async () => {
      command.resolve({ kind: "Accepted" });
      await Promise.resolve();
      paneChrome.focus();
    });

    await waitFor(() => expect(paneChrome).toHaveFocus());
    expect(screen.getByRole("link", { name: /Item 2/ })).not.toHaveFocus();
  });

  it("never replays focus repair when Add settles while the pane is inactive", async () => {
    const initial = [slateItem(1), slateItem(2)];
    const command = deferred<AcceptResult>();
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: initial })
      .mockImplementationOnce(() => refill.promise);
    const accept = vi.fn<ReadingSlateAccept>(() => command.promise);
    const user = userEvent.setup();
    const view = renderLectern(accept);

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    view.rerender(lecternNode(accept, false));
    await act(async () => command.resolve({ kind: "Accepted" }));
    const paneChrome = screen.getByRole("button", { name: "Pane chrome" });
    paneChrome.focus();

    view.rerender(lecternNode(accept, true));
    await act(async () =>
      refill.resolve({ items: [initial[1], slateItem(3)] }),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Item 3/ })).toBeVisible(),
    );
    expect(paneChrome).toHaveFocus();
    expect(screen.getByRole("link", { name: /Item 2/ })).not.toHaveFocus();
  });

  it("exposes one exact-attempt Retry for a local unknown and keeps Add disabled", async () => {
    const initial = [slateItem(1), slateItem(2)];
    lecternSlateResponse.mockResolvedValueOnce({ items: initial });
    const command = deferred<AcceptResult>();
    const retry = vi.fn();
    const accept: ReadingSlateAccept = (_target, options) => {
      options.onUnknown({
        error: new ApiError(0, "E_NETWORK", "Connection lost"),
        recovery: { kind: "Local", retry },
      });
      return command.promise;
    };
    const user = userEvent.setup();
    renderLectern(accept);

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t confirm Add");
    expect(
      within(alert).getAllByRole("button", { name: "Retry" }),
    ).toHaveLength(1);
    screen
      .getAllByRole("button", { name: /Add Item .* to Lectern/ })
      .forEach((button) => expect(button).toBeDisabled());

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an external unknown quiet with no Slate Retry owner", async () => {
    const initial = [slateItem(1)];
    lecternSlateResponse.mockResolvedValueOnce({ items: initial });
    const command = deferred<AcceptResult>();
    const accept: ReadingSlateAccept = (_target, options) => {
      options.onUnknown({
        error: new ApiError(503, "E_UPSTREAM", "Unknown"),
        recovery: { kind: "External", owner: "LecternMutationNotice" },
      });
      return command.promise;
    };
    const user = userEvent.setup();
    renderLectern(accept);

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    const section = screen.getByRole("region", { name: "At hand suggestions" });
    expect(within(section).getByText("Couldn’t confirm Add.")).toBeVisible();
    expect(within(section).queryByRole("status")).toBeNull();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(section).not.toHaveAttribute("aria-busy");
    expect(
      within(section).getByRole("button", { name: "Add Item 1 to Lectern" }),
    ).toBeDisabled();
  });

  it("announces an activation-time command rejection without a post-commit read", async () => {
    const initial = [slateItem(1), slateItem(2)];
    lecternSlateResponse.mockResolvedValueOnce({ items: initial });
    const command = deferred<AcceptResult>();
    const accept = vi.fn<ReadingSlateAccept>(() => command.promise);
    const user = userEvent.setup();
    const view = renderLectern(accept);

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    view.rerender(lecternNode(accept, false));
    view.rerender(lecternNode(accept, true));
    await act(async () =>
      command.resolve({
        kind: "Rejected",
        error: new ApiError(409, "E_CONFLICT", "Already filed"),
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Already filed");
    expect(screen.getByRole("link", { name: /Item 1/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Add Item 1 to Lectern" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("region", { name: "At hand suggestions" }),
    ).not.toHaveAttribute("aria-busy");
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(1);
  });

  it("preserves rows through a busy activation refresh and quiet retry", async () => {
    const initial = [slateItem(1), slateItem(2)];
    const refresh = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: initial })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce({ items: [slateItem(3)] });
    const accept = vi.fn<ReadingSlateAccept>();
    const user = userEvent.setup();
    const view = renderLectern(accept);
    const section = await screen.findByRole("region", {
      name: "At hand suggestions",
    });
    expect(
      await within(section).findByRole("link", { name: /Item 1/ }),
    ).toBeVisible();

    view.rerender(lecternNode(accept, false));
    view.rerender(lecternNode(accept, true));
    await waitFor(() => expect(section).toHaveAttribute("aria-busy", "true"));
    expect(within(section).getByRole("link", { name: /Item 1/ })).toBeVisible();
    await act(async () =>
      refresh.reject(new ApiError(400, "E_INVALID_REQUEST", "Refresh failed")),
    );

    const retry = await within(section).findByRole("button", { name: "Retry" });
    expect(
      within(section).getByText("Couldn’t refresh suggestions."),
    ).toBeVisible();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(section).not.toHaveAttribute("aria-busy");
    expect(
      within(section).getByRole("button", { name: "Add Item 1 to Lectern" }),
    ).toBeEnabled();
    await user.click(retry);
    expect(
      await within(section).findByRole("link", { name: /Item 3/ }),
    ).toBeVisible();
  });

  it("preserves disabled survivors through refill failure and section-level retry", async () => {
    const initial = [slateItem(1), slateItem(2)];
    const retriedRefill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: initial })
      .mockRejectedValueOnce(
        new ApiError(400, "E_INVALID_REQUEST", "Refill failed"),
      )
      .mockImplementationOnce(() => retriedRefill.promise);
    const user = userEvent.setup();
    renderLectern(async () => ({ kind: "Accepted" }));

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    const section = screen.getByRole("region", { name: "At hand suggestions" });
    const retry = await within(section).findByRole("button", { name: "Retry" });
    expect(
      within(section).getByText("Added, but couldn’t refill suggestions."),
    ).toBeVisible();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(within(section).getByRole("link", { name: /Item 2/ })).toBeVisible();
    expect(
      within(section).getByRole("button", { name: "Add Item 2 to Lectern" }),
    ).toBeDisabled();

    await user.click(retry);
    expect(section).toHaveAttribute("aria-busy", "true");
    await act(async () =>
      retriedRefill.resolve({ items: [initial[1], slateItem(3)] }),
    );
    expect(
      await within(section).findByRole("link", { name: /Item 3/ }),
    ).toBeVisible();
    expect(section).not.toHaveAttribute("aria-busy");
  });

  it("focuses the previous survivor when the accepted row was last", async () => {
    const initial = [slateItem(1), slateItem(2), slateItem(3)];
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: initial })
      .mockImplementationOnce(() => refill.promise);
    const user = userEvent.setup();
    renderLectern(async () => ({ kind: "Accepted" }));

    await user.click(
      await screen.findByRole("button", { name: "Add Item 3 to Lectern" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Item 2/ })).toHaveFocus(),
    );
  });

  it("moves focus to pane chrome before a terminal empty slate unmounts", async () => {
    const only = slateItem(1);
    const command = deferred<AcceptResult>();
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: [only] })
      .mockImplementationOnce(() => refill.promise);
    const user = userEvent.setup();
    renderLectern(() => command.promise);

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );
    await act(async () => command.resolve({ kind: "Accepted" }));
    const section = screen.getByRole("region", { name: "At hand suggestions" });
    await waitFor(() => expect(section).toHaveFocus());

    await act(async () => refill.resolve({ items: [] }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "At hand suggestions" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Pane chrome" })).toHaveFocus();
  });

  it("moves focus directly to pane chrome when a terminal refill settles immediately", async () => {
    const only = slateItem(1);
    lecternSlateResponse
      .mockResolvedValueOnce({ items: [only] })
      .mockResolvedValueOnce({ items: [] });
    const user = userEvent.setup();
    renderLectern(async () => ({ kind: "Accepted" }));

    await user.click(
      await screen.findByRole("button", { name: "Add Item 1 to Lectern" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "At hand suggestions" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Pane chrome" })).toHaveFocus();
  });

  it("moves focus to pane chrome before a terminal refresh removes the focused row", async () => {
    const only = slateItem(1);
    const refresh = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce({ items: [only] })
      .mockImplementationOnce(() => refresh.promise);
    const accept = vi.fn<ReadingSlateAccept>();
    const view = renderLectern(accept);

    const focusedRow = await screen.findByRole("link", { name: /Item 1/ });
    const paneChrome = screen.getByRole("button", { name: "Pane chrome" });
    let rowWasConnectedAtFocusHandoff = false;
    paneChrome.addEventListener(
      "focus",
      () => {
        rowWasConnectedAtFocusHandoff = focusedRow.isConnected;
      },
      { once: true },
    );
    focusedRow.focus();
    expect(focusedRow).toHaveFocus();
    view.rerender(lecternNode(accept, false));
    view.rerender(lecternNode(accept, true));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "At hand suggestions" }),
      ).toHaveAttribute("aria-busy", "true"),
    );

    await act(async () => refresh.resolve({ items: [] }));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "At hand suggestions" }),
      ).toBeNull(),
    );
    expect(paneChrome).toHaveFocus();
    expect(rowWasConnectedAtFocusHandoff).toBe(true);
  });

  it("omits library initial loading and renders compact Retry after a read failure", async () => {
    const failed = new ApiError(400, "E_INVALID_REQUEST", "Bad request");
    librarySlateResponse
      .mockRejectedValueOnce(failed)
      .mockResolvedValueOnce({ items: [] });
    const accept = vi.fn<ReadingSlateAccept>();
    const user = userEvent.setup();
    render(
      withRenderEnvironment(
        <ReadingSlateSection
          returnScope="Test.ReadingSlate"
          destination={{ kind: "Library", id: "library-1", name: "Research" }}
          paneId="pane-1"
          isActive
          accept={accept}
        />,
      ),
    );

    expect(
      screen.queryByRole("region", { name: "Suggestions for Research" }),
    ).toBeNull();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Couldn’t load suggestions.")).toBeVisible();
    await user.click(retry);
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Suggestions for Research" }),
      ).toBeNull(),
    );
    expect(
      fetchCallsForPath(fetchMock, "/api/libraries/library-1/slate"),
    ).toHaveLength(2);
  });
});
