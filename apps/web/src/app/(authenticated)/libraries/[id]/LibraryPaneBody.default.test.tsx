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
import LibraryPaneBody from "./LibraryPaneBody";

// Default-library ("My Library") coverage per the default-library-virtualization
// cutover contract: no reorder UX (no drag handles, no reorder PATCH), no
// resonance sort offered/forced, and pagination merges are deduped by media id
// (the server may hand back a different representative entry id for the same
// media across pages). Every existing LibraryPaneBody fixture uses
// `is_default: false`; this file is the only is_default:true coverage.

const LIBRARY_ID = "default-library";
const LIBRARY_NAME = "My Library";

function seededDefaultLibrary() {
  return {
    id: LIBRARY_ID,
    name: LIBRARY_NAME,
    is_default: true,
    role: "admin",
    owner_user_id: "user-1",
    system_key: null,
    can_rename: false,
    can_delete: false,
    can_edit_entries: true,
  };
}

function seededMediaEntry(id: string, mediaId: string, title: string) {
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
  it("shows no drag handles and offers no Resonance sort option for the default library", async () => {
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

    // No reorder UX: canReorder = canEditEntries && !library.is_default is
    // false, so no drag handle renders even though canEditEntries is true here.
    expect(
      screen.queryByRole("button", { name: /^Reorder / }),
    ).not.toBeInTheDocument();

    // No Resonance sort UI: the sort control is either absent, or if present,
    // never advertises the "Resonance" option.
    const sortControl = screen.queryByRole("combobox", { name: "Sort" });
    if (sortControl) {
      expect(
        screen.queryByRole("option", { name: "Resonance" }),
      ).not.toBeInTheDocument();
    }
  });

  it("never fetches or renders resonance for the default library even with ?sort=resonance in the URL", async () => {
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=resonance`
      ) {
        throw new Error(
          `resonance entries fetched for default library: ${String(input)}`,
        );
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
          library: seededDefaultLibrary(),
          entries: [seededMediaEntry("entry-1", "media-1", "First Default Work")],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    // sort is forced to "manual" for Default regardless of the URL param, so
    // the manually-sorted entry renders and no resonance request ever fires.
    expect(await screen.findByText("First Default Work")).toBeInTheDocument();

    const resonanceCalls = fetchCallsForPath(
      fetchMock,
      `/api/libraries/${LIBRARY_ID}/entries`,
    ).filter(([input]) => fetchInputPathWithSearch(input).includes("resonance"));
    expect(resonanceCalls).toHaveLength(0);
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
            seededMediaEntry("entry-1b", "media-1", "First Default Work"),
            seededMediaEntry("entry-2", "media-2", "Second Default Work"),
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
});
