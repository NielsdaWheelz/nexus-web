import { proxyMediaAssetToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; generation: string; itemId: string }>;

export async function POST(request: Request, { params }: { params: Params }) {
  const { id, generation, itemId } = await params;
  return proxyMediaAssetToFastAPI(request, `/media/${encodeURIComponent(id)}/reader-publications/${encodeURIComponent(generation)}/apparatus/${encodeURIComponent(itemId)}/text`);
}
