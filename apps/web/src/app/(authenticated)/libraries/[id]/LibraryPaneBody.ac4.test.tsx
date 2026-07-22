import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import {
  fetchCallsForPath,
  fetchInputPath,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import {
  OPEN_LAUNCHER_EVENT,
  type OpenLauncherDetail,
} from "@/lib/launcher/launcherEvents";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import type { PanePrimaryChromePublicationUpdate } from "@/lib/panes/panePublications";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import LibraryPaneBody from "./LibraryPaneBody";

// AC-4 hydration-hit: when the server prefetched the library pane's primary
// resource into the bootstrap hydration cache under the bare library id (the
// same cacheKey `libraryResource` reads — see paneResourceLoaders.library seeding
// `{ library, entries }`), LibraryPaneBody must paint from the seed and never
// fetch `/api/libraries/<id>`. We exercise the real useResource → apiFetch →
// global fetch path (apiFetch is NOT mocked) and assert the library GET never
// fires. `usePanePrimaryChrome` / `usePaneSecondary` no-op without their
// contexts, so the minimal harness is FeedbackProvider + PaneRuntimeProvider.

const LIBRARY_ID = "ac4-library";
const LIBRARY_NAME = "AC-4 Seeded Library";
const ACTION_MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function seededLibrary() {
  // Minimal valid Library in the loader's composed shape. `entries: []` keeps
  // the body in its empty state, so the only candidate primary network call is
  // the library GET, which the seed serves.
  return {
    id: LIBRARY_ID,
    name: LIBRARY_NAME,
    color: "#0ea5e9",
    is_default: false,
    role: "admin",
    owner_user_id: "user-1",
    system_key: null,
    can_rename: true,
    can_delete: true,
    can_edit_entries: true,
  };
}

function seededSystemLibraryWithMutableMedia() {
  return {
    library: {
      id: LIBRARY_ID,
      name: "Oracle Corpus",
      color: null,
      is_default: false,
      role: "admin",
      owner_user_id: "user-1",
      system_key: "oracle_corpus",
      can_rename: false,
      can_delete: false,
      can_edit_entries: false,
    },
    entries: [
      seededMediaEntry("entry-1", "media-1", "Corpus Work", {
        capabilities: {
          can_delete: true,
          can_refresh_source: true,
          can_retry: true,
          can_retry_metadata: true,
        },
      }),
    ],
    entriesPage: { has_more: false, next_cursor: null },
  };
}

function mediaEntryWire(
  id: string,
  mediaId: string,
  title: string,
  options: {
    readState?: "unread" | "in_progress" | "finished";
    progressFraction?: number | null;
    totalMinutes?: number;
    remainingMinutes?: number;
    capabilities?: Record<string, boolean>;
  } = {},
) {
  return {
    id,
    kind: "media",
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    media: {
      id: mediaId,
      kind: "web_article",
      title,
      contributors: [],
      published_date: null,
      publisher: null,
      canonical_source_url: null,
      processing_status: "ready_for_reading",
      read_state: options.readState ?? "unread",
      progress_fraction: options.progressFraction ?? null,
      capabilities: { can_quote: true, ...options.capabilities },
    },
    readingTimeEstimate: {
      kind: "Present",
      value: {
        totalMinutes: options.totalMinutes ?? 15,
        remainingMinutes:
          options.remainingMinutes === undefined
            ? { kind: "Absent" }
            : { kind: "Present", value: options.remainingMinutes },
      },
    },
  };
}

function seededMediaEntry(
  ...args: Parameters<typeof mediaEntryWire>
) {
  return decodeLibraryReadingTimeEntry(mediaEntryWire(...args));
}

function fetchInputPathWithSearch(input: unknown): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

// LibraryPaneBody now consumes the Lectern capability (mark-finished / mark-unread /
// add-to-lectern), so it must render under a LecternProvider. The provider issues an
// initial GET /api/lectern on mount; `lecternGetResponse` answers it with an empty
// snapshot envelope so the provider settles to Ready without console noise.
function LecternStatusProbe() {
  return (
    <span hidden data-testid="lectern-status">
      {useLectern().resource.status}
    </span>
  );
}

const paneWithLectern = (
  <LecternProvider>
    <LecternStatusProbe />
    <LibraryPaneBody />
  </LecternProvider>
);

function lecternGetResponse(input: unknown): Response | null {
  const path = fetchInputPath(input);
  if (path === "/api/lectern" || path === `/api/libraries/${LIBRARY_ID}/slate`) {
    return Response.json({ data: { items: [] } });
  }
  return null;
}

function consumptionSuccessResponse(): Response {
  return Response.json({
    data: {
      outcome: { kind: "StateOnly" },
      lectern: { items: [] },
      nextItem: { kind: "Absent" },
      listeningStates: [],
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LibraryPaneBody (AC-4 hydration hit)", () => {
  it.each([320, 390, 960])(
    "keeps a populated canonical row within the real %ipx Library pane host",
    async (width) => {
      stubFetch(async (input) => {
        const lectern = lecternGetResponse(input);
        if (lectern) return lectern;
        return Response.json({});
      });
      const longTitle =
        "A deliberately long Library title that must wrap compactly without widening the pane";

      renderHydratedPane({
        href: `/libraries/${LIBRARY_ID}`,
        resources: {
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [seededMediaEntry("entry-width", ACTION_MEDIA_ID, longTitle)],
            entriesPage: { has_more: false, next_cursor: null },
          },
        },
        children: (
          <div
            data-testid={`library-host-${width}`}
            style={{ width: `${width}px`, maxWidth: `${width}px` }}
          >
            {paneWithLectern}
          </div>
        ),
      });

      expect(await screen.findByText(longTitle)).toBeVisible();
      const host = screen.getByTestId(`library-host-${width}`);
      expect(host.clientWidth).toBe(width);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(horizontallyScrollableElements(host)).toEqual([]);
      expect(screen.getByRole("list", { name: "Library entries" })).toBeVisible();
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.queryByRole("progressbar")).toBeNull();
    },
  );

  it("paints from the bootstrap seed without fetching the library resource", async () => {
    // Any fetch of the library resource is a failure signal; reject it loudly
    // and resolve everything else empty so a stray call never masks the assertion.
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}`) {
        throw new Error(`library resource fetched: ${String(input)}`);
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    const { onSetPaneLabel } = renderHydratedPane({
      href,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    // Seed consumed: the pane left the loading state and rendered the seeded
    // library's empty body (proves resource.data.library/entries drove render).
    expect(
      await screen.findByText("No podcasts or media in this library yet."),
    ).toBeInTheDocument();

    // Seed surfaced: the pane label is published from the seeded library name.
    await waitFor(() => {
      expect(onSetPaneLabel).toHaveBeenCalledWith(
        expect.objectContaining({ label: LIBRARY_NAME }),
      );
    });

    // The hydration hit: the primary library GET never fired.
    const libraryCalls = fetchCallsForPath(
      fetchMock,
      `/api/libraries/${LIBRARY_ID}`,
    );
    expect(libraryCalls).toHaveLength(0);
  });

  it("seeds editable library context into direct Add intent", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return Response.json({});
    });
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    const details: OpenLauncherDetail[] = [];
    const onOpen = (event: Event) => {
      details.push((event as CustomEvent<OpenLauncherDetail>).detail);
    };
    window.addEventListener(OPEN_LAUNCHER_EVENT, onOpen);

    try {
      renderHydratedPane({
        href: `/libraries/${LIBRARY_ID}`,
        resources: {
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [],
            entriesPage: { has_more: false, next_cursor: null },
          },
        },
        children: (
          <PanePrimaryChromeProvider publish={publish}>
            {paneWithLectern}
          </PanePrimaryChromeProvider>
        ),
      });

      let update: PanePrimaryChromePublicationUpdate | undefined;
      await waitFor(() => {
        update = publish.mock.calls
          .map(([value]) => value)
          .find((value) =>
            value.publication?.options?.some(
              (option) => option.id === "add-content",
            ),
          );
        expect(update).toBeDefined();
      });
      const add = update?.publication?.options?.find(
        (option) => option.id === "add-content",
      );
      expect(add?.kind).toBe("command");
      if (add?.kind !== "command")
        throw new Error("Add content command was not published");

      add.onSelect({ triggerEl: null });

      expect(details).toEqual([
        {
          kind: "Add",
          seed: {
            kind: "Content",
            initialFocus: "Url",
            initialDestinations: [
              { id: LIBRARY_ID, name: LIBRARY_NAME, color: "#0ea5e9" },
            ],
          },
        },
      ]);
    } finally {
      window.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen);
    }
  });

  it("does not expose media mutation actions for system-library entries", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    renderHydratedPane({
      href,
      resources: { [LIBRARY_ID]: seededSystemLibraryWithMutableMedia() },
      children: paneWithLectern,
    });

    expect(await screen.findByText("Corpus Work")).toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: "More actions for Corpus Work" }),
    );

    expect(
      await screen.findByRole("menuitem", {
        name: "Chat about this resource",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Retry processing" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Refresh source" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Re-enrich metadata" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Libraries..." }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Delete document" }),
    ).not.toBeInTheDocument();
  });

  it("loads another page of library entries", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`
      ) {
        return Response.json({
          data: [mediaEntryWire("entry-2", "media-2", "Second Page Work")],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    renderHydratedPane({
      href,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "First Page Work")],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("First Page Work")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));

    expect(await screen.findByText("Second Page Work")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("loads another page of resonance-sorted library entries", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?sort=resonance`) {
        return Response.json({
          data: [
            mediaEntryWire("entry-r1", "media-r1", "First Resonance Work"),
          ],
          page: { has_more: true, next_cursor: "cursor-r2" },
        });
      }
      if (
        path ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=resonance&cursor=cursor-r2`
      ) {
        return Response.json({
          data: [
            mediaEntryWire("entry-r2", "media-r2", "Second Resonance Work"),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=resonance`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "Manual Work")],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("First Resonance Work")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));

    expect(
      await screen.findByText("Second Resonance Work"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?sort=resonance&cursor=cursor-r2`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects a malformed load-more entry at the shared reading-time boundary", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`
      ) {
        const invalid = mediaEntryWire("entry-2", "media-2", "Invalid Work");
        Reflect.deleteProperty(invalid, "readingTimeEstimate");
        return Response.json({
          data: [invalid],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "Valid Work")],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("Valid Work")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(
      await screen.findByText("Failed to load more entries"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid Work")).not.toBeInTheDocument();
  });

  it("rejects a malformed resonance entry at the shared reading-time boundary", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=resonance`
      ) {
        const invalid = mediaEntryWire(
          "entry-r1",
          "media-r1",
          "Invalid Resonance Work",
        );
        Reflect.deleteProperty(invalid, "readingTimeEstimate");
        return Response.json({
          data: [invalid],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=resonance`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "Manual Work")],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByText("Failed to rank library entries"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Invalid Resonance Work"),
    ).not.toBeInTheDocument();
  });

  it("optimistically shows finished state and restores progress without losing a concurrent page", async () => {
    const user = userEvent.setup();
    let resolveConsumption!: (response: Response) => void;
    const pendingConsumption = new Promise<Response>((resolve) => {
      resolveConsumption = resolve;
    });
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === "/api/consumption/commands") {
        return pendingConsumption;
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`) {
        return Response.json({
          data: [mediaEntryWire("entry-2", "media-2", "Concurrent Work")],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-1", ACTION_MEDIA_ID, "Progressive Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
            }),
          ],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );
    expect(await screen.findByText("Finished")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(await screen.findByText("Concurrent Work")).toBeInTheDocument();

    resolveConsumption(
      Response.json(
        { error: { code: "E_INVALID", message: "rejected" } },
        { status: 400 },
      ),
    );

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    expect(screen.getByText("Concurrent Work")).toBeInTheDocument();
  });

  it("does not let an older failed command overwrite a newer same-media action", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let commandCount = 0;
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === "/api/consumption/commands") {
        commandCount += 1;
        return commandCount === 1
          ? firstResponse
          : consumptionSuccessResponse();
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-1", ACTION_MEDIA_ID, "Progressive Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
            }),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as unread" }),
    );
    expect(await screen.findByText("Unread · ≈15 min")).toBeInTheDocument();

    resolveFirst(
      Response.json(
        { error: { code: "E_INVALID", message: "rejected" } },
        { status: 400 },
      ),
    );

    await waitFor(() =>
      expect(
        fetchCallsForPath(fetchMock, "/api/consumption/commands"),
      ).toHaveLength(2),
    );
    expect(screen.getByText("Unread · ≈15 min")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    ).toBeInTheDocument();
  });

  it("suppresses a stale estimate in both manual and resonance views after source refresh", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?sort=resonance`) {
        return Response.json({
          data: [
            mediaEntryWire("entry-r1", ACTION_MEDIA_ID, "Refreshing Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
              capabilities: { can_refresh_source: true },
            }),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === `/api/media/${ACTION_MEDIA_ID}/refresh`) {
        return Response.json({
          data: {
            media_id: ACTION_MEDIA_ID,
            source_attempt_id: "attempt-1",
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "refreshed",
            processing_status: "extracting",
            ingest_enqueued: true,
            capabilities: {
              can_read: false,
              can_highlight: false,
              can_quote: false,
              can_search: false,
              can_play: false,
              can_download_file: false,
              can_delete: true,
              can_retry: false,
              can_refresh_source: false,
              can_retry_metadata: false,
            },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=resonance`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-1", ACTION_MEDIA_ID, "Refreshing Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
              capabilities: { can_refresh_source: true },
            }),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Refreshing Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Refresh source" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("50% · ≈5 min left")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Processing")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort" }),
      "manual",
    );
    expect(await screen.findByText("Processing")).toBeInTheDocument();
    expect(screen.queryByText("50% · ≈5 min left")).not.toBeInTheDocument();
  });
});
