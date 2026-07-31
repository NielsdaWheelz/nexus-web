import "server-only";

import { cookies, headers } from "next/headers";
import { isApiError } from "@/lib/api/client";
import { callFastAPI } from "@/lib/api/server";
import { PREFETCH_OPTS } from "@/lib/api/resourceTransport";
import { serverResourceFetcher } from "@/lib/api/resourceTransport.server";
import type { DehydratedResources } from "@/lib/api/resourceCache";
import {
  decodeAuthenticatedAccount,
  type AuthenticatedAccount,
} from "@/lib/account/contract";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { parseReaderProfile } from "@/lib/reader/readerProfileSync";
import type { ReaderProfile } from "@/lib/reader/types";
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
  const res = await callFastAPI<{ data: unknown }>("/me/reader-profile");
  return parseReaderProfile(res.data);
}

async function loadAuthenticatedAccount(): Promise<AuthenticatedAccount> {
  const response = await callFastAPI<{ data: unknown }>("/me");
  return decodeAuthenticatedAccount(response.data);
}

async function loadSession(
  deviceId: string | null,
): Promise<{ own: unknown; mostRecentElsewhere: unknown } | null> {
  if (!deviceId) {
    return null;
  }
  let response: unknown;
  try {
    response = await callFastAPI<unknown>(
      `/me/workspace-session?device_id=${encodeURIComponent(deviceId)}`,
      PREFETCH_OPTS,
    );
  } catch (error) {
    if (
      isApiError(error) &&
      error.code === "E_INVALID_RESPONSE" &&
      error.status >= 200 &&
      error.status < 300
    ) {
      throw error;
    }
    // justify-ignore-error: best-effort restore; on failure the deep-link/default stands.
    return null;
  }

  // A transport failure is optional restore data. A successful response is a trusted
  // persistence boundary: malformed envelopes or rows must defect rather than masquerade
  // as an absent session and silently discard the user's saved workspace.
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
export async function loadWorkspaceBootstrap(androidShell: boolean): Promise<{
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}> {
  const entryIntent = parseWorkspaceEntryIntent(
    (await headers()).get(REQUEST_PATH_HEADER),
  );
  const deviceId = readDeviceId(await cookies());

  let urlSeedPromise: ReturnType<typeof seedPane> | null;
  switch (entryIntent.kind) {
    case "Resume":
      urlSeedPromise = null;
      break;
    case "Navigate":
      urlSeedPromise = seedPane(entryIntent.href);
      break;
    default: {
      const exhaustive: never = entryIntent;
      throw new Error(`Unexpected workspace entry intent: ${exhaustive}`);
    }
  }

  // Wave 1 — account profile, reader profile, saved session, and only a Navigate
  // pane's resource are concurrent. Resume never speculatively seeds root. Both
  // profiles are required; session and pane seeds stay best-effort. None gates
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
  const restored = session
    ? selectRestoredState(session.own, session.mostRecentElsewhere, metrics, androidShell)
    : null;
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
    default: {
      const exhaustive: never = entryIntent;
      throw new Error(`Unexpected workspace entry intent: ${exhaustive}`);
    }
  }

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

  return { account, readerProfile, initialState, resources };
}
