/**
 * LibraryPlacementOverlay — the standing-placement wiring of the shared chooser
 * (library-chooser-interaction-hard-cutover.md §2/§4/§6). Real Chromium, real
 * providers, real fetch boundary (no internal vi.mock): this drives the placement
 * flow through the new LibraryChooserSurface + LibraryEntryEditor + LibraryChooser
 * stack rather than the deleted desktop Dialog.
 *
 * The browser project's default viewport is narrow (mobile); the desktop
 * anchored-popover branch is exercised by resizing the real viewport via
 * `page.viewport`, matching LibraryChooserSurface.test.tsx.
 */
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { absent } from "@/lib/api/presence";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeReaderScrollport,
} from "@/lib/workspace/mobileChrome";
import LibraryPlacementOverlay from "./LibraryPlacementOverlay";

const LIBRARY_1 = "00000000-0000-4000-8000-000000000001";

function wireRow(id: string, name: string, inLibrary: boolean) {
  return {
    id,
    name,
    color: null,
    is_in_library: inLibrary,
    can_add: !inLibrary,
    can_remove: inLibrary,
  };
}

function listResponse(...rows: ReturnType<typeof wireRow>[]) {
  return Response.json({ data: rows });
}

function Harness() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [session, setSession] = useState<LibraryPlacementSession | null>(null);
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        onClick={() =>
          setSession({
            key: 1,
            target: { kind: "Media", id: "media-1" },
            options: {
              anchor: () => anchorRef.current,
              returnFocusFallback: absent(),
            },
          })
        }
      >
        Open libraries
      </button>
      <LibraryPlacementOverlay
        session={session}
        onClose={() => setSession(null)}
      />
    </>
  );
}

function MotionPhase() {
  const { motionPhase } = useMobileChrome();
  return <output data-testid="mobile-chrome-phase">{motionPhase.kind}</output>;
}

function ReaderScrollport() {
  const registerScrollport = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey: "library-placement-test",
    enabled: true,
  });
  return (
    <div
      ref={registerScrollport}
      data-testid="reader-scrollport"
      style={{ height: 100, overflowY: "auto" }}
    >
      <div style={{ height: 1_000 }} />
    </div>
  );
}

describe("LibraryPlacementOverlay", () => {
  beforeEach(async () => {
    // A wide viewport keeps the desktop anchored-popover branch of the surface.
    await page.viewport(1024, 768);
  });

  it("opens the chooser, toggles a placement through POST + reconcile, and returns focus on Escape", async () => {
    let selected = false;
    const calls: { method: string; path: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({
          method,
          path: String(input),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (method === "POST") {
          selected = true;
          return new Response(null, { status: 204 });
        }
        return listResponse(wireRow(LIBRARY_1, "Research", selected));
      }),
    );
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Open libraries" });
    await user.click(trigger);

    // The surface renders the placement copy and focuses the search combobox.
    const combobox = await screen.findByRole("combobox", {
      name: "Search libraries",
    });
    await waitFor(() => expect(combobox).toHaveFocus());
    expect(
      screen.getByRole("listbox", { name: "Library options" }),
    ).toBeInTheDocument();

    // The library option renders as an unselected multi-select option.
    const option = await screen.findByRole("option", { name: "Research" });
    expect(option).toHaveAttribute("aria-selected", "false");

    // Toggling issues the POST, then the reconcile GET flips membership.
    await user.click(option);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Research" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(calls).toEqual([
      { method: "GET", path: "/api/media/media-1/libraries", body: undefined },
      {
        method: "POST",
        path: "/api/media/media-1/libraries",
        body: JSON.stringify({ library_ids: [LIBRARY_1] }),
      },
      { method: "GET", path: "/api/media/media-1/libraries", body: undefined },
    ]);

    // Escape closes the surface and restores focus to the opener.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", { name: "Search libraries" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows the empty-inventory copy when no libraries exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => listResponse()),
    );
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open libraries" }));

    expect(
      await screen.findByText("No libraries to place this in."),
    ).toBeInTheDocument();
  });

  it("pins mobile chrome for the picker lifecycle and releases on close", async () => {
    await page.viewport(390, 844);
    vi.stubGlobal("fetch", vi.fn(async () => listResponse()));
    const user = userEvent.setup();
    render(
      <MobileChromeProvider>
        <MobileViewportProvider>
          <MotionPhase />
          <ReaderScrollport />
          <Harness />
        </MobileViewportProvider>
      </MobileChromeProvider>,
    );

    const phase = screen.getByTestId("mobile-chrome-phase");
    const scrollport = screen.getByTestId("reader-scrollport");
    scrollport.scrollTop = 9;
    fireEvent.scroll(scrollport);
    scrollport.scrollTop = 100;
    fireEvent.scroll(scrollport);
    await waitFor(() => expect(phase).toHaveTextContent("Hidden"));

    const trigger = screen.getByRole("button", { name: "Open libraries" });
    await user.click(trigger);
    await waitFor(() =>
      expect(phase).toHaveTextContent("Pinned"),
    );

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(phase).toHaveTextContent("Visible"),
    );
    await waitFor(() => expect(trigger).toHaveFocus());

    scrollport.scrollTop = 108;
    fireEvent.scroll(scrollport);
    scrollport.scrollTop = 116;
    fireEvent.scroll(scrollport);
    await waitFor(() => expect(phase).toHaveTextContent("Tracking"));
  });
});
