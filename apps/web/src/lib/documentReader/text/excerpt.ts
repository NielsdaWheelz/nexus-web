/** Native source endpoints are captured before canonical whitespace loses information. */
import { validateExcerpt, type ExcerptBody, type ExcerptNode, type ExcerptPoint } from "@nexus/authored/excerpt";
import { isCanonicalTextSkipped } from "@/lib/canonicalText/domTextCursor";

const BRANCHES = new Set("p div span section article header footer nav aside main h1 h2 h3 h4 h5 h6 strong em b i u s cite sup sub code pre blockquote a xref ul ol li dl dt dd figure figcaption table thead tbody tfoot tr td th".split(" "));
const STRUCTURAL = new Set("table thead tbody tfoot tr ul ol dl".split(" "));
export class UnsupportedExcerpt extends Error {}

/** Smallest containing block, promoted through list/table structural ancestry. */
export function excerptSourceRoot(root: Element, range: Range): Element {
  let common = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement!;
  while (common !== root && !["p", "div", "section", "article", "main", "pre", "blockquote", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"].includes(common.tagName.toLowerCase())) common = common.parentElement!;
  for (let parent = common; parent !== root; parent = parent.parentElement!) {
    if (["ol", "ul", "dl", "table"].includes(parent.tagName.toLowerCase())) common = parent;
  }
  return common;
}

export function excerptSourceRange(root: Element, selection: Range): Range {
  const bounded = selection.cloneRange();
  bounded.selectNodeContents(root);
  const atomic = ["table"].includes(root.tagName.toLowerCase());
  if (!["table", "pre", "p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(root.tagName.toLowerCase())) {
    const blocks = Array.from(root.childNodes).filter(child => selection.intersectsNode(child));
    if (blocks.length) { bounded.setStartBefore(blocks[0]!); bounded.setEndAfter(blocks.at(-1)!); }
  }
  if (!atomic) for (const el of root.querySelectorAll("*")) {
    const kind = el.tagName.toLowerCase();
    if (BRANCHES.has(kind) || kind === "br" || kind === "hr" || isCanonicalTextSkipped(el) || !el.textContent?.trim() || selection.intersectsNode(el)) continue;
    if (!bounded.intersectsNode(el) || !el.parentNode) continue;
    const index = Array.from(el.parentNode.childNodes).indexOf(el);
    if (selection.comparePoint(el.parentNode, index) === -1) bounded.setStartAfter(el);
    else if (selection.comparePoint(el.parentNode, index) === 1) bounded.setEndBefore(el);
  }
  return bounded;
}

export function captureNativeExcerpt(root: Element, range: Range, includeRoot = false): ExcerptBody {
  const bounds = excerptSourceRange(root, range);
  const points = new Map<Node, { path: number[]; boundaries: number[] | null }>();
  function children(parent: Element, path: number[]): ExcerptNode[] {
    const result: ExcerptNode[] = [];
    const boundaries = [0];
    points.set(parent, { path, boundaries });
    for (const child of parent.childNodes) {
      if (!bounds.intersectsNode(child)) { boundaries.push(result.length); continue; }
      const at = [...path, result.length];
      if (child instanceof Text) {
        if (!STRUCTURAL.has(parent.tagName.toLowerCase()) || child.data.trim()) {
          points.set(child, { path: at, boundaries: null });
          result.push({ kind: "text", text: child.data });
        }
      } else if (child instanceof Element) {
        const node = element(child, at);
        if (node) result.push(node);
      }
      boundaries.push(result.length);
    }
    return result;
  }
  function element(el: Element, path: number[]): ExcerptNode | null {
    const kind = el.tagName.toLowerCase();
    const selected = range.intersectsNode(el);
    if (kind === "table" && selected && el.getAttribute("data-nexus-incomplete-table") === "true") throw new UnsupportedExcerpt();
    if (kind === "figure" && el.getAttribute("data-nexus-document-embed-kind") === "x_post") return { kind: "figure", lang: null, dir: null, children: [{ kind: "media_gap", media_kind: "embed", flow: "block" }] };
    if (isCanonicalTextSkipped(el) || el.hasAttribute("data-document-embed-ui") || el.hasAttribute("data-reader-unit")) {
      return null;
    }
    if (kind === "br" || kind === "hr") return { kind };
    if (["img", "svg", "iframe", "video", "audio", "object", "embed"].includes(kind)) {
      if (kind === "svg" && selected && el.textContent?.trim()) throw new UnsupportedExcerpt();
      return { kind: "media_gap", media_kind: kind === "img" ? "image" : kind === "svg" ? "svg" : "embed", flow: getComputedStyle(el).display.startsWith("inline") ? "inline" : "block" };
    }
    if (!BRANCHES.has(kind)) {
      if (selected && el.textContent?.trim()) throw new UnsupportedExcerpt();
      return { kind: "media_gap", media_kind: "embed", flow: "block" };
    }
    const fields = { lang: el.getAttribute("lang"), dir: getComputedStyle(el).direction === "rtl" ? "rtl" as const : "ltr" as const, children: children(el, path) };
    if (el instanceof HTMLOListElement) {
      const items = Array.from(el.children).filter((child): child is HTMLLIElement => child instanceof HTMLLIElement);
      let ordinal = el.hasAttribute("start") ? el.start : el.reversed ? items.length : 1;
      for (const item of items) {
        if (item.hasAttribute("value")) ordinal = item.value;
        if (bounds.intersectsNode(item)) break;
        ordinal += el.reversed ? -1 : 1;
      }
      return { kind: "ol", ...fields, start: ordinal, reversed: el.reversed };
    }
    if (el instanceof HTMLLIElement) return { kind: "li", ...fields, value: el.hasAttribute("value") ? el.value : null };
    if (el instanceof HTMLTableCellElement) {
      if (el.hasAttribute("headers")) throw new UnsupportedExcerpt();
      const group = el.parentElement?.parentElement;
      const row = el.parentElement;
      const remaining = group instanceof HTMLTableSectionElement && row instanceof HTMLTableRowElement ? group.rows.length - row.sectionRowIndex : el.rowSpan;
      const scope = el.scope === "row" || el.scope === "col" || el.scope === "rowgroup" || el.scope === "colgroup" ? el.scope : null;
      return { kind: kind === "td" ? "td" : "th", ...fields, col_span: el.colSpan, row_span: el.rowSpan === 0 ? 0 : Math.min(el.rowSpan, remaining), scope };
    }
    // justify-type-assertion: the closed branch vocabulary was checked above; specialized branches returned already.
    return { kind, ...fields } as ExcerptNode;
  }
  const wrapped = includeRoot ? element(root, [0]) : null;
  const content = includeRoot ? wrapped ? [wrapped] : [] : children(root, []);
  function point(node: Node, offset: number): ExcerptPoint {
    const found = points.get(node);
    if (!found) throw new UnsupportedExcerpt();
    if (node instanceof Text) {
      if (offset > 0 && offset < node.data.length && /[\uD800-\uDBFF]/u.test(node.data[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(node.data[offset]!)) throw new UnsupportedExcerpt();
      return { path: found.path, offset: Array.from(node.data.slice(0, offset)).length };
    }
    const boundary = found.boundaries?.[offset];
    if (boundary === undefined) throw new UnsupportedExcerpt();
    return { path: found.path, offset: boundary };
  }
  const body: ExcerptBody = { structure: "captured", lang: root.closest("[lang]")?.getAttribute("lang") ?? null, dir: getComputedStyle(root).direction === "rtl" ? "rtl" : "ltr", content,
    selection: { start: point(range.startContainer, range.startOffset), end: point(range.endContainer, range.endOffset) } };
  try { validateExcerpt({ ...body, source_extent: null, truncated_before: false, truncated_after: false }); }
  catch { throw new UnsupportedExcerpt(); }
  return body;
}
