import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyToFastAPI(req, `/media/${id}/reader-state`);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyToFastAPI(req, `/media/${id}/reader-state`);
}
