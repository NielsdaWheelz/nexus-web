import { describe, expect, it } from "vitest";
import {
  clearExactPublicTextHighlight,
  focusPublicHighlightTarget,
  installExactPublicTextHighlight,
  installPublicPdfHighlightOverlay,
} from "./publicHighlightRendering";

const PDF_QUAD = {
  x1: 10,
  y1: 20,
  x2: 40,
  y2: 20,
  x3: 40,
  y3: 30,
  x4: 10,
  y4: 30,
};

describe("public highlight rendering", () => {
  it("marks the exact Unicode-codepoint text range across DOM nodes", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>alpha <em>😀beta</em> gamma</p>";
    const canonicalText = "alpha 😀beta gamma";

    const target = installExactPublicTextHighlight(root, {
      canonicalText,
      startOffset: 6,
      endOffset: 11,
      expectedText: "😀beta",
    });

    expect(target).toBe(root);
    expect(target?.dataset.publicHighlightTarget).toBe("true");
    expect(root.querySelector("mark")?.textContent).toBe("😀beta");
    expect(root.textContent).toBe(canonicalText);
    document.body.append(root);
    if (target) focusPublicHighlightTarget(target);
    expect(document.activeElement).toBe(target);
    clearExactPublicTextHighlight(root);
    expect(root.querySelector("mark")).toBeNull();
    expect(root.textContent).toBe(canonicalText);
    expect(root).not.toHaveAttribute("data-public-highlight-target");
    root.remove();
  });

  it("maps and paints an exact range across canonical block separators", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<h2>There's Water on the Moon?</h2><p>NASA recently announced it.</p>";
    const canonicalText =
      "There's Water on the Moon?\nNASA recently announced it.";
    const expectedText =
      "There's Water on the Moon?\nNASA recentl";

    const target = installExactPublicTextHighlight(root, {
      canonicalText,
      startOffset: 0,
      endOffset: Array.from(expectedText).length,
      expectedText,
    });

    expect(target).toBe(root);
    expect(root.querySelectorAll("mark")).toHaveLength(2);
    expect(
      Array.from(root.querySelectorAll("mark"), (mark) => mark.textContent),
    ).toEqual(["There's Water on the Moon?", "NASA recentl"]);
    expect(root.textContent).toBe(
      "There's Water on the Moon?NASA recently announced it.",
    );
  });

  it("does not paint or fall back when canonical text or quote mismatches", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>alpha beta gamma</p>";

    expect(
      installExactPublicTextHighlight(root, {
        canonicalText: "alpha changed gamma",
        startOffset: 6,
        endOffset: 13,
        expectedText: "changed",
      }),
    ).toBeNull();
    expect(
      installExactPublicTextHighlight(root, {
        canonicalText: "alpha beta gamma",
        startOffset: 6,
        endOffset: 10,
        expectedText: "wrong",
      }),
    ).toBeNull();
    expect(root.querySelector("mark")).toBeNull();
  });

  it("projects and paints every PDF quad on the exact current page geometry", () => {
    const page = document.createElement("div");
    const first = installPublicPdfHighlightOverlay({
      pageElement: page,
      pageView: {
        viewport: { width: 200, height: 400, scale: 2, rotation: 0 },
      },
      quads: [PDF_QUAD],
      color: "Blue",
      classes: { layer: "layer", rect: "rect" },
    });

    expect(first?.style.left).toBe("20px");
    expect(first?.style.top).toBe("40px");
    expect(first?.style.width).toBe("60px");
    expect(first?.style.height).toBe("20px");
    expect(first?.dataset.publicHighlightTarget).toBe("true");
  });

  it("does not paint PDF geometry against a missing or mismatched viewport", () => {
    const page = document.createElement("div");

    expect(
      installPublicPdfHighlightOverlay({
        pageElement: page,
        pageView: undefined,
        quads: [PDF_QUAD],
        color: "Yellow",
        classes: { layer: "layer", rect: "rect" },
      }),
    ).toBeNull();
    expect(
      installPublicPdfHighlightOverlay({
        pageElement: page,
        pageView: {
          viewport: { width: 20, height: 20, scale: 1, rotation: 0 },
        },
        quads: [PDF_QUAD],
        color: "Yellow",
        classes: { layer: "layer", rect: "rect" },
      }),
    ).toBeNull();
    expect(page.children).toHaveLength(0);
  });
});
