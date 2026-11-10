// A browser download cannot set the wire header; the session asset lane does.
import { proxySession } from "@/lib/api/proxy";
export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  return proxySession(request, "/feeds/opml", "Asset");
}
