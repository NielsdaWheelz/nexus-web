import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ refreshRunHandle: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { refreshRunHandle } = await params;
  return proxyToFastAPI(
    req,
    `/podcasts/refresh-runs/${encodeURIComponent(refreshRunHandle)}`,
  );
}
