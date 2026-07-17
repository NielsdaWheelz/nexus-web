import { proxyToFastAPI } from "@/lib/api/proxy";
import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return privateNoStoreResponse(await proxyToFastAPI(req, "/me/reader-profile"));
}

export async function PATCH(req: Request) {
  return privateNoStoreResponse(await proxyToFastAPI(req, "/me/reader-profile"));
}
