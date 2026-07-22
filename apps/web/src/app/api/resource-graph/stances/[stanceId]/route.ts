import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ stanceId: string }>;

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { stanceId } = await params;
  return proxyToFastAPI(req, `/resource-graph/stances/${stanceId}`);
}
