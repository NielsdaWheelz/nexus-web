// Exact request grammar shared by bootstrap, arrival and mounted index reads.
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { parseWorkspaceHref } from "@/lib/workspace/workspaceHref";

export type LibrarianPaneQuery =
  | { readonly kind: "Timeline"; readonly messageId: string | null }
  | { readonly kind: "Search"; readonly text: string }
  | { readonly kind: "InvalidLink" };

export function librarianPaneQuery(href: string): LibrarianPaneQuery {
  const url = parseWorkspaceHref(href);
  if (url?.pathname !== "/librarian") return { kind: "InvalidLink" };
  const target = sourceTargetFromHref(href);
  if (target?.kind === "invalid_destination") return { kind: "InvalidLink" };
  const text = url.searchParams.get("q")?.trim();
  if (text) return { kind: "Search", text };
  const ref = target?.kind === "resource" ? target.resource_ref
    : target?.kind === "live_reference" ? target.reference.resource_ref : null;
  return { kind: "Timeline", messageId: ref?.startsWith("message:") ? ref.slice("message:".length) : null };
}

export function librarianSearchQuery(href: string): string | null {
  const query = librarianPaneQuery(href);
  return query.kind === "Search" ? query.text : null;
}

export function indexPaneQuery(routeId: PaneRouteId | "unsupported", query: URLSearchParams): string | null {
  if ((routeId === "podcastDetail" || routeId === "feedDetail")) return new URLSearchParams({ state: query.get("state") ?? "all", sort: query.get("sort") ?? "newest" }).toString();
  if (routeId === "podcasts" || routeId === "feeds") {
    const result = new URLSearchParams({ kind: routeId === "podcasts" ? "podcast" : "article", sort: query.get("sort") ?? "recent_entry", filter: query.get("filter") ?? "all" });
    const library = query.get("library_id");
    if (library !== null) result.set("library_id", library);
    return result.toString();
  }
  const keys = routeId === "libraries" ? [] : routeId === "library" ? ["sort", "projection"] : ["sort", "direction"];
  return new URLSearchParams(keys.flatMap(key => query.getAll(key).map(value => [key, value]))).toString();
}
