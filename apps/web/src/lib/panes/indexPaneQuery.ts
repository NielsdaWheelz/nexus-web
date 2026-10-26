// Exact request grammar shared by bootstrap, arrival and mounted index reads.
import { decodeUpdatedTitleIndexView, updatedTitleIndexViewQuery } from "@/lib/collections/updatedTitleIndexView";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";
export function indexPaneQuery(routeId: PaneRouteId | "unsupported", query: URLSearchParams): string | null {
  if (routeId === "notes" || routeId === "conversations") {
    const decoded = decodeUpdatedTitleIndexView(query);
    return decoded.kind === "Invalid" ? null : updatedTitleIndexViewQuery(decoded.view).slice(1);
  }
  if (routeId === "podcastDetail") return new URLSearchParams({ state: query.get("state") ?? "all", sort: query.get("sort") ?? "newest" }).toString();
  if (routeId === "podcasts") {
    const result = new URLSearchParams({ sort: query.get("sort") ?? "recent_episode", filter: query.get("filter") ?? "all" });
    const library = query.get("library_id");
    if (library !== null) result.set("library_id", library);
    return result.toString();
  }
  const keys = routeId === "libraries" ? ["sort"] : routeId === "library" ? ["sort", "entry_type", "projection", "completion"] : ["sort", "direction"];
  return new URLSearchParams(keys.flatMap(key => query.getAll(key).map(value => [key, value]))).toString();
}
