// Public source links and workspace arrivals name the same target. Coordinates
// come from the source owner after landing, never from a display excerpt.
import type { Schema } from "@/lib/api/wire";
import { parseReaderDestination, type ReaderDestination } from "@/lib/documentReader/location";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { isCanonicalUuid } from "@/lib/validation";
import { MAX_WORKSPACE_HREF_LENGTH, parseWorkspaceHref } from "@/lib/workspace/workspaceHref";

export type SourceTargetKey = NonNullable<Schema<"ResourceActivationOut">["source_target"]>;
export type SourceArrivalTarget = SourceTargetKey
  | { readonly kind: "reader_destination"; readonly destination: ReaderDestination }
  | { readonly kind: "invalid_destination"; readonly reason: "invalid_reader_destination" };
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
  const locatedQuery = ["fragment", "apparatus", "apparatus_id", "x_post", "message"].some((key) => query.has(key));
  if (route.id === "media" && query.has("source_attempt_id") && (query.has("loc") || locatedQuery || url.hash))
    return { kind: "invalid_destination", reason: "invalid_reader_destination" };
  if (route.id === "media" && query.has("x_post"))
    return { kind: "invalid_destination", reason: "invalid_reader_destination" };
  if (query.has("loc")) {
    const destination = parseReaderDestination(query.get("loc")!);
    if (route.id !== "media" || query.getAll("loc").length !== 1 ||
      `${url.pathname}${url.search}${url.hash}`.length > MAX_WORKSPACE_HREF_LENGTH ||
      url.hash || locatedQuery || destination === null)
      return { kind: "invalid_destination", reason: "invalid_reader_destination" };
    return { kind: "reader_destination", destination };
  }
  const match = /^#(quote|citation|retrieval|highlight|evidence|passage|fragment|chunk|apparatus|message|oracle-passage)-(.+)$/.exec(url.hash);
  if (match && isCanonicalUuid(match[2])) {
    const [, kind, id] = match;
    if (kind === "quote") return { kind: "reader_quote", message_id: id };
    if (kind === "citation") return { kind: "citation", edge_id: id };
    if (kind === "retrieval") return { kind: "retrieval", retrieval_id: id };
    // justify-type-assertion: the regex exhausts these keys after occurrence keys return.
    const scheme = SCHEMES[kind as keyof typeof SCHEMES];
    return { kind: "resource", resource_ref: `${scheme}:${id}` };
  }
  const message = url.pathname.startsWith("/conversations/") && query.get("message");
  if (message && isCanonicalUuid(message)) return { kind: "resource", resource_ref: `message:${message}` };
  if (url.pathname.startsWith("/media/")) {
    const apparatus = query.get("apparatus_id");
    if (apparatus && isCanonicalUuid(apparatus)) return { kind: "resource", resource_ref: `reader_apparatus_item:${apparatus}` };
    const fragment = query.get("fragment");
    if (fragment && isCanonicalUuid(fragment)) return { kind: "resource", resource_ref: `fragment:${fragment}` };
  }
  if (wholeSource && !url.hash && (route.id === "media" || route.id === "note" || route.id === "conversation") && route.locator?.kind === "resource_ref")
    return { kind: "resource", resource_ref: route.locator.ref };
  return null;
}
