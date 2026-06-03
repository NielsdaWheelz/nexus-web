import { proxyToFastAPI } from "@/lib/api/proxy";
import { billingAccountResource } from "@/lib/api/resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  return proxyToFastAPI(
    req,
    billingAccountResource.serverPath({ refreshVersion: 0 }),
  );
}
