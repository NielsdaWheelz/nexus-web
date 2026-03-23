import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PUT(req: Request) {
  return proxyToFastAPI(req, "/podcasts/categories/order");
}
