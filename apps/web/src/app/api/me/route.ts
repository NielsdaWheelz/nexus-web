import { proxyToFastAPI } from "@/lib/api/proxy";
import { settingsAccountResource } from "@/lib/api/resource";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyToFastAPI(req, settingsAccountResource.serverPath({}));
}

export async function PATCH(req: Request) {
  return proxyToFastAPI(req, settingsAccountResource.serverPath({}));
}
