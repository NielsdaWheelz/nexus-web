import { expect, it } from "vitest";
import corpus from "../../../../../testdata/offline-reading/epub-pathnames.json";
import { normalizeEpubHref, normalizeEpubPathname } from "./epubHref";

it("preserves source spelling while resolving browser EPUB pathnames and relative anchors", () => {
  for (const item of corpus.cases) expect(normalizeEpubPathname(item.href), item.href).toBe(item.pathname);
  expect(normalizeEpubHref("../Text/café chapter.xhtml#%2520", "Other/start.xhtml"))
    .toEqual({ path: "Text/caf%C3%A9%20chapter.xhtml", anchorId: "%20" });
  expect(normalizeEpubHref("#%F0%9F%A7%A0%20note", "Text/chapter.xhtml"))
    .toEqual({ path: null, anchorId: "🧠 note" });
  expect(normalizeEpubHref("next.xhtml", "Other/current.xhtml"))
    .toEqual({ path: "Other/next.xhtml", anchorId: null });
});
