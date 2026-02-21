import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; idx: string }>;

export async function GET(req: Request, { params }: { params: Params }) {
  const { id, idx } = await params;
  return proxyToFastAPI(req, `/media/${id}/chapters/${idx}`);
}
