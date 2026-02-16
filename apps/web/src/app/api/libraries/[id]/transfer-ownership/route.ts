import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { id } = await params;
  return proxyToFastAPI(req, `/libraries/${id}/transfer-ownership`);
}
