import { proxyToFastAPI } from "@/lib/api/proxy";
import { postActivityExclusionWithProxy } from "@/lib/consumption/historyBff.server";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return postActivityExclusionWithProxy(request, proxyToFastAPI);
}
