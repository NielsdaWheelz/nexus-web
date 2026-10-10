import "server-only";

import { cookies, headers } from "next/headers";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import type { DehydratedResources } from "@/lib/api/resourceCache";
import { serverResourceFetcher } from "@/lib/api/resourceTransport.server";
import { callFastAPI } from "@/lib/api/server";
import type { ApiJson } from "@/lib/api/wire";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { REQUEST_PATH_HEADER } from "@/lib/auth/urls";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import type { ReaderProfile } from "@/lib/reader/ReaderContext";
import { enterWorkspace, type WorkspaceState } from "@/lib/workspace/model";
import {
  MAX_WORKSPACE_HREF_LENGTH,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

/**
 * The authenticated shell's one server data root. Account, reader profile and
 * saved sessions are required: a failure is the workspace error region, never
 * a fabricated default that could autosave over an unread session. Pane seeds
 * are best effort; a pane whose seed fails fetches on the client.
 */
export async function loadWorkspaceBootstrap(): Promise<{
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}> {
  const requestPath = (await headers()).get(REQUEST_PATH_HEADER);
  const deviceId = readDeviceId(await cookies());
  if (requestPath === null || !deviceId) {
    // justify-defect: middleware stamps both on every protected request.
    throw new Error("Workspace request path or device cookie missing");
  }
  const [me, profile, sessions] = await Promise.all([
    callFastAPI<ApiJson<"/me", "get">>("/me"),
    callFastAPI<ApiJson<"/me/reader-profile", "get">>("/me/reader-profile"),
    callFastAPI<ApiJson<"/me/workspace-session", "get">>(
      `/me/workspace-session?device_id=${encodeURIComponent(deviceId)}`,
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

  // One seed per cache key over the visible panes.
  const loads = new Map<string, () => Promise<unknown>>();
  for (const pane of initialState.panes) {
    const route = resolvePaneRouteModel(pane.currentVisit.href);
    const loader = route.id === "unsupported" ? null : paneResourceLoaders[route.id];
    if (!loader || pane.visibility !== "visible") continue;
    const load = () => loader.load(serverResourceFetcher, route.params);
    loads.set(loader.cacheKey(route.params), load);
  }
  const resources: DehydratedResources = {};
  await Promise.all(
    [...loads].map(async ([key, load]) => {
      try {
        resources[key] = await load();
      } catch {
        // justify-ignore-error: a seed is a prefetch; the pane fetches on mount.
      }
    }),
  );
  return {
    account: { accountId: me.data.user_id, calendarTimeZone: zone },
    readerProfile: profile.data,
    initialState,
    resources,
  };
}
