import { describe, expect, it } from "vitest";
import { deriveDossierLede } from "@/lib/library/dossierLede";

describe("deriveDossierLede", () => {
  it("returns the first prose paragraph, skipping an opening heading", () => {
    expect(
      deriveDossierLede("# Dossier\n\nThe synthesis opens here.\n\nA later paragraph."),
    ).toBe("The synthesis opens here.");
  });

  it("returns the first paragraph when there is no heading", () => {
    expect(deriveDossierLede("Opening claim.\n\nSupporting detail.")).toBe(
      "Opening claim.",
    );
  });

  it("strips emphasis, code, and link marks", () => {
    expect(
      deriveDossierLede("**Bold** and _italic_ with `code` and [a link](http://x)."),
    ).toBe("Bold and italic with code and a link.");
  });

  it("falls back to the heading text when the document is heading-only", () => {
    expect(deriveDossierLede("# Only a title")).toBe("Only a title");
  });

  it("truncates at a word boundary and appends an ellipsis", () => {
    const words = Array.from({ length: 80 }, (_, index) => `word${index + 1}`).join(" ");
    const lede = deriveDossierLede(words);
    expect(lede.endsWith("…")).toBe(true);
    expect(lede.split(/\s+/).length).toBeLessThanOrEqual(51);
    expect(lede).not.toContain("word60");
  });

  it("returns an empty string for empty or whitespace-only content", () => {
    expect(deriveDossierLede("")).toBe("");
    expect(deriveDossierLede("   \n\n   ")).toBe("");
  });
});
