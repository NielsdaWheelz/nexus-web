import { proxyToFastAPI } from "@/lib/api/proxy";
import { librariesResource } from "@/lib/api/resource";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyToFastAPI(
    req,
    librariesResource.serverPath({ refreshVersion: 0 }),
  );
}

export async function POST(req: Request) {
  return proxyToFastAPI(
    req,
    librariesResource.serverPath({ refreshVersion: 0 }),
  );
}
