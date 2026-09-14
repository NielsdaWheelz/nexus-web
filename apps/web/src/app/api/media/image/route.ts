import { proxyCacheableMediaAssetToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyCacheableMediaAssetToFastAPI(req, "/media/image");
}
