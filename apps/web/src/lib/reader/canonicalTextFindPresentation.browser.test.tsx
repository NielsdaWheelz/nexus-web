import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import readerStyles from "@/app/(authenticated)/media/[id]/page.module.css";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import {
  createPaneFindResultKey,
  type PaneFindResultKey,
} from "@/lib/panes/paneSearch";
import {
  createCanonicalTextFindPresentationOwner,
  type CanonicalTextFindPresentationOwner,
  type CanonicalTextFindPresentationTarget,
} from "./canonicalTextFindPresentation";
import {
  CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME,
  CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME,
} from "./paneFindHighlightRegistry";

const owners: CanonicalTextFindPresentationOwner[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.clear();
  }
  document.body.replaceChildren();
});

function owner(): CanonicalTextFindPresentationOwner {
  const value = createCanonicalTextFindPresentationOwner();
  owners.push(value);
  return value;
}

interface Fragment {
  readonly viewport: HTMLDivElement;
  readonly content: HTMLDivElement;
  readonly cursor: ReturnType<typeof buildCanonicalCursor>;
}

function mountFragment(className: string | null, html: string): Fragment {
  const viewport = document.createElement("div");
  const content = document.createElement("div");
  if (className !== null) {
    content.className = className;
  }
  content.innerHTML = html;
  viewport.append(content);
  document.body.append(viewport);
  return { viewport, content, cursor: buildCanonicalCursor(content) };
}

function key(id: string): PaneFindResultKey {
  return createPaneFindResultKey({ source: id, locator: id });
}

function target(
  fragment: Fragment,
  resultKey: PaneFindResultKey,
  fragmentId: string,
  word: string,
): CanonicalTextFindPresentationTarget {
  const startCp = fragment.cursor.emitted.indexOf(word);
  if (startCp < 0) {
    throw new Error(`Fixture is missing "${word}".`);
  }
  return { key: resultKey, fragmentId, startCp, endCp: startCp + word.length };
}

function ranges(name: string): AbstractRange[] {
  const highlight = CSS.highlights.get(name);
  return highlight ? Array.from(highlight) : [];
}

function texts(name: string): string[] {
  return ranges(name).map((range) => (range as Range).toString());
}

describe("canonical text Find presentation owner", () => {
  it("publishes live passive ranges and only the visible active target", () => {
    const fragment = mountFragment(null, "<p>alpha BEACON omega LANTERN end</p>");
    const beacon = key("beacon");
    const lantern = key("lantern");

    owner().publish({
      fragmentId: "frag-1",
      cursor: fragment.cursor,
      viewport: fragment.viewport,
      targets: [
        target(fragment, beacon, "frag-1", "BEACON"),
        target(fragment, lantern, "frag-1", "LANTERN"),
      ],
      activeKey: lantern,
    });

    expect(texts(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME).sort()).toEqual([
      "BEACON",
      "LANTERN",
    ]);
    expect(texts(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toEqual(["LANTERN"]);
    for (const range of ranges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)) {
      expect(fragment.viewport.contains((range as Range).startContainer)).toBe(
        true,
      );
      expect((range as Range).collapsed).toBe(false);
    }
  });

  it("paints the active highlight above the passive highlight by priority", () => {
    const fragment = mountFragment(null, "<p>only BEACON here</p>");
    const beacon = key("beacon");

    owner().publish({
      fragmentId: "frag-1",
      cursor: fragment.cursor,
      viewport: fragment.viewport,
      targets: [target(fragment, beacon, "frag-1", "BEACON")],
      activeKey: beacon,
    });

    expect(
      CSS.highlights.get(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)!.priority,
    ).toBeGreaterThan(
      CSS.highlights.get(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)!.priority,
    );
  });

  it("filters targets to the rendered fragment and drops an off-fragment active", () => {
    const fragment = mountFragment(null, "<p>alpha BEACON omega</p>");
    const beacon = key("beacon");
    const elsewhere = key("elsewhere");

    owner().publish({
      fragmentId: "frag-1",
      cursor: fragment.cursor,
      viewport: fragment.viewport,
      targets: [
        target(fragment, beacon, "frag-1", "BEACON"),
        // A target that lives in another rendered fragment.
        { key: elsewhere, fragmentId: "frag-2", startCp: 0, endCp: 3 },
      ],
      activeKey: elsewhere,
    });

    expect(texts(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toEqual(["BEACON"]);
    expect(ranges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toEqual([]);
  });

  it("clears the owner's marks when no target lives in the rendered fragment", () => {
    const fragment = mountFragment(null, "<p>alpha BEACON omega</p>");
    const presentation = owner();
    presentation.publish({
      fragmentId: "frag-1",
      cursor: fragment.cursor,
      viewport: fragment.viewport,
      targets: [target(fragment, key("beacon"), "frag-1", "BEACON")],
      activeKey: null,
    });
    expect(ranges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toHaveLength(1);

    presentation.publish({
      fragmentId: "frag-2",
      cursor: fragment.cursor,
      viewport: fragment.viewport,
      targets: [target(fragment, key("beacon"), "frag-1", "BEACON")],
      activeKey: null,
    });

    expect(CSS.highlights.has(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toBe(false);
  });

  it("defects on a target whose span is not exactly renderable", () => {
    const fragment = mountFragment(null, "<p>alpha BEACON omega</p>");
    expect(() =>
      owner().publish({
        fragmentId: "frag-1",
        cursor: fragment.cursor,
        viewport: fragment.viewport,
        targets: [
          {
            key: key("oob"),
            fragmentId: "frag-1",
            startCp: 0,
            endCp: fragment.cursor.length + 1,
          },
        ],
        activeKey: null,
      }),
    ).toThrow(/not exactly renderable/);
  });

  it("defects on a stale range whose node left the current viewport", () => {
    const fragment = mountFragment(null, "<p>alpha BEACON omega</p>");
    const beacon = target(fragment, key("beacon"), "frag-1", "BEACON");
    // Simulate a committed DOM replacement: the resolved nodes are detached
    // from the viewport, but the same logical cursor is republished.
    fragment.content.remove();

    expect(() =>
      owner().publish({
        fragmentId: "frag-1",
        cursor: fragment.cursor,
        viewport: fragment.viewport,
        targets: [beacon],
        activeKey: beacon.key,
      }),
    ).toThrow(/outside the current viewport/);
  });

  it("rebinds the mark to the replaced DOM when republished against a fresh cursor", () => {
    const before = mountFragment(null, "<p>alpha BEACON omega</p>");
    const beacon = target(before, key("beacon"), "frag-1", "BEACON");
    const presentation = owner();
    presentation.publish({
      fragmentId: "frag-1",
      cursor: before.cursor,
      viewport: before.viewport,
      targets: [beacon],
      activeKey: beacon.key,
    });
    const stale = ranges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)[0] as Range;
    expect(before.viewport.contains(stale.startContainer)).toBe(true);

    // A committed canonical-DOM replacement for the same fragment: fresh nodes,
    // a fresh cursor, a fresh viewport. Republishing the same logical target
    // must repaint against the current DOM, never the retired nodes.
    const after = mountFragment(null, "<p>alpha BEACON omega</p>");
    presentation.publish({
      fragmentId: "frag-1",
      cursor: after.cursor,
      viewport: after.viewport,
      targets: [beacon],
      activeKey: beacon.key,
    });

    const rebound = ranges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)[0] as Range;
    expect(rebound.toString()).toBe("BEACON");
    expect(after.viewport.contains(rebound.startContainer)).toBe(true);
    expect(before.viewport.contains(rebound.startContainer)).toBe(false);
    expect(rebound.startContainer).not.toBe(stale.startContainer);
  });

  it("keeps two mounted owners isolated when one clears", () => {
    const first = mountFragment(null, "<p>first BEACON body</p>");
    const second = mountFragment(null, "<p>second LANTERN body</p>");
    const firstOwner = owner();
    const secondOwner = owner();

    firstOwner.publish({
      fragmentId: "frag-1",
      cursor: first.cursor,
      viewport: first.viewport,
      targets: [target(first, key("beacon"), "frag-1", "BEACON")],
      activeKey: null,
    });
    secondOwner.publish({
      fragmentId: "frag-2",
      cursor: second.cursor,
      viewport: second.viewport,
      targets: [target(second, key("lantern"), "frag-2", "LANTERN")],
      activeKey: null,
    });
    expect(texts(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME).sort()).toEqual([
      "BEACON",
      "LANTERN",
    ]);

    firstOwner.clear();

    expect(texts(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toEqual(["LANTERN"]);
  });

  it("computes a stronger active fill and a non-color active cue from page styles", () => {
    const fragment = mountFragment(readerStyles.fragments, "alpha BEACON omega");
    const beacon = key("beacon");
    owner().publish({
      fragmentId: "frag-1",
      cursor: fragment.cursor,
      viewport: fragment.viewport,
      targets: [target(fragment, beacon, "frag-1", "BEACON")],
      activeKey: beacon,
    });

    const passive = getComputedStyle(
      fragment.content,
      `::highlight(${CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME})`,
    );
    const active = getComputedStyle(
      fragment.content,
      `::highlight(${CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME})`,
    );

    const transparent = new Set(["", "rgba(0, 0, 0, 0)", "transparent"]);
    expect(transparent.has(passive.backgroundColor)).toBe(false);
    expect(transparent.has(active.backgroundColor)).toBe(false);
    // Active is distinguishable from passive by fill alone...
    expect(active.backgroundColor).not.toBe(passive.backgroundColor);
    // ...and, crucially, without relying on color: a double underline.
    expect(active.textDecorationStyle).toBe("double");
    expect(active.textDecorationLine).toContain("underline");
    expect(passive.textDecorationLine).toBe("none");
  });

  it("retains a color-independent active cue under forced colors (page CSS)", () => {
    // The forced-colors media feature cannot be emulated in this runner, so
    // assert the real page.module.css forced-colors rules via the CSSOM.
    const forced: CSSStyleRule[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (
          rule instanceof CSSMediaRule &&
          rule.conditionText.includes("forced-colors")
        ) {
          for (const inner of Array.from(rule.cssRules)) {
            if (
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes("nexus-find")
            ) {
              forced.push(inner);
            }
          }
        }
      }
    }
    const combined = forced.find(
      (rule) =>
        rule.selectorText.includes("nexus-find-all") &&
        rule.selectorText.includes("nexus-find-active"),
    );
    const activeOnly = forced.find(
      (rule) =>
        rule.selectorText.includes("nexus-find-active") &&
        !rule.selectorText.includes("nexus-find-all"),
    );
    expect(combined).toBeDefined();
    expect(activeOnly).toBeDefined();
    // Both marks stay perceivable via the system Highlight color.
    expect(combined!.style.backgroundColor.toLowerCase()).toBe("highlight");
    // The passive+active fill carries no underline; only active does, so active
    // stays distinguishable without color under forced colors.
    expect(combined!.style.textDecoration).toBe("");
    expect(activeOnly!.style.textDecorationStyle).toBe("double");
  });
});
