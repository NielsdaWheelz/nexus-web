/**
 * The structured BFF lane: every browser API path whose only job is to reach
 * the identically named FastAPI path. Routes that add anything — a cache
 * directive, a guard, a remapped target, a non-structured proxy policy — stay
 * as explicit files and shadow this catch-all.
 *
 * The guard is a denylist, so a FastAPI path added under a new prefix is
 * browser-reachable the moment it is registered. Server-only trust lanes and
 * self-authenticating callers must therefore be listed here.
 */
import { NextResponse } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Denied: the internal trust lane, unauthenticated operational and schema
// endpoints, the SSE streams the browser opens directly against the stream
// origin with a minted token, and every lane whose callers authenticate
// themselves against FastAPI (Stripe's signed webhook, the offline-reading
// package token, share tokens, the extension token, public plate bytes). The
// explicit route files under those prefixes are the only doors into them.
const DENIED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "auth",
  "docs",
  "extension",
  "ingest",
  "internal",
  "livez",
  "openapi.json",
  "public",
  "readyz",
  "redoc",
  "stream",
  "version",
]);
const DENIED_PREFIXES = [
  "billing/stripe/webhook",
  "offline-reading/packages",
  "oracle/plates",
];

function isDenied(segments: readonly string[]): boolean {
  if (DENIED_FIRST_SEGMENTS.has(segments[0])) {
    return true;
  }
  const path = segments.join("/");
  return DENIED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function proxy(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  if (isDenied(path)) {
    return NextResponse.json(
      { error: { code: "E_NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  }
  return proxyToFastAPI(request, `/${path.map(encodeURIComponent).join("/")}`);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
