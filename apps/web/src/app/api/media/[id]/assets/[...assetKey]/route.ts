// Reader epub assets: <img> requests, so the asset lane.
import { proxySession } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; assetKey: string[] }> },
): Promise<Response> {
  const { id, assetKey } = await params;
  const key = assetKey.map(encodeURIComponent).join("/");
  const target = `/media/${encodeURIComponent(id)}/assets/${key}`;
  return proxySession(request, target, "Asset");
}
