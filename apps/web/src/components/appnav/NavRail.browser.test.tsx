import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import NavRail from "./NavRail";
import {
  NAV_ACCOUNT,
  NAV_HOME,
  NAV_MODEL,
  NAV_UTILITIES,
  type NavItem,
} from "./navModel";

/**
 * Oracle: contract D9 (one Imports entrance on the rail and one in the shared
 * Account menu, each carrying the same count badge, the accessible name always
 * exact) and the spec's navigation rubric row — the count must be *readable*
 * where it is painted, which the collapsed 48px rail decides geometrically.
 * The rail is rendered with the real navigation model, the real badge and the
 * real stylesheet; only the BFF and the workspace activation the chrome sits in
 * are supplied at their own boundaries.
 */

/** A rail as tall as the desktop viewport it lives in. */
const RAIL_HEIGHT_PX = 720;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installSummary(needsAttentionCount: number): void {
  vi.stubGlobal("fetch", async (target: RequestInfo | URL) => {
    const url = new URL(
      target instanceof Request ? target.url : String(target),
      window.location.origin,
    );
    if (url.pathname === "/api/imports/summary") {
      return jsonResponse({
        data: {
          observed_at: "2026-09-08T12:00:00Z",
          needs_attention_count: needsAttentionCount,
          // Nothing active, so the provider settles after one read.
          active_count: 0,
        },
      });
    }
    return jsonResponse({ data: null });
  });
}

function Rail({
  collapsed,
  utilityActive = false,
  onOpen = () => undefined,
}: {
  readonly collapsed: boolean;
  readonly utilityActive?: boolean;
  readonly onOpen?: (href: string) => void;
}) {
  return withRenderEnvironment(
    <ImportsProvider>
      <div style={{ display: "flex", height: RAIL_HEIGHT_PX }}>
        <NavRail
          items={NAV_MODEL}
          home={NAV_HOME}
          utilities={NAV_UTILITIES}
          account={NAV_ACCOUNT}
          utilityActiveId={utilityActive ? NAV_UTILITIES.imports.id : null}
          accountActiveId={null}
          activeId={null}
          collapsed={collapsed}
          onToggleCollapse={() => undefined}
          commandHint="⌘K"
          commandCombo="Mod+K"
          onOpenCommand={() => undefined}
          onOpenAdd={() => undefined}
          onNavigate={(event, destination: NavItem): AppNavActivationResult => {
            // The workspace opens the destination itself, as it does in the shell.
            event.preventDefault();
            onOpen(destination.href);
            return "handled-destination-focus";
          }}
        />
      </div>
    </ImportsProvider>,
  );
}

function box(element: Element): DOMRect {
  return element.getBoundingClientRect();
}

function describeBox(name: string, rect: DOMRect): string {
  return `${name} ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(
    rect.width,
  )}x${Math.round(rect.height)}`;
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

function contains(outer: DOMRect, inner: DOMRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom
  );
}

/** The glyph the Imports entrance is drawn with. */
function icon(link: HTMLElement): Element {
  // eslint-disable-next-line testing-library/no-node-access -- an icon carries no accessible role by design; its painted box is the subject here
  const glyph = link.querySelector("svg");
  if (glyph === null) throw new Error("The Imports link painted no icon");
  return glyph;
}

/**
 * The surface painted around one piece of the badge's text: the chip a count is
 * drawn in, or — where the badge is hidden — whatever the chrome still paints
 * around its screen-reader-only label. What may not land on the glyph is that
 * whole surface, not the digits inside it.
 */
function paintedAround(host: HTMLElement, text: string): HTMLElement {
  const inner = within(host).getByText(text);
  // eslint-disable-next-line testing-library/no-node-access -- the surface is the parent of the text it wraps and carries no role of its own
  const surface = inner.parentElement;
  if (surface === null) {
    throw new Error(`"${text}" was painted outside the badge`);
  }
  return surface;
}

describe("Navigation rail", () => {
  // One digit and the widest a count ever paints: the cap is what tests the
  // 48px rail's room.
  const COLLAPSED_COUNTS: readonly [number, string, string][] = [
    [1, "1", "Imports, 1 needs attention"],
    [150, "99+", "Imports, 150 need attention"],
  ];

  it.each(COLLAPSED_COUNTS)(
    "paints a collapsed count of %i clear of the icon it belongs to",
    async (count, painted, name) => {
      installSummary(count);

      render(<Rail collapsed />);

      const link = await screen.findByRole("link", { name });

      await waitFor(() => {
        const chip = box(paintedAround(link, painted));
        const glyph = box(icon(link));
        expect(
          Math.min(chip.width, chip.height),
          "the collapsed rail painted no count chip at all",
        ).toBeGreaterThan(1);
        expect(
          chip.height,
          `the collapsed count is not the smaller chip a 48px rail has room for: ${describeBox(
            "chip",
            chip,
          )} vs ${describeBox("icon", glyph)}`,
        ).toBeLessThan(glyph.height);
        expect(
          overlaps(chip, glyph),
          `the count chip is painted over the icon, so no digit can be read: ${describeBox(
            "chip",
            chip,
          )} vs ${describeBox("icon", glyph)}`,
        ).toBe(false);
        expect(
          contains(box(link), chip),
          `the count chip is painted outside the link it counts for, so a click on the count misses it: ${describeBox(
            "chip",
            chip,
          )} vs ${describeBox("link", box(link))}`,
        ).toBe(true);
      });

      // The rail lifts and grows an item's icon on hover, which is the one
      // state that can move the glyph into the clearance the chip is designed
      // with, so the clearance is proved hovered as well as at rest.
      const restingSurface = getComputedStyle(link).backgroundColor;
      await userEvent.hover(link);
      await waitFor(() => {
        expect(
          getComputedStyle(link).backgroundColor,
          "the collapsed Imports link never entered its hover state",
        ).not.toBe(restingSurface);
        const chip = box(paintedAround(link, painted));
        const glyph = box(icon(link));
        expect(
          overlaps(chip, glyph),
          `the hovered icon reaches the count chip: ${describeBox(
            "chip",
            chip,
          )} vs ${describeBox("icon", glyph)}`,
        ).toBe(false);
      });
    },
  );

  it("paints the expanded attention count beside the label it qualifies", async () => {
    installSummary(150);

    render(<Rail collapsed={false} />);

    const link = await screen.findByRole("link", {
      name: "Imports, 150 need attention",
    });

    await waitFor(() => {
      const chip = box(paintedAround(link, "99+"));
      const label = box(within(link).getByText("Imports"));
      const glyph = box(icon(link));
      expect(
        chip.left,
        `the capped count is not beside its label: ${describeBox(
          "chip",
          chip,
        )} vs ${describeBox("label", label)}`,
      ).toBeGreaterThanOrEqual(label.right);
      expect(
        overlaps(chip, glyph),
        `the capped count is painted over the icon: ${describeBox(
          "chip",
          chip,
        )} vs ${describeBox("icon", glyph)}`,
      ).toBe(false);
    });
    expect(
      link,
      "the rail marks Imports current for a workspace that is not on the pane",
    ).not.toHaveAttribute("aria-current");
  });

  it("paints no chip on the collapsed rail when no import needs attention", async () => {
    installSummary(0);

    render(<Rail collapsed />);

    const link = await screen.findByRole("link", { name: "Imports" });

    await waitFor(() => {
      const surface = box(paintedAround(link, "Imports"));
      expect(
        Math.max(surface.width, surface.height),
        `a settled Imports entrance painted an empty chip: ${describeBox(
          "chip",
          surface,
        )}`,
      ).toBeLessThanOrEqual(1);
    });
  });

  it("offers Imports in the Account menu with the same count and the pane it opens", async () => {
    installSummary(1);
    const opened: string[] = [];

    const { rerender } = render(
      <Rail
        collapsed={false}
        utilityActive
        onOpen={(href) => opened.push(href)}
      />,
    );

    await screen.findByRole("link", { name: "Imports, 1 needs attention" });
    await userEvent.click(screen.getByRole("button", { name: "Account" }));

    const item = await screen.findByRole("menuitem", {
      name: "Imports, 1 needs attention",
    });
    expect(item).toHaveAttribute("href", "/imports");
    const chip = box(paintedAround(item, "1"));
    expect(
      Math.min(chip.width, chip.height),
      "the Account entrance names the count but paints none",
    ).toBeGreaterThan(1);
    expect(
      item,
      "the Account entrance does not mark itself current while the workspace is on the pane",
    ).toHaveAttribute("aria-current", "page");

    rerender(
      <Rail collapsed={false} onOpen={(href) => opened.push(href)} />,
    );
    const offPane = await screen.findByRole("menuitem", {
      name: "Imports, 1 needs attention",
    });
    expect(
      offPane,
      "the Account entrance marks itself current for a workspace that is not on the pane",
    ).not.toHaveAttribute("aria-current");

    await userEvent.click(offPane);
    expect(
      opened,
      "the Account entrance did not open the Imports pane",
    ).toEqual(["/imports"]);
  });
});
