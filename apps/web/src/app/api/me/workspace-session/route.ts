import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyToFastAPI(req, "/me/workspace-session");
}

export async function PUT(req: Request) {
  return proxyToFastAPI(req, "/me/workspace-session");
}
