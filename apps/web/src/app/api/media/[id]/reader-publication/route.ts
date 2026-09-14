import { proxyMediaAssetToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return proxyMediaAssetToFastAPI(request, `/media/${encodeURIComponent(id)}/reader-publication`);
}
