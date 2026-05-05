import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ blockId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { blockId } = await params;
  return proxyToFastAPI(req, `/notes/blocks/${blockId}/merge`);
}
