import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: {
  params: Promise<{ id: string; fragmentId: string }>;
}) {
  const { id, fragmentId } = await params;
  return proxyToFastAPI(req, `/media/${id}/fragments/${encodeURIComponent(fragmentId)}`);
}
