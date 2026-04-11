import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ itemId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { itemId } = await params;
  return proxyToFastAPI(req, `/playback/queue/items/${itemId}`);
}
