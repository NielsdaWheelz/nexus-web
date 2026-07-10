import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Params = Promise<{ id: string; toolCallId: string }>;

export async function POST(req: Request, { params }: { params: Params }) {
  const { id, toolCallId } = await params;
  return proxyToFastAPI(req, `/conversations/${id}/tool-calls/${toolCallId}/undo`);
}
