import "server-only";

import { cookies, headers } from "next/headers";
import { callFastAPI } from "@/lib/api/server";
import type { DehydratedResources } from "@/lib/api/hydrationCache";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { paneServerLoaders, PREFETCH_OPTS } from "@/lib/panes/paneServerLoaders";
import { DEFAULT_READER_PROFILE, type ReaderProfile } from "@/lib/reader/types";
import { estimatePrimaryWidthPx } from "@/lib/workspace/paneSizing";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import {
  mergeRestoredWorkspaceWithDeepLink,
  selectRestoredState,
} from "@/lib/workspace/workspaceRestore";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";

// Seed one pane's resource into the hydration cache, keyed exactly as the pane's useResource
// reads it (AC-4) — or null if there's no loader, or it throws/times out, in which case the
// client hook fetches normally (D-8). One code path; prefetch is the optimization.
async function seedPane(href: string): Promise<{ cacheKey: string; data: unknown } | null> {
  const route = resolvePaneRouteModel(href);
  const loader = route.id === "unsupported" ? undefined : paneServerLoaders[route.id];
  if (!loader) {
    return null;
  }
  try {
    return await loader(route.params);
  } catch {
    // justify-ignore-error: best-effort prefetch; the client useResource refetches.
    return null;
  }
}

async function loadReaderProfile(): Promise<ReaderProfile> {
  try {
    return (await callFastAPI<{ data: ReaderProfile }>("/me/reader-profile", PREFETCH_OPTS)).data;
  } catch {
    // justify-ignore-error: best-effort; a slow/absent profile must never gate paint — the
    // client ReaderProvider owns save/retry.
    return DEFAULT_READER_PROFILE;
  }
}

async function loadSession(
  deviceId: string | null,
): Promise<{ own: unknown; mostRecentElsewhere: unknown } | null> {
  if (!deviceId) {
    return null;
  }
  try {
    const { data } = await callFastAPI<{
      data: {
        own: { state: unknown } | null;
        most_recent_elsewhere: { state: unknown } | null;
      };
    }>(`/me/workspace-session?device_id=${encodeURIComponent(deviceId)}`, PREFETCH_OPTS);
    return {
      own: data.own?.state ?? null,
      mostRecentElsewhere: data.most_recent_elsewhere?.state ?? null,
    };
  } catch {
    // justify-ignore-error: best-effort restore; on failure the deep-link/default stands.
    return null;
  }
}

// The authenticated shell's single server data root: the initial pane href (from the
// middleware-stamped request path), the reader profile, the server-restored workspace
// (merged with the deep link), and a hydration cache of every restored visible pane's data —
// so the first paint shows the right panes, with their data, and no client round-trip.
export async function loadWorkspaceBootstrap(androidShell: boolean): Promise<{
  initialHref: string;
  readerProfile: ReaderProfile;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}> {
  const initialHref =
    (await headers()).get(REQUEST_PATH_HEADER) ?? WORKSPACE_DEFAULT_FALLBACK_HREF;
  const deviceId = readDeviceId(await cookies());

  // Wave 1 — reader profile, saved session, and the URL pane's resource: concurrent and
  // best-effort. None gates the first byte (the shell skeleton already streamed). The URL
  // pane is usually the active pane, so this collapses the common case to one wave (D-6).
  const [readerProfile, session, urlSeed] = await Promise.all([
    loadReaderProfile(),
    loadSession(deviceId),
    seedPane(initialHref),
  ]);

  // Identity: merge the restored session (own → most-recent-elsewhere) with the deep-link
  // intent. Width metrics come from the reader profile, matching the client's first-paint
  // probe seed so the restored widths need no settle.
  const widthPx = estimatePrimaryWidthPx(readerProfile);
  const metrics = { primaryMinWidthPx: widthPx, primaryDefaultWidthPx: widthPx };
  const deepLink = createDefaultWorkspaceState(initialHref, metrics);
  const restored = session
    ? selectRestoredState(session.own, session.mostRecentElsewhere, metrics, androidShell)
    : null;
  const initialState = restored
    ? mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics)
    : deepLink;

  // Wave 2 — seed the remaining restored visible panes, concurrent, deduped by resource. The
  // URL pane is pre-marked as seeded only when its wave-1 seed actually succeeded; if that seed
  // failed (timeout/throw), it stays eligible here so the active pane still gets a second shot.
  const resources: DehydratedResources = {};
  if (urlSeed) {
    resources[urlSeed.cacheKey] = urlSeed.data;
  }
  const seededRouteKeys = new Set(
    urlSeed ? [resolvePaneRouteIdentity(initialHref).routeKey] : [],
  );
  const extraHrefs = getWorkspacePrimaryPanes(initialState)
    .filter((pane) => pane.visibility === "visible")
    .map((pane) => pane.href)
    .filter((href) => {
      const routeKey = resolvePaneRouteIdentity(href).routeKey;
      if (seededRouteKeys.has(routeKey)) {
        return false;
      }
      seededRouteKeys.add(routeKey);
      return true;
    });
  for (const seed of await Promise.all(extraHrefs.map(seedPane))) {
    if (seed) {
      resources[seed.cacheKey] = seed.data;
    }
  }

  return { initialHref, readerProfile, initialState, resources };
}
