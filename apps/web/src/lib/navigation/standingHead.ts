// The standing head derives from the route model's required semantic section,
// then resolves that identity through the destination registry. There is no
// second path-prefix or route-to-section map to drift.
import { getDestination } from "@/lib/navigation/destinations";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";
import { sectionDestinationIdForRoute } from "@/lib/panes/paneRouteModel";

// Natural-case label. The running head's `.standing` class applies
// text-transform: uppercase, so all-caps never enters the DOM — a screen reader
// reads the natural-case word, not letter-by-letter.
export function standingHeadForRoute(routeId: PaneRouteId): string {
  return getDestination(sectionDestinationIdForRoute(routeId)).label;
}
