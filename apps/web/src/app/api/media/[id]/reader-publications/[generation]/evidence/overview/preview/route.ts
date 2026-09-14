import { proxyMediaAssetToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; generation: string }>;

export async function POST(request: Request, { params }: { params: Params }) {
  const { id, generation } = await params;
  return proxyMediaAssetToFastAPI(request, `/media/${encodeURIComponent(id)}/reader-publications/${encodeURIComponent(generation)}/evidence/overview/preview`);
}
