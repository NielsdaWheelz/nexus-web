// Proxied external images inside the reader: <img> requests, so the asset lane.
import { proxySession } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return proxySession(request, "/media/image", "Asset");
}
