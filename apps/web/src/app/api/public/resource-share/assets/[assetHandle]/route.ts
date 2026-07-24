import { proxyResourceShareToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ assetHandle: string }>;

export async function GET(
  request: Request,
  { params }: { params: Params }
) {
  const { assetHandle } = await params;
  return proxyResourceShareToFastAPI(
    request,
    `/public/resource-share/assets/${encodeURIComponent(assetHandle)}`
  );
}
