import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { absent } from "@/lib/api/presence";
import {
  LibraryPlacementControllerProvider,
  useLibraryPlacementController,
} from "@/lib/libraries/placementController";
import {
  MobileChromeProvider,
  useMobileChrome,
} from "@/lib/workspace/mobileChrome";

const LIBRARY_1 = "00000000-0000-4000-8000-000000000001";
const LIBRARY_2 = "00000000-0000-4000-8000-000000000002";

function placement(
  id: string,
  name: string,
  {
    selected = false,
    canAdd = !selected,
    canRemove = selected,
  }: {
    selected?: boolean;
    canAdd?: boolean;
    canRemove?: boolean;
  } = {},
) {
  const canonicalId =
    id === "library-1" ? LIBRARY_1 : id === "library-2" ? LIBRARY_2 : id;
  return {
    id: canonicalId,
    name,
    color: null,
    is_in_library: selected,
    can_add: canAdd,
    can_remove: canRemove,
  };
}

function listResponse(...items: ReturnType<typeof placement>[]) {
  return Response.json({ data: items });
}

function apiError(status: number, code = "E_CONFLICT") {
  return Response.json(
    { error: { code, message: "Request failed", request_id: "req-1" } },
    { status },
  );
}

function Harness() {
  const { openLibraryPlacement } = useLibraryPlacementController();
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const trigger = event.currentTarget;
          openLibraryPlacement(
            { kind: "Media", id: "media-1" },
            {
              returnFocusTo: () => trigger,
              returnFocusFallback: absent(),
            },
          );
        }}
      >
        Open media libraries
      </button>
      <button
        type="button"
        onClick={(event) => {
          const trigger = event.currentTarget;
          openLibraryPlacement(
            { kind: "Podcast", id: "podcast-1" },
            {
              returnFocusTo: () => trigger,
              returnFocusFallback: absent(),
            },
          );
        }}
      >
        Open podcast libraries
      </button>
    </>
  );
}

function ChromePhase() {
  return <div data-testid="mobile-chrome-phase">{useMobileChrome().motionPhase.kind}</div>;
}

function renderHarness(viewport: "desktop" | "mobile" = "desktop") {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: viewport === "mobile" && query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList,
  );
  return render(
    withRenderEnvironment(
      <MobileChromeProvider>
        <LibraryPlacementControllerProvider>
          <Harness />
          <ChromePhase />
        </LibraryPlacementControllerProvider>
      </MobileChromeProvider>,
      viewport === "mobile" ? { initialViewport: "mobile" } : {},
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

describe("LibraryPlacementOverlay", () => {
  it("loads without Share, focuses search, filters, and returns focus", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        calls.push(String(input));
        return listResponse(
          placement("library-1", "Research"),
          placement("library-2", "Reading"),
        );
      }),
    );
    renderHarness();
    const trigger = screen.getByRole("button", {
      name: "Open media libraries",
    });

    await userEvent.click(trigger);

    const search = screen.getByRole("searchbox", {
      name: "Search libraries",
    });
    await waitFor(() => expect(search).toHaveFocus());
    expect(await screen.findByRole("button", { name: "Research" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(calls).toEqual(["/api/media/media-1/libraries"]);
    expect(calls.some((path) => path.includes("/share"))).toBe(false);

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No matching libraries.")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Close dialog" }),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(
      screen.getByRole("button", { name: "Open podcast libraries" }),
    );
    expect(
      screen.getByRole("searchbox", { name: "Search libraries" }),
    ).toHaveValue("");
  });

  it("distinguishes an empty inventory and explains disabled rows", async () => {
    let request = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        request += 1;
        return request === 1
          ? listResponse()
          : listResponse(
              placement("library-1", "Shared", {
                canAdd: false,
                canRemove: false,
              }),
            );
      }),
    );
    renderHarness();

    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );
    expect(
      await screen.findByText("No additional libraries available."),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close dialog" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open podcast libraries" }),
    );

    const row = await screen.findByRole("button", { name: "Shared" });
    expect(row).toBeDisabled();
    expect(screen.getByText("You can’t change this library.")).toBeVisible();
  });

  it("keeps the initiating row focused and refetches server truth after 204", async () => {
    let selected = false;
    let finishCommand: ((response: Response) => void) | null = null;
    const command = new Promise<Response>((resolve) => {
      finishCommand = resolve;
    });
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const response = await command;
          selected = true;
          return response;
        }
        return listResponse(
          placement("library-1", "Research", { selected }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderHarness();
    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );
    const row = await screen.findByRole("button", { name: "Research" });

    await userEvent.click(row);

    await waitFor(() => expect(row).toHaveAttribute("aria-busy", "true"));
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute("aria-disabled", "true");
    await act(async () => finishCommand!(new Response(null, { status: 204 })));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Research" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/media/media-1/libraries",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ library_ids: [LIBRARY_1] }),
      }),
    );
  });

  it("preserves the prior list when a command fails and offers Retry", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        requests += 1;
        return init?.method === "POST"
          ? apiError(409)
          : listResponse(placement("library-1", "Research"));
      }),
    );
    renderHarness();
    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );
    const row = await screen.findByRole("button", { name: "Research" });

    await userEvent.click(row);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to add item to library",
    );
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(requests).toBe(2);
  });

  it("retries a failed list request", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests += 1;
        return requests === 1
          ? apiError(503, "E_UPSTREAM")
          : listResponse(placement("library-1", "Recovered"));
      }),
    );
    renderHarness();
    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(
      screen.queryByText("No additional libraries available."),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("button", { name: "Recovered" }),
    ).toBeVisible();
    expect(requests).toBe(2);
  });

  it("aborts a closed GET and suppresses its stale result after reopening", async () => {
    let finishMedia: ((response: Response) => void) | null = null;
    const media = new Promise<Response>((resolve) => {
      finishMedia = resolve;
    });
    let mediaSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (String(input).includes("/media/")) {
          mediaSignal = init?.signal ?? undefined;
          return media;
        }
        return listResponse(placement("library-2", "Podcast library"));
      }),
    );
    renderHarness();
    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );
    await screen.findByRole("status");
    await userEvent.click(
      screen.getByRole("button", { name: "Close dialog" }),
    );
    expect(mediaSignal?.aborted).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Open podcast libraries" }),
    );
    expect(
      await screen.findByRole("button", { name: "Podcast library" }),
    ).toBeVisible();

    await act(async () =>
      finishMedia!(listResponse(placement("library-1", "Stale media library"))),
    );

    expect(
      screen.queryByRole("button", { name: "Stale media library" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Podcast library" }),
    ).toBeVisible();
  });

  it("serializes a command across close/reopen and reconciles the open session", async () => {
    let finishMediaCommand: ((response: Response) => void) | null = null;
    const mediaCommand = new Promise<Response>((resolve) => {
      finishMediaCommand = resolve;
    });
    let finishInitialPodcastRead: ((response: Response) => void) | null = null;
    const initialPodcastRead = new Promise<Response>((resolve) => {
      finishInitialPodcastRead = resolve;
    });
    let mediaCommandSignal: AbortSignal | null | undefined;
    let initialPodcastSignal: AbortSignal | undefined;
    let podcastReads = 0;
    const fetchMock = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("/media/") && init?.method === "POST") {
          mediaCommandSignal = init.signal;
          return mediaCommand;
        }
        if (path.includes("/media/")) {
          return listResponse(placement("library-1", "Media library"));
        }
        podcastReads += 1;
        if (podcastReads === 1) {
          initialPodcastSignal = init?.signal ?? undefined;
          return initialPodcastRead;
        }
        return listResponse(
          placement("library-1", "Podcast library", {
            selected: true,
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderHarness();
    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Media library" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/media/media-1/libraries",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(mediaCommandSignal).toBeUndefined();
    await userEvent.click(
      screen.getByRole("button", { name: "Close dialog" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open podcast libraries" }),
    );
    await screen.findByRole("status");

    await act(async () =>
      finishMediaCommand!(new Response(null, { status: 204 })),
    );

    await waitFor(() => expect(podcastReads).toBe(2));
    expect(initialPodcastSignal?.aborted).toBe(true);
    const podcastRow = await screen.findByRole("button", {
      name: "Podcast library",
    });
    await waitFor(() =>
      expect(podcastRow).toHaveAttribute("aria-pressed", "true"),
    );
    await act(async () =>
      finishInitialPodcastRead!(
        listResponse(
          placement("library-2", "Stale same-session library"),
        ),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Stale same-session library" }),
    ).not.toBeInTheDocument();
    expect(podcastRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("focuses mobile chrome without summoning the search field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        listResponse(placement("library-1", "Mobile library")),
      ),
    );
    renderHarness("mobile");

    await userEvent.click(
      screen.getByRole("button", { name: "Open media libraries" }),
    );

    const sheet = screen.getByTestId("library-placement-sheet");
    await waitFor(() => expect(sheet).toHaveFocus());
    await waitFor(() =>
      expect(screen.getByTestId("mobile-chrome-phase")).toHaveTextContent("Pinned"),
    );
    expect(
      screen.getByRole("searchbox", { name: "Search libraries" }),
    ).not.toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByTestId("mobile-chrome-phase")).toHaveTextContent("Visible"),
    );
  });
});
