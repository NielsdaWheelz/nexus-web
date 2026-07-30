/**
 * LibraryChooserSurface — the responsive placement/portal/dismissal/focus owner
 * (library-chooser-interaction-hard-cutover.md §3/§6). Real Chromium, real
 * providers, no internal vi.mock. These cover the surface responsibilities the
 * child LibraryChooser and the e2e do not: desktop anchored portal, focus-search-
 * on-open, Escape / outside-pointer dismissal, trigger-pointer non-dismissal, and
 * return-focus.
 *
 * The browser project's default viewport is narrow (414px → mobile), so the
 * desktop path is driven by resizing the real viewport via `page.viewport`; the
 * repo's setup `matchMedia` reflects `window.innerWidth`, so this exercises the
 * genuine responsive branch rather than a matchMedia mock.
 */
import { useRef, useState } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent, page } from "vitest/browser";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import LibraryChooserSurface from "./LibraryChooserSurface";

function Harness({
  layer = "modal",
  onClose,
}: {
  layer?: "modal" | "palette";
  onClose: () => void;
}) {
  const [active, setActive] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={anchorRef} onClick={() => setActive((v) => !v)}>
        Open chooser
      </button>
      <LibraryChooserSurface
        active={active}
        onClose={() => {
          setActive(false);
          onClose();
        }}
        layer={layer}
        anchor={() => anchorRef.current}
        title="Libraries"
        panelTestId="library-chooser-sheet"
      >
        <div>
          <input
            role="combobox"
            aria-label="Search"
            aria-expanded="true"
            aria-controls="library-chooser-listbox"
          />
          <div
            id="library-chooser-listbox"
            role="listbox"
            aria-label="Library options"
          >
            <div role="option" aria-selected={false}>
              Reading
            </div>
          </div>
        </div>
      </LibraryChooserSurface>
    </>
  );
}

describe("LibraryChooserSurface", () => {
  beforeEach(async () => {
    // A wide viewport keeps the desktop anchored-popover branch active.
    await page.viewport(1024, 768);
  });

  it("opens an anchored desktop panel, focuses the search combobox, and reflects the layer", async () => {
    const user = userEvent.setup();
    render(<Harness layer="palette" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open chooser" }));

    const combobox = await screen.findByRole("combobox", { name: "Search" });
    await waitFor(() => expect(combobox).toHaveFocus());
    const dialog = screen.getByRole("dialog", { name: "Libraries" });
    expect(dialog).toHaveAttribute("data-layer", "palette");
    expect(dialog).toContainElement(combobox);
  });

  it("closes on Escape from within the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Open chooser" }));
    const combobox = await screen.findByRole("combobox", { name: "Search" });
    await waitFor(() => expect(combobox).toHaveFocus());

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("combobox", { name: "Search" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("closes on a pointerdown outside the anchor and panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Open chooser" }));
    await screen.findByRole("combobox", { name: "Search" });

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not treat a pointerdown on the anchor as an outside dismissal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    const anchor = screen.getByRole("button", { name: "Open chooser" });
    await user.click(anchor);
    await screen.findByRole("combobox", { name: "Search" });

    fireEvent.pointerDown(anchor);

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "Search" }),
    ).toBeInTheDocument();
  });

  it("restores focus to the anchor when the desktop chooser closes", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={vi.fn()} />);

    const anchor = screen.getByRole("button", { name: "Open chooser" });
    await user.click(anchor);
    const combobox = await screen.findByRole("combobox", { name: "Search" });
    await waitFor(() => expect(combobox).toHaveFocus());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(anchor).toHaveFocus());
  });

  it("renders the MobileSheet on a mobile viewport without a desktop popover or auto-focused search", async () => {
    await page.viewport(414, 800);
    const user = userEvent.setup();
    render(
      withRenderEnvironment(<Harness onClose={vi.fn()} />, {
        initialViewport: "mobile",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Open chooser" }));

    const sheet = await screen.findByTestId("library-chooser-sheet");
    expect(sheet).toHaveAttribute("role", "dialog");
    expect(sheet).toHaveAttribute("aria-label", "Libraries");
    await waitFor(() => expect(sheet).toHaveFocus());
    // Initial focus is the sheet chrome, not the search — opening must not
    // summon the mobile keyboard (spec §3).
    expect(
      within(sheet).getByRole("combobox", { name: "Search" }),
    ).not.toHaveFocus();
  });
});
