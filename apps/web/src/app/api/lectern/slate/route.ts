import { proxyToFastAPI } from "@/lib/api/proxy";
import { lecternSlateResource } from "@/lib/api/resource";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyToFastAPI(req, lecternSlateResource.serverPath({ refreshVersion: 0 }));
}
