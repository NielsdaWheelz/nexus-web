// Public source links and workspace arrivals name the same target. Coordinates
// come from the source owner after landing, never from a display excerpt.
import type { Schema } from "@/lib/api/wire";
import { parseReaderDestination, type ReaderDestination } from "@/lib/documentReader/location";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { isCanonicalUuid } from "@/lib/validation";
import { MAX_WORKSPACE_HREF_LENGTH, parseWorkspaceHref } from "@/lib/workspace/workspaceHref";

export type SourceTargetKey = Schema<"ResolveSourceTargetRequest">["target"];
export type SourceArrivalTarget = SourceTargetKey
  | { readonly kind: "reader_destination"; readonly destination: ReaderDestination }
  | { readonly kind: "invalid_destination"; readonly reason: "invalid_reader_destination" | "location_too_long" };
export type SourceTarget = Schema<"SourceTargetOut">;
export type SourceLocator = Extract<SourceTarget["location"], { kind: "located" }>["locator"];

const SCHEMES = {
  highlight: "highlight", evidence: "evidence_span", passage: "passage_anchor",
  fragment: "fragment", chunk: "content_chunk", apparatus: "reader_apparatus_item",
  message: "message", "oracle-passage": "oracle_passage_anchor",
} as const;

/** An explicit whole-source follow also replaces inspection; a plain reload has none to replace. */
export function sourceTargetFromHref(href: string, wholeSource = false): SourceArrivalTarget | null {
  const url = parseWorkspaceHref(href);
  if (!url) return null;
  const query = url.searchParams;
  const route = resolvePaneRouteModel(href);
  if (route.id === "librarian") {
    const located = ["message", "start_offset", "end_offset"].some(key => query.has(key));
    if (query.has("q") && (located || ["before_seq", "after_seq", "loc"].some(key => query.has(key)) || url.hash || query.getAll("q").length !== 1))
      return { kind: "invalid_destination", reason: "invalid_reader_destination" };
    if (located) {
      if (`${url.pathname}${url.search}${url.hash}`.length > MAX_WORKSPACE_HREF_LENGTH)
        return { kind: "invalid_destination", reason: "location_too_long" };
      const message = query.get("message");
      const start = query.get("start_offset");
      const end = query.get("end_offset");
      if (!message || !isCanonicalUuid(message) || query.getAll("message").length !== 1 || url.hash ||
          [...query.keys()].some(key => !["message", "start_offset", "end_offset", "via"].includes(key)))
        return { kind: "invalid_destination", reason: "invalid_reader_destination" };
      if (start === null && end === null) return { kind: "resource", field: null, resource_ref: `message:${message}` };
      if (start === null || end === null || query.getAll("start_offset").length !== 1 || query.getAll("end_offset").length !== 1 ||
          !/^(0|[1-9][0-9]*)$/.test(start) || !/^(0|[1-9][0-9]*)$/.test(end) ||
          !Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end)) || Number(start) >= Number(end) || Number(end) > 2 ** 31 - 1)
        return { kind: "invalid_destination", reason: "invalid_reader_destination" };
      return { kind: "live_reference", reference: { resource_ref: `message:${message}`, field: null, quote: null,
        locator: { kind: "TextOffsets", start_offset: Number(start), end_offset: Number(end) } } };
    }
  }
  if (query.has("post_revision")) {
    const revision = query.get("post_revision");
    const attempt = query.get("source_attempt_id");
    if (`${url.pathname}${url.search}${url.hash}`.length > MAX_WORKSPACE_HREF_LENGTH)
      return { kind: "invalid_destination", reason: "location_too_long" };
    if (route.id !== "media" || url.hash || query.getAll("post_revision").length !== 1 ||
        revision === null || !/^[0-9]+$/.test(revision) ||
        [...query.keys()].some(key => key !== "post_revision" && key !== "source_attempt_id") ||
        attempt !== null && (query.getAll("source_attempt_id").length !== 1 || !isCanonicalUuid(attempt)))
      return { kind: "invalid_destination", reason: "invalid_reader_destination" };
    return { kind: "x_post", revision_id: revision };
  }
  const locatedQuery = ["fragment", "apparatus", "apparatus_id", "x_post", "message"].some((key) => query.has(key));
  if (route.id === "media" && query.has("source_attempt_id") && (query.has("loc") || locatedQuery || url.hash))
    return { kind: "invalid_destination", reason: "invalid_reader_destination" };
  if (route.id === "media" && query.has("x_post"))
    return { kind: "invalid_destination", reason: "invalid_reader_destination" };
  if (query.has("loc")) {
    if (`${url.pathname}${url.search}${url.hash}`.length > MAX_WORKSPACE_HREF_LENGTH)
      return { kind: "invalid_destination", reason: "location_too_long" };
    if (query.getAll("loc").length !== 1 || url.hash || locatedQuery || route.locator === null && route.id !== "xCapture")
      return { kind: "invalid_destination", reason: "invalid_reader_destination" };
    if ((route.id === "media" || route.id === "xCapture") && [...query.keys()].every((key) => key === "loc" || key === "view") &&
        (!query.has("view") || query.getAll("view").length === 1 && (query.get("view") === "downloaded" || query.get("view") === "live"))) {
      const destination = parseReaderDestination(query.get("loc")!);
      if (destination) return { kind: "reader_destination", destination };
    }
    return { kind: "invalid_destination", reason: "invalid_reader_destination" };
  }
  if (route.id === "highlight" && url.hash === "#annotation" && route.locator?.kind === "resource_ref") return {kind: "resource", resource_ref: route.locator.ref, field: "annotation"};
  const match = /^#(citation-source|citation|highlight|evidence|passage|fragment|chunk|apparatus|message|oracle-passage)-(.+)$/.exec(url.hash);
  if (match && isCanonicalUuid(match[2])) {
    const [, kind, id] = match;
    if (kind === "citation" || kind === "citation-source") return { kind: "citation", edge_id: id, side: kind === "citation" ? "target" : "source" };
    // justify-type-assertion: the regex exhausts these keys after occurrence keys return.
    const scheme = SCHEMES[kind as keyof typeof SCHEMES];
    return { kind: "resource", field: null, resource_ref: `${scheme}:${id}` };
  }
  if (url.pathname.startsWith("/media/")) {
    const apparatus = query.get("apparatus_id");
    if (apparatus && isCanonicalUuid(apparatus)) return { kind: "resource", field: null, resource_ref: `reader_apparatus_item:${apparatus}` };
    const fragment = query.get("fragment");
    if (fragment && isCanonicalUuid(fragment)) return { kind: "resource", field: null, resource_ref: `fragment:${fragment}` };
  }
  if (wholeSource && !url.hash && (route.id === "media" || route.id === "note" || route.id === "highlight") && route.locator?.kind === "resource_ref")
    return { kind: "resource", field: null, resource_ref: route.locator.ref };
  return null;
}
