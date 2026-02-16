import { proxyToFastAPI } from "@/lib/api/proxy";

export const runtime = "nodejs";

type Params = Promise<{ id: string; userId: string }>;

export async function PATCH(req: Request, { params }: { params: Params }) {
  const { id, userId } = await params;
  return proxyToFastAPI(req, `/libraries/${id}/members/${userId}`);
}

export async function DELETE(req: Request, { params }: { params: Params }) {
  const { id, userId } = await params;
  return proxyToFastAPI(req, `/libraries/${id}/members/${userId}`);
}
