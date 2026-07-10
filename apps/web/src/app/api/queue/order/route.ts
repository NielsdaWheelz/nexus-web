import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function PUT(req: Request) {
  return proxyToFastAPI(req, "/queue/order");
}
