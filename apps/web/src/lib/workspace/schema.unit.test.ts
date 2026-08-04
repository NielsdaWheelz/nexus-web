import { describe, expect, it } from "vitest";
import { normalizePaneLabel } from "./schema";

/**
 * Risk: the pane label is the canonical route title
 * (`docs/cutovers/canonical-pane-title-ownership-hard-cutover.md`). The
 * specification requires the full text to survive into the DOM, the accessible
 * name, and the native title disclosure, with truncation left to CSS. A
 * normalizer that shortens the label instead would silently store a second,
 * clipped title — the exact thing the cutover forbids — and no visual check
 * would reveal it, because the header ellipsizes either way.
 *
 * Oracle: the specification's "Canonical title" and "Target behavior" clauses.
 */
describe("pane label normalization", () => {
  it("collapses whitespace and rejects blank input without ever shortening a long exact title", () => {
    const longExactTitle =
      "The Collected Correspondence of a Nineteenth-Century Transatlantic Publishing House, Together with an Account of Its Founders and Their Several Misfortunes";
    expect(
      longExactTitle.length,
      "The fixture must exceed any plausible storage bound for this proof to discriminate.",
    ).toBeGreaterThan(120);

    expect(
      normalizePaneLabel(longExactTitle),
      `A ${longExactTitle.length}-character work title is the pane's exact identity and must reach the header whole; clipping it would put a shortened title in the accessible name and the native disclosure.`,
    ).toBe(longExactTitle);

    expect(
      normalizePaneLabel("  Deep\n  Work \t& Attention  "),
      "Authored titles arrive with incidental whitespace; the label collapses it to one canonical spacing rather than rendering ragged chrome.",
    ).toBe("Deep Work & Attention");

    for (const blank of ["", "   ", "\n\t"]) {
      expect(
        normalizePaneLabel(blank),
        `A blank label (${JSON.stringify(blank)}) is absence, not identity: it must normalize to null so the pane keeps its route default instead of rendering an empty title.`,
      ).toBeNull();
    }

    expect(
      normalizePaneLabel(null),
      "A body that has not resolved its title yet publishes null, which stays absence.",
    ).toBeNull();
  });
});
