import "server-only";

import { cookies, headers } from "next/headers";
import { callFastAPI } from "@/lib/api/server";
import { serverResourceFetcher } from "@/lib/api/resourceTransport.server";
import type { DehydratedResources } from "@/lib/api/resourceCache";
import type { ApiJson } from "@/lib/api/wire";
import {
  decodeAuthenticatedAccount,
  type AuthenticatedAccount,
} from "@/lib/account/contract";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { decodeAuthorWorksView } from "@/lib/contributors/workView";
import type { ReaderProfile } from "@/lib/reader/ReaderContext";
import { expectExactRecord, expectString } from "@/lib/validation";
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
import {
  WORKSPACE_DEFAULT_FALLBACK_HREF,
  parseWorkspaceHref,
} from "@/lib/workspace/workspaceHref";

type WorkspaceEntryIntent =
  | { kind: "Resume" }
  | { kind: "Navigate"; href: string };

function parseWorkspaceEntryIntent(
  requestPath: string | null,
): WorkspaceEntryIntent {
  if (requestPath === null) {
    throw new Error("Missing required workspace request path");
  }

  const parsed = parseWorkspaceHref(requestPath);
  if (
    !parsed ||
    parsed.hash ||
    `${parsed.pathname}${parsed.search}` !== requestPath
  ) {
    throw new Error(
      `Request path must be a canonical pathname and search: ${JSON.stringify(requestPath)}`,
    );
  }

  return parsed.pathname === "/"
    ? { kind: "Resume" }
    : { kind: "Navigate", href: requestPath };
}

// Seed one pane's resource into the resource cache, keyed exactly as the pane's useResource
// reads it (AC-4) — or null if there's no loader, or it throws/times out, in which case the
// client hook fetches normally. The loader is the SAME isomorphic body the client mount and
// prefetch-on-intent run; only the transport differs (serverResourceFetcher here).
async function seedPane(href: string): Promise<{ cacheKey: string; data: unknown } | null> {
  const route = resolvePaneRouteModel(href);
  if (
    route.id === "author" &&
    decodeAuthorWorksView(new URLSearchParams(parseWorkspaceHref(href)?.search)).kind ===
      "Invalid"
  ) {
    return null;
  }
  const loader = route.id === "unsupported" ? undefined : paneResourceLoaders[route.id];
  if (!loader) {
    return null;
  }
  try {
    return {
      cacheKey: loader.cacheKey(route.params),
      data: await loader.load(serverResourceFetcher, route.params),
    };
  } catch {
    // justify-ignore-error: best-effort prefetch; the client useResource refetches.
    return null;
  }
}

// Required: the profile participates in workspace width restoration, so the shell cannot
// exist without it. It rides the normal 30 s server-request deadline (no prefetch bound) and
// a failure or malformed payload rejects the whole bootstrap into the workspace error
// boundary — never a fabricated default.
async function loadReaderProfile(): Promise<ReaderProfile> {
  const res = await callFastAPI<ApiJson<"/me/reader-profile", "get">>("/me/reader-profile");
  return res.data;
}

async function loadAuthenticatedAccount(): Promise<AuthenticatedAccount> {
  const response = await callFastAPI<{ data: unknown }>("/me");
  return decodeAuthenticatedAccount(response.data);
}

// Saved state is required bootstrap input. Transport failure must not fabricate
// absence: mounting a fallback could autosave over the unknown saved workspace.
async function loadSession(
  deviceId: string,
): Promise<{ own: unknown; mostRecentElsewhere: unknown }> {
  const response = await callFastAPI<unknown>(
    `/me/workspace-session?device_id=${encodeURIComponent(deviceId)}`,
  );

  const envelope = expectExactRecord(
    response,
    ["data"],
    "workspace session response",
  );
  const data = expectExactRecord(
    envelope.data,
    ["own", "most_recent_elsewhere"],
    "workspace session response.data",
  );
  const sessionState = (raw: unknown, name: string): unknown => {
    if (raw === null) {
      return null;
    }
    const session = expectExactRecord(raw, ["state", "updated_at"], name);
    expectString(session.updated_at, `${name}.updated_at`);
    return session.state;
  };
  return {
    own: sessionState(data.own, "workspace session response.data.own"),
    mostRecentElsewhere: sessionState(
      data.most_recent_elsewhere,
      "workspace session response.data.most_recent_elsewhere",
    ),
  };
}

// The authenticated shell's single server data root: the middleware-stamped entry intent,
// reader profile, server-restored workspace, and hydration cache of every restored visible
// pane's data — so the first paint shows the right panes, with their data, and no client
// round-trip.
export async function loadWorkspaceBootstrap(): Promise<{
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  initialState: WorkspaceState;
  persistInitialState: boolean;
  resources: DehydratedResources;
}> {
  const entryIntent = parseWorkspaceEntryIntent(
    (await headers()).get(REQUEST_PATH_HEADER),
  );
  const deviceId = readDeviceId(await cookies());
  if (!deviceId) {
    // justify-defect: middleware forwards its minted device cookie on the first request.
    throw new Error("Missing required workspace device cookie");
  }

  let urlSeedPromise: ReturnType<typeof seedPane> | null;
  switch (entryIntent.kind) {
    case "Resume":
      urlSeedPromise = null;
      break;
    case "Navigate":
      urlSeedPromise = seedPane(entryIntent.href);
      break;
  }

  // Wave 1 — account profile, reader profile, saved session, and only a Navigate
  // pane's resource are concurrent. Resume never speculatively seeds root. Both
  // profiles and saved session are required; pane seeds stay best-effort. None gates
  // the first byte — the shell skeleton streamed.
  const [account, readerProfile, session, urlSeed] = await Promise.all([
    loadAuthenticatedAccount(),
    loadReaderProfile(),
    loadSession(deviceId),
    urlSeedPromise,
  ]);

  // Width metrics come from the reader profile, matching the client's first-paint probe seed
  // so restored widths need no settle. Session selection remains own → most-recent-elsewhere.
  const widthPx = estimatePrimaryWidthPx(readerProfile);
  const metrics = { primaryMinWidthPx: widthPx, primaryDefaultWidthPx: widthPx };
  const restored = selectRestoredState(
    session.own,
    session.mostRecentElsewhere,
    metrics,
  );
  let initialState: WorkspaceState;
  switch (entryIntent.kind) {
    case "Resume":
      initialState =
        restored ?? createDefaultWorkspaceState(WORKSPACE_DEFAULT_FALLBACK_HREF, metrics);
      break;
    case "Navigate": {
      const deepLink = createDefaultWorkspaceState(entryIntent.href, metrics);
      initialState = restored
        ? mergeRestoredWorkspaceWithDeepLink(restored, deepLink, metrics)
        : deepLink;
      break;
    }
  }
  const restoredActive = restored && getWorkspacePrimaryPanes(restored).find(
    (pane) => pane.id === restored.activePrimaryPaneId,
  );
  const initialActive = getWorkspacePrimaryPanes(initialState).find(
    (pane) => pane.id === initialState.activePrimaryPaneId,
  );
  const persistInitialState = entryIntent.kind === "Navigate" && (
    restoredActive?.id !== initialActive?.id ||
    restoredActive?.currentVisit.id !== initialActive?.currentVisit.id ||
    restoredActive?.currentVisit.href !== initialActive?.currentVisit.href
  );

  // Wave 2 — seed the remaining restored visible panes, concurrent, deduped by resource. The
  // URL pane is pre-marked as seeded only when its wave-1 seed actually succeeded; if that seed
  // failed (timeout/throw), it stays eligible here so the active pane still gets a second shot.
  const resources: DehydratedResources = {};
  if (urlSeed) {
    resources[urlSeed.cacheKey] = urlSeed.data;
  }
  const seededRouteKeys = new Set(
    entryIntent.kind === "Navigate" && urlSeed
      ? [resolvePaneRouteIdentity(entryIntent.href).routeKey]
      : [],
  );
  const extraHrefs = getWorkspacePrimaryPanes(initialState)
    .filter((pane) => pane.visibility === "visible")
    .map((pane) => pane.currentVisit.href)
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

  return { account, readerProfile, initialState, persistInitialState, resources };
}
