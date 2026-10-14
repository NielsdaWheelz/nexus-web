// The anonymous share reader's lane.
import { proxyShare } from "@/lib/api/proxy";

export const runtime = "nodejs";

// The four public shapes, closed: no other path reaches FastAPI with the internal secret.
const SHAPE = /^(?:\/file|\/document|\/assets\/[0-9]{1,9})?$/;
const MASKED = { error: { code: "E_NOT_FOUND", message: "Share unavailable" } };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const segments = (await params).path ?? [];
  const suffix = segments.map((segment) => `/${segment}`).join("");
  if (!SHAPE.test(suffix)) return Response.json(MASKED, { status: 404 });
  return proxyShare(request, `/public/resource-share${suffix}`);
}
