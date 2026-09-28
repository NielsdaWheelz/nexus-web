import { proxyResourceShareToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

// The four public shapes, closed: no other path reaches FastAPI with the internal secret.
const SHAPE = /^(?:\/file|\/sections\/nxps1_[A-Za-z0-9_-]{48}|\/assets\/nxpa1_[A-Za-z0-9_-]{48})?$/;
const MASKED = { error: { code: "E_NOT_FOUND", message: "Share unavailable" } };

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const suffix = ((await params).path ?? []).map((segment) => `/${segment}`).join("");
  if (!SHAPE.test(suffix)) return Response.json(MASKED, { status: 404 });
  return proxyResourceShareToFastAPI(request, `/public/resource-share${suffix}`);
}
