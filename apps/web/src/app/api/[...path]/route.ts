// The json session lane: every /api path whose only job is to reach the same
// FastAPI path. A file under a more specific path owns its own lane. The guard
// is a denylist: server-only trust lanes and unauthenticated operational and
// schema endpoints must be listed, or they become browser-reachable.
import { proxySession } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = new Set([
  "auth",
  "docs",
  "ingest",
  "livez",
  "openapi.json",
  "public",
  "readyz",
  "redoc",
  "version",
]);

async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  if (DENIED.has(path[0])) {
    return Response.json(
      { error: { code: "E_NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  }
  const target = `/${path.map(encodeURIComponent).join("/")}`;
  return proxySession(request, target, "Json");
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
