import { proxyToFastAPI } from "@/lib/api/proxy";
import { postActivityAdjustmentWithProxy } from "@/lib/consumption/historyBff.server";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return postActivityAdjustmentWithProxy(request, proxyToFastAPI);
}
