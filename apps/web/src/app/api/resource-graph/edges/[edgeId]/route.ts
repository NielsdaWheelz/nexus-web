import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ edgeId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { edgeId } = await params;
  return proxyToFastAPI(req, `/resource-graph/edges/${edgeId}`);
}
