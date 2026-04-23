import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export async function DELETE(req: Request) {
  return proxyExtensionToFastAPI(req, "/auth/extension-sessions/current");
}
