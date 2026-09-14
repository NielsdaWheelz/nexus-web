import { expect, it } from "vitest";
import { buildCanonicalCursor } from "@/lib/highlights/canonicalCursor";
import { readPdfGutterWindow, readTextGutterWindow, publicationGutterTop } from "./publicationGutter";

it("preserves disjoint source intervals and inverse rotated PDF visibility within its admitted window bytes", () => {
  const root = document.createElement("div");
  root.style.cssText = "position:fixed;left:20px;top:20px;width:300px;height:300px;font:20px monospace";
  for (const [text, top] of [["ab", 0], ["OFF", 200], ["ef", 40]] as const) {
    const span = document.createElement("span"); span.textContent = text;
    span.style.cssText = `position:absolute;left:0;top:${top}px`;
    root.append(span);
  }
  document.body.append(root);
  const following = document.createElement("div");
  following.style.cssText = root.style.cssText; following.textContent = "later source unit";
  document.body.append(following);
  const page = document.createElement("div");
  page.className = "page"; page.dataset.pageNumber = "1";
  page.style.cssText = "position:fixed;left:400px;top:20px;width:400px;height:200px";
  page.dataset.nexusPageScale = "2"; page.dataset.nexusPageRotation = "90";
  page.dataset.nexusPageViewportWidth = "400"; page.dataset.nexusPageViewportHeight = "200";
  page.dataset.nexusPageDpiScale = "1";
  const pdf = document.createElement("div"); pdf.append(page); document.body.append(pdf);
  try {
    const cursor = buildCanonicalCursor(root);
    expect(cursor.emitted).toBe("abOFFef");
    const parts = [{ unitKey: "units/later.json", fragmentId: "original-fragment", renderStart: 100, root, cursor }];
    const visible = new DOMRect(20, 20, 300, 80);
    expect(readTextGutterWindow(parts, visible, 4096), "offscreen middle text entered the visible canonical union").toEqual({ kind: "Text", units: [
      { unit_key: "units/later.json", fragment_id: "original-fragment", ranges: [[100, 102], [105, 107]] },
    ] });
    expect(readTextGutterWindow(parts, visible, 100), "gutter built a partial window after byte refusal").toBeNull();
    expect(readPdfGutterWindow(pdf, new DOMRect(440, 40, 60, 40), 4096), "rotated page visibility lost its original source rectangle").toEqual({
      kind: "Pdf", pages: [{ page: 1, rect: { left: 10, top: 150, right: 30, bottom: 180 } }],
    });
    const last = root.lastElementChild!.getBoundingClientRect();
    expect(publicationGutterTop({ id: "margin:eof", fact_id: "eof", kind: "Link", label_excerpt: "End", label_codepoints: 3,
      excerpt: null, excerpt_codepoints: null, edge_id: null, stance: null,
      location: { kind: "Text", range: { unit_key: "units/later.json", fragment_id: "original-fragment", start_cp: 107, end_cp: 107 } },
    }, [{ unitKey: "units/following.json", fragmentId: "original-fragment", renderStart: 1000, root: following, cursor: buildCanonicalCursor(following) }, ...parts], root, visible),
    "exact EOF occurrence lost its final authored line").toBe(last.top);
    root.replaceChildren();
    expect(readTextGutterWindow([{ ...parts[0], cursor: buildCanonicalCursor(root) }], visible, 4096)).toEqual({
      kind: "Text", units: [{ unit_key: "units/later.json", fragment_id: "original-fragment", ranges: [] }],
    });
  } finally { root.remove(); following.remove(); pdf.remove(); }
});
