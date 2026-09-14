import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export function POST(request: Request) {
  return proxyToFastAPI(request, "/nexus/history/query");
}
