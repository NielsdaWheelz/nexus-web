import { proxyToFastAPI } from "@/lib/api/proxy";
import { contributorReconciliationCandidatesResource } from "@/lib/api/resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  return proxyToFastAPI(req, contributorReconciliationCandidatesResource.serverPath({}));
}
