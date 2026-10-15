import "server-only";

import { headers } from "next/headers";
import { isApiError, type ApiError } from "@/lib/api/client";
import { callFastAPI } from "@/lib/api/server";
import type { ApiJson } from "@/lib/api/wire";
import { REQUEST_PATH_HEADER } from "@/lib/auth/urls";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { paneSeeds, type Get } from "@/lib/panes/paneResourceLoaders";
import type { WorkspaceBootstrap } from "@/lib/workspace/bootstrap";
import { enterWorkspace } from "@/lib/workspace/model";
import {
  MAX_WORKSPACE_HREF_LENGTH,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

/**
 * The authenticated shell's one server data root. Account, reader profile and
 * saved sessions are required: failure never mounts a fabricated default that
 * could autosave over an unread session. Only the active pane is seeded (500 ms
 * per read); named prefetch misses use its normal client read, while defects
 * stop entry.
 */
export async function loadWorkspaceBootstrap(): Promise<WorkspaceBootstrap> {
  const requestPath = (await headers()).get(REQUEST_PATH_HEADER);
  if (requestPath === null) {
    // justify-defect: middleware stamps it on every protected request.
    throw new Error("Workspace request path missing");
  }
  const [me, profile, sessions] = await Promise.all([
    callFastAPI<ApiJson<"/me", "get">>("/me"),
    callFastAPI<ApiJson<"/me/reader-profile", "get">>("/me/reader-profile"),
    callFastAPI<ApiJson<"/me/workspace-session", "get">>(
      "/me/workspace-session",
    ),
  ]);
  const zone = me.data.calendar_time_zone;
  // `/` and paths that are not canonical resume; bare /daily is today (L10, L11).
  const url = parseWorkspaceHref(requestPath);
  let href: string | null = requestPath;
  if (
    !url ||
    url.pathname === "/" ||
    `${url.pathname}${url.search}` !== requestPath ||
    requestPath.length > MAX_WORKSPACE_HREF_LENGTH
  ) {
    href = null;
  } else if (url.pathname === "/daily") {
    href = `/daily/${formatLocalDateInTimeZone(new Date(), zone)}`;
  }
  const { own, most_recent_elsewhere } = sessions.data;
  const initialState = enterWorkspace(own, most_recent_elsewhere, href);

  // The active pane's seeds, by its id under its hooks' keys.
  // justify-type-assertion: the API validates the active visible pane on every
  // stored read, and enterWorkspace preserves it or creates one with its pane.
  const pane = initialState.panes.find(
    (pane) => pane.id === initialState.active_primary_pane_id,
  )!;
  const route = resolvePaneRouteModel(pane.current_visit.href);
  const named = route.id === "unsupported" ? undefined : paneSeeds[route.id];
  const get: Get = (path) => callFastAPI(path, { timeoutMs: 500 });
  const seeded: Record<string, unknown> = {};
  await Promise.all(
    Object.entries(named?.(route.params) ?? {}).map(async ([key, load]) => {
      try {
        seeded[key] = await load(get);
      } catch (error) {
        const resourceMiss = isApiError(error) && (
          (route.id === "media" && error.code === "E_MEDIA_NOT_FOUND") ||
          (route.id === "library" && error.code === "E_LIBRARY_NOT_FOUND") ||
          ((route.id === "media" || route.id === "library") && error.code === "E_INVALID_REQUEST")
        );
        if (!isWorkspaceTransportError(error) && !resourceMiss) throw error;
        // justify-ignore-error: these named prefetch misses leave the pane's
        // ordinary client read in charge; unknown failures never become misses.
      }
    }),
  );
  return {
    account: { accountId: me.data.user_id, calendarTimeZone: zone },
    readerProfile: profile.data,
    initialState,
    seeds: { [pane.id]: seeded },
  };
}

/** Required reads explicitly model these dependency failures before first mount. */
export function isWorkspaceTransportError(error: unknown): error is ApiError {
  return isApiError(error) && [
    "E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT", "E_AUTH_UNAVAILABLE",
  ].includes(error.code);
}
