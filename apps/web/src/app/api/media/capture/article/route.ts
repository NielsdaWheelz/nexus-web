import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return proxyExtensionToFastAPI(req, "/media/capture/article", {
    defaultAccept: "application/json",
    defaultContentType: "application/json",
  });
}
