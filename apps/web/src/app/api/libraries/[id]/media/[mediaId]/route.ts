import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; mediaId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { id, mediaId } = await params;
  return proxyToFastAPI(req, `/libraries/${id}/media/${mediaId}`);
}
