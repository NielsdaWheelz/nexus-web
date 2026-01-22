import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return proxyToFastAPI(req, "/media/upload/init");
}
