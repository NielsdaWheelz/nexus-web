import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; podcastId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { id, podcastId } = await params;
  return proxyToFastAPI(req, `/libraries/${id}/podcasts/${podcastId}`);
}
