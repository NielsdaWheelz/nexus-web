import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyToFastAPI(req, "/libraries");
}

export async function POST(req: Request) {
  return proxyToFastAPI(req, "/libraries");
}
