/** Frozen source structure owns literal evidence. Canonical coordinates only locate it. */
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalSerialization, canonicalTokens, CANONICAL_BLOCKS, isCanonicalWhitespace, type CanonicalToken } from "./canonical.ts";
import type { SelectionCapture, PassageCapture } from "./types.ts";

/** A well-formed native capture cannot retain/prove the requested selected evidence. */
export class ExcerptCaptureError extends Error {}

export type ExcerptPoint = { path: number[]; offset: number };
export type ExcerptRange = { start: ExcerptPoint; end: ExcerptPoint };
export type ExcerptExtent = { reading_ref: string; document_identity: string; fragment_id: string; start_offset: number; end_offset: number };
type BranchKind = "p" | "div" | "span" | "section" | "article" | "header" | "footer" | "nav" | "aside" | "main" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "strong" | "em" | "b" | "i" | "u" | "s" | "cite" | "sup" | "sub" | "code" | "pre" | "blockquote" | "a" | "xref" | "ul" | "dl" | "dt" | "dd" | "figure" | "figcaption" | "table" | "thead" | "tbody" | "tfoot" | "tr";
type BranchFields = { lang: string | null; dir: "ltr" | "rtl" | "auto" | null; children: ExcerptNode[] };
export type ExcerptNode =
  | { kind: "text"; text: string }
  | { kind: "br" | "hr" }
  | { kind: "media_gap"; media_kind: "image" | "svg" | "embed"; flow: "inline" | "block" }
  | ({ kind: BranchKind } & BranchFields)
  | ({ kind: "ol"; start: number; reversed: boolean } & BranchFields)
  | ({ kind: "li"; value: number | null } & BranchFields)
  | ({ kind: "td" | "th"; col_span: number; row_span: number; scope: "row" | "col" | "rowgroup" | "colgroup" | null } & BranchFields);
export type FrozenExcerpt = {
  structure: "captured" | "unknown" | "plain"; lang: string | null; dir: "ltr" | "rtl" | null;
  content: ExcerptNode[]; selection: ExcerptRange; source_extent: ExcerptExtent | null;
  truncated_before: boolean | null; truncated_after: boolean | null;
};
export type ExcerptBody = Pick<FrozenExcerpt, "structure" | "lang" | "dir" | "content" | "selection">;
export type ExcerptView =
  | { kind: "content"; body: ExcerptBody; omitted_before: boolean | null; omitted_after: boolean | null; selected_truncated_before: boolean; selected_truncated_after: boolean }
  | { kind: "table_summary" };
export type ExcerptScope = { kind: "capture" } | { kind: "selection" } | { kind: "interval"; start_offset: number; end_offset: number };
export type ExcerptTextParts = { prefix: string; exact: string; suffix: string };
export type ExcerptEvidence = { quote: { excerpt: FrozenExcerpt; exact: string; prefix: string | null; suffix: string | null; color: string | null }; source: unknown; target: unknown };
export type ExcerptCapture = { kind: "selection"; value: SelectionCapture } | { kind: "passage"; value: PassageCapture } | { kind: "evidence"; value: ExcerptEvidence };

const BRANCHES = new Set("p div span section article header footer nav aside main h1 h2 h3 h4 h5 h6 strong em b i u s cite sup sub code pre blockquote a xref ul dl dt dd figure figcaption table thead tbody tfoot tr ol li td th".split(" "));
const PHRASING = new Set("text br media_gap span strong em b i u s cite sup sub code a xref".split(" "));
const INLINE_PARENTS = new Set("p span h1 h2 h3 h4 h5 h6 strong em b i u s cite sup sub code pre a xref".split(" "));
const BLOCKS = new Set("p div section article header footer nav aside main h1 h2 h3 h4 h5 h6 pre blockquote ul ol dl dt dd li figure figcaption table thead tbody tfoot tr".split(" "));
function record(value: unknown, fields: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected excerpt object");
  const expected = fields.split(" ");
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new TypeError("Unknown or missing excerpt field");
  // justify-type-assertion: only object keys are narrowed; values remain unknown.
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError("Invalid excerpt integer");
}
function language(value: unknown): void { if (value !== null && typeof value !== "string") throw new TypeError("Invalid excerpt language"); }
function codepointLength(text: string): number {
  let length = 0;
  for (let offset = 0; offset < text.length; offset += text.codePointAt(offset)! > 0xffff ? 2 : 1) length++;
  return length;
}
function nodeSize(node: ExcerptNode): number {
  return node.kind === "text" ? codepointLength(node.text) : "children" in node ? node.children.reduce((sum, child) => sum + nodeSize(child), 0) : 1;
}
function contentSize(content: ExcerptNode[]): number { return content.reduce((sum, node) => sum + nodeSize(node), 0); }
export function validateExcerptBody(value: unknown): asserts value is ExcerptBody {
  const body = record(value, "structure lang dir content selection");
  if (!["captured", "unknown", "plain"].includes(String(body.structure))) throw new TypeError("Invalid excerpt structure");
  language(body.lang);
  if (body.dir !== null && body.dir !== "ltr" && body.dir !== "rtl") throw new TypeError("Invalid excerpt direction");
  if (!Array.isArray(body.content)) throw new TypeError("Expected excerpt content");
  const walk = (raw: unknown, parent: string | null) => {
    if (raw === null || typeof raw !== "object" || !("kind" in raw) || typeof raw.kind !== "string") throw new TypeError("Invalid excerpt node");
    const kind = raw.kind;
    let fields = "kind";
    if (kind === "text") fields += " text";
    else if (kind === "media_gap") fields += " media_kind flow";
    else if (BRANCHES.has(kind)) fields += " lang dir children" + (kind === "ol" ? " start reversed" : kind === "li" ? " value" : kind === "td" || kind === "th" ? " col_span row_span scope" : "");
    else if (kind !== "br" && kind !== "hr") throw new TypeError("Unknown excerpt node kind");
    const node = record(raw, fields);
    if (INLINE_PARENTS.has(parent ?? "") && !PHRASING.has(kind)) throw new TypeError("Block in excerpt phrasing content");
    if (parent === "ul" || parent === "ol") { if (kind !== "li") throw new TypeError("Excerpt list requires items"); }
    if (parent === "dl" && kind !== "dt" && kind !== "dd") throw new TypeError("Excerpt definition list requires terms and definitions");
    if (parent === "table" && !["thead", "tbody", "tfoot", "tr"].includes(kind)) throw new TypeError("Unsupported excerpt table child");
    if (["thead", "tbody", "tfoot"].includes(parent ?? "") && kind !== "tr") throw new TypeError("Excerpt table group requires rows");
    if (parent === "tr" && kind !== "td" && kind !== "th") throw new TypeError("Excerpt row requires cells");
    if (kind === "li" && parent !== "ul" && parent !== "ol" || ["dt", "dd"].includes(kind) && parent !== "dl" || ["td", "th"].includes(kind) && parent !== "tr" || ["thead", "tbody", "tfoot", "tr"].includes(kind) && !(parent === "table" || kind === "tr" && ["thead", "tbody", "tfoot"].includes(parent ?? ""))) throw new TypeError("Excerpt structure lacks required parent");
    if (kind === "text") { if (typeof node.text !== "string") throw new TypeError("Expected excerpt text"); return; }
    if (kind === "media_gap") { if (!["image", "svg", "embed"].includes(String(node.media_kind)) || !["inline", "block"].includes(String(node.flow))) throw new TypeError("Invalid excerpt media boundary"); return; }
    if (!BRANCHES.has(kind)) return;
    language(node.lang);
    if (node.dir !== null && !["ltr", "rtl", "auto"].includes(String(node.dir))) throw new TypeError("Invalid excerpt branch direction");
    if (!Array.isArray(node.children)) throw new TypeError("Expected excerpt children");
    if (kind === "ol") { integer(node.start, Number.MIN_SAFE_INTEGER); if (typeof node.reversed !== "boolean") throw new TypeError("Invalid ordered-list direction"); }
    if (kind === "li" && node.value !== null) integer(node.value, Number.MIN_SAFE_INTEGER);
    if (kind === "td" || kind === "th") { integer(node.col_span, 1); integer(node.row_span, 0); if (node.scope !== null && !["row", "col", "rowgroup", "colgroup"].includes(String(node.scope))) throw new TypeError("Invalid excerpt cell scope"); }
    for (const child of node.children) walk(child, kind);
  };
  for (const node of body.content) walk(node, null);
  const range = record(body.selection, "start end");
  for (const point of [range.start, range.end]) { const parsed = record(point, "path offset"); if (!Array.isArray(parsed.path)) throw new TypeError("Expected excerpt path"); }
  // justify-type-assertion: closed nodes and scalar fields have been validated above; endpoint bounds are checked next.
  const accepted = value as ExcerptBody;
  const at = excerptPointOffsets(accepted.content);
  if (at(accepted.selection.start) > at(accepted.selection.end)) throw new TypeError("Excerpt selection is reversed");
  if (accepted.structure !== "captured" && (accepted.content.length !== 1 || accepted.content[0]?.kind !== "text" || accepted.lang !== null || accepted.dir !== null)) throw new TypeError("Plain and unknown excerpts require one literal text leaf");
}
export function validateExcerpt(value: unknown): asserts value is FrozenExcerpt {
  const full = record(value, "structure lang dir content selection source_extent truncated_before truncated_after");
  validateExcerptBody({ structure: full.structure, lang: full.lang, dir: full.dir, content: full.content, selection: full.selection });
  for (const flag of [full.truncated_before, full.truncated_after]) if (flag !== null && typeof flag !== "boolean") throw new TypeError("Invalid excerpt cutoff");
  if (full.source_extent !== null) {
    const extent = record(full.source_extent, "reading_ref document_identity fragment_id start_offset end_offset");
    for (const field of ["reading_ref", "document_identity", "fragment_id"]) if (typeof extent[field] !== "string") throw new TypeError("Invalid excerpt source extent");
    integer(extent.start_offset, 0); integer(extent.end_offset, 0);
    if (Number(extent.end_offset) < Number(extent.start_offset)) throw new TypeError("Reversed excerpt source extent");
  }
  if (full.structure !== "captured" && (full.source_extent !== null || full.truncated_before !== null || full.truncated_after !== null)) throw new TypeError("Unknown/plain excerpt cannot claim source structure facts");
}
export function createPlainExcerpt(prefix: string, exact: string, suffix: string, structure: "unknown" | "plain"): FrozenExcerpt {
  const start = Array.from(prefix).length;
  return { structure, lang: null, dir: null, content: [{kind: "text", text: prefix + exact + suffix}], selection: {start: {path: [0], offset: start}, end: {path: [0], offset: start + Array.from(exact).length}}, source_extent: null, truncated_before: null, truncated_after: null };
}

type LiteralToken = { text: string; spans: {start: number; end: number}[]; synthetic: boolean; boundary: number | null };
function* sourceTokens(body: ExcerptBody): Generator<LiteralToken> {
  if (body.structure !== "captured") {
    const node = body.content[0];
    if (node?.kind !== "text") throw new Error("Literal excerpt lacks text leaf");
    let offset = 0;
    for (const text of node.text) { yield {text, spans: [{start: offset, end: offset + 1}], synthetic: false, boundary: null}; offset++; }
    return;
  }
  let pending = 0, pendingBoundary = 0, emitted = false;
  let previous: LiteralToken | null = null, previousCollapsible = false;
  const separator = (count: number, boundary: number) => { pending = Math.max(pending, count); pendingBoundary = boundary; };
  function* emit(token: LiteralToken, collapsible = false): Generator<LiteralToken> {
    if (pending && (previous !== null || emitted)) {
      if (previous !== null && !previousCollapsible) { emitted = true; yield previous; }
      previous = null;
      previousCollapsible = false;
      emitted = true;
      yield {text: "\n".repeat(pending), spans: [], synthetic: true, boundary: pendingBoundary};
    }
    pending = 0;
    if (collapsible && previousCollapsible && previous?.text === " " && !previous.synthetic) {
      const tail = previous.spans.at(-1)!, span = token.spans[0]!;
      if (tail.end === span.start) tail.end = span.end;
      else previous.spans.push(span);
    } else {
      if (previous !== null) { emitted = true; yield previous; }
      previous = token;
    }
    previousCollapsible = collapsible;
  }
  function* walk(node: ExcerptNode, path: number[], base: number, pre: boolean): Generator<LiteralToken> {
    const size = nodeSize(node);
    if (node.kind === "text") {
      let offset = 0;
      for (const ch of node.text) {
        const text = !pre && /^[\t\n\f\r ]$/u.test(ch) ? " " : ch;
        if (!(pending && text === " " && !pre)) yield* emit({text, spans: [{start: base + offset, end: base + offset + 1}], synthetic: false, boundary: null}, text === " " && !pre);
        offset++;
      }
      return;
    }
    const index = path.at(-1)!;
    if (node.kind === "br") { yield* emit({text: "\n", spans: [{start: base, end: base + 1}], synthetic: false, boundary: null}); return; }
    if (node.kind === "hr" || node.kind === "media_gap" && node.flow === "block") { separator(1, base); return; }
    if (!("children" in node)) return;
    const block = BLOCKS.has(node.kind), count = node.kind === "p" ? 2 : 1;
    if (block) separator(count, base);
    if (node.kind === "td" || node.kind === "th") {
      if (index > 0) { pending = 0; yield* emit({text: "\t", spans: [], synthetic: true, boundary: base}); }
    }
    let childBase = base;
    for (const [index, child] of node.children.entries()) { yield* walk(child, [...path, index], childBase, pre || node.kind === "pre"); childBase += nodeSize(child); }
    if (block) separator(count, base + size);
  }
  let base = 0;
  for (const [index, node] of body.content.entries()) { yield* walk(node, [index], base, false); base += nodeSize(node); }
  if (previous !== null) yield previous;
}
/** Partition one literal stream; collapsing spans retain every contributing source boundary. */
export function excerptTextParts(body: ExcerptBody): ExcerptTextParts {
  const at = excerptPointOffsets(body.content), start = at(body.selection.start), end = at(body.selection.end);
  if (body.structure !== "captured") {
    const node = body.content[0];
    if (node?.kind !== "text") throw new Error("Literal excerpt lacks text leaf");
    const chars = Array.from(node.text);
    return {prefix: chars.slice(0, start).join(""), exact: chars.slice(start, end).join(""), suffix: chars.slice(end).join("")};
  }
  const parts: ExcerptTextParts = {prefix: "", exact: "", suffix: ""};
  for (const token of sourceTokens(body)) {
    const spans = token.spans;
    const exact = token.synthetic ? token.boundary !== null && start < token.boundary && token.boundary < end : spans.some(span => span.start < end && span.end > start);
    const before = token.synthetic ? token.boundary! <= start : spans.every(span => span.end <= start);
    parts[exact ? "exact" : before ? "prefix" : "suffix"] += token.text;
  }
  return parts;
}

function canonicalSource(body: ExcerptBody): { emitted: string; tokens: CanonicalToken<number>[] } {
  const at = excerptPointOffsets(body.content);
  const tokens: CanonicalToken<number>[] = [];
  const last = () => tokens.at(-1)?.ch ?? "";
  const boundary = () => { if (last() !== "\n" && last() !== "") tokens.push({ch: "\n", spans: []}); };
  const walk = (node: ExcerptNode, path: number[]) => {
    if (node.kind === "text") {
      const base = at({path, offset: 0});
      let offset = base;
      for (const ch of node.text) {
        const span = offset;
        if (isCanonicalWhitespace(ch)) {
          const prior = tokens.at(-1);
          if (prior?.ch === " " && prior.spans.length && prior.spans.at(-1)! >= base) prior.spans.push(span);
          else tokens.push({ch: " ", spans: [span]});
        } else tokens.push({ch, spans: [span]});
        offset++;
      }
      return;
    }
    if (node.kind === "br") { tokens.push({ch: "\n", spans: []}); return; }
    const block = CANONICAL_BLOCKS.has(node.kind);
    if (block) boundary();
    if ("children" in node) for (const [index, child] of node.children.entries()) walk(child, [...path, index]);
    if (block) boundary();
  };
  for (const [index, node] of body.content.entries()) walk(node, [index]);
  const normalized = canonicalTokens(tokens, spans => [...new Set(spans)].sort((a,b) => a-b));
  return {emitted: normalized.map(token => token.ch).join(""), tokens: normalized};
}

/** Scalar provenance stays internal; only a requested endpoint needs a tree path. */
function sourceRange(content: ExcerptNode[]): (offset: number) => ExcerptRange {
  const leaves = locate(content).filter(entry => entry.node.kind === "text" && entry.start < entry.end);
  return offset => {
    let lo = 0, hi = leaves.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (leaves[mid]!.end <= offset) lo = mid + 1; else hi = mid; }
    const leaf = leaves[lo];
    if (!leaf || offset < leaf.start) throw new Error("Canonical provenance does not name source text");
    return {start: {path: leaf.path, offset: offset-leaf.start}, end: {path: leaf.path, offset: offset-leaf.start+1}};
  };
}
export function excerptCanonicalMap(body: ExcerptBody): { emitted: string; length: number; provenance: {start: number; end: number; spans: ExcerptRange[]}[] } {
  const map = canonicalSource(body), range = sourceRange(body.content);
  return {emitted:map.emitted, length:map.tokens.length, provenance:map.tokens.map((token,index) => ({start:index,end:index+1,spans:token.spans.map(range)}))};
}
/** Prove canonical publication text, returning only selected endpoints and refusals. */
export function excerptSourceSelection(body: ExcerptBody, start: number, end: number, unsupportedPaths: number[][]): {emitted: string; length: number; selection: ExcerptRange | null; unsupported_intervals: {start_offset:number; end_offset:number}[]} {
  integer(start,0); integer(end,start);
  const map = canonicalSource(body), range = sourceRange(body.content), at = excerptPointOffsets(body.content);
  if (end > map.tokens.length) throw new TypeError("Source selection exceeds canonical publication");
  const unsupported = unsupportedPaths.map(path => {
    let nodes=body.content, node: ExcerptNode | null=null;
    for (const [depth,index] of path.entries()) {
      integer(index,0); node=nodes[index] ?? null;
      if (node===null) throw new TypeError("Unsupported source path is absent");
      if (depth+1<path.length) {if (!("children" in node)) throw new TypeError("Unsupported source path crosses a leaf"); nodes=node.children;}
    }
    if (node?.kind!=="text") throw new TypeError("Unsupported source path must name text");
    const lo=at({path,offset:0}); return {lo,hi:lo+codepointLength(node.text)};
  });
  let first = Infinity, last = -Infinity;
  const intervals: {start_offset:number;end_offset:number}[] = [];
  for (const [index,token] of map.tokens.entries()) {
    if (index < end && index+1 > start) for (const span of token.spans) {first=Math.min(first,span);last=Math.max(last,span);}
    if (token.spans.some(span => unsupported.some(bounds => bounds.lo <= span && span < bounds.hi))) {
      const previous=intervals.at(-1); if (previous?.end_offset===index) previous.end_offset=index+1; else intervals.push({start_offset:index,end_offset:index+1});
    }
  }
  return {emitted:map.emitted,length:map.tokens.length,selection:Number.isFinite(first)?{start:range(first).start,end:range(last).end}:null,unsupported_intervals:intervals};
}

export function captureRevision(source_ref: string | null, capture: ExcerptCapture): string {
  return Array.from(sha256(new TextEncoder().encode(canonicalSerialization({source_ref, capture}))), byte => byte.toString(16).padStart(2, "0")).join("");
}

type LocatedNode = {node: ExcerptNode; path: number[]; start: number; end: number; ancestors: LocatedNode[]};
function locate(content: ExcerptNode[]): LocatedNode[] {
  const located: LocatedNode[] = [];
  let offset = 0;
  const walk = (nodes: ExcerptNode[], path: number[], ancestors: LocatedNode[]) => {
    for (const [index, node] of nodes.entries()) {
      const entry: LocatedNode = {node, path: [...path, index], start: offset, end: offset, ancestors};
      located.push(entry);
      if (node.kind === "text") offset += codepointLength(node.text);
      else if ("children" in node) walk(node.children, entry.path, [...ancestors, entry]);
      else offset++;
      entry.end = offset;
    }
  };
  walk(content, [], []);
  return located;
}
/** Index source order once; resolving any endpoint never rescans its text or siblings. */
export function excerptPointOffsets(content: ExcerptNode[]): (point: ExcerptPoint) => number {
  const located = locate(content);
  const entries = new Map(located.map(entry => [JSON.stringify(entry.path), entry]));
  const boundaries = new Map<string, number[]>();
  boundaries.set("[]", [0, ...located.filter(entry => entry.path.length === 1).map(entry => entry.end)]);
  for (const entry of located) if ("children" in entry.node) {
    boundaries.set(JSON.stringify(entry.path), [entry.start, ...entry.node.children.map((_node, index) => entries.get(JSON.stringify([...entry.path, index]))!.end)]);
  }
  return point => {
    const key = JSON.stringify(point.path);
    const entry = point.path.length ? entries.get(key) : null;
    if (point.path.length && !entry) throw new TypeError("Excerpt point path is outside content");
    integer(point.offset, 0);
    if (entry?.node.kind === "text") {
      if (point.offset > entry.end - entry.start) throw new TypeError("Excerpt text offset is outside content");
      return entry.start + point.offset;
    }
    const offsets = boundaries.get(key);
    if (!offsets) throw new TypeError("Excerpt atoms require parent boundaries");
    const offset = offsets[point.offset];
    if (offset === undefined) throw new TypeError("Excerpt child offset is outside content");
    return offset;
  };
}
function pointAt(content: ExcerptNode[], offset: number): ExcerptPoint {
  const leaves = locate(content).filter(entry => entry.node.kind === "text");
  const text = leaves.find(entry => entry.start <= offset && offset <= entry.end);
  if (text) return {path: text.path, offset: offset - text.start};
  const atom = locate(content).find(entry => !("children" in entry.node) && entry.start <= offset && offset <= entry.end);
  if (atom) return {path: atom.path.slice(0, -1), offset: atom.path.at(-1)! + Number(offset === atom.end)};
  if (offset === 0) return {path: [], offset: 0};
  if (offset === contentSize(content)) return {path: [], offset: content.length};
  throw new Error("Excerpt projection lost source boundary");
}
function cutsTable(content: ExcerptNode[], lo: number, hi: number): boolean {
  return locate(content).some(entry => entry.node.kind === "table" && entry.start < hi && entry.end > lo && (lo > entry.start || hi < entry.end));
}
function clipBody(body: ExcerptBody, lo: number, hi: number): ExcerptBody {
  const at = excerptPointOffsets(body.content), start = at(body.selection.start), end = at(body.selection.end);
  const clip = (nodes: ExcerptNode[], base: number): ExcerptNode[] => {
    const kept: ExcerptNode[] = [];
    let ordinal: number | null = null;
    for (const node of nodes) {
      const size = nodeSize(node), next = base + size;
      if (base < hi && next > lo || size === 0 && lo <= base && base < hi) {
        // Whole tables retain zero-text rows/cells at their scalar boundaries.
        if (node.kind === "table" && lo <= base && next <= hi) kept.push(node);
        else if (node.kind === "text") kept.push({...node, text: Array.from(node.text).slice(Math.max(0, lo - base), Math.min(size, hi - base)).join("")});
        else if ("children" in node) {
          if (node.dir === "auto" && (lo > base || hi < next)) throw new TypeError("Excerpt direction must be resolved before clipping");
          const children = clip(node.children, base);
          if (node.kind === "ol") {
            ordinal = node.start;
            let first: number | null = null, childBase = base;
            for (const child of node.children) {
              if (child.kind !== "li") throw new Error("Ordered list contains a non-item");
              ordinal = child.value ?? ordinal;
              if (first === null && childBase < hi && childBase + nodeSize(child) > lo) first = ordinal;
              ordinal += node.reversed ? -1 : 1;
              childBase += nodeSize(child);
            }
            kept.push({...node, start: first ?? node.start, children});
          } else kept.push({...node, children});
        } else kept.push(node);
      }
      base = next;
    }
    return kept;
  };
  const content = clip(body.content, 0);
  if (body.structure !== "captured") {
    const original = body.content[0];
    if (original?.kind !== "text") throw new Error("Literal excerpt lacks text leaf");
    const chars = Array.from(original.text).slice(lo, hi);
    return {...body, content: [{kind: "text", text: chars.join("")}], selection: {start: {path: [0], offset: Math.max(0, Math.min(hi, start) - lo)}, end: {path: [0], offset: Math.max(0, Math.min(hi, end) - lo)}}};
  }
  return {...body, content, selection: {start: pointAt(content, Math.max(0, Math.min(hi, start) - lo)), end: pointAt(content, Math.max(0, Math.min(hi, end) - lo))}};
}
function bodyOf(full: FrozenExcerpt): ExcerptBody {
  return {structure: full.structure, lang: full.lang, dir: full.dir, content: full.content, selection: full.selection};
}
function tokenBounds(token: LiteralToken): {start: number; end: number} {
  return token.synthetic ? {start: token.boundary!, end: token.boundary!} : {
    start: token.spans[0]!.start,
    end: token.spans.at(-1)!.end,
  };
}
/** Codepoint budgets never divide a grapheme; prefer a complete neighboring word. */
function contextCut(text: string, budget: number, side: "before" | "after"): number {
  const size = codepointLength(text);
  if (size <= budget) return side === "before" ? 0 : size;
  const target = side === "before" ? size - budget : budget;
  let cursor = 0, grapheme = side === "before" ? size : 0;
  for (const segment of new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text)) {
    if (side === "before" && cursor >= target) { grapheme = cursor; break; }
    if (side === "after") { if (cursor > target) break; grapheme = cursor; }
    cursor += codepointLength(segment.segment);
  }
  cursor = 0;
  let wordBoundary = grapheme;
  for (const segment of new Intl.Segmenter(undefined, {granularity: "word"}).segment(text)) {
    const end = cursor + codepointLength(segment.segment);
    if (side === "before" && segment.isWordLike && cursor >= grapheme && cursor < size) return cursor;
    if (side === "after") {
      if (end > grapheme) break;
      if (segment.isWordLike) wordBoundary = end;
    }
    cursor = end;
  }
  return wordBoundary;
}
function literalWindow(body: ExcerptBody, lo: number, hi: number, before: number, selected: number, after: number): {lo: number; hi: number; selected_clipped: boolean} {
  const at = excerptPointOffsets(body.content), start = at(body.selection.start), end = at(body.selection.end);
  const includes = (key: "prefix" | "exact" | "suffix", bounds: {start: number; end: number}): boolean => {
    if (bounds.start < lo || bounds.end > hi) return false;
    if (key === "prefix") return bounds.end <= start;
    if (key === "suffix") return bounds.start >= end;
    return bounds.start < end && bounds.end > start;
  };
  const text = {prefix: "", exact: "", suffix: ""};
  for (const token of sourceTokens(body)) {
    const bounds = tokenBounds(token);
    if (includes("prefix", bounds)) text.prefix += token.text;
    if (includes("exact", bounds)) text.exact += token.text;
    if (includes("suffix", bounds)) text.suffix += token.text;
  }
  const beforeCut = contextCut(text.prefix, before, "before"), exactCut = contextCut(text.exact, selected, "after"), afterCut = contextCut(text.suffix, after, "after");
  const bound = (key: "prefix" | "exact" | "suffix", offset: number, fallback: number, endBoundary: boolean) => {
    let consumed = 0;
    for (const token of sourceTokens(body)) {
      const bounds = tokenBounds(token);
      if (!includes(key, bounds)) continue;
      const next = consumed + codepointLength(token.text);
      if (next > offset) return bounds.start;
      if (endBoundary && next === offset) return bounds.end;
      consumed = next;
    }
    return fallback;
  };
  const selected_clipped = exactCut < codepointLength(text.exact);
  return {lo: beforeCut ? Math.max(lo, bound("prefix", beforeCut, start, false)) : lo,
    hi: selected_clipped ? Math.min(hi, bound("exact", exactCut, end, true)) : afterCut < codepointLength(text.suffix) ? Math.min(hi, bound("suffix", afterCut, end, true)) : hi,
    selected_clipped};
}
function intervalBounds(full: FrozenExcerpt, scope: ExcerptScope): {lo: number; hi: number} {
  const point = excerptPointOffsets(full.content), size = contentSize(full.content), start = point(full.selection.start), end = point(full.selection.end);
  if (scope.kind === "capture") return {lo: 0, hi: size};
  if (scope.kind === "selection") return {lo: start, hi: end};
  if (full.source_extent === null) throw new TypeError("Excerpt interval lacks proved source coordinates");
  integer(scope.start_offset, 0); integer(scope.end_offset, 0);
  if (scope.end_offset < scope.start_offset) throw new TypeError("Reversed excerpt scope");
  const map = canonicalSource(full), offset = full.source_extent.start_offset;
  let lo = scope.start_offset <= offset ? 0 : Infinity;
  let hi = scope.end_offset >= offset+map.tokens.length ? size : -Infinity;
  for (const [index,token] of map.tokens.entries()) if (index+offset >= scope.start_offset && index+offset+1 <= scope.end_offset) {
    for (const span of token.spans) {lo=Math.min(lo,span);hi=Math.max(hi,span+1);}
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > start || hi < end) throw new TypeError("Excerpt scope does not admit the complete selection");
  return {lo, hi};
}
export function excerptView(full: FrozenExcerpt, mode: "compact" | "full", scope: ExcerptScope): ExcerptView {
  const body = bodyOf(full), admitted = intervalBounds(full, scope), size = contentSize(full.content);
  if (cutsTable(full.content, admitted.lo, admitted.hi)) throw new TypeError("Excerpt scope does not admit a whole table");
  const window = mode === "compact" ? literalWindow(body, admitted.lo, admitted.hi, 48, 600, 48) : {...admitted, selected_clipped: false};
  if (mode === "compact" && cutsTable(full.content, window.lo, window.hi)) return {kind: "table_summary"};
  return {kind: "content", body: window.lo === 0 && window.hi === size ? body : clipBody(body, window.lo, window.hi), omitted_before: window.lo > 0 ? true : full.truncated_before,
    omitted_after: window.hi < size ? true : full.truncated_after, selected_truncated_before: false, selected_truncated_after: window.selected_clipped};
}
function clippedExtent(full: FrozenExcerpt, body: ExcerptBody, lo: number, hi: number): ExcerptExtent | null {
  if (full.source_extent === null) return null;
  const canonical = canonicalSource(full), projected = canonicalSource(body);
  const first = canonical.tokens.findIndex(token => token.spans.some(span => span+1 > lo && span < hi));
  if (first < 0) return null;
  const original = Array.from(canonical.emitted).slice(first, first + projected.tokens.length).join("");
  if (original !== projected.emitted) return null;
  return {...full.source_extent, start_offset: full.source_extent.start_offset + first, end_offset: full.source_extent.start_offset + first + projected.tokens.length};
}
/** Persist only admitted historical words. A partial atomic table is unavailable. */
export function scopeExcerpt(full: FrozenExcerpt, scope: ExcerptScope): FrozenExcerpt | null {
  if (scope.kind === "capture") return full;
  if (scope.kind === "interval" && full.source_extent !== null
    && scope.start_offset <= full.source_extent.start_offset && scope.end_offset >= full.source_extent.end_offset) {
    integer(scope.start_offset,0); integer(scope.end_offset,0);
    return full;
  }
  const {lo, hi} = intervalBounds(full, scope);
  if (lo === 0 && hi === contentSize(full.content)) return full;
  if (cutsTable(full.content, lo, hi)) return null;
  const body = clipBody(bodyOf(full), lo, hi);
  return {...body, source_extent: clippedExtent(full, body, lo, hi), truncated_before: full.structure === "captured" ? lo > 0 ? true : full.truncated_before : null, truncated_after: full.structure === "captured" ? hi < contentSize(full.content) ? true : full.truncated_after : null};
}
/** Source adapters prove and freeze endpoints; this owner alone bounds optional literal context. */
export function captureExcerpt(full: FrozenExcerpt): FrozenExcerpt {
  validateExcerpt(full);
  if (full.structure !== "captured" || full.source_extent === null) throw new TypeError("Reflowable capture requires proved source structure");
  const at = excerptPointOffsets(full.content), body = bodyOf(full), start = at(full.selection.start), end = at(full.selection.end), entries = locate(full.content);
  const selected = entries.filter(entry => !("children" in entry.node) && entry.start < end && entry.end > start);
  const first = selected[0], last = selected.at(-1);
  if (!first || !last || !selected.some(entry => entry.node.kind === "text" && entry.end > entry.start)) throw new ExcerptCaptureError("Reflowable capture requires selected source text");
  if (canonicalSource(full).tokens.length !== full.source_extent.end_offset - full.source_extent.start_offset) throw new TypeError("Excerpt source extent disagrees with canonical projection");
  const containing = (entry: LocatedNode): LocatedNode | null => entry.ancestors.find(ancestor => ancestor.node.kind === "table") ?? [...entry.ancestors].reverse().find(ancestor => BLOCKS.has(ancestor.node.kind)) ?? null;
  let lo = containing(first)?.start ?? 0, hi = containing(last)?.end ?? contentSize(full.content);
  for (const entry of entries) if (entry.node.kind === "media_gap") {
    if (entry.end <= start && entry.end > lo) lo = entry.end;
    if (entry.start >= end && entry.start < hi) hi = entry.start;
  }
  const window = literalWindow(body, lo, hi, 600, Number.MAX_SAFE_INTEGER, 600);
  lo = window.lo; hi = window.hi;
  for (const entry of entries) if (entry.node.kind === "table" && entry.start < end && entry.end > start) {lo = Math.min(lo, entry.start); hi = Math.max(hi, entry.end);}
  for (const entry of entries) if (entry.node.kind === "table") {
    if (entry.end <= start && entry.start < lo && lo < entry.end) lo = entry.end;
    if (entry.start >= end && entry.start < hi && hi < entry.end) hi = entry.start;
  }
  const clipped = clipBody(body, lo, hi), source_extent = clippedExtent(full, clipped, lo, hi);
  if (source_extent === null) throw new ExcerptCaptureError("Excerpt clipping changed its canonical publication correspondence");
  return {...clipped, source_extent,
    truncated_before: lo > (containing(first)?.start ?? 0), truncated_after: hi < (containing(last)?.end ?? contentSize(full.content))};
}
