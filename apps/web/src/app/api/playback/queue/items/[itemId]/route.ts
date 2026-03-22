import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const { itemId } = await params;
  return proxyToFastAPI(req, `/playback/queue/items/${itemId}`);
}
