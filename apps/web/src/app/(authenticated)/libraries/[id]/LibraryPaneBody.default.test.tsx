import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchCallsForPath,
  fetchInputPath,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import LibraryPaneBody from "./LibraryPaneBody";

// Default-library ("My Library") coverage per the default-library-virtualization
// cutover contract: no reorder UX (no drag handles, no reorder PATCH), no
// resonance sort offered/forced, and pagination merges are deduped by media id
// (the server may hand back a different representative entry id for the same
// media across pages). Every existing LibraryPaneBody fixture uses
// `isDefault: false`; this file is the only isDefault:true coverage.

const LIBRARY_ID = "default-library";
const LIBRARY_NAME = "My Library";

function seededDefaultLibrary() {
  return {
    id: LIBRARY_ID,
    name: LIBRARY_NAME,
    color: null,
    isDefault: true,
    role: "admin",
    ownerUserHandle:
      "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    systemKey: null,
    canRename: false,
    canDelete: false,
    canEditEntries: true,
    canManageMembers: false,
    canTransferOwnership: false,
  };
}

function mediaEntryWire(
  id: string,
  mediaId: string,
  title: string,
  options: { createdAt?: string; mediaCreatedAt?: string } = {},
) {
  return {
    id,
    kind: "media",
    position: 0,
    created_at: options.createdAt ?? "2026-01-01T00:00:00Z",
    media: {
      id: mediaId,
      kind: "web_article",
      title,
      contributors: [],
      published_date: null,
      publisher: null,
      canonical_source_url: null,
      // Distinct from the entry-level created_at above: the default library's
      // "Added" order keys the row line off *this* instant (see addedContext
      // in LibraryPaneBody.tsx), not the physical entry's created_at.
      created_at:
        options.mediaCreatedAt ?? options.createdAt ?? "2026-01-01T00:00:00Z",
      processing_status: "ready_for_reading",
      read_state: "unread",
      progress_fraction: null,
      capabilities: { can_quote: true },
    },
    readingTimeEstimate: {
      kind: "Present",
      value: {
        totalMinutes: 15,
        remainingMinutes: { kind: "Absent" },
      },
    },
  };
}

function seededMediaEntry(...args: Parameters<typeof mediaEntryWire>) {
  return decodeLibraryReadingTimeEntry(mediaEntryWire(...args));
}

function fetchInputPathWithSearch(input: unknown): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

// LibraryPaneBody consumes the Lectern capability (mark-finished / mark-unread /
// add-to-lectern), so it must render under a LecternProvider. The provider issues
// an initial GET /api/lectern on mount; `lecternGetResponse` answers it with an
// empty snapshot envelope so the provider settles to Ready without console noise.
const paneWithLectern = (
  <LecternProvider>
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LibraryPaneBody (Default library)", () => {
  it("shows no drag handles and omits Custom order and the Added — newest duplicate", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", "media-1", "First Default Work"),
            seededMediaEntry("entry-2", "media-2", "Second Default Work"),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("First Default Work")).toBeInTheDocument();
    expect(await screen.findByText("Second Default Work")).toBeInTheDocument();

    // No reorder UX: canReorder = canEditEntries && !library.isDefault is
    // false, so no per-row Move up/down renders even though canEditEntries is
    // true here.
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", {
          name: "More actions for First Default Work",
        }),
      );
    expect(
      screen.queryByRole("menuitem", { name: "Move up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Move down" }),
    ).not.toBeInTheDocument();

    // The Sort-by control offers Default's baseline ("Recently added"), never a
    // "Custom order" (reorder is Default-forbidden) and never an "Added — newest"
    // duplicate of that baseline. The dead "Resonance" option is gone entirely.
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Recently added" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Added — oldest" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Custom order" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Added — newest" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Resonance" }),
    ).not.toBeInTheDocument();
  });

  it("sorts the default library by a factual view via the entries endpoint", async () => {
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        return Response.json({
          data: [mediaEntryWire("entry-t1", "media-t1", "Titled Default Work")],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "Canonical Seed")],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("Titled Default Work")).toBeInTheDocument();
    expect(
      fetchCallsForPath(fetchMock, `/api/libraries/${LIBRARY_ID}/entries`),
    ).toHaveLength(1);
  });

  it("dedupes an appended default-library page by media id, not entry id", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`
      ) {
        // The server hands back a *different* representative entry id
        // ("entry-1b") for the same underlying media ("media-1") already
        // present on the first page, alongside one genuinely new entry.
        return Response.json({
          data: [
            mediaEntryWire("entry-1b", "media-1", "First Default Work"),
            mediaEntryWire("entry-2", "media-2", "Second Default Work"),
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
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "First Default Work")],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("First Default Work")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));

    expect(await screen.findByText("Second Default Work")).toBeInTheDocument();

    // Exactly one row for media-1: the media-keyed dedupe collapsed
    // entry-1/entry-1b into a single row rather than rendering both.
    expect(screen.getAllByText("First Default Work")).toHaveLength(1);
  });

  // Regression: the default library's "Added" row line must be dated by
  // media.created_at (the underlying media's Nexus-entry instant), not the
  // physical library entry's created_at — the two can differ once the same
  // media is deduped across representative entries. Previously untested.
  it("shows Added to Nexus dated by media.created_at under Added — oldest, absent under Recently added", async () => {
    const mediaCreatedIso = "2025-11-02T08:15:00Z";
    const entryCreatedIso = "2026-04-10T00:00:00Z";
    const expectedAddedToNexus = `Added to Nexus ${new Intl.DateTimeFormat(
      undefined,
      { year: "numeric", month: "short", day: "numeric" },
    ).format(new Date(mediaCreatedIso))}`;

    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=added&direction=asc`
      ) {
        return Response.json({
          data: [
            mediaEntryWire("entry-a1", "media-a1", "Oldest Default Work", {
              createdAt: entryCreatedIso,
              mediaCreatedAt: mediaCreatedIso,
            }),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { unmount } = renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=added&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "Canonical Seed")],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByText("Oldest Default Work"),
    ).toBeInTheDocument();
    expect(screen.getByText(expectedAddedToNexus)).toBeInTheDocument();
    unmount();

    // Canonical ("Recently added") view: no Added to Nexus line at all, even
    // though the same media carries the same media.created_at.
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", "media-1", "Canonical Seed", {
              mediaCreatedAt: mediaCreatedIso,
            }),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("Canonical Seed")).toBeInTheDocument();
    expect(screen.queryByText(/Added to Nexus/)).not.toBeInTheDocument();
  });
});
