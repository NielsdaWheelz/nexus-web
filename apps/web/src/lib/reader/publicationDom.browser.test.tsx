import { expect, it } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { prepareReaderUnit } from "./publicationDom";
import { decodeReaderPublicationUnit } from "./publicationContract";
import { READER_CAPACITY } from "./readerCapacity";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const unit = decodeReaderPublicationUnit({
  fragment_id: MEDIA, fragment_idx: 0,
  document_word_start: 0, starts_in_word: false, epub_target: null, document_embeds: [],
  fragment_document_start_cp: 50, fragment_length_cp: 150,
  start_cp: 100, end_cp: 111, render_start_cp: 101, render_end_cp: 111,
  canonical_text: "\nalpha beta", word_boundaries: [100, 101, 106, 107, 111],
  render_nodes: [
    { kind: "Element", parent: null, namespace: "html", name: "h1", attributes: [] },
    { kind: "Text", parent: 0, text: "alpha beta" },
  ], assets: [], table_contexts: [],
});

it("retains the mounted selection at DOM capacity and admits growth only after release", () => {
  const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxDomNodes: 8 } };
  const runtime = new HostedReaderProgressRuntime(ACCOUNT, () => {});
  const session = createDocumentReaderSession({
    mediaId: MEDIA, capacity,
    source: createHostedReaderSource({ accountId: ACCOUNT, cache: new ResourceCache({}, capacity.cache), capacity }),
    progress: runtime.createPort(MEDIA),
  });
  const first = prepareReaderUnit({ session, unit, unitKey: "first", highlights: [], headingLevelOffset: 1 });
  if (first.kind !== "Ready") throw new Error("Initial unit admission failed");
  const second = prepareReaderUnit({ session, unit, unitKey: "second", highlights: [], headingLevelOffset: 1 });
  if (second.kind !== "Ready") throw new Error("Second unit admission failed");
  document.body.append(first.value.root);
  const heading = first.value.root.querySelector("h2");
  if (heading === null) throw new Error("Source heading projection is absent");
  const selection = document.getSelection();
  if (selection === null) throw new Error("Browser selection is unavailable");
  const range = document.createRange();
  range.selectNodeContents(heading);
  selection.removeAllRanges(); selection.addRange(range);
  expect(prepareReaderUnit({ session, unit, unitKey: "third", highlights: [], headingLevelOffset: 1 })).toEqual({ kind: "Capacity", reason: "Dom" });
  expect(selection.toString()).toBe("alpha beta");
  expect(first.value.root.querySelector("h2")).toBe(heading);
  second.value.release();
  const highlight = [{ id: "mark", start_offset: 107, end_offset: 111, color: "yellow" as const, created_at: "2026-09-01T00:00:00Z" }];
  expect(prepareReaderUnit({ session, unit, unitKey: "decorated", highlights: highlight, headingLevelOffset: 1 })).toEqual({ kind: "Capacity", reason: "Dom" });
  expect(selection.toString()).toBe("alpha beta");
  selection.removeAllRanges(); first.value.release();
  const next = prepareReaderUnit({ session, unit, unitKey: "decorated", highlights: highlight, headingLevelOffset: 1 });
  if (next.kind !== "Ready") throw new Error("Released capacity did not admit the next unit");
  expect(next.value.root.querySelector("[data-active-highlight-ids='mark']")?.textContent).toBe("beta");
  next.value.release(); session.close(); runtime.close();
});

it("defers captured resources, preserves unavailable-image text, and avoids false continuation anchors", () => {
  const image = { kind: "Captured", member: { key: "assets/figure.png", bytes: 12, sha256: "a".repeat(64) }, media_type: "image/png", package_href: null };
  const source = "https://example.invalid/missing.png";
  const withImages = decodeReaderPublicationUnit({ ...unit,
    assets: [image, { kind: "Unavailable", source_url: source, reason: "NotFound" }],
    render_nodes: [...unit.render_nodes,
      { kind: "Element", parent: null, namespace: "html", name: "img", attributes: [{ namespace: null, name: "src", value: "nexus-reader-member:assets/figure.png" }] },
      { kind: "Element", parent: null, namespace: "html", name: "img", attributes: [
        { namespace: null, name: "src", value: `nexus-reader-unavailable:${encodeURIComponent(source)}` },
        { namespace: null, name: "alt", value: "authored figure description" },
      ] },
      { kind: "Element", parent: null, namespace: "svg", name: "svg", attributes: [] },
      { kind: "Element", parent: 4, namespace: "svg", name: "use", attributes: [{ namespace: "xlink", name: "href", value: "#authored-vector" }] },
      { kind: "Element", parent: 4, namespace: "svg", name: "rect", attributes: [
        { namespace: null, name: "fill", value: { kind: "LocalFragment", fragment_id: 'authored "gradient"', fallback: "currentColor" } },
        { namespace: null, name: "stroke", value: "currentColor" },
      ] },
    ],
  });
  const runtime = new HostedReaderProgressRuntime(ACCOUNT, () => {});
  const session = createDocumentReaderSession({
    mediaId: MEDIA, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId: ACCOUNT, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(MEDIA),
  });
  const result = prepareReaderUnit({ session, unit: withImages, unitKey: "images", headingLevelOffset: 1,
    highlights: [{ id: "continued", start_offset: 90, end_offset: 105, color: "blue", created_at: "2026-09-01T00:00:00Z" }],
  });
  if (result.kind !== "Ready") throw new Error("Image unit admission failed");
  expect(result.value.root.querySelector("img")?.getAttribute("src")).toBeNull();
  expect(result.value.root.querySelector("use")?.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBeNull();
  expect(result.value.root.querySelector("rect")?.getAttribute("fill")).toBeNull();
  expect(result.value.root.querySelector("rect")?.getAttribute("stroke")).toBe("currentColor");
  expect(result.value.resources.map((resource) => resource.assets)).toEqual([[image], [], []]);
  document.body.append(result.value.root);
  expect(result.value.root.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Image unavailable: authored figure description");
  expect(result.value.root.textContent).toBe("alpha beta");
  expect(result.value.root.querySelector("[data-active-highlight-ids='continued']")?.textContent).toBe("alph");
  expect(result.value.root.querySelector("[data-highlight-anchor='continued']")).toBeNull();
  result.value.release(); session.close(); runtime.close();
});
