import "server-only";

import { headers } from "next/headers";
import { callFastAPI } from "@/lib/api/server";
import type { DehydratedResources } from "@/lib/api/hydrationCache";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { paneServerLoaders, PREFETCH_DEADLINE_MS } from "@/lib/panes/paneServerLoaders";
import { DEFAULT_READER_PROFILE, type ReaderProfile } from "@/lib/reader/types";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";

// The authenticated shell's single server data root: the initial pane href (from
// the middleware-stamped request path), the reader profile, and a hydration cache
// of the initial pane's data — so the shell paints its chrome, applies reader
// settings, and renders the landing pane with no client round-trip.
export async function loadWorkspaceBootstrap(): Promise<{
  initialHref: string;
  readerProfile: ReaderProfile;
  resources: DehydratedResources;
}> {
  const initialHref =
    (await headers()).get(REQUEST_PATH_HEADER) ?? WORKSPACE_DEFAULT_FALLBACK_HREF;

  let readerProfile = DEFAULT_READER_PROFILE;
  try {
    readerProfile = (
      await callFastAPI<{ data: ReaderProfile }>("/me/reader-profile", {
        timeoutMs: PREFETCH_DEADLINE_MS,
      })
    ).data;
  } catch {
    // justify-ignore-error: bootstrap is best-effort. Any failure — deadline
    // (504), no profile yet (404), or transient — falls back to the default; the
    // client ReaderProvider owns save/retry. A slow profile must never gate paint.
  }

  // Prefetch the URL-primary pane's resource into the hydration cache (D-6), keyed
  // exactly as the pane's useResource reads it, so the initial pane paints without
  // a client fetch (AC-4). Resolved with the SAME resolver the client uses (D-5).
  // A loader that throws/times out is omitted and the client hook fetches normally
  // (D-8) — one code path; prefetch is the optimization.
  const resources: DehydratedResources = {};
  const route = resolvePaneRouteModel(initialHref);
  const loader =
    route.id === "unsupported" ? undefined : paneServerLoaders[route.id];
  if (loader) {
    try {
      const seeded = await loader(route.params);
      resources[seeded.cacheKey] = seeded.data;
    } catch {
      // justify-ignore-error: best-effort prefetch; the client hook refetches.
    }
  }

  return { initialHref, readerProfile, resources };
}
