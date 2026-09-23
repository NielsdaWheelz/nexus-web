import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyExtensionToFastAPI(req, "/auth/extension-sessions/current");
}

export async function DELETE(req: Request) {
  return proxyExtensionToFastAPI(req, "/auth/extension-sessions/current");
}
