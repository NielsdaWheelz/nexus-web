import { proxyMediaAssetToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; generation: string; memberKey: string[] }>;

export async function GET(request: Request, { params }: { params: Params }) {
  const { id, generation, memberKey } = await params;
  const key = memberKey.map(encodeURIComponent).join("/");
  return proxyMediaAssetToFastAPI(request, `/media/${encodeURIComponent(id)}/reader-publications/${encodeURIComponent(generation)}/assets/${key}`);
}
