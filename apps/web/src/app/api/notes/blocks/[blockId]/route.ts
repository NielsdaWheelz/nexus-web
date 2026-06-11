import { proxyToFastAPI } from "@/lib/api/proxy";
import { noteBlockResource } from "@/lib/api/resource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ blockId: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { blockId } = await params;
  return proxyToFastAPI(req, noteBlockResource.serverPath({ blockId }));
}
