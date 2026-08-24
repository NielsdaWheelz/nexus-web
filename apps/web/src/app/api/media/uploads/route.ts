import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return proxyToFastAPI(request, "/media/uploads");
}
