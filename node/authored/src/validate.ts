/** Runtime validation at the shared semantic boundary. Host schemas close the
 * transport; these checks own identity agreement and content invariants. */
import { isResourceRef, normalizeQuote } from "./identity.ts";
import { canonicalQuads } from "./geometry.ts";
import { counter } from "./merge.ts";
import type { Change, Locator, Publication, Register, SelectionCapture, Vector } from "./types.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function uuid(value: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError("Expected canonical UUID");
}
function vector(value: Vector): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected version vector");
  for (const [replica, sequence] of Object.entries(value)) { uuid(replica); counter(sequence); }
}
function register<T>(value: Register<T>): void {
  if (!value || typeof value !== "object" || !value.stamp) throw new TypeError("Expected stamped register");
  uuid(value.stamp.replica_id);
  if (counter(value.stamp.lamport) < 1n) throw new TypeError("Register lamport must be positive");
}
function publication(value: Publication | null): void {
  if (value === null) return;
  if (value.kind === "reader") {
    if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new TypeError("Invalid reader generation");
  } else if (value.kind !== "note_text" || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw new TypeError("Invalid note publication");
}
function integer(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError("Invalid locator integer");
}
function range(start: number, end: number): void {
  integer(start); integer(end);
  if (end <= start) throw new TypeError("Locator range must be nonempty");
}
function literal(value: string | null): void {
  if (value !== null && typeof value !== "string") throw new TypeError("Expected literal text or null");
}
export function validateLocator(locator: Locator, source_ref: string): void {
  if (!locator || typeof locator !== "object") throw new TypeError("Expected typed locator");
  if (!isResourceRef(source_ref)) throw new TypeError("Invalid locator source");
  const source_id = source_ref.slice(source_ref.indexOf(":") + 1);
  if ("media_id" in locator && (locator.media_id !== source_id || !source_ref.startsWith("media:"))) throw new TypeError("Locator media disagrees with immutable source");
  switch (locator.type) {
    case "web_text_offsets":
    case "epub_fragment_offsets":
      uuid(locator.fragment_id);
      range(locator.start_offset, locator.end_offset);
      if (locator.type === "epub_fragment_offsets" && locator.section_id !== null) uuid(locator.section_id);
      break;
    case "note_block_offsets":
      if (source_ref !== `note_block:${locator.block_id}`) throw new TypeError("Locator note disagrees with immutable source");
      range(locator.start_offset, locator.end_offset);
      if (locator.body_version !== null) integer(locator.body_version, 1);
      break;
    case "pdf_page_geometry":
      integer(locator.page_number, 1);
      if (!Array.isArray(locator.quads) || locator.quads.length < 1 || locator.quads.length > 512) throw new TypeError("Invalid PDF geometry");
      for (const quad of locator.quads) for (const key of ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"] as const) if (!Number.isFinite(quad[key])) throw new TypeError("Nonfinite PDF coordinate");
      literal(locator.exact); literal(locator.prefix); literal(locator.suffix);
      break;
    case "pdf_page": integer(locator.page_number, 1); break;
    case "transcript_time_range":
    case "audio_time_range":
    case "video_time_range": range(locator.t_start_ms, locator.t_end_ms); break;
    case "message_offsets":
      uuid(locator.conversation_id); uuid(locator.message_id);
      if (source_ref !== `message:${locator.message_id}`) throw new TypeError("Locator message disagrees with source");
      range(locator.start_offset, locator.end_offset);
      break;
    case "external_url":
      if (typeof locator.url !== "string") throw new TypeError("Invalid external URL locator");
      break;
    default: throw new TypeError("Unknown locator kind");
  }
  if ("text_quote_selector" in locator && locator.text_quote_selector !== null) {
    if (typeof locator.text_quote_selector.exact !== "string") throw new TypeError("Invalid quote selector");
    literal(locator.text_quote_selector.prefix); literal(locator.text_quote_selector.suffix);
  }
}
function selection(value: SelectionCapture, source_ref: string): void {
  if (!source_ref.startsWith("media:") || !["web_text_offsets", "epub_fragment_offsets", "pdf_page_geometry"].includes(value.locator.type)) throw new TypeError("Highlight selections require media text or PDF geometry");
  if (value.publication !== null && value.publication.kind !== "reader") throw new TypeError("Highlight publication must identify a reader generation");
  if (value.locator.type === "pdf_page_geometry") {
    const canonical = canonicalQuads(value.locator.quads);
    const keys = ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"] as const;
    if (canonical.some((quad, index) => keys.some(key => quad[key] !== value.locator.quads[index]![key]))) throw new TypeError("PDF selection geometry must be canonical before commit");
    if ([...value.quote_exact].length > 2000) throw new TypeError("PDF quote exceeds 2000 codepoints");
  }
  publication(value.publication);
  validateLocator(value.locator, source_ref);
  if (typeof value.quote_exact !== "string") throw new TypeError("Expected literal quote");
  literal(value.prefix); literal(value.suffix);
  if (value.passage_ref !== null && (!isResourceRef(value.passage_ref) || !value.passage_ref.startsWith("passage_anchor:"))) throw new TypeError("Invalid selection passage");
}
export function validateChange(change: Change): void {
  if (counter(change.command_seq) < 1n || counter(change.lamport) < 1n) throw new TypeError("Command counters must be positive");
  for (const resource of change.resources) {
    if (!isResourceRef(resource.ref)) throw new TypeError("Invalid resource ref");
    vector(resource.touch_vv); vector(resource.delete_vv);

    if (resource.kind === "highlight") {
      if (!isResourceRef(resource.source_ref)) throw new TypeError("Invalid highlight source");
      register(resource.selection); register(resource.color);
      selection(resource.selection.value, resource.source_ref);
      if (!["yellow", "green", "blue", "pink", "purple"].includes(resource.color.value)) throw new TypeError("Unknown highlight color");
    } else if (resource.kind === "page") {
      if (resource.local_date !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(resource.local_date) || new Date(`${resource.local_date}T00:00:00Z`).toISOString().slice(0, 10) !== resource.local_date)) throw new TypeError("Invalid daily date");
    } else if (resource.kind !== "note") throw new TypeError("Unknown resource kind");
  }
  for (const link of change.links) {
    uuid(link.link_id); vector(link.add_vv); vector(link.remove_vv);
    for (const position of [link.position_a, link.position_b]) if (position !== null) {
      register(position);
      if (typeof position.value !== "string" || position.value.length === 0) throw new TypeError("Invalid position key");
    }
  }
  for (const passage of change.passages) {
    uuid(passage.anchor_id);
    if (!isResourceRef(passage.source_ref)) throw new TypeError("Invalid passage source");
    for (const text of [passage.normalized_exact, passage.prefix, passage.suffix]) if (typeof text !== "string" || normalizeQuote(text) !== text) throw new TypeError("Passage binding must be normalized");
    register(passage.capture); publication(passage.capture.value.publication);
    if (typeof passage.capture.value.quote_exact !== "string") throw new TypeError("Expected literal passage quote");
    if (normalizeQuote(passage.capture.value.quote_exact) !== passage.normalized_exact) throw new TypeError("Passage quote disagrees with semantic binding");
    if (passage.capture.value.locator !== null) validateLocator(passage.capture.value.locator, passage.source_ref);
  }
  for (const stub of change.source_stubs) {
    if (!isResourceRef(stub.source_ref)) throw new TypeError("Invalid captured source ref");
    register(stub.capture); publication(stub.capture.value.publication);
    if (typeof stub.capture.value.label !== "string" || typeof stub.capture.value.kind !== "string") throw new TypeError("Invalid source capture");
  }
}
