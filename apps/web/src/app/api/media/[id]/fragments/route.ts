import { proxyToFastAPI } from "@/lib/api/proxy";
import { mediaFragmentsResource } from "@/lib/api/resource";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, mediaFragmentsResource.serverPath({ id }));
}
