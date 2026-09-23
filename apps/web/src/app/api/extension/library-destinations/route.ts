import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyExtensionToFastAPI(req, "/extension/library-destinations");
}
