import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyToFastAPI(req, "/me/reader-profile");
}

export async function PATCH(req: Request) {
  return proxyToFastAPI(req, "/me/reader-profile");
}
