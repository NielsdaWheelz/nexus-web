import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import FloatingActionSurface, {
  type FloatingActionDismissReason,
} from "@/components/ui/FloatingActionSurface";
import {
  buildSelectionActions,
  projectSelectionActionPlan,
  type SelectionActionPlan,
} from "./selectionActions";
import SelectionActionDock from "./SelectionActionDock";

/**
 * Oracle: `docs/cutovers/text-selection-icon-toolbar-hard-cutover.md` §4.1,
 * §4.2, §5.1, §5.2 and §9 AC1–AC7. Real CSS, real Chromium geometry, real
 * `ActionMenu` / `FloatingActionSurface` collaborators.
 */

const DIRECT_ROW: readonly string[] = [
  "Highlight",
  "Note",
  "Link",
  "Ask",
  "More",
];
const OVERFLOW_MENU: readonly string[] = [
  "Learn",
  "Ask in existing chat…",
  "Share",
];
const PASSAGE = "There is water ice at the lunar south pole.";
const noop = () => {};

function selectionPlan({
  chat = true,
  note = true,
  learn = true,
  share = true,
  changingColor = false,
  onLearn = noop,
}: {
  chat?: boolean;
  note?: boolean;
  learn?: boolean;
  share?: boolean;
  changingColor?: boolean;
  onLearn?: () => void;
} = {}): SelectionActionPlan {
  return projectSelectionActionPlan(
    buildSelectionActions({
      color: "yellow",
      canQuoteToChat: chat,
      canAddNote: note,
      changingColor,
      handlers: {
        onSelectColor: noop,
        onAddNote: note ? noop : undefined,
        onLink: noop,
        onShare: share ? noop : undefined,
        onLearn: learn ? onLearn : undefined,
        onQuoteToNewChat: chat ? noop : undefined,
        onQuoteToExistingChat: chat ? noop : undefined,
      },
    }),
  );
}

function dock() {
  return screen.getByRole("toolbar", { name: "Selection actions" });
}

/** The rendered toolbar order, relabelled by the names it is expected to hold. */
function renderedOrder(expectedNames: readonly string[]): string[] {
  const toolbar = dock();
  const expected = expectedNames.map((name) =>
    within(toolbar).getByRole("button", { name }),
  );
  return within(toolbar)
    .getAllByRole("button")
    .map((control) => {
      const index = expected.indexOf(control);
      return index < 0 ? "unnamed control" : expectedNames[index];
    });
}

function glyphSizes(
  controls: readonly HTMLElement[],
): Array<{ control: string; width: number; height: number }> {
  return controls.flatMap((control) => {
    const name = control.getAttribute("aria-label") ?? "unnamed control";
    // justify-eslint-override: spec §5.2 hides decorative glyphs from the
    // accessibility tree, so their real rendered geometry cannot be reached by
    // any role/name query. Reading it is the only way to prove the icon scale.
    // eslint-disable-next-line testing-library/no-node-access
    const glyphs = Array.from(control.querySelectorAll("svg"));
    if (glyphs.length === 0) {
      throw new Error(`Toolbar control ${name} rendered no glyph.`);
    }
    return glyphs.map((glyph) => {
      const rect = glyph.getBoundingClientRect();
      return { control: name, width: rect.width, height: rect.height };
    });
  });
}

/** The rendered value of a design token, in the form computed styles report. */
function resolvedToken(token: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${token})`;
  document.body.append(probe);
  const resolved = window.getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

function Dock({
  plan,
  pendingActionId = null,
  showDock = true,
}: {
  plan: SelectionActionPlan;
  pendingActionId?: "learn" | "quote-new" | null;
  showDock?: boolean;
}) {
  return (
    <>
      <button type="button">Return to passage</button>
      {showDock ? (
        <SelectionActionDock
          plan={plan}
          pendingActionId={pendingActionId}
          externalBusy={false}
        />
      ) : null}
    </>
  );
}

function SelectionSurface({
  plan,
  onDismiss,
}: {
  plan: SelectionActionPlan;
  onDismiss: (reason: FloatingActionDismissReason) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <p ref={setAnchor}>{PASSAGE}</p>
      <FloatingActionSurface
        open
        anchor={anchor}
        placement="below"
        preservePointerSelection
        onDismiss={onDismiss}
      >
        <SelectionActionDock
          plan={plan}
          pendingActionId={null}
          externalBusy={false}
        />
      </FloatingActionSurface>
    </>
  );
}

describe("selection action toolbar in Chromium", () => {
  beforeEach(async () => {
    await page.viewport(1_024, 768);
  });

  it("renders the canonical controls as one icon-only row", async () => {
    render(withRenderEnvironment(<Dock plan={selectionPlan()} />));

    expect(
      renderedOrder(DIRECT_ROW),
      "AC1: the toolbar must expose exactly Highlight · Note · Link · Ask · More in that order",
    ).toEqual([...DIRECT_ROW]);

    const toolbar = dock();
    for (const name of DIRECT_ROW) {
      expect(
        toolbar.textContent ?? "",
        `AC3: "${name}" is rendered as visible text; direct controls are icon-only`,
      ).not.toContain(name);
      expect(
        within(toolbar).getByRole("button", { name }),
        `spec §5.2: "${name}" is a wordless control, so its native title must carry the same canonical name as its accessible name`,
      ).toHaveAttribute("title", name);
    }

    const highlight = within(toolbar).getByRole("button", {
      name: "Highlight",
    });
    // justify-eslint-override: spec §5.1 makes colour a state of Highlight, so
    // the ink indicator is decorative and unreachable by any role/name query.
    // eslint-disable-next-line testing-library/no-node-access
    const highlightParts = Array.from(highlight.querySelectorAll("span"));
    expect(
      highlightParts
        .map((part) => window.getComputedStyle(part).backgroundColor)
        .filter((color) => color === resolvedToken("--highlight-yellow")),
      "spec §5.1: the Highlight glyph must report the ink the next swatch press lays down",
    ).toEqual([resolvedToken("--highlight-yellow")]);

    const singleRow = () => {
      const rects = within(toolbar)
        .getAllByRole("button")
        .map((control) => control.getBoundingClientRect());
      expect(
        new Set(rects.map((rect) => rect.top)).size,
        `AC3: the direct row wrapped at ${window.innerWidth}px — control tops were ${rects.map((rect) => rect.top).join(", ")}`,
      ).toBe(1);
      expect(
        toolbar.scrollWidth,
        `AC3: the direct row scrolls at ${window.innerWidth}px — ${toolbar.scrollWidth}px of content in ${toolbar.clientWidth}px`,
      ).toBeLessThanOrEqual(toolbar.clientWidth);
    };

    singleRow();
    await page.viewport(320, 720);
    singleRow();
  });

  it("keeps one roving tab stop and returns focus to the passage when the selection ends", async () => {
    const plan = selectionPlan();
    const view = render(withRenderEnvironment(<Dock plan={plan} />));
    const returnTarget = screen.getByRole("button", {
      name: "Return to passage",
    });
    returnTarget.focus();

    fireEvent.keyDown(window, { key: "F10", altKey: true });
    expect(
      screen.getByRole("button", { name: "Highlight" }),
      "spec §5.2: Alt+F10 must enter the toolbar at its first control",
    ).toHaveFocus();

    await userEvent.keyboard("{End}");
    expect(
      screen.getByRole("button", { name: "More" }),
      "spec §5.2: End must reach More, which participates in the roving sequence",
    ).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(
      screen.getByRole("button", { name: "Highlight" }),
      "spec §5.2: Home must return to the first toolbar control",
    ).toHaveFocus();

    const tabStops = within(dock())
      .getAllByRole("button")
      .filter((control) => control.tabIndex === 0);
    expect(
      tabStops.length,
      `spec §5.2: a toolbar exposes exactly one tab stop; found ${tabStops.length}`,
    ).toBe(1);

    view.rerender(
      withRenderEnvironment(<Dock plan={plan} showDock={false} />),
    );
    await waitFor(() =>
      expect(
        returnTarget,
        "AC7: dismissing the selection must restore focus to the element that owned it",
      ).toHaveFocus(),
    );
  });

  it("opens the overflow menu with exactly the spec's text-labeled items", async () => {
    render(withRenderEnvironment(<Dock plan={selectionPlan()} />));

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
      "AC2: overflow items must read Learn, Ask in existing chat…, Share in that order",
    ).toEqual([...OVERFLOW_MENU]);
  });

  it("unwinds nested Escape one layer at a time before dismissing the selection surface", async () => {
    const dismissals: FloatingActionDismissReason[] = [];
    render(
      withRenderEnvironment(
        <SelectionSurface
          plan={selectionPlan()}
          onDismiss={(reason) => dismissals.push(reason)}
        />,
      ),
    );

    const more = await screen.findByRole("button", { name: "More" });
    await userEvent.click(more);
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() =>
      expect(
        more,
        "spec §5.2: closing the overflow menu must return focus to More",
      ).toHaveFocus(),
    );
    expect(
      dismissals,
      "spec §5.2: the first Escape must close only the overflow menu",
    ).toEqual([]);

    const highlight = screen.getByRole("button", { name: "Highlight" });
    highlight.focus();
    await userEvent.keyboard("{Enter}");
    const picker = await screen.findByRole("dialog", {
      name: "Highlight colours",
    });
    await waitFor(() =>
      expect(
        within(picker).getByRole("button", { name: "Yellow (selected)" }),
        "spec §5.2: opening the colour picker from the keyboard must move focus into the swatches",
      ).toHaveFocus(),
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Highlight colours" }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(
        highlight,
        "spec §5.2: closing the colour picker must return focus to Highlight",
      ).toHaveFocus(),
    );
    expect(
      dismissals,
      "spec §5.2: the colour picker's Escape must not reach the selection surface",
    ).toEqual([]);

    await userEvent.keyboard("{Escape}");
    expect(
      dismissals,
      "spec §5.2: Escape with no nested surface open must dismiss the selection surface",
    ).toEqual(["escape"]);
  });

  it("surfaces a pending action on its own control and keeps More operable", async () => {
    const plan = selectionPlan({ changingColor: true });
    const view = render(
      withRenderEnvironment(<Dock plan={plan} pendingActionId="learn" />),
    );

    const more = screen.getByRole("button", { name: "More" });
    expect(
      more,
      "spec §4.2: a pending overflow action must expose its busy state on More",
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("status"),
      "spec §5.2: the pending action must be announced by its canonical name",
    ).toHaveTextContent("Learn in progress");
    expect(
      screen.getByRole("button", { name: "Highlight" }),
      "spec §4.2: the single-flight lock must mark direct controls unavailable",
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      more.getAttribute("aria-disabled"),
      "spec §4.2: More must stay operable so the busy overflow item stays reachable",
    ).not.toBe("true");

    await userEvent.click(more);
    expect(
      within(await screen.findByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
      "spec §4.2: the busy overflow action must remain visible in its canonical slot",
    ).toEqual([...OVERFLOW_MENU]);

    view.rerender(
      withRenderEnvironment(<Dock plan={plan} pendingActionId="quote-new" />),
    );
    expect(
      screen.getByRole("button", { name: "Ask" }),
      "spec §4.2: a pending direct action must expose its busy state on its own control",
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("status"),
      "spec §5.2: the pending direct action must be announced by its canonical name",
    ).toHaveTextContent("Ask in progress");
    expect(
      more,
      "spec §4.2: More must not claim a direct action's pending state",
    ).not.toHaveAttribute("aria-busy", "true");
  });

  it("preserves the native selection and its enclosing surface when an overflow item is used", async () => {
    const dismissals: FloatingActionDismissReason[] = [];
    let learnRuns = 0;
    render(
      withRenderEnvironment(
        <SelectionSurface
          plan={selectionPlan({
            onLearn: () => {
              learnRuns += 1;
            },
          })}
          onDismiss={(reason) => dismissals.push(reason)}
        />,
      ),
    );

    const selection = document.getSelection();
    if (!selection) {
      throw new Error("Chromium did not expose the document Selection.");
    }
    const range = document.createRange();
    range.selectNodeContents(screen.getByText(PASSAGE));
    selection.removeAllRanges();
    selection.addRange(range);
    expect(
      selection.toString(),
      "the fixture failed to place a real document text selection",
    ).toBe(PASSAGE);

    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(
      document.getSelection()?.toString(),
      "AC7: opening the overflow menu collapsed the native text selection",
    ).toBe(PASSAGE);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Learn" }));

    expect(
      learnRuns,
      "the overflow item did not run its catalog command exactly once",
    ).toBe(1);
    expect(
      document.getSelection()?.toString(),
      "AC7: activating an overflow item collapsed the native text selection",
    ).toBe(PASSAGE);
    expect(
      dismissals,
      "spec §6: the portaled overflow menu dismissed its enclosing selection surface",
    ).toEqual([]);
  });

  it("omits ineligible actions and renders no More when overflow is empty", async () => {
    const view = render(
      withRenderEnvironment(
        <Dock plan={selectionPlan({ chat: false, note: false })} />,
      ),
    );

    expect(
      renderedOrder(["Highlight", "Link", "More"]),
      "AC5: with note and chat ineligible the direct row must read Highlight · Link · More",
    ).toEqual(["Highlight", "Link", "More"]);
    expect(
      screen.queryByRole("button", { name: "Ask" }),
      "AC5: an ineligible chat destination must be absent, not disabled",
    ).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(
      within(await screen.findByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
      "AC5: surviving overflow actions keep their canonical relative order",
    ).toEqual(["Learn", "Share"]);

    view.unmount();
    render(
      withRenderEnvironment(
        <Dock
          plan={selectionPlan({ chat: false, learn: false, share: false })}
        />,
      ),
    );

    expect(
      renderedOrder(["Highlight", "Note", "Link"]),
      "spec §4.1: an empty overflow must leave the direct row alone",
    ).toEqual(["Highlight", "Note", "Link"]);
    expect(
      screen.queryByRole("button", { name: "More" }),
      "spec §4.1: More appears only when at least one overflow action exists",
    ).toBeNull();
  });

  // Declared last, and the only scenario that touches CDP: measured in this
  // harness, the page is `pointer: fine` until touch emulation is first
  // enabled, and `Emulation.setTouchEmulationEnabled { enabled: false }` then
  // leaves it `pointer: none` rather than restoring `fine`
  // (`Emulation.setEmulatedMedia` does not move the feature at all). A
  // file-level reset would therefore make the fine-pointer half of this
  // scenario unfalsifiable, so the toggle lives here and the residue outlives
  // no other scenario — each test file gets its own page.
  it("meets the fine- and coarse-pointer target sizes", async () => {
    render(withRenderEnvironment(<Dock plan={selectionPlan()} />));
    const controls = DIRECT_ROW.map((name) =>
      screen.getByRole("button", { name }),
    );

    const fineRects = controls.map((control) =>
      control.getBoundingClientRect(),
    );
    fineRects.forEach((rect, index) => {
      expect(
        [rect.width, rect.height],
        `spec §5.1: ${DIRECT_ROW[index]} is ${rect.width}×${rect.height}, not the 32×32 fine-pointer target`,
      ).toEqual([32, 32]);
    });
    for (let index = 1; index < fineRects.length; index += 1) {
      expect(
        fineRects[index].left - fineRects[index - 1].right,
        `spec §5.1: the gap between ${DIRECT_ROW[index - 1]} and ${DIRECT_ROW[index]} is not 4px`,
      ).toBe(4);
    }
    expect(
      glyphSizes(controls).filter(
        (glyph) => glyph.width !== 16 || glyph.height !== 16,
      ),
      "spec §5.1: every toolbar glyph must render at the 16px scale on a fine pointer",
    ).toEqual([]);

    // Enabling touch input is what moves Chromium's `pointer` feature, which is
    // the real capability the CSS reads.
    await cdp().send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 1,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Highlight" }).getBoundingClientRect()
          .width,
        "spec §5.1: the toolbar did not respond to a coarse pointer",
      ).toBe(44),
    );

    const coarseRects = controls.map((control) =>
      control.getBoundingClientRect(),
    );
    coarseRects.forEach((rect, index) => {
      expect(
        [rect.width, rect.height],
        `spec §5.1: ${DIRECT_ROW[index]} is ${rect.width}×${rect.height}, not the 44×44 coarse-pointer target`,
      ).toEqual([44, 44]);
    });
    expect(
      glyphSizes(controls).filter(
        (glyph) => glyph.width !== 16 || glyph.height !== 16,
      ),
      "spec §5.1: the glyph scale must not change with pointer coarseness",
    ).toEqual([]);

    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  });
});
