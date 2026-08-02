import { proxyMediaAssetToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; assetKey: string[] }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id, assetKey } = await params;
  const encodedAssetKey = assetKey.map(encodeURIComponent).join("/");
  return proxyMediaAssetToFastAPI(
    req,
    `/media/${id}/assets/${encodedAssetKey}`,
  );
}
